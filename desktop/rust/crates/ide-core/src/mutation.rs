#![allow(dead_code)]

use crate::{
    error::{CoreError, Result},
    file_identity::{directory_identity, FileIdentity},
    workspace::Workspace,
};
#[path = "write_workspace.rs"]
mod write_workspace;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_OPERATIONS: usize = 20_000;
const MAX_PLANS_PER_RPC: usize = 128;
const MAX_WRITE_BYTES: usize = 64 * 1024 * 1024;
const MAX_TRANSACTION_BLOB_BYTES: u64 = 256 * 1024 * 1024;
#[cfg(not(test))]
const TERMINAL_TRANSACTION_RECEIPT_LIMIT: usize = 1024;
#[cfg(test)]
const TERMINAL_TRANSACTION_RECEIPT_LIMIT: usize = 8;
const TX_DIR: &str = ".crewforge/desktop-transactions";
const EXTERNAL_LOCK_FILE: &str = "external.lock";

#[derive(Default)]
pub struct Mutations {
    state: Mutex<WriterState>,
}

#[derive(Default)]
struct WriterState {
    admissions: HashMap<String, Admission>,
    leases: HashMap<String, Lease>,
    external_leases: HashMap<String, ExternalLease>,
}

#[derive(Clone)]
struct Admission {
    canonical_root: PathBuf,
    root_identity: FileIdentity,
    owner: WriterOwner,
    intent: String,
    external_token: Option<String>,
    expires_at_ms: f64,
}

#[derive(Clone)]
struct Lease {
    admission_token: String,
    canonical_root: PathBuf,
    root_identity: FileIdentity,
    owner: WriterOwner,
    lock_path: PathBuf,
    expires_at_ms: f64,
}

#[derive(Clone)]
struct ExternalLease {
    canonical_root: PathBuf,
    root_identity: FileIdentity,
    owner: WriterOwner,
    lock_path: PathBuf,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExternalLockFile {
    pid: u32,
    token: String,
    owner: WriterOwner,
    intent: String,
    root_identity: PersistedFileIdentity,
    created_at_ms: f64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PersistedFileIdentity {
    volume: u64,
    index: u64,
}

#[derive(Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WriterOwner {
    kind: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutateParams {
    pub workspace_dir: String,
    #[serde(default)]
    pub transaction_id: String,
    pub operations: Vec<MutationOperation>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MutationOperation {
    WriteFile {
        path: String,
        #[serde(default)]
        content: String,
        #[serde(default)]
        content_base64: String,
        #[serde(default)]
        expected: Option<ExpectedState>,
        #[serde(default)]
        overwrite: bool,
    },
    Mkdir {
        path: String,
        #[serde(default)]
        recursive: bool,
    },
    Delete {
        path: String,
        #[serde(default)]
        recursive: bool,
    },
    Rename {
        path: String,
        #[serde(rename = "newPath")]
        new_path: String,
    },
    Copy {
        path: String,
        #[serde(rename = "newPath")]
        new_path: String,
    },
}

#[derive(Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedState {
    #[serde(default)]
    exists: Option<bool>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    file: Option<bool>,
    #[serde(default)]
    directory: Option<bool>,
    #[serde(default)]
    identity: Option<ExpectedIdentity>,
}

#[derive(Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedIdentity {
    device: String,
    inode: String,
    nlink: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutateResponse {
    transaction_id: String,
    status: String,
    entries: Vec<MutationReceipt>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MutationReceipt {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_path: Option<String>,
    operation: String,
    exists: bool,
    is_file: bool,
    is_directory: bool,
    size: u64,
    mtime_ms: f64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusParams {
    pub workspace_dir: String,
    pub transaction_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    transaction_id: String,
    status: String,
    entries: Vec<MutationReceipt>,
    publications: Vec<PublicationReceipt>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmitParams {
    pub workspace_dir: String,
    pub owner: WriterOwner,
    pub intent: String,
    #[serde(default)]
    pub ttl_ms: Option<u64>,
    #[serde(default)]
    pub external_token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmitResponse {
    admission_token: String,
    canonical_root: String,
    expires_at_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireParams {
    pub admission_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireResponse {
    lease_token: String,
    canonical_root: String,
    owner: WriterOwner,
    lock: LockReceipt,
    expires_at_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockReceipt {
    pid: u32,
    token: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseParams {
    pub lease_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseResponse {
    released: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBeginParams {
    pub workspace_dir: String,
    pub owner: WriterOwner,
    pub intent: String,
    #[serde(default)]
    pub owner_pid: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBeginResponse {
    external_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEndParams {
    pub external_token: String,
    #[serde(default)]
    pub workspace_dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectParams {
    pub admission_token: String,
    pub path: String,
    #[serde(default)]
    pub read_bytes: bool,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResponse {
    path: String,
    exists: bool,
    kind: String,
    size: u64,
    mtime_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes_base64: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionBeginParams {
    pub lease_token: String,
    pub transaction_id: String,
    #[serde(default = "default_transaction_mode")]
    pub mode: String,
    pub files: Vec<TransactionFilePlan>,
    #[serde(default)]
    pub publications: Vec<TransactionPublicationPlan>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionAppendPlansParams {
    pub lease_token: String,
    pub transaction_id: String,
    #[serde(default)]
    pub files: Vec<TransactionFilePlan>,
    #[serde(default)]
    pub publications: Vec<TransactionPublicationPlan>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionAppendPlansResponse {
    transaction_id: String,
    file_count: usize,
    publication_count: usize,
}

#[derive(Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransactionFilePlan {
    pub path: String,
    pub operation: String,
    #[serde(default)]
    pub to_path: Option<String>,
    pub expected: ExpectedState,
    #[serde(default)]
    pub output: Option<TransactionBlobRef>,
}

#[derive(Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransactionPublicationPlan {
    pub namespace: String,
    pub key: String,
    pub expected: ExpectedState,
    pub blob_id: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransactionBlobRef {
    pub blob_id: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub modified_at_ms: Option<f64>,
    #[serde(default)]
    pub mode: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionBeginResponse {
    transaction_id: String,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionChunkParams {
    pub lease_token: String,
    pub transaction_id: String,
    pub blob_id: String,
    pub offset: u64,
    #[serde(rename = "dataBase64")]
    pub data_base64: String,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionChunkResponse {
    blob_id: String,
    received_bytes: u64,
    complete: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionCommitParams {
    pub lease_token: String,
    pub transaction_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionCommitResponse {
    transaction_id: String,
    status: String,
    entries: Vec<MutationReceipt>,
    publications: Vec<PublicationReceipt>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublicationReceipt {
    namespace: String,
    key: String,
    sha256: String,
    mtime_ms: f64,
    #[serde(default)]
    previous_exists: bool,
    #[serde(default)]
    previous_sha256: Option<String>,
    #[serde(default)]
    backup_blob: Option<String>,
    #[serde(default)]
    no_op: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionAbortParams {
    pub lease_token: String,
    pub transaction_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionAbortResponse {
    transaction_id: String,
    phase: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeParams {
    pub admission_token: String,
}

fn default_transaction_mode() -> String {
    "metadataOnly".to_owned()
}

struct WorkspaceLock {
    path: PathBuf,
    token: String,
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        let _ = remove_lock_if_owned(&self.path, &self.token);
    }
}

struct PreparedOp {
    operation: MutationOperation,
    path: String,
    new_path: Option<String>,
    staged: Option<PathBuf>,
    bytes: Option<Vec<u8>>,
    modified_at_ms: Option<f64>,
    mode: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalRecord {
    phase: String,
    #[serde(default)]
    entries: Vec<MutationReceipt>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionPlan {
    schema_version: u32,
    transaction_id: String,
    phase: String,
    mode: String,
    owner: WriterOwner,
    files: Vec<TransactionFilePlan>,
    #[serde(default)]
    publications: Vec<TransactionPublicationPlan>,
    #[serde(default)]
    entries: Vec<MutationReceipt>,
    #[serde(default)]
    publication_receipts: Vec<PublicationReceipt>,
    #[serde(default)]
    attention: Option<String>,
}

#[derive(Clone)]
struct DeclaredBlob {
    size: u64,
    sha256: String,
}

impl Mutations {
    pub fn writer_admit(&self, params: AdmitParams) -> Result<AdmitResponse> {
        validate_owner(&params.owner)?;
        if params.intent.trim().is_empty() || params.intent.len() > 128 {
            return Err(CoreError::invalid("Invalid writer intent"));
        }
        let workspace = Workspace::open(&params.workspace_dir)?;
        let root_identity = directory_identity(workspace.root())?;
        validate_external_guard_for_admission(&workspace, &root_identity, &params)?;
        let token = opaque_token("admit");
        let ttl = params.ttl_ms.unwrap_or(30_000).clamp(1_000, 300_000) as f64;
        let expires_at_ms = now_ms() + ttl;
        let admission = Admission {
            canonical_root: workspace.root().to_path_buf(),
            root_identity,
            owner: params.owner,
            intent: params.intent,
            external_token: params.external_token,
            expires_at_ms,
        };
        self.state
            .lock()
            .unwrap()
            .admissions
            .insert(token.clone(), admission);
        Ok(AdmitResponse {
            admission_token: token,
            canonical_root: workspace.root().to_string_lossy().into_owned(),
            expires_at_ms,
        })
    }

    pub fn writer_acquire(&self, params: AcquireParams) -> Result<AcquireResponse> {
        let now = now_ms();
        let admission = {
            let state = self.state.lock().unwrap();
            state
                .admissions
                .get(&params.admission_token)
                .filter(|admission| admission.expires_at_ms > now)
                .cloned()
                .ok_or_else(|| {
                    CoreError::new("NOT_FOUND", "Writer admission is missing or expired")
                })?
        };
        let workspace = open_admission_workspace(&admission)?;
        validate_external_guard_for_acquire(&workspace, &admission)?;
        let tx_root = metadata_dir(&workspace, TX_DIR)?;
        let lock_path = tx_root.join("workspace.lock");
        recover_stale_lock(&lock_path)?;
        let lease_token = opaque_token("lease");
        let lock = create_lock_file(&lock_path, &lease_token)?;
        if !writer_intent_allows_unresolved_transactions(&admission.intent) {
            let attention = recover_unfinished_transactions(&workspace)?;
            if !attention.is_empty() {
                return Err(CoreError::new(
                    "CONFLICT",
                    format!(
                        "Workspace has unresolved transactions requiring attention: {}",
                        attention.join(", ")
                    ),
                ));
            }
        }
        let receipt = LockReceipt {
            pid: std::process::id(),
            token: lease_token.clone(),
            path: lock.path.to_string_lossy().into_owned(),
        };
        self.state.lock().unwrap().leases.insert(
            lease_token.clone(),
            Lease {
                admission_token: params.admission_token,
                canonical_root: admission.canonical_root.clone(),
                root_identity: admission.root_identity.clone(),
                owner: admission.owner.clone(),
                lock_path: lock.path.clone(),
                expires_at_ms: admission.expires_at_ms,
            },
        );
        std::mem::forget(lock);
        Ok(AcquireResponse {
            lease_token,
            canonical_root: admission.canonical_root.to_string_lossy().into_owned(),
            owner: admission.owner,
            lock: receipt,
            expires_at_ms: admission.expires_at_ms,
        })
    }

    pub fn writer_release(&self, params: ReleaseParams) -> Result<ReleaseResponse> {
        let lease = self
            .state
            .lock()
            .unwrap()
            .leases
            .remove(&params.lease_token);
        if let Some(lease) = lease {
            let workspace = open_lease_workspace(&lease)?;
            if has_applying_transaction(&workspace, &lease.owner)? {
                self.state
                    .lock()
                    .unwrap()
                    .leases
                    .insert(params.lease_token, lease);
                return Err(CoreError::new(
                    "CONFLICT",
                    "Writer lease has an applying transaction",
                ));
            }
            let _ = remove_lock_if_owned(&lease.lock_path, &params.lease_token);
            return Ok(ReleaseResponse { released: true });
        }
        Ok(ReleaseResponse { released: false })
    }

    pub fn writer_revoke(&self, params: RevokeParams) -> Result<ReleaseResponse> {
        let mut state = self.state.lock().unwrap();
        let released = state.admissions.contains_key(&params.admission_token);
        let tokens: Vec<_> = state
            .leases
            .iter()
            .filter_map(|(token, lease)| {
                (lease.admission_token == params.admission_token).then_some(token.clone())
            })
            .collect();
        for token in &tokens {
            if let Some(lease) = state.leases.get(token) {
                let workspace = open_lease_workspace(lease)?;
                if has_applying_transaction(&workspace, &lease.owner)? {
                    return Err(CoreError::new(
                        "CONFLICT",
                        "Writer admission has an applying transaction",
                    ));
                }
            }
        }
        for token in tokens {
            if let Some(lease) = state.leases.remove(&token) {
                let _ = remove_lock_if_owned(&lease.lock_path, &token);
            }
        }
        state.admissions.remove(&params.admission_token);
        Ok(ReleaseResponse { released })
    }

    pub fn writer_external_begin(
        &self,
        params: ExternalBeginParams,
    ) -> Result<ExternalBeginResponse> {
        validate_owner(&params.owner)?;
        if params.intent != "external-process" {
            return Err(CoreError::invalid("Invalid external writer intent"));
        }
        let workspace = Workspace::open(&params.workspace_dir)?;
        let root_identity = directory_identity(workspace.root())?;
        let tx_root = metadata_dir(&workspace, TX_DIR)?;
        fs::create_dir_all(&tx_root)?;
        let workspace_lock_path = tx_root.join("workspace.lock");
        recover_stale_lock(&workspace_lock_path)?;
        let guard_token = opaque_token("external-guard");
        let _guard = create_lock_file(&workspace_lock_path, &guard_token)?;
        let lock_path = external_lock_path(&workspace)?;
        recover_stale_external_lock(&lock_path, &root_identity)?;
        if let Some(existing) = read_external_lock(&lock_path)? {
            ensure_persisted_root_identity(&existing, &root_identity)?;
            if existing.owner == params.owner
                && existing.pid == params.owner_pid.unwrap_or_else(std::process::id)
                && existing.intent == params.intent
            {
                self.state.lock().unwrap().external_leases.insert(
                    existing.token.clone(),
                    ExternalLease {
                        canonical_root: workspace.root().to_path_buf(),
                        root_identity,
                        owner: params.owner,
                        lock_path,
                    },
                );
                return Ok(ExternalBeginResponse {
                    external_token: existing.token,
                });
            }
            return Err(CoreError::new("BUSY", "External writer guard is active"));
        }
        let external_token = opaque_token("external");
        create_external_lock_file(
            &lock_path,
            &external_token,
            &params.owner,
            &params.intent,
            params.owner_pid.unwrap_or_else(std::process::id),
            &root_identity,
        )?;
        self.state.lock().unwrap().external_leases.insert(
            external_token.clone(),
            ExternalLease {
                canonical_root: workspace.root().to_path_buf(),
                root_identity,
                owner: params.owner,
                lock_path,
            },
        );
        Ok(ExternalBeginResponse { external_token })
    }

    pub fn writer_external_end(&self, params: ExternalEndParams) -> Result<ReleaseResponse> {
        let lease = self
            .state
            .lock()
            .unwrap()
            .external_leases
            .remove(&params.external_token);
        let lease = match lease {
            Some(lease) => lease,
            None => {
                let Some(workspace_dir) = params.workspace_dir.as_ref() else {
                    return Ok(ReleaseResponse { released: false });
                };
                let workspace = Workspace::open(workspace_dir)?;
                let root_identity = directory_identity(workspace.root())?;
                let lock_path = external_lock_path(&workspace)?;
                let Some(lock) = read_external_lock(&lock_path)? else {
                    return Ok(ReleaseResponse { released: false });
                };
                ensure_persisted_root_identity(&lock, &root_identity)?;
                if lock.token != params.external_token {
                    return Ok(ReleaseResponse { released: false });
                }
                ExternalLease {
                    canonical_root: workspace.root().to_path_buf(),
                    root_identity,
                    owner: lock.owner,
                    lock_path,
                }
            }
        };
        let workspace = Workspace::open(&lease.canonical_root)?;
        ensure_root_identity(workspace.root(), &lease.root_identity)?;
        if has_applying_transaction(&workspace, &lease.owner)? {
            self.state
                .lock()
                .unwrap()
                .external_leases
                .insert(params.external_token, lease);
            return Err(CoreError::new(
                "CONFLICT",
                "External writer owner has an applying transaction",
            ));
        }
        let released = remove_external_lock_if_owned(&lease.lock_path, &params.external_token)?;
        Ok(ReleaseResponse { released })
    }

    pub fn shutdown(&self) {
        let mut state = self.state.lock().unwrap();
        for (token, lease) in state.leases.drain() {
            let _ = remove_lock_if_owned(&lease.lock_path, &token);
        }
        state.admissions.clear();
        state.external_leases.clear();
    }

    pub fn writer_inspect(&self, params: InspectParams) -> Result<InspectResponse> {
        let admission = self.admission(&params.admission_token)?;
        let workspace = open_admission_workspace(&admission)?;
        validate_user_path(&params.path)?;
        let target = workspace_path(&workspace, &params.path, true)?;
        let Ok(metadata) = fs::symlink_metadata(&target) else {
            return Ok(InspectResponse {
                path: params.path,
                exists: false,
                kind: "missing".to_owned(),
                size: 0,
                mtime_ms: 0.0,
                sha256: None,
                bytes_base64: None,
            });
        };
        if metadata.file_type().is_symlink() {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Mutation refuses symbolic links",
            ));
        }
        let kind = if metadata.is_file() {
            "file"
        } else if metadata.is_dir() {
            "directory"
        } else {
            "other"
        };
        let sha256 = metadata
            .is_file()
            .then(|| file_sha256(&target))
            .transpose()?;
        let bytes_base64 = if params.read_bytes {
            let limit = params
                .max_bytes
                .unwrap_or(10 * 1024 * 1024)
                .min(10 * 1024 * 1024);
            if !metadata.is_file() || metadata.len() > limit {
                return Err(CoreError::new(
                    "LIMIT_EXCEEDED",
                    "Inspect byte read exceeds limit",
                ));
            }
            Some(STANDARD.encode(fs::read(&target)?))
        } else {
            None
        };
        Ok(InspectResponse {
            path: params.path,
            exists: true,
            kind: kind.to_owned(),
            size: metadata.len(),
            mtime_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs_f64() * 1000.0)
                .unwrap_or_else(now_ms),
            sha256,
            bytes_base64,
        })
    }

    pub fn transaction_begin(
        &self,
        params: TransactionBeginParams,
    ) -> Result<TransactionBeginResponse> {
        let lease = self.lease(&params.lease_token)?;
        let workspace = open_lease_workspace(&lease)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        if params.files.is_empty() && params.publications.is_empty() {
            return Err(CoreError::invalid(
                "Transaction requires file or publication plans",
            ));
        }
        if params.files.len() > MAX_PLANS_PER_RPC || params.publications.len() > MAX_PLANS_PER_RPC {
            return Err(CoreError::invalid(
                "Transaction begin accepts at most 128 plans",
            ));
        }
        validate_transaction_mode(&params.mode)?;
        for file in &params.files {
            validate_user_path(&file.path)?;
            if let Some(to_path) = &file.to_path {
                validate_user_path(to_path)?;
            }
        }
        for publication in &params.publications {
            validate_publication(publication)?;
        }
        validate_declared_blobs(&params.files, &params.publications)?;
        let tx_root = transaction_root(&workspace, &tx_id)?;
        fs::create_dir_all(tx_root.join("blobs"))?;
        let plan_path = tx_root.join("transaction.json");
        if let Some(plan) = read_transaction_plan(&plan_path)? {
            if !begin_matches_existing_plan(
                &plan,
                &params.mode,
                &lease.owner,
                &params.files,
                &params.publications,
            ) {
                return Err(CoreError::new(
                    "CONFLICT",
                    "Transaction id already has a different plan",
                ));
            }
            return Ok(TransactionBeginResponse {
                transaction_id: plan.transaction_id,
                status: plan.phase,
            });
        }
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: tx_id.clone(),
            phase: "begun".to_owned(),
            mode: params.mode,
            owner: lease.owner,
            files: params.files,
            publications: params.publications,
            entries: Vec::new(),
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&plan_path, &plan)?;
        Ok(TransactionBeginResponse {
            transaction_id: tx_id,
            status: "begun".to_owned(),
        })
    }

    pub fn transaction_append_plans(
        &self,
        params: TransactionAppendPlansParams,
    ) -> Result<TransactionAppendPlansResponse> {
        let lease = self.lease(&params.lease_token)?;
        let workspace = open_lease_workspace(&lease)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        if params.files.len() > MAX_PLANS_PER_RPC || params.publications.len() > MAX_PLANS_PER_RPC {
            return Err(CoreError::invalid("Plan append accepts at most 128 plans"));
        }
        let tx_root = transaction_root(&workspace, &tx_id)?;
        let plan_path = tx_root.join("transaction.json");
        let mut plan = read_transaction_plan(&plan_path)?
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Transaction is missing"))?;
        ensure_plan_owner(&plan, &lease)?;
        if plan.phase != "begun" {
            return Err(CoreError::new(
                "CONFLICT",
                "Transaction plans are already prepared",
            ));
        }
        if plan.files.len() + params.files.len() > 20_000 {
            return Err(CoreError::new(
                "LIMIT_EXCEEDED",
                "Transaction file plan limit exceeded",
            ));
        }
        for file in &params.files {
            validate_user_path(&file.path)?;
            if let Some(to_path) = &file.to_path {
                validate_user_path(to_path)?;
            }
        }
        for publication in &params.publications {
            validate_publication(publication)?;
        }
        let mut combined_files = plan.files.clone();
        combined_files.extend(params.files.clone());
        let mut combined_publications = plan.publications.clone();
        combined_publications.extend(params.publications.clone());
        validate_declared_blobs(&combined_files, &combined_publications)?;
        plan.files.extend(params.files);
        plan.publications.extend(params.publications);
        write_transaction_plan(&plan_path, &plan)?;
        Ok(TransactionAppendPlansResponse {
            transaction_id: tx_id,
            file_count: plan.files.len(),
            publication_count: plan.publications.len(),
        })
    }

    pub fn transaction_chunk(
        &self,
        params: TransactionChunkParams,
    ) -> Result<TransactionChunkResponse> {
        let lease = self.lease(&params.lease_token)?;
        let workspace = open_lease_workspace(&lease)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        validate_blob_id(&params.blob_id)?;
        let tx_root = transaction_root(&workspace, &tx_id)?;
        let plan = read_transaction_plan(&tx_root.join("transaction.json"))?
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Transaction is missing"))?;
        if plan.owner != lease.owner {
            return Err(CoreError::new(
                "CONFLICT",
                "Writer lease does not own this transaction",
            ));
        }
        if plan.phase != "begun" {
            return Err(CoreError::new(
                "CONFLICT",
                "Transaction is not accepting chunks",
            ));
        }
        let declared = declared_blob(&plan, &params.blob_id)
            .ok_or_else(|| CoreError::new("CONFLICT", "Transaction chunk blob is not declared"))?;
        let bytes = STANDARD
            .decode(params.data_base64)
            .map_err(|_| CoreError::invalid("Invalid transaction chunk base64"))?;
        if bytes.len() > 512 * 1024 {
            return Err(CoreError::new(
                "LIMIT_EXCEEDED",
                "Transaction chunks are limited to 512 KiB",
            ));
        }
        let received = params.offset + bytes.len() as u64;
        if received > declared.size {
            return Err(CoreError::new(
                "LIMIT_EXCEEDED",
                "Transaction chunk exceeds declared blob size",
            ));
        }
        if let Some(expected) = &params.sha256 {
            if expected != &declared.sha256 {
                return Err(CoreError::new(
                    "CONFLICT",
                    "Transaction chunk digest does not match declared blob",
                ));
            }
        }
        let blob_path = tx_root.join("blobs").join(&params.blob_id);
        fs::create_dir_all(parent(&blob_path)?)?;
        let current = fs::metadata(&blob_path).map(|meta| meta.len()).unwrap_or(0);
        if blob_path.exists()
            && current >= received
            && blob_contains_at(&blob_path, params.offset, &bytes)?
        {
            return Ok(TransactionChunkResponse {
                blob_id: params.blob_id,
                received_bytes: current,
                complete: current == declared.size && file_sha256(&blob_path)? == declared.sha256,
            });
        }
        if current != params.offset {
            return Err(CoreError::new(
                "CONFLICT",
                "Transaction chunk offset is not continuous",
            ));
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&blob_path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        sync_parent(&blob_path)?;
        let complete = if received == declared.size {
            if file_sha256(&blob_path)? != declared.sha256 {
                return Err(CoreError::new(
                    "CONFLICT",
                    "Transaction output blob digest mismatch",
                ));
            }
            true
        } else {
            false
        };
        Ok(TransactionChunkResponse {
            blob_id: params.blob_id,
            received_bytes: received,
            complete,
        })
    }

    pub fn transaction_commit(
        &self,
        params: TransactionCommitParams,
    ) -> Result<TransactionCommitResponse> {
        let lease = self.lease(&params.lease_token)?;
        let workspace = open_lease_workspace(&lease)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        let tx_root = transaction_root(&workspace, &tx_id)?;
        let plan_path = tx_root.join("transaction.json");
        let mut plan = read_transaction_plan(&plan_path)?
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Transaction is missing"))?;
        ensure_plan_owner(&plan, &lease)?;
        if matches!(plan.phase.as_str(), "committed" | "rolled_back") {
            cleanup_terminal_payloads(&tx_root)?;
            return Ok(TransactionCommitResponse {
                transaction_id: plan.transaction_id,
                status: plan.phase,
                entries: plan.entries,
                publications: plan.publication_receipts,
            });
        }
        if plan.phase == "needs_attention" {
            return Ok(TransactionCommitResponse {
                transaction_id: plan.transaction_id,
                status: plan.phase,
                entries: plan.entries,
                publications: plan.publication_receipts,
            });
        }
        if plan.phase != "committing" {
            let result = self.commit_plan(&workspace, &tx_root, &mut plan);
            if let Err(error) = result {
                plan.attention = Some(error.to_string());
                if plan.phase == "committing" {
                    plan.phase = "needs_attention".to_owned();
                    write_transaction_plan(&plan_path, &plan)?;
                } else {
                    let rollback = rollback_transaction_plan(&workspace, &tx_root, &mut plan);
                    match rollback {
                        Ok(()) => {
                            plan.phase = "rolled_back".to_owned();
                        }
                        Err(rollback_error) => {
                            plan.phase = "needs_attention".to_owned();
                            plan.attention = Some(format!("{error}; rollback: {rollback_error}"));
                        }
                    }
                    write_transaction_plan(&plan_path, &plan)?;
                    if plan.phase == "rolled_back" {
                        cleanup_terminal_payloads(&tx_root)?;
                    }
                }
                return Ok(TransactionCommitResponse {
                    transaction_id: plan.transaction_id,
                    status: plan.phase,
                    entries: plan.entries,
                    publications: plan.publication_receipts,
                });
            }
        }
        plan.phase = "committed".to_owned();
        write_transaction_plan(&plan_path, &plan)?;
        cleanup_terminal_payloads(&tx_root)?;
        Ok(TransactionCommitResponse {
            transaction_id: plan.transaction_id,
            status: plan.phase,
            entries: plan.entries,
            publications: plan.publication_receipts,
        })
    }

    pub fn transaction_abort(
        &self,
        params: TransactionAbortParams,
    ) -> Result<TransactionAbortResponse> {
        let lease = self.lease(&params.lease_token)?;
        let workspace = open_lease_workspace(&lease)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        let tx_root = transaction_root(&workspace, &tx_id)?;
        let plan_path = tx_root.join("transaction.json");
        let mut plan = read_transaction_plan(&plan_path)?
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Transaction is missing"))?;
        ensure_plan_owner(&plan, &lease)?;
        if matches!(plan.phase.as_str(), "begun" | "prepared") {
            plan.phase = "aborted".to_owned();
            write_transaction_plan(&plan_path, &plan)?;
            cleanup_terminal_payloads(&tx_root)?;
        } else if matches!(plan.phase.as_str(), "applying" | "needs_attention") {
            write_transaction_plan(&plan_path, &plan)?;
        }
        Ok(TransactionAbortResponse {
            transaction_id: tx_id,
            phase: plan.phase,
        })
    }

    pub fn mutate(&self, params: MutateParams) -> Result<MutateResponse> {
        if params.operations.is_empty() || params.operations.len() > MAX_OPERATIONS {
            return Err(CoreError::invalid(
                "Mutation requires 1 to 20000 operations",
            ));
        }
        let workspace = Workspace::open(&params.workspace_dir)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        let tx_root = metadata_dir(&workspace, TX_DIR)?;
        let _guard = self.acquire(&workspace, &tx_root)?;
        fs::create_dir_all(&tx_root)?;
        let tx_file = tx_root.join(format!("{tx_id}.json"));
        if let Some(previous) = read_wal(&tx_file)? {
            return Ok(MutateResponse {
                transaction_id: tx_id,
                status: previous.phase,
                entries: previous.entries,
            });
        }
        let mut prepared = Vec::new();
        for operation in params.operations {
            prepared.push(prepare_operation(&workspace, operation)?);
        }
        write_wal(&tx_file, &tx_id, "prepared", &prepared, &[])?;
        let mut staged_paths = Vec::new();
        for op in &mut prepared {
            if let Some(bytes) = &op.bytes {
                match write_workspace::stage_file(workspace.root(), &op.path, bytes, None, None) {
                    Ok(staged) => {
                        staged_paths.push(staged.clone());
                        op.staged = Some(staged);
                    }
                    Err(error) => {
                        cleanup_staged(&staged_paths);
                        return Err(error);
                    }
                }
            }
        }
        write_wal(&tx_file, &tx_id, "applying", &prepared, &[])?;
        let mut receipts = Vec::new();
        for op in &prepared {
            apply_operation(&workspace, op, &mut receipts)?;
        }
        write_wal(&tx_file, &tx_id, "committed", &prepared, &receipts)?;
        Ok(MutateResponse {
            transaction_id: tx_id,
            status: "committed".to_owned(),
            entries: receipts,
        })
    }

    pub fn status(&self, params: StatusParams) -> Result<StatusResponse> {
        let workspace = Workspace::open(&params.workspace_dir)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        let plan_path = transaction_root(&workspace, &tx_id)?.join("transaction.json");
        if let Some(plan) = read_transaction_plan(&plan_path)? {
            return Ok(StatusResponse {
                transaction_id: tx_id,
                status: plan.phase,
                entries: plan.entries,
                publications: plan.publication_receipts,
            });
        }
        let tx_file = metadata_dir(&workspace, TX_DIR)?.join(format!("{tx_id}.json"));
        let wal = read_wal(&tx_file)?;
        Ok(StatusResponse {
            transaction_id: tx_id,
            status: wal
                .as_ref()
                .map(|value| value.phase.clone())
                .unwrap_or_else(|| "missing".to_owned()),
            entries: wal.map(|value| value.entries).unwrap_or_default(),
            publications: Vec::new(),
        })
    }

    pub fn recover(&self, params: StatusParams) -> Result<StatusResponse> {
        let workspace = Workspace::open(&params.workspace_dir)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        let tx_root = transaction_root(&workspace, &tx_id)?;
        let plan_path = tx_root.join("transaction.json");
        let Some(mut plan) = read_transaction_plan(&plan_path)? else {
            return self.status(params);
        };
        if plan.phase == "committing" {
            plan.phase = "needs_attention".to_owned();
            plan.attention = Some(
                "Transaction completed side effects but the final commit marker is missing"
                    .to_owned(),
            );
            write_transaction_plan(&plan_path, &plan)?;
        } else if matches!(plan.phase.as_str(), "applying" | "needs_attention") {
            match rollback_transaction_plan(&workspace, &tx_root, &mut plan) {
                Ok(()) => {
                    plan.phase = "rolled_back".to_owned();
                    write_transaction_plan(&plan_path, &plan)?;
                    cleanup_terminal_payloads(&tx_root)?;
                }
                Err(error) => {
                    plan.phase = "needs_attention".to_owned();
                    plan.attention = Some(error.to_string());
                    write_transaction_plan(&plan_path, &plan)?;
                }
            }
        } else if matches!(plan.phase.as_str(), "committed" | "rolled_back" | "aborted") {
            cleanup_terminal_payloads(&tx_root)?;
        }
        Ok(StatusResponse {
            transaction_id: tx_id,
            status: plan.phase,
            entries: plan.entries,
            publications: plan.publication_receipts,
        })
    }

    fn acquire(&self, workspace: &Workspace, tx_root: &Path) -> Result<WorkspaceLock> {
        let lock_path = tx_root.join("workspace.lock");
        let _ = workspace;
        let token = opaque_token("lock");
        create_lock_file(&lock_path, &token)
    }

    fn admission(&self, token: &str) -> Result<Admission> {
        let now = now_ms();
        self.state
            .lock()
            .unwrap()
            .admissions
            .get(token)
            .filter(|admission| admission.expires_at_ms > now)
            .cloned()
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Writer admission is missing or expired"))
    }

    fn lease(&self, token: &str) -> Result<Lease> {
        self.state
            .lock()
            .unwrap()
            .leases
            .get(token)
            .cloned()
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Writer lease is missing"))
    }

    fn commit_plan(
        &self,
        workspace: &Workspace,
        tx_root: &Path,
        plan: &mut TransactionPlan,
    ) -> Result<()> {
        plan.phase = "prepared".to_owned();
        write_transaction_plan(&tx_root.join("transaction.json"), plan)?;
        validate_transaction_publications(workspace, tx_root, &plan.publications)?;
        let mut prepared = Vec::new();
        for file in &plan.files {
            check_expected(workspace, &file.path, Some(&file.expected))?;
            let op = transaction_file_to_operation(tx_root, file)?;
            let mut prepared_op = prepare_operation(workspace, op)?;
            if let Some(output) = &file.output {
                prepared_op.modified_at_ms = output.modified_at_ms;
                prepared_op.mode = output.mode;
            }
            prepared.push(prepared_op);
        }
        backup_private_preimages(workspace, tx_root, plan)?;
        let mut staged_paths = Vec::new();
        for op in &mut prepared {
            if let Some(bytes) = &op.bytes {
                match write_workspace::stage_file(
                    workspace.root(),
                    &op.path,
                    bytes,
                    op.mode,
                    op.modified_at_ms,
                ) {
                    Ok(staged) => {
                        staged_paths.push(staged.clone());
                        op.staged = Some(staged);
                    }
                    Err(error) => {
                        cleanup_staged(&staged_paths);
                        return Err(error);
                    }
                }
            }
        }
        plan.phase = "applying".to_owned();
        write_transaction_plan(&tx_root.join("transaction.json"), plan)?;
        plan.entries.clear();
        for op in &prepared {
            let before = plan.entries.len();
            apply_operation(workspace, op, &mut plan.entries)?;
            if plan.entries.len() != before {
                write_transaction_plan(&tx_root.join("transaction.json"), plan)?;
            }
        }
        publish_transaction_metadata(workspace, tx_root, plan)?;
        plan.phase = "committing".to_owned();
        write_transaction_plan(&tx_root.join("transaction.json"), plan)?;
        Ok(())
    }
}

fn validate_external_guard_for_admission(
    workspace: &Workspace,
    root_identity: &FileIdentity,
    params: &AdmitParams,
) -> Result<()> {
    let lock_path = external_lock_path(workspace)?;
    recover_stale_external_lock(&lock_path, root_identity)?;
    let Some(lock) = read_external_lock(&lock_path)? else {
        return Ok(());
    };
    ensure_persisted_root_identity(&lock, root_identity)?;
    if params.intent == "external-audit" {
        let Some(token) = &params.external_token else {
            return Err(CoreError::new(
                "BUSY",
                "External audit requires the active external token",
            ));
        };
        if lock.token == *token && lock.owner == params.owner {
            return Ok(());
        }
        return Err(CoreError::new(
            "BUSY",
            "External audit is not owned by the active external writer",
        ));
    }
    if external_guard_permits_intent(&params.intent) {
        return Ok(());
    }
    Err(CoreError::new("BUSY", "External writer guard is active"))
}

fn validate_external_guard_for_acquire(workspace: &Workspace, admission: &Admission) -> Result<()> {
    if admission.intent != "external-audit" {
        return Ok(());
    }
    let token = admission.external_token.as_deref().ok_or_else(|| {
        CoreError::new("BUSY", "External audit requires the active external token")
    })?;
    let lock_path = external_lock_path(workspace)?;
    recover_stale_external_lock(&lock_path, &admission.root_identity)?;
    let lock = read_external_lock(&lock_path)?
        .ok_or_else(|| CoreError::new("BUSY", "External writer guard is missing"))?;
    ensure_persisted_root_identity(&lock, &admission.root_identity)?;
    if lock.token == token && lock.owner == admission.owner {
        Ok(())
    } else {
        Err(CoreError::new(
            "BUSY",
            "External audit is not owned by the active external writer",
        ))
    }
}

fn external_guard_permits_intent(intent: &str) -> bool {
    matches!(
        intent,
        "user-save"
            | "editor"
            | "editor-save"
            | "human-editor"
            | "index"
            | "indexing"
            | "repository-index"
            | "native-index"
    )
}

fn external_lock_path(workspace: &Workspace) -> Result<PathBuf> {
    Ok(metadata_dir(workspace, TX_DIR)?.join(EXTERNAL_LOCK_FILE))
}

fn create_external_lock_file(
    path: &Path,
    token: &str,
    owner: &WriterOwner,
    intent: &str,
    owner_pid: u32,
    root_identity: &FileIdentity,
) -> Result<()> {
    fs::create_dir_all(parent(path)?)?;
    let lock = ExternalLockFile {
        pid: owner_pid,
        token: token.to_owned(),
        owner: owner.clone(),
        intent: intent.to_owned(),
        root_identity: persisted_identity(root_identity),
        created_at_ms: now_ms(),
    };
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(CoreError::new("BUSY", "External writer guard is active"));
        }
        Err(error) => return Err(error.into()),
    };
    file.write_all(serde_json::to_string(&lock)?.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    sync_parent(path)?;
    Ok(())
}

fn read_external_lock(path: &Path) -> Result<Option<ExternalLockFile>> {
    let value = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    serde_json::from_str(&value)
        .map(Some)
        .map_err(|_| CoreError::new("BUSY", "External writer guard is not recoverable"))
}

fn recover_stale_external_lock(path: &Path, root_identity: &FileIdentity) -> Result<()> {
    let Some(lock) = read_external_lock(path)? else {
        return Ok(());
    };
    ensure_persisted_root_identity(&lock, root_identity)?;
    if lock.pid != 0 && !process_alive(lock.pid) {
        fs::remove_file(path)?;
        sync_parent(path)?;
    }
    Ok(())
}

fn remove_external_lock_if_owned(path: &Path, token: &str) -> Result<bool> {
    let Some(lock) = read_external_lock(path)? else {
        return Ok(false);
    };
    if lock.token != token {
        return Ok(false);
    }
    fs::remove_file(path)?;
    sync_parent(path)?;
    Ok(true)
}

fn ensure_persisted_root_identity(lock: &ExternalLockFile, expected: &FileIdentity) -> Result<()> {
    if lock.root_identity != persisted_identity(expected) {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "External writer guard root identity changed",
        ));
    }
    Ok(())
}

fn persisted_identity(identity: &FileIdentity) -> PersistedFileIdentity {
    PersistedFileIdentity {
        volume: identity.volume,
        index: identity.index,
    }
}

fn open_admission_workspace(admission: &Admission) -> Result<Workspace> {
    let workspace = Workspace::open(&admission.canonical_root)?;
    ensure_root_identity(workspace.root(), &admission.root_identity)?;
    Ok(workspace)
}

fn open_lease_workspace(lease: &Lease) -> Result<Workspace> {
    let workspace = Workspace::open(&lease.canonical_root)?;
    ensure_root_identity(workspace.root(), &lease.root_identity)?;
    Ok(workspace)
}

fn ensure_root_identity(root: &Path, expected: &FileIdentity) -> Result<()> {
    let actual = directory_identity(root)?;
    if &actual != expected {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Workspace root identity changed",
        ));
    }
    Ok(())
}

fn ensure_plan_owner(plan: &TransactionPlan, lease: &Lease) -> Result<()> {
    if plan.owner != lease.owner {
        return Err(CoreError::new(
            "CONFLICT",
            "Writer lease does not own this transaction",
        ));
    }
    Ok(())
}

fn cleanup_terminal_payloads(tx_root: &Path) -> Result<()> {
    remove_dir_if_exists(&tx_root.join("blobs"))?;
    remove_dir_if_exists(&tx_root.join("backups"))?;
    Ok(())
}

fn remove_dir_if_exists(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => {
            sync_parent(path)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn cleanup_staged(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

fn writer_intent_allows_unresolved_transactions(intent: &str) -> bool {
    matches!(
        intent,
        "editor" | "user-save" | "index" | "repository-index" | "native-index"
    )
}

struct TerminalTransactionReceipt {
    transaction_id: String,
    path: PathBuf,
    modified_ms: f64,
}

fn recover_unfinished_transactions(workspace: &Workspace) -> Result<Vec<String>> {
    let tx_root = metadata_dir(workspace, TX_DIR)?;
    let entries = match fs::read_dir(&tx_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut attention = Vec::new();
    let mut terminal = Vec::new();
    for entry in entries {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Transaction metadata path contains a symbolic link",
            ));
        }
        if !metadata.is_dir() {
            continue;
        }
        let tx_root = entry.path();
        let plan_path = tx_root.join("transaction.json");
        let Some(mut plan) = read_transaction_plan(&plan_path)? else {
            continue;
        };
        match plan.phase.as_str() {
            "applying" => match rollback_transaction_plan(workspace, &tx_root, &mut plan) {
                Ok(()) => {
                    plan.phase = "rolled_back".to_owned();
                    write_transaction_plan(&plan_path, &plan)?;
                    cleanup_terminal_payloads(&tx_root)?;
                    terminal.push(terminal_receipt(&tx_root, &plan)?);
                }
                Err(error) => {
                    plan.phase = "needs_attention".to_owned();
                    plan.attention = Some(error.to_string());
                    write_transaction_plan(&plan_path, &plan)?;
                    attention.push(plan.transaction_id.clone());
                }
            },
            "committing" => {
                plan.phase = "needs_attention".to_owned();
                plan.attention = Some(
                    "Transaction completed side effects but the final commit marker is missing"
                        .to_owned(),
                );
                write_transaction_plan(&plan_path, &plan)?;
                attention.push(plan.transaction_id.clone());
            }
            "needs_attention" => attention.push(plan.transaction_id.clone()),
            "committed" | "rolled_back" | "aborted" => {
                cleanup_terminal_payloads(&tx_root)?;
                terminal.push(terminal_receipt(&tx_root, &plan)?);
            }
            _ => {}
        }
    }
    prune_terminal_transaction_receipts(terminal)?;
    attention.sort();
    attention.dedup();
    Ok(attention)
}

fn terminal_receipt(tx_root: &Path, plan: &TransactionPlan) -> Result<TerminalTransactionReceipt> {
    let dir_metadata = fs::symlink_metadata(tx_root)?;
    if dir_metadata.file_type().is_symlink() || !dir_metadata.is_dir() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Transaction metadata path contains a symbolic link",
        ));
    }
    let plan_metadata = fs::symlink_metadata(tx_root.join("transaction.json"))?;
    if plan_metadata.file_type().is_symlink() || !plan_metadata.is_file() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Transaction receipt is not a regular metadata file",
        ));
    }
    Ok(TerminalTransactionReceipt {
        transaction_id: plan.transaction_id.clone(),
        path: tx_root.to_path_buf(),
        modified_ms: plan_metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs_f64() * 1000.0)
            .unwrap_or_else(now_ms),
    })
}

fn prune_terminal_transaction_receipts(
    mut receipts: Vec<TerminalTransactionReceipt>,
) -> Result<()> {
    if receipts.len() <= TERMINAL_TRANSACTION_RECEIPT_LIMIT {
        return Ok(());
    }
    receipts.sort_by(|a, b| {
        a.modified_ms
            .partial_cmp(&b.modified_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.transaction_id.cmp(&b.transaction_id))
    });
    let prune_count = receipts.len() - TERMINAL_TRANSACTION_RECEIPT_LIMIT;
    for receipt in receipts.into_iter().take(prune_count) {
        remove_terminal_transaction_receipt(&receipt.path)?;
    }
    Ok(())
}

fn remove_terminal_transaction_receipt(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Transaction metadata path contains a symbolic link",
        ));
    }
    fs::remove_dir_all(path)?;
    sync_parent(path)?;
    Ok(())
}

fn create_lock_file(path: &Path, token: &str) -> Result<WorkspaceLock> {
    fs::create_dir_all(parent(path)?)?;
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(CoreError::new("BUSY", "Workspace writer is busy"));
        }
        Err(error) => return Err(error.into()),
    };
    let owner =
        serde_json::json!({ "pid": std::process::id(), "token": token, "createdAt": now_ms() });
    file.write_all(owner.to_string().as_bytes())?;
    file.sync_all()?;
    sync_parent(path)?;
    Ok(WorkspaceLock {
        path: path.to_path_buf(),
        token: token.to_owned(),
    })
}

fn remove_lock_if_owned(path: &Path, token: &str) -> Result<bool> {
    let value = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let owned = serde_json::from_str::<serde_json::Value>(&value)
        .ok()
        .and_then(|value| {
            value
                .get("token")
                .and_then(|token| token.as_str())
                .map(str::to_owned)
        })
        .as_deref()
        == Some(token);
    if !owned {
        return Ok(false);
    }
    fs::remove_file(path)?;
    sync_parent(path)?;
    Ok(true)
}

fn recover_stale_lock(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let value = fs::read_to_string(path).unwrap_or_default();
    let pid = serde_json::from_str::<serde_json::Value>(&value)
        .ok()
        .and_then(|value| value.get("pid").and_then(|pid| pid.as_u64()))
        .unwrap_or(0) as u32;
    if pid != 0 && !process_alive(pid) {
        let _ = fs::remove_file(path);
        sync_parent(path)?;
    }
    Ok(())
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // SAFETY: kill(pid, 0) does not send a signal; it only checks process visibility.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use std::ffi::c_void;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    const ERROR_ACCESS_DENIED: u32 = 5;
    const ERROR_INVALID_PARAMETER: u32 = 87;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut c_void;
        fn GetExitCodeProcess(handle: *mut c_void, exit_code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }

    // SAFETY: the Windows APIs are called with documented constants and valid output storage.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return match GetLastError() {
                ERROR_INVALID_PARAMETER => false,
                ERROR_ACCESS_DENIED => true,
                _ => true,
            };
        }
        let mut exit_code = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code) != 0;
        let error = if ok { 0 } else { GetLastError() };
        CloseHandle(handle);
        if ok {
            exit_code == STILL_ACTIVE
        } else {
            error != ERROR_INVALID_PARAMETER
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn process_alive(_pid: u32) -> bool {
    false
}

fn transaction_file_to_operation(
    tx_root: &Path,
    file: &TransactionFilePlan,
) -> Result<MutationOperation> {
    match file.operation.as_str() {
        "write" => {
            let output = file
                .output
                .as_ref()
                .ok_or_else(|| CoreError::invalid("Write transaction file is missing output"))?;
            validate_blob_id(&output.blob_id)?;
            let blob = tx_root.join("blobs").join(&output.blob_id);
            if fs::metadata(&blob)?.len() != output.size || file_sha256(&blob)? != output.sha256 {
                return Err(CoreError::new(
                    "CONFLICT",
                    "Transaction output blob digest mismatch",
                ));
            }
            Ok(MutationOperation::WriteFile {
                path: file.path.clone(),
                content: String::new(),
                content_base64: STANDARD.encode(fs::read(blob)?),
                expected: Some(file.expected.clone()),
                overwrite: true,
            })
        }
        "delete" => Ok(MutationOperation::Delete {
            path: file.path.clone(),
            recursive: false,
        }),
        "deleteTree" => Ok(MutationOperation::Delete {
            path: file.path.clone(),
            recursive: true,
        }),
        "mkdir" => Ok(MutationOperation::Mkdir {
            path: file.path.clone(),
            recursive: true,
        }),
        "rename" | "moveTree" => Ok(MutationOperation::Rename {
            path: file.path.clone(),
            new_path: file
                .to_path
                .clone()
                .ok_or_else(|| CoreError::invalid("Rename transaction file is missing toPath"))?,
        }),
        "copyTree" => Ok(MutationOperation::Copy {
            path: file.path.clone(),
            new_path: file
                .to_path
                .clone()
                .ok_or_else(|| CoreError::invalid("Copy transaction file is missing toPath"))?,
        }),
        _ => Err(CoreError::invalid("Unsupported transaction file operation")),
    }
}

fn publish_transaction_metadata(
    workspace: &Workspace,
    tx_root: &Path,
    plan: &mut TransactionPlan,
) -> Result<()> {
    validate_transaction_publications(workspace, tx_root, &plan.publications)?;
    plan.publication_receipts.clear();
    let plan_path = tx_root.join("transaction.json");
    for publication in plan.publications.clone() {
        let relative = publication_relative(&publication)?;
        let target = metadata_dir(workspace, &relative)?;
        let blob = tx_root.join("blobs").join(&publication.blob_id);
        let bytes = fs::read(&blob)?;
        let before_sha256 = if target.exists() {
            let metadata = fs::symlink_metadata(&target)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(CoreError::new(
                    "PATH_ESCAPE",
                    "Metadata publication target is not a regular file",
                ));
            }
            Some(file_sha256(&target)?)
        } else {
            None
        };
        let previous_exists = before_sha256.is_some();
        if before_sha256.as_deref() == Some(publication.sha256.as_str()) {
            plan.publication_receipts.push(PublicationReceipt {
                namespace: publication.namespace.clone(),
                key: publication.key.clone(),
                sha256: publication.sha256.clone(),
                mtime_ms: publication_mtime_ms(&target)?,
                previous_exists,
                previous_sha256: before_sha256,
                backup_blob: None,
                no_op: true,
            });
            write_transaction_plan(&plan_path, plan)?;
            continue;
        }
        let backup_blob = if previous_exists {
            Some(backup_publication_preimage(
                tx_root,
                &target,
                plan.publication_receipts.len(),
            )?)
        } else {
            None
        };
        let staged = write_workspace::stage_file(workspace.root(), &relative, &bytes, None, None)?;
        write_workspace::install_file(
            workspace.root(),
            &relative,
            &staged,
            publication.expected.exists == Some(false),
        )?;
        plan.publication_receipts.push(PublicationReceipt {
            namespace: publication.namespace.clone(),
            key: publication.key.clone(),
            sha256: file_sha256(&target)?,
            mtime_ms: publication_mtime_ms(&target)?,
            previous_exists,
            previous_sha256: before_sha256,
            backup_blob,
            no_op: false,
        });
        write_transaction_plan(&plan_path, plan)?;
    }
    Ok(())
}

fn publication_mtime_ms(target: &Path) -> Result<f64> {
    Ok(fs::metadata(target)?
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or_else(now_ms))
}

fn backup_publication_preimage(tx_root: &Path, target: &Path, index: usize) -> Result<String> {
    let backup_blob = format!("publication-{index}.bin");
    let backup = tx_root.join("backups").join(&backup_blob);
    fs::create_dir_all(parent(&backup)?)?;
    fs::copy(target, &backup)?;
    sync_file(&backup)?;
    sync_parent(&backup)?;
    Ok(backup_blob)
}

fn validate_transaction_publications(
    workspace: &Workspace,
    tx_root: &Path,
    publications: &[TransactionPublicationPlan],
) -> Result<()> {
    for publication in publications {
        validate_publication(publication)?;
        let current = publication_expected(workspace, publication)?;
        if publication
            .expected
            .exists
            .is_some_and(|expected| current.exists != expected)
            || publication
                .expected
                .file
                .is_some_and(|expected| expected != (current.kind == "file"))
            || publication
                .expected
                .directory
                .is_some_and(|expected| expected != (current.kind == "directory"))
            || publication
                .expected
                .sha256
                .as_ref()
                .is_some_and(|expected| current.sha256.as_deref() != Some(expected))
        {
            return Err(CoreError::new("CONFLICT", "Metadata publication changed"));
        }
        let blob = tx_root.join("blobs").join(&publication.blob_id);
        if fs::metadata(&blob)?.len() != publication.size
            || file_sha256(&blob)? != publication.sha256
        {
            return Err(CoreError::new(
                "CONFLICT",
                "Metadata publication blob digest mismatch",
            ));
        }
    }
    Ok(())
}

fn backup_private_preimages(
    workspace: &Workspace,
    tx_root: &Path,
    plan: &TransactionPlan,
) -> Result<()> {
    if plan.mode != "privateBackup" {
        return Ok(());
    }
    let backup_root = tx_root.join("backups");
    fs::create_dir_all(&backup_root)?;
    for (index, file) in plan.files.iter().enumerate() {
        if matches!(file.operation.as_str(), "write" | "delete")
            && file.expected.exists == Some(true)
        {
            let source = workspace_path(workspace, &file.path, false)?;
            if fs::metadata(&source)?.is_file() {
                let target = backup_root.join(format!("{index}.bin"));
                if !target.exists() {
                    fs::copy(&source, &target)?;
                    sync_file(&target)?;
                    sync_parent(&target)?;
                }
            }
        }
    }
    Ok(())
}

fn rollback_transaction_plan(
    workspace: &Workspace,
    tx_root: &Path,
    plan: &mut TransactionPlan,
) -> Result<()> {
    if matches!(plan.phase.as_str(), "applying" | "needs_attention") {
        validate_unrecorded_plans_before_rollback(workspace, plan)?;
    }
    for entry in plan.entries.clone().into_iter().rev() {
        let file = plan
            .files
            .iter()
            .find(|file| {
                file.path == entry.path || file.to_path.as_deref() == Some(entry.path.as_str())
            })
            .ok_or_else(|| {
                CoreError::new(
                    "NEEDS_ATTENTION",
                    "Receipt is missing its transaction file plan",
                )
            })?;
        match file.operation.as_str() {
            "write" => rollback_write(workspace, tx_root, plan, file, &entry)?,
            "rename" | "moveTree" => rollback_rename(workspace, file, &entry)?,
            "mkdir" => rollback_created_entry(workspace, &entry, true)?,
            "copyTree" => rollback_created_entry(workspace, &entry, false)?,
            "delete" | "deleteTree" => rollback_delete(workspace, tx_root, plan, file)?,
            _ => {
                return Err(CoreError::new(
                    "NEEDS_ATTENTION",
                    "Unsupported rollback operation",
                ))
            }
        }
    }
    rollback_publications(workspace, tx_root, plan)?;
    Ok(())
}

fn validate_unrecorded_plans_before_rollback(
    workspace: &Workspace,
    plan: &TransactionPlan,
) -> Result<()> {
    for file in &plan.files {
        if file_plan_has_receipt(file, &plan.entries) {
            continue;
        }
        validate_unrecorded_file_before_rollback(workspace, file)?;
    }
    for publication in &plan.publications {
        if plan.publication_receipts.iter().any(|receipt| {
            receipt.namespace == publication.namespace && receipt.key == publication.key
        }) {
            continue;
        }
        validate_unrecorded_publication_before_rollback(workspace, publication)?;
    }
    Ok(())
}

fn file_plan_has_receipt(file: &TransactionFilePlan, entries: &[MutationReceipt]) -> bool {
    entries.iter().any(|entry| {
        entry.path == file.path
            || file.to_path.as_deref() == Some(entry.path.as_str())
            || entry.previous_path.as_deref() == Some(file.path.as_str())
    })
}

fn validate_unrecorded_file_before_rollback(
    workspace: &Workspace,
    file: &TransactionFilePlan,
) -> Result<()> {
    match file.operation.as_str() {
        "rename" | "moveTree" => {
            check_unrecorded_expected(workspace, &file.path, &file.expected, "file")?;
            let target = file.to_path.as_ref().ok_or_else(|| {
                CoreError::new(
                    "NEEDS_ATTENTION",
                    "Unrecorded rename plan is missing its target",
                )
            })?;
            let target_path = workspace_path(workspace, target, true)?;
            if target_path.exists() {
                return Err(unrecorded_changed_error("rename target"));
            }
        }
        "copyTree" => {
            check_unrecorded_expected(workspace, &file.path, &file.expected, "file")?;
            let target = file.to_path.as_ref().ok_or_else(|| {
                CoreError::new(
                    "NEEDS_ATTENTION",
                    "Unrecorded copy plan is missing its target",
                )
            })?;
            let target_path = workspace_path(workspace, target, true)?;
            if target_path.exists() {
                return Err(unrecorded_changed_error("copy target"));
            }
        }
        "mkdir" => {
            if file.expected.exists == Some(true) {
                check_unrecorded_expected(workspace, &file.path, &file.expected, "directory")?;
            } else {
                let target = workspace_path(workspace, &file.path, true)?;
                if target.exists() {
                    return Err(unrecorded_changed_error("directory"));
                }
                check_unrecorded_expected(workspace, &file.path, &file.expected, "directory")?;
            }
        }
        "write" | "delete" | "deleteTree" => {
            check_unrecorded_expected(workspace, &file.path, &file.expected, "file")?;
        }
        _ => return Err(CoreError::invalid("Unsupported transaction file operation")),
    }
    Ok(())
}

fn validate_unrecorded_publication_before_rollback(
    workspace: &Workspace,
    publication: &TransactionPublicationPlan,
) -> Result<()> {
    validate_publication(publication).map_err(|_| unrecorded_changed_error("publication"))?;
    let current = publication_expected(workspace, publication)
        .map_err(|_| unrecorded_changed_error("publication"))?;
    if publication
        .expected
        .exists
        .is_some_and(|expected| current.exists != expected)
        || publication
            .expected
            .file
            .is_some_and(|expected| expected != (current.kind == "file"))
        || publication
            .expected
            .directory
            .is_some_and(|expected| expected != (current.kind == "directory"))
        || publication
            .expected
            .sha256
            .as_ref()
            .is_some_and(|expected| current.sha256.as_deref() != Some(expected))
    {
        return Err(unrecorded_changed_error("publication"));
    }
    Ok(())
}

fn check_unrecorded_expected(
    workspace: &Workspace,
    path: &str,
    expected: &ExpectedState,
    label: &str,
) -> Result<()> {
    check_expected(workspace, path, Some(expected)).map_err(|_| unrecorded_changed_error(label))
}

fn unrecorded_changed_error(label: &str) -> CoreError {
    CoreError::new(
        "NEEDS_ATTENTION",
        format!("Unrecorded transaction {label} changed before rollback"),
    )
}

fn rollback_write(
    workspace: &Workspace,
    tx_root: &Path,
    plan: &TransactionPlan,
    file: &TransactionFilePlan,
    entry: &MutationReceipt,
) -> Result<()> {
    let target = workspace_path(workspace, &entry.path, false)?;
    ensure_current_receipt_matches(&target, entry)?;
    if file.expected.exists == Some(false) {
        fs::remove_file(&target)?;
        sync_parent(&target)?;
        return Ok(());
    }
    if plan.mode == "privateBackup" {
        let Some(index) = plan
            .files
            .iter()
            .position(|candidate| candidate.path == file.path)
        else {
            return Err(CoreError::new(
                "NEEDS_ATTENTION",
                "Missing private backup index",
            ));
        };
        let backup = tx_root.join("backups").join(format!("{index}.bin"));
        if backup.exists() {
            fs::copy(&backup, &target)?;
            sync_parent(&target)?;
            return Ok(());
        }
    }
    Err(CoreError::new(
        "NEEDS_ATTENTION",
        "Metadata-only overwrite cannot be rolled back without private backup",
    ))
}

fn rollback_delete(
    workspace: &Workspace,
    tx_root: &Path,
    plan: &TransactionPlan,
    file: &TransactionFilePlan,
) -> Result<()> {
    if plan.mode != "privateBackup" {
        return Err(CoreError::new(
            "NEEDS_ATTENTION",
            "Metadata-only delete cannot be rolled back without private backup",
        ));
    }
    let Some(index) = plan
        .files
        .iter()
        .position(|candidate| candidate.path == file.path)
    else {
        return Err(CoreError::new(
            "NEEDS_ATTENTION",
            "Missing private backup index",
        ));
    };
    let backup = tx_root.join("backups").join(format!("{index}.bin"));
    if !backup.exists() {
        return Err(CoreError::new("NEEDS_ATTENTION", "Missing private backup"));
    }
    let target = workspace_path(workspace, &file.path, true)?;
    if target.exists() {
        return Err(CoreError::new(
            "NEEDS_ATTENTION",
            "Delete target was recreated externally",
        ));
    }
    fs::create_dir_all(parent(&target)?)?;
    fs::copy(&backup, &target)?;
    sync_parent(&target)?;
    Ok(())
}

fn rollback_rename(
    workspace: &Workspace,
    file: &TransactionFilePlan,
    entry: &MutationReceipt,
) -> Result<()> {
    let from = file
        .to_path
        .as_ref()
        .ok_or_else(|| CoreError::new("NEEDS_ATTENTION", "Rename receipt is missing target"))?;
    let current = workspace_path(workspace, from, false)?;
    ensure_current_receipt_matches(&current, entry)?;
    let original = workspace_path(workspace, &file.path, true)?;
    if original.exists() {
        return Err(CoreError::new(
            "NEEDS_ATTENTION",
            "Rename source was recreated externally",
        ));
    }
    fs::rename(&current, &original)?;
    sync_parent(&current)?;
    sync_parent(&original)?;
    Ok(())
}

fn rollback_created_entry(
    workspace: &Workspace,
    entry: &MutationReceipt,
    only_empty_dir: bool,
) -> Result<()> {
    let target = workspace_path(workspace, &entry.path, false)?;
    ensure_current_receipt_matches(&target, entry)?;
    if entry.is_directory {
        if only_empty_dir {
            fs::remove_dir(&target)?;
        } else {
            fs::remove_dir_all(&target)?;
        }
    } else {
        fs::remove_file(&target)?;
    }
    sync_parent(&target)?;
    Ok(())
}

fn rollback_publications(
    workspace: &Workspace,
    tx_root: &Path,
    plan: &TransactionPlan,
) -> Result<()> {
    for receipt in plan.publication_receipts.iter().rev() {
        if receipt.no_op {
            continue;
        }
        let publication = TransactionPublicationPlan {
            namespace: receipt.namespace.clone(),
            key: receipt.key.clone(),
            expected: ExpectedState {
                exists: Some(false),
                sha256: None,
                file: None,
                directory: None,
                identity: None,
            },
            blob_id: "rollback".to_owned(),
            size: 0,
            sha256: String::new(),
        };
        let target = publication_path(workspace, &publication)?;
        if target.exists() {
            let metadata = fs::symlink_metadata(&target)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(CoreError::new(
                    "NEEDS_ATTENTION",
                    "Metadata publication target changed after transaction",
                ));
            }
            if file_sha256(&target)? != receipt.sha256 {
                return Err(CoreError::new(
                    "NEEDS_ATTENTION",
                    "Metadata publication changed after transaction",
                ));
            }
        } else {
            return Err(CoreError::new(
                "NEEDS_ATTENTION",
                "Metadata publication disappeared after transaction",
            ));
        }
        if receipt.previous_exists {
            let backup_blob = receipt.backup_blob.as_ref().ok_or_else(|| {
                CoreError::new("NEEDS_ATTENTION", "Metadata publication backup is missing")
            })?;
            let backup = tx_root.join("backups").join(backup_blob);
            if !backup.exists() {
                return Err(CoreError::new(
                    "NEEDS_ATTENTION",
                    "Metadata publication backup is missing",
                ));
            }
            if let Some(expected) = &receipt.previous_sha256 {
                if file_sha256(&backup)? != *expected {
                    return Err(CoreError::new(
                        "NEEDS_ATTENTION",
                        "Metadata publication backup digest mismatch",
                    ));
                }
            }
            fs::copy(&backup, &target)?;
            sync_file(&target)?;
            sync_parent(&target)?;
        } else {
            fs::remove_file(&target)?;
            sync_parent(&target)?;
        }
    }
    Ok(())
}

fn ensure_current_receipt_matches(target: &Path, entry: &MutationReceipt) -> Result<()> {
    let metadata = fs::symlink_metadata(target)?;
    if metadata.file_type().is_symlink() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Rollback refuses symbolic links",
        ));
    }
    if metadata.is_file() != entry.is_file || metadata.is_dir() != entry.is_directory {
        return Err(CoreError::new(
            "NEEDS_ATTENTION",
            "Rollback target type changed",
        ));
    }
    if metadata.is_file() && file_sha256(target)? != entry.sha256 {
        return Err(CoreError::new(
            "NEEDS_ATTENTION",
            "Rollback target changed after transaction",
        ));
    }
    Ok(())
}

fn publication_expected(
    workspace: &Workspace,
    publication: &TransactionPublicationPlan,
) -> Result<InspectResponse> {
    let target = publication_path(workspace, publication)?;
    let Ok(metadata) = fs::symlink_metadata(&target) else {
        return Ok(InspectResponse {
            path: publication.key.clone(),
            exists: false,
            kind: "missing".to_owned(),
            size: 0,
            mtime_ms: 0.0,
            sha256: None,
            bytes_base64: None,
        });
    };
    if metadata.file_type().is_symlink() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Metadata publication refuses symbolic links",
        ));
    }
    reject_hardlink(&metadata)?;
    Ok(InspectResponse {
        path: publication.key.clone(),
        exists: true,
        kind: if metadata.is_file() {
            "file".to_owned()
        } else if metadata.is_dir() {
            "directory".to_owned()
        } else {
            "other".to_owned()
        },
        size: metadata.len(),
        mtime_ms: 0.0,
        sha256: metadata
            .is_file()
            .then(|| file_sha256(&target))
            .transpose()?,
        bytes_base64: None,
    })
}

fn publication_path(
    workspace: &Workspace,
    publication: &TransactionPublicationPlan,
) -> Result<PathBuf> {
    metadata_dir(workspace, &publication_relative(publication)?)
}

fn publication_relative(publication: &TransactionPublicationPlan) -> Result<String> {
    let base = match publication.namespace.as_str() {
        "mutationJournal" => ".checkpoints",
        "mutationBlob" => ".checkpoints/blobs",
        "repositoryIndex" => ".history/repository-index/v1",
        "changeSetWal" => ".history/change-sets/transactions",
        _ => return Err(CoreError::invalid("Unsupported metadata namespace")),
    };
    validate_publication_key(&publication.key)?;
    Ok(format!("{base}/{}", publication.key))
}

fn read_transaction_plan(path: &Path) -> Result<Option<TransactionPlan>> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Transaction record is not a regular file",
        ));
    }
    const MAX_WAL_BYTES: u64 = 64 * 1024 * 1024;
    if metadata.len() > MAX_WAL_BYTES {
        return Err(CoreError::new(
            "LIMIT_EXCEEDED",
            "Transaction record exceeds size limit",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(3).custom_flags(0x00200000);
    }
    let file = options.open(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if file.metadata()?.file_attributes() & 0x400 != 0 {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Transaction record is a reparse point",
            ));
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_WAL_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_WAL_BYTES {
        return Err(CoreError::new(
            "LIMIT_EXCEEDED",
            "Transaction record exceeds size limit",
        ));
    }
    Ok(Some(serde_json::from_slice(&bytes)?))
}

fn has_applying_transaction(workspace: &Workspace, owner: &WriterOwner) -> Result<bool> {
    let tx_dir = metadata_dir(workspace, TX_DIR)?;
    let Ok(entries) = fs::read_dir(tx_dir) else {
        return Ok(false);
    };
    for entry in entries {
        let entry = entry?;
        let plan_path = entry.path().join("transaction.json");
        if let Some(plan) = read_transaction_plan(&plan_path)? {
            if &plan.owner == owner && plan.phase == "applying" {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn write_transaction_plan(path: &Path, plan: &TransactionPlan) -> Result<()> {
    fs::create_dir_all(parent(path)?)?;
    let temporary = unique_temp_path(path);
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(serde_json::to_string_pretty(plan)?.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&temporary, path)?;
    sync_parent(path)?;
    Ok(())
}

fn begin_matches_existing_plan(
    plan: &TransactionPlan,
    mode: &str,
    owner: &WriterOwner,
    files: &[TransactionFilePlan],
    publications: &[TransactionPublicationPlan],
) -> bool {
    plan.mode == mode
        && &plan.owner == owner
        && plan.files == files
        && plan.publications == publications
}

fn prepare_operation(workspace: &Workspace, operation: MutationOperation) -> Result<PreparedOp> {
    match operation.clone() {
        MutationOperation::WriteFile {
            path,
            content,
            content_base64,
            expected,
            overwrite,
        } => {
            let bytes = if content_base64.is_empty() {
                content.into_bytes()
            } else {
                STANDARD
                    .decode(content_base64)
                    .map_err(|_| CoreError::invalid("Invalid base64 file content"))?
            };
            if bytes.len() > MAX_WRITE_BYTES {
                return Err(CoreError::new(
                    "LIMIT_EXCEEDED",
                    "Desktop mutation write exceeds 64 MiB",
                ));
            }
            let target = workspace_path(workspace, &path, true)?;
            if !overwrite && target.exists() && expected.is_none() {
                return Err(CoreError::new("CONFLICT", "Target already exists"));
            }
            check_expected(workspace, &path, expected.as_ref())?;
            Ok(PreparedOp {
                operation,
                path,
                new_path: None,
                staged: None,
                bytes: Some(bytes),
                modified_at_ms: None,
                mode: None,
            })
        }
        MutationOperation::Mkdir { path, .. } => {
            let target = workspace_path(workspace, &path, true)?;
            if target.exists() && !target.is_dir() {
                return Err(CoreError::new("CONFLICT", "Target already exists"));
            }
            Ok(PreparedOp {
                operation,
                path,
                new_path: None,
                staged: None,
                bytes: None,
                modified_at_ms: None,
                mode: None,
            })
        }
        MutationOperation::Delete { path, recursive } => {
            let target = workspace_path(workspace, &path, false)?;
            let meta = lstat(&target)?;
            if meta.file_type().is_symlink() {
                return Err(CoreError::new(
                    "PATH_ESCAPE",
                    "Mutation refuses symbolic links",
                ));
            }
            reject_hardlink(&meta)?;
            if meta.is_dir() && !recursive {
                return Err(CoreError::new(
                    "CONFLICT",
                    "Directory delete requires recursive=true",
                ));
            }
            if meta.is_dir() {
                reject_tree_symlinks(&target)?;
            }
            Ok(PreparedOp {
                operation,
                path,
                new_path: None,
                staged: None,
                bytes: None,
                modified_at_ms: None,
                mode: None,
            })
        }
        MutationOperation::Rename { path, new_path } => {
            let source = workspace_path(workspace, &path, false)?;
            let target = workspace_path(workspace, &new_path, true)?;
            if source == *workspace.root() || lstat(&source)?.file_type().is_symlink() {
                return Err(CoreError::new(
                    "PATH_ESCAPE",
                    "Mutation refuses symbolic links",
                ));
            }
            reject_hardlink(&lstat(&source)?)?;
            if target.exists() {
                return Err(CoreError::new("CONFLICT", "Target already exists"));
            }
            prevent_into_self(&source, &target)?;
            Ok(PreparedOp {
                operation,
                path,
                new_path: Some(new_path),
                staged: None,
                bytes: None,
                modified_at_ms: None,
                mode: None,
            })
        }
        MutationOperation::Copy { path, new_path } => {
            let source = workspace_path(workspace, &path, false)?;
            let target = workspace_path(workspace, &new_path, true)?;
            if source == *workspace.root() || lstat(&source)?.file_type().is_symlink() {
                return Err(CoreError::new(
                    "PATH_ESCAPE",
                    "Mutation refuses symbolic links",
                ));
            }
            reject_hardlink(&lstat(&source)?)?;
            if target.exists() {
                return Err(CoreError::new("CONFLICT", "Target already exists"));
            }
            prevent_into_self(&source, &target)?;
            reject_tree_symlinks(&source)?;
            Ok(PreparedOp {
                operation,
                path,
                new_path: Some(new_path),
                staged: None,
                bytes: None,
                modified_at_ms: None,
                mode: None,
            })
        }
    }
}

fn apply_operation(
    workspace: &Workspace,
    prepared: &PreparedOp,
    receipts: &mut Vec<MutationReceipt>,
) -> Result<()> {
    match &prepared.operation {
        MutationOperation::WriteFile { expected, .. } => {
            let target = workspace_path(workspace, &prepared.path, true)?;
            fs::create_dir_all(parent(&target)?)?;
            let staged = prepared
                .staged
                .as_ref()
                .ok_or_else(|| CoreError::failed("Missing staged write"))?;
            let _ = target;
            write_workspace::install_file(
                workspace.root(),
                &prepared.path,
                staged,
                expected
                    .as_ref()
                    .is_some_and(|expected| expected.exists == Some(false)),
            )?;
            receipts.push(receipt(workspace, &prepared.path, None, "writeFile")?);
        }
        MutationOperation::Mkdir { recursive, .. } => {
            let target = workspace_path(workspace, &prepared.path, true)?;
            if *recursive {
                fs::create_dir_all(&target)?;
            } else {
                fs::create_dir(&target)?;
            }
            sync_parent(&target)?;
            receipts.push(receipt(workspace, &prepared.path, None, "mkdir")?);
        }
        MutationOperation::Delete { recursive, .. } => {
            let target = workspace_path(workspace, &prepared.path, false)?;
            let was_dir = lstat(&target)?.is_dir();
            if was_dir {
                if *recursive {
                    reject_tree_symlinks(&target)?;
                    fs::remove_dir_all(&target)?;
                } else {
                    fs::remove_dir(&target)?;
                }
            } else {
                fs::remove_file(&target)?;
            }
            sync_parent(&target)?;
            receipts.push(MutationReceipt {
                path: prepared.path.clone(),
                previous_path: None,
                operation: "delete".to_owned(),
                exists: false,
                is_file: false,
                is_directory: false,
                size: 0,
                mtime_ms: now_ms(),
                sha256: hex_sha256(&[]),
            });
        }
        MutationOperation::Rename { .. } => {
            let new_path = prepared.new_path.as_ref().unwrap();
            let source = workspace_path(workspace, &prepared.path, false)?;
            let target = workspace_path(workspace, new_path, true)?;
            let _ = (source, target);
            write_workspace::rename_no_replace(workspace.root(), &prepared.path, new_path)?;
            receipts.push(receipt(
                workspace,
                new_path,
                Some(prepared.path.clone()),
                "rename",
            )?);
        }
        MutationOperation::Copy { .. } => {
            let new_path = prepared.new_path.as_ref().unwrap();
            let target = workspace_path(workspace, new_path, true)?;
            copy_entry(workspace, &prepared.path, new_path)?;
            sync_parent(&target)?;
            receipts.push(receipt(
                workspace,
                new_path,
                Some(prepared.path.clone()),
                "copy",
            )?);
        }
    }
    Ok(())
}

fn workspace_path(
    workspace: &Workspace,
    relative: &str,
    allow_missing_leaf: bool,
) -> Result<PathBuf> {
    validate_user_path(relative)?;
    let raw = workspace.root().join(relative.replace('\\', "/"));
    let mut cursor = workspace.root().to_path_buf();
    let parts: Vec<_> = Path::new(relative).components().collect();
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Path must stay inside the workspace",
            ));
        };
        cursor.push(name);
        if allow_missing_leaf && index + 1 == parts.len() && !cursor.exists() {
            break;
        }
        match fs::symlink_metadata(&cursor) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(CoreError::new(
                        "PATH_ESCAPE",
                        "Mutation refuses symbolic links",
                    ));
                }
                if index + 1 < parts.len() && !meta.is_dir() {
                    return Err(CoreError::new(
                        "CONFLICT",
                        "Mutation parent is not a directory",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !allow_missing_leaf {
                    return Err(CoreError::new("NOT_FOUND", "Workspace entry not found"));
                }
                break;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(raw)
}

fn validate_user_path(relative: &str) -> Result<()> {
    let normalized = relative.replace('\\', "/");
    if normalized.is_empty()
        || normalized.contains('\0')
        || normalized.starts_with('/')
        || normalized.as_bytes().get(1) == Some(&b':')
        || normalized.split('/').any(invalid_user_path_component)
    {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Mutation path must stay inside user workspace files",
        ));
    }
    Ok(())
}

fn invalid_user_path_component(part: &str) -> bool {
    const PROTECTED: &[&str] = &[
        ".git",
        ".history",
        ".checkpoints",
        ".team",
        ".codex",
        ".omx",
        ".crewforge",
        ".crownforge-worktrees",
    ];
    part.is_empty()
        || part == "."
        || part == ".."
        || PROTECTED
            .iter()
            .any(|protected| part.eq_ignore_ascii_case(protected))
        || invalid_windows_user_path_component(part)
}

#[cfg(windows)]
fn invalid_windows_user_path_component(part: &str) -> bool {
    if part.contains(':') || part.ends_with([' ', '.']) {
        return true;
    }
    let stem = part.split('.').next().unwrap_or(part);
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

#[cfg(not(windows))]
fn invalid_windows_user_path_component(_part: &str) -> bool {
    false
}

fn metadata_dir(workspace: &Workspace, relative: &str) -> Result<PathBuf> {
    let root = workspace.root().join(relative);
    let mut cursor = workspace.root().to_path_buf();
    for part in relative.split('/') {
        cursor.push(part);
        if cursor.exists() && fs::symlink_metadata(&cursor)?.file_type().is_symlink() {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Metadata path contains a symbolic link",
            ));
        }
    }
    Ok(root)
}

fn transaction_root(workspace: &Workspace, tx_id: &str) -> Result<PathBuf> {
    metadata_dir(workspace, &format!("{TX_DIR}/{tx_id}"))
}

fn validate_owner(owner: &WriterOwner) -> Result<()> {
    if !["user", "agent", "integration"].contains(&owner.kind.as_str())
        || owner.id.trim().is_empty()
        || owner.id.len() > 200
    {
        return Err(CoreError::invalid("Invalid writer owner"));
    }
    Ok(())
}

fn validate_transaction_mode(mode: &str) -> Result<()> {
    if mode == "metadataOnly" || mode == "privateBackup" {
        Ok(())
    } else {
        Err(CoreError::invalid("Invalid transaction mode"))
    }
}

fn validate_blob_id(value: &str) -> Result<()> {
    if value.len() > 128
        || value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(CoreError::invalid("Invalid blob id"));
    }
    Ok(())
}

fn validate_publication(publication: &TransactionPublicationPlan) -> Result<()> {
    validate_blob_id(&publication.blob_id)?;
    validate_publication_key(&publication.key)?;
    match publication.namespace.as_str() {
        "mutationJournal" if publication.key == "mutations.json" => Ok(()),
        "mutationBlob" if is_hex_sha256(&publication.key) => Ok(()),
        "repositoryIndex" if valid_index_store_key(&publication.key) => Ok(()),
        "changeSetWal" if valid_changeset_wal_key(&publication.key) => Ok(()),
        "mutationJournal" | "mutationBlob" | "repositoryIndex" | "changeSetWal" => {
            Err(CoreError::new(
                "PATH_ESCAPE",
                "Metadata publication key is not in the fixed namespace map",
            ))
        }
        _ => Err(CoreError::invalid("Unsupported metadata namespace")),
    }
}

fn validate_declared_blobs(
    files: &[TransactionFilePlan],
    publications: &[TransactionPublicationPlan],
) -> Result<()> {
    let mut declared = HashMap::<String, DeclaredBlob>::new();
    let mut total = 0u64;
    for file in files {
        if let Some(output) = &file.output {
            validate_declared_blob(
                &mut declared,
                &mut total,
                &output.blob_id,
                output.size,
                &output.sha256,
            )?;
        }
    }
    for publication in publications {
        validate_declared_blob(
            &mut declared,
            &mut total,
            &publication.blob_id,
            publication.size,
            &publication.sha256,
        )?;
    }
    if total > MAX_TRANSACTION_BLOB_BYTES {
        return Err(CoreError::new(
            "LIMIT_EXCEEDED",
            "Transaction declared blobs exceed size limit",
        ));
    }
    Ok(())
}

fn validate_declared_blob(
    declared: &mut HashMap<String, DeclaredBlob>,
    total: &mut u64,
    blob_id: &str,
    size: u64,
    sha256: &str,
) -> Result<()> {
    validate_blob_id(blob_id)?;
    if size > MAX_WRITE_BYTES as u64 {
        return Err(CoreError::new(
            "LIMIT_EXCEEDED",
            "Transaction blob exceeds size limit",
        ));
    }
    if !is_hex_sha256(sha256) {
        return Err(CoreError::invalid("Invalid transaction blob digest"));
    }
    if let Some(previous) = declared.get(blob_id) {
        if previous.size != size || previous.sha256 != sha256 {
            return Err(CoreError::new(
                "CONFLICT",
                "Transaction blob id has conflicting declarations",
            ));
        }
        return Ok(());
    }
    *total = total.saturating_add(size);
    declared.insert(
        blob_id.to_owned(),
        DeclaredBlob {
            size,
            sha256: sha256.to_owned(),
        },
    );
    Ok(())
}

fn declared_blob(plan: &TransactionPlan, blob_id: &str) -> Option<DeclaredBlob> {
    plan.files
        .iter()
        .filter_map(|file| file.output.as_ref())
        .find(|output| output.blob_id == blob_id)
        .map(|output| DeclaredBlob {
            size: output.size,
            sha256: output.sha256.clone(),
        })
        .or_else(|| {
            plan.publications
                .iter()
                .find(|publication| publication.blob_id == blob_id)
                .map(|publication| DeclaredBlob {
                    size: publication.size,
                    sha256: publication.sha256.clone(),
                })
        })
}

fn is_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_index_store_key(value: &str) -> bool {
    value == "meta.json"
        || value
            .strip_prefix("shards/")
            .and_then(|rest| rest.strip_suffix(".json"))
            .is_some_and(|shard| {
                shard.len() == 2
                    && shard
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
}

fn valid_changeset_wal_key(value: &str) -> bool {
    value.ends_with(".json")
        && value
            .trim_end_matches(".json")
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
}

fn validate_publication_key(value: &str) -> Result<()> {
    let normalized = value.replace('\\', "/");
    if normalized.is_empty()
        || normalized.contains('\0')
        || normalized.starts_with('/')
        || normalized.as_bytes().get(1) == Some(&b':')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Invalid metadata publication key",
        ));
    }
    Ok(())
}

fn check_expected(
    workspace: &Workspace,
    path: &str,
    expected: Option<&ExpectedState>,
) -> Result<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let target = workspace_path(workspace, path, expected.exists == Some(false))?;
    let metadata = fs::symlink_metadata(&target).ok();
    let exists = metadata.is_some();
    if expected.exists.is_some_and(|value| value != exists) {
        return Err(CoreError::new("CONFLICT", "File existence changed"));
    }
    if let Some(metadata) = metadata {
        if metadata.file_type().is_symlink() {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Mutation refuses symbolic links",
            ));
        }
        reject_hardlink(&metadata)?;
        if expected
            .file
            .is_some_and(|value| value != metadata.is_file())
        {
            return Err(CoreError::new("CONFLICT", "File type changed"));
        }
        if expected
            .directory
            .is_some_and(|value| value != metadata.is_dir())
        {
            return Err(CoreError::new("CONFLICT", "Directory type changed"));
        }
        if let Some(hash) = &expected.sha256 {
            if !metadata.is_file() || file_sha256(&target)? != *hash {
                return Err(CoreError::new("CONFLICT", "File content changed"));
            }
        }
        if let Some(identity) = &expected.identity {
            let current = file_identity_for_path(&target, &metadata)?;
            if &current != identity {
                return Err(CoreError::new("CONFLICT", "File identity changed"));
            }
        }
    } else if expected.sha256.is_some() {
        return Err(CoreError::new("CONFLICT", "File content changed"));
    } else if expected.identity.is_some() {
        return Err(CoreError::new("CONFLICT", "File identity changed"));
    }
    Ok(())
}

fn file_identity_for_path(path: &Path, metadata: &fs::Metadata) -> Result<ExpectedIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let _ = path;
        Ok(ExpectedIdentity {
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
            nlink: metadata.nlink(),
        })
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        use std::{
            ffi::c_void,
            os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        };

        #[repr(C)]
        #[derive(Default)]
        struct FileInformation {
            attributes: u32,
            creation_time: [u32; 2],
            access_time: [u32; 2],
            write_time: [u32; 2],
            volume_serial: u32,
            size_high: u32,
            size_low: u32,
            links: u32,
            index_high: u32,
            index_low: u32,
        }

        #[link(name = "kernel32")]
        extern "system" {
            fn GetFileInformationByHandle(
                handle: *mut c_void,
                information: *mut FileInformation,
            ) -> i32;
        }

        let file = OpenOptions::new()
            .read(true)
            .share_mode(7)
            .custom_flags(0x02000000 | 0x00200000)
            .open(path)?;
        let mut information = FileInformation::default();
        // SAFETY: the file handle is valid and the output buffer has the documented layout.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(ExpectedIdentity {
            device: information.volume_serial.to_string(),
            inode: (((information.index_high as u64) << 32) | information.index_low as u64)
                .to_string(),
            nlink: information.links as u64,
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, metadata);
        Err(CoreError::invalid(
            "File identity expectations are unsupported on this platform",
        ))
    }
}

fn receipt(
    workspace: &Workspace,
    relative: &str,
    previous_path: Option<String>,
    operation: &'static str,
) -> Result<MutationReceipt> {
    let target = workspace_path(workspace, relative, false)?;
    let metadata = fs::symlink_metadata(&target)?;
    if metadata.file_type().is_symlink() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Mutation refuses symbolic links",
        ));
    }
    reject_hardlink(&metadata)?;
    let sha256 = if metadata.is_file() {
        file_sha256(&target)?
    } else {
        hex_sha256(&[])
    };
    Ok(MutationReceipt {
        path: relative.to_owned(),
        previous_path,
        operation: operation.to_owned(),
        exists: true,
        is_file: metadata.is_file(),
        is_directory: metadata.is_dir(),
        size: metadata.len(),
        mtime_ms: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs_f64() * 1000.0)
            .unwrap_or_else(now_ms),
        sha256,
    })
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn blob_contains_at(path: &Path, offset: u64, bytes: &[u8]) -> Result<bool> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut existing = vec![0u8; bytes.len()];
    file.read_exact(&mut existing)?;
    Ok(existing == bytes)
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn write_wal(
    path: &Path,
    tx_id: &str,
    phase: &str,
    prepared: &[PreparedOp],
    entries: &[MutationReceipt],
) -> Result<()> {
    let paths: Vec<_> = prepared
        .iter()
        .map(|op| serde_json::json!({ "path": op.path, "newPath": op.new_path }))
        .collect();
    let value = serde_json::json!({
        "schemaVersion": 1,
        "transactionId": tx_id,
        "phase": phase,
        "updatedAt": now_ms(),
        "paths": paths,
        "entries": entries
    });
    fs::create_dir_all(parent(path)?)?;
    let tmp = unique_temp_path(path);
    {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(serde_json::to_string_pretty(&value)?.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    sync_parent(path)?;
    Ok(())
}

fn read_wal(path: &Path) -> Result<Option<WalRecord>> {
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}

fn copy_entry(workspace: &Workspace, source_relative: &str, target_relative: &str) -> Result<()> {
    let source = workspace_path(workspace, source_relative, false)?;
    let target = workspace_path(workspace, target_relative, true)?;
    let meta = lstat(&source)?;
    if meta.file_type().is_symlink() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Mutation refuses symbolic links",
        ));
    }
    reject_hardlink(&meta)?;
    if meta.is_file() {
        let bytes = fs::read(&source)?;
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            Some(meta.permissions().mode() & 0o7777)
        };
        #[cfg(not(unix))]
        let mode = None;
        let modified_at_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs_f64() * 1000.0);
        let staged = write_workspace::stage_file(
            workspace.root(),
            target_relative,
            &bytes,
            mode,
            modified_at_ms,
        )?;
        write_workspace::install_file(workspace.root(), target_relative, &staged, true)?;
        return Ok(());
    }
    if !meta.is_dir() {
        return Err(CoreError::new("CONFLICT", "Unsupported entry type"));
    }
    fs::create_dir(&target)?;
    sync_parent(&target)?;
    for entry in fs::read_dir(&source)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| CoreError::invalid("Workspace path is not valid UTF-8"))?;
        copy_entry(
            workspace,
            &join_relative(source_relative, &name),
            &join_relative(target_relative, &name),
        )?;
    }
    Ok(())
}

fn join_relative(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_owned()
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), child)
    }
}

fn reject_tree_symlinks(source: &Path) -> Result<()> {
    let meta = lstat(source)?;
    if meta.file_type().is_symlink() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Mutation refuses symbolic links",
        ));
    }
    reject_hardlink(&meta)?;
    if meta.is_dir() {
        for entry in fs::read_dir(source)? {
            reject_tree_symlinks(&entry?.path())?;
        }
    }
    Ok(())
}

fn prevent_into_self(source: &Path, target: &Path) -> Result<()> {
    if target == source || target.starts_with(source) {
        return Err(CoreError::new(
            "CONFLICT",
            "A directory cannot be moved or copied into itself",
        ));
    }
    Ok(())
}

fn lstat(path: &Path) -> Result<fs::Metadata> {
    fs::symlink_metadata(path).map_err(CoreError::from)
}

fn reject_hardlink(metadata: &fs::Metadata) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        if metadata.is_file() && metadata.nlink() > 1 {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Mutation refuses hard-linked files",
            ));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
    }
    Ok(())
}

fn parent(path: &Path) -> Result<&Path> {
    path.parent()
        .ok_or_else(|| CoreError::new("PATH_ESCAPE", "Path has no parent"))
}

fn unique_temp_path(target: &Path) -> PathBuf {
    target.with_extension(format!(
        "crewforge-tmp-{}-{}",
        std::process::id(),
        now_ms() as u64
    ))
}

fn sync_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

#[cfg(windows)]
fn sync_file(path: &Path) -> Result<()> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

    const GENERIC_WRITE: u32 = 0x40000000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    let file = OpenOptions::new()
        .access_mode(GENERIC_WRITE)
        .share_mode(0x1 | 0x2 | 0x4)
        .custom_flags(0x00200000)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(CoreError::new("PATH_ESCAPE", "Sync refuses reparse points"));
    }
    file.sync_all()?;
    Ok(())
}

#[cfg(not(windows))]
fn sync_file(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn sync_directory(path: &Path) -> Result<()> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

    const GENERIC_WRITE: u32 = 0x40000000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    // FILE_FLAG_BACKUP_SEMANTICS is required for CreateFile to open directories
    // on Windows. FlushFileBuffers, which backs sync_all, also requires a
    // GENERIC_WRITE handle.
    let directory = OpenOptions::new()
        .access_mode(GENERIC_WRITE)
        .share_mode(0x1 | 0x2 | 0x4)
        .custom_flags(0x02000000 | 0x00200000)
        .open(path)?;
    let metadata = directory.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(CoreError::new("PATH_ESCAPE", "Sync refuses reparse points"));
    }
    directory.sync_all()?;
    Ok(())
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

fn transaction_id(value: &str) -> Result<String> {
    if value.is_empty() {
        return Ok(format!("tx-{}-{}", std::process::id(), now_ms() as u64));
    }
    if value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(CoreError::invalid("Invalid transaction id"));
    }
    Ok(value.to_owned())
}

fn opaque_token(prefix: &str) -> String {
    let seed = format!("{prefix}\0{}\0{}", std::process::id(), now_ms());
    format!("{prefix}-{}", hex_sha256(seed.as_bytes()))
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

impl From<serde_json::Error> for CoreError {
    fn from(error: serde_json::Error) -> Self {
        CoreError::failed(error.to_string())
    }
}

#[cfg(test)]
mod writer_tests {
    use super::*;
    use tempfile::TempDir;

    fn owner() -> WriterOwner {
        WriterOwner {
            kind: "user".to_owned(),
            id: "tester".to_owned(),
        }
    }

    #[test]
    fn user_path_rejects_case_folded_protected_components() {
        for path in [
            ".HISTORY/index.json",
            ".CrewForge/desktop-transactions/x",
            "src/.GIT/config",
            "notes/.CheckPoints/mutations.json",
        ] {
            let error = expect_core_error(validate_user_path(path));
            assert_eq!(error.code, "PATH_ESCAPE", "{path}");
        }
        validate_user_path("src/history.txt").unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn user_path_rejects_windows_alias_components() {
        for path in [
            "file.txt:ads",
            "dir/name. ",
            "dir/name.",
            "CON",
            "aux.txt",
            ".env::$DATA",
        ] {
            let error = expect_core_error(validate_user_path(path));
            assert_eq!(error.code, "PATH_ESCAPE", "{path}");
        }
    }

    #[test]
    fn writer_admission_lease_inspect_and_release_are_token_bound() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "hello").unwrap();
        let mutations = Mutations::default();
        let admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner(),
                intent: "user-save".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();
        let inspected = mutations
            .writer_inspect(InspectParams {
                admission_token: admission.admission_token.clone(),
                path: "file.txt".to_owned(),
                read_bytes: true,
                max_bytes: Some(64),
            })
            .unwrap();
        assert_eq!(inspected.sha256.unwrap(), hex_sha256(b"hello"));
        assert_eq!(inspected.bytes_base64.unwrap(), STANDARD.encode("hello"));
        let lease = mutations
            .writer_acquire(AcquireParams {
                admission_token: admission.admission_token,
            })
            .unwrap();
        let second = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner(),
                intent: "user-save".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();
        match mutations.writer_acquire(AcquireParams {
            admission_token: second.admission_token,
        }) {
            Ok(_) => panic!("second writer unexpectedly acquired the workspace lock"),
            Err(error) => assert_eq!(error.code, "BUSY"),
        }
        assert!(
            mutations
                .writer_release(ReleaseParams {
                    lease_token: lease.lease_token,
                })
                .unwrap()
                .released
        );
    }

    #[test]
    fn chunked_transaction_commits_file_and_metadata_without_preimage_journal() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "before").unwrap();
        let mutations = Mutations::default();
        let admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner(),
                intent: "user-save".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();
        let lease = mutations
            .writer_acquire(AcquireParams {
                admission_token: admission.admission_token,
            })
            .unwrap();
        let after = b"after";
        let metadata = br#"{"schemaVersion":1,"records":[]}"#;
        let tx = "12345678-1234-1234-1234-123456789abc";
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: tx.to_owned(),
                mode: "metadataOnly".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "file.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(true),
                        sha256: Some(hex_sha256(b"before")),
                        file: Some(true),
                        directory: None,
                        identity: None,
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: after.len() as u64,
                        sha256: hex_sha256(after),
                        modified_at_ms: None,
                        mode: None,
                    }),
                }],
                publications: vec![TransactionPublicationPlan {
                    namespace: "mutationJournal".to_owned(),
                    key: "mutations.json".to_owned(),
                    expected: ExpectedState {
                        exists: Some(false),
                        sha256: None,
                        file: None,
                        directory: None,
                        identity: None,
                    },
                    blob_id: "journal".to_owned(),
                    size: metadata.len() as u64,
                    sha256: hex_sha256(metadata),
                }],
            })
            .unwrap();
        for (blob_id, bytes) in [
            ("file-after", after.as_slice()),
            ("journal", metadata.as_slice()),
        ] {
            mutations
                .transaction_chunk(TransactionChunkParams {
                    lease_token: lease.lease_token.clone(),
                    transaction_id: tx.to_owned(),
                    blob_id: blob_id.to_owned(),
                    offset: 0,
                    data_base64: STANDARD.encode(bytes),
                    sha256: Some(hex_sha256(bytes)),
                })
                .unwrap();
        }
        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: tx.to_owned(),
            })
            .unwrap();
        assert_eq!(committed.status, "committed");
        assert_eq!(
            fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
            "after"
        );
        assert_eq!(
            fs::read_to_string(fixture.path().join(".checkpoints/mutations.json")).unwrap(),
            String::from_utf8_lossy(metadata)
        );
        let plan = fs::read_to_string(
            fixture
                .path()
                .join(".crewforge/desktop-transactions")
                .join(tx)
                .join("transaction.json"),
        )
        .unwrap();
        assert!(!plan.contains("before"));
        assert!(!fixture
            .path()
            .join(".crewforge/desktop-transactions")
            .join(tx)
            .join("blobs")
            .exists());
        mutations
            .writer_release(ReleaseParams {
                lease_token: lease.lease_token,
            })
            .unwrap();
    }

    fn lease_for(fixture: &TempDir, mutations: &Mutations) -> AcquireResponse {
        let admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner(),
                intent: "agent-edit".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();
        mutations
            .writer_acquire(AcquireParams {
                admission_token: admission.admission_token,
            })
            .unwrap()
    }

    fn expect_core_error<T>(result: Result<T>) -> CoreError {
        match result {
            Ok(_) => panic!("operation unexpectedly succeeded"),
            Err(error) => error,
        }
    }

    fn begin_single_write_with_conflicting_publication(
        fixture: &TempDir,
        mutations: &Mutations,
        lease: &AcquireResponse,
        tx: &str,
        mode: &str,
        expected: ExpectedState,
    ) {
        fs::create_dir_all(fixture.path().join(".checkpoints")).unwrap();
        fs::write(fixture.path().join(".checkpoints/mutations.json"), "{}").unwrap();
        let after = b"after";
        let metadata = br#"{"schemaVersion":1,"records":[]}"#;
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: tx.to_owned(),
                mode: mode.to_owned(),
                files: vec![TransactionFilePlan {
                    path: "file.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected,
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: after.len() as u64,
                        sha256: hex_sha256(after),
                        modified_at_ms: None,
                        mode: None,
                    }),
                }],
                publications: vec![TransactionPublicationPlan {
                    namespace: "mutationJournal".to_owned(),
                    key: "mutations.json".to_owned(),
                    expected: ExpectedState {
                        exists: Some(false),
                        sha256: None,
                        file: None,
                        directory: None,
                        identity: None,
                    },
                    blob_id: "journal".to_owned(),
                    size: metadata.len() as u64,
                    sha256: hex_sha256(metadata),
                }],
            })
            .unwrap();
        for (blob_id, bytes) in [
            ("file-after", after.as_slice()),
            ("journal", metadata.as_slice()),
        ] {
            mutations
                .transaction_chunk(TransactionChunkParams {
                    lease_token: lease.lease_token.clone(),
                    transaction_id: tx.to_owned(),
                    blob_id: blob_id.to_owned(),
                    offset: 0,
                    data_base64: STANDARD.encode(bytes),
                    sha256: Some(hex_sha256(bytes)),
                })
                .unwrap();
        }
    }

    #[test]
    fn commit_failure_rolls_back_created_file_only_when_postimage_matches() {
        let fixture = TempDir::new().unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        begin_single_write_with_conflicting_publication(
            &fixture,
            &mutations,
            &lease,
            "created-rollback",
            "metadataOnly",
            ExpectedState {
                exists: Some(false),
                sha256: None,
                file: None,
                directory: None,
                identity: None,
            },
        );
        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "created-rollback".to_owned(),
            })
            .unwrap();
        assert_eq!(committed.status, "rolled_back");
        assert!(!fixture.path().join("file.txt").exists());
        assert!(fixture
            .path()
            .join(".crewforge/desktop-transactions/created-rollback/transaction.json")
            .exists());
    }

    #[test]
    fn publication_preflight_conflict_prevents_workspace_write_and_keeps_recovery_blob() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "before").unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        begin_single_write_with_conflicting_publication(
            &fixture,
            &mutations,
            &lease,
            "overwrite-attention",
            "metadataOnly",
            ExpectedState {
                exists: Some(true),
                sha256: Some(hex_sha256(b"before")),
                file: Some(true),
                directory: None,
                identity: None,
            },
        );
        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "overwrite-attention".to_owned(),
            })
            .unwrap();
        assert_eq!(committed.status, "rolled_back");
        assert_eq!(
            fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
            "before"
        );
        assert!(!fixture
            .path()
            .join(".crewforge/desktop-transactions/overwrite-attention/blobs/file-after")
            .exists());
    }

    #[test]
    fn exclusive_publication_create_preserves_race_created_destination() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "before").unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        let tx = "publication-race";
        let after = b"after";
        let metadata = br#"{"schemaVersion":1,"records":[]}"#;
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: tx.to_owned(),
                mode: "metadataOnly".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "file.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(true),
                        sha256: Some(hex_sha256(b"before")),
                        file: Some(true),
                        directory: None,
                        identity: None,
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: after.len() as u64,
                        sha256: hex_sha256(after),
                        modified_at_ms: None,
                        mode: None,
                    }),
                }],
                publications: vec![TransactionPublicationPlan {
                    namespace: "mutationJournal".to_owned(),
                    key: "mutations.json".to_owned(),
                    expected: ExpectedState {
                        exists: Some(false),
                        sha256: None,
                        file: None,
                        directory: None,
                        identity: None,
                    },
                    blob_id: "journal".to_owned(),
                    size: metadata.len() as u64,
                    sha256: hex_sha256(metadata),
                }],
            })
            .unwrap();
        for (blob_id, bytes) in [
            ("file-after", after.as_slice()),
            ("journal", metadata.as_slice()),
        ] {
            mutations
                .transaction_chunk(TransactionChunkParams {
                    lease_token: lease.lease_token.clone(),
                    transaction_id: tx.to_owned(),
                    blob_id: blob_id.to_owned(),
                    offset: 0,
                    data_base64: STANDARD.encode(bytes),
                    sha256: Some(hex_sha256(bytes)),
                })
                .unwrap();
        }
        fs::create_dir_all(fixture.path().join(".checkpoints")).unwrap();
        fs::write(fixture.path().join(".checkpoints/mutations.json"), "raced").unwrap();

        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: tx.to_owned(),
            })
            .unwrap();

        assert_eq!(committed.status, "rolled_back");
        assert_eq!(
            fs::read_to_string(fixture.path().join(".checkpoints/mutations.json")).unwrap(),
            "raced"
        );
        assert_eq!(
            fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
            "before"
        );
    }

    #[test]
    #[cfg(unix)]
    fn expected_identity_rejects_same_bytes_replacement() {
        use std::os::unix::fs::MetadataExt;

        let fixture = TempDir::new().unwrap();
        let target = fixture.path().join("file.txt");
        fs::write(&target, "before").unwrap();
        let metadata = fs::metadata(&target).unwrap();
        let expected_identity = ExpectedIdentity {
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
            nlink: metadata.nlink(),
        };
        fs::remove_file(&target).unwrap();
        fs::write(&target, "before").unwrap();

        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        let after = b"after";
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "identity-conflict".to_owned(),
                mode: "metadataOnly".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "file.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(true),
                        sha256: Some(hex_sha256(b"before")),
                        file: Some(true),
                        directory: None,
                        identity: Some(expected_identity),
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: after.len() as u64,
                        sha256: hex_sha256(after),
                        modified_at_ms: None,
                        mode: None,
                    }),
                }],
                publications: Vec::new(),
            })
            .unwrap();
        mutations
            .transaction_chunk(TransactionChunkParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "identity-conflict".to_owned(),
                blob_id: "file-after".to_owned(),
                offset: 0,
                data_base64: STANDARD.encode(after),
                sha256: Some(hex_sha256(after)),
            })
            .unwrap();

        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "identity-conflict".to_owned(),
            })
            .unwrap();

        assert_eq!(committed.status, "rolled_back");
        assert_eq!(fs::read_to_string(target).unwrap(), "before");
    }

    #[test]
    #[cfg(unix)]
    fn hardlinked_write_target_is_rejected() {
        let fixture = TempDir::new().unwrap();
        let target = fixture.path().join("file.txt");
        fs::write(&target, "before").unwrap();
        fs::hard_link(&target, fixture.path().join("other.txt")).unwrap();

        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        let after = b"after";
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "hardlink-conflict".to_owned(),
                mode: "metadataOnly".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "file.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(true),
                        sha256: Some(hex_sha256(b"before")),
                        file: Some(true),
                        directory: None,
                        identity: None,
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: after.len() as u64,
                        sha256: hex_sha256(after),
                        modified_at_ms: None,
                        mode: None,
                    }),
                }],
                publications: Vec::new(),
            })
            .unwrap();
        mutations
            .transaction_chunk(TransactionChunkParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "hardlink-conflict".to_owned(),
                blob_id: "file-after".to_owned(),
                offset: 0,
                data_base64: STANDARD.encode(after),
                sha256: Some(hex_sha256(after)),
            })
            .unwrap();

        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "hardlink-conflict".to_owned(),
            })
            .unwrap();

        assert_eq!(committed.status, "rolled_back");
        assert_eq!(fs::read_to_string(target).unwrap(), "before");
    }

    #[test]
    fn rename_target_created_after_prepare_is_not_overwritten() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("source.txt"), "source").unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        let prepared = prepare_operation(
            &workspace,
            MutationOperation::Rename {
                path: "source.txt".to_owned(),
                new_path: "target.txt".to_owned(),
            },
        )
        .unwrap();
        fs::write(fixture.path().join("target.txt"), "raced").unwrap();

        let error = apply_operation(&workspace, &prepared, &mut Vec::new()).unwrap_err();

        assert_eq!(error.code, "CONFLICT");
        assert_eq!(
            fs::read_to_string(fixture.path().join("source.txt")).unwrap(),
            "source"
        );
        assert_eq!(
            fs::read_to_string(fixture.path().join("target.txt")).unwrap(),
            "raced"
        );
    }

    #[test]
    #[cfg(unix)]
    fn file_rename_preserves_source_inode() {
        use std::os::unix::fs::MetadataExt;

        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("source.txt"), "source").unwrap();
        let source_metadata = fs::metadata(fixture.path().join("source.txt")).unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        let prepared = prepare_operation(
            &workspace,
            MutationOperation::Rename {
                path: "source.txt".to_owned(),
                new_path: "target.txt".to_owned(),
            },
        )
        .unwrap();

        apply_operation(&workspace, &prepared, &mut Vec::new()).unwrap();

        let target_metadata = fs::metadata(fixture.path().join("target.txt")).unwrap();
        assert_eq!(source_metadata.dev(), target_metadata.dev());
        assert_eq!(source_metadata.ino(), target_metadata.ino());
        assert!(!fixture.path().join("source.txt").exists());
    }

    #[test]
    #[cfg(unix)]
    fn swapped_parent_symlink_is_rejected_before_staging_user_file() {
        let fixture = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::create_dir(fixture.path().join("safe")).unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        workspace_path(&workspace, "safe/file.txt", true).unwrap();
        fs::remove_dir(fixture.path().join("safe")).unwrap();
        std::os::unix::fs::symlink(outside.path(), fixture.path().join("safe")).unwrap();

        let error =
            write_workspace::stage_file(workspace.root(), "safe/file.txt", b"secret", None, None)
                .unwrap_err();

        assert_eq!(error.code, "PATH_ESCAPE");
        assert!(!outside.path().join("file.txt").exists());
    }

    #[test]
    #[cfg(unix)]
    fn swapped_metadata_parent_symlink_is_rejected_before_publication_stage() {
        let fixture = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::create_dir(fixture.path().join(".checkpoints")).unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        publication_path(
            &workspace,
            &TransactionPublicationPlan {
                namespace: "mutationJournal".to_owned(),
                key: "mutations.json".to_owned(),
                expected: ExpectedState {
                    exists: Some(false),
                    sha256: None,
                    file: None,
                    directory: None,
                    identity: None,
                },
                blob_id: "journal".to_owned(),
                size: 2,
                sha256: hex_sha256(b"{}"),
            },
        )
        .unwrap();
        fs::remove_dir(fixture.path().join(".checkpoints")).unwrap();
        std::os::unix::fs::symlink(outside.path(), fixture.path().join(".checkpoints")).unwrap();

        let error = write_workspace::stage_file(
            workspace.root(),
            ".checkpoints/mutations.json",
            b"{}",
            None,
            None,
        )
        .unwrap_err();

        assert_eq!(error.code, "PATH_ESCAPE");
        assert!(!outside.path().join("mutations.json").exists());
    }

    #[test]
    #[cfg(unix)]
    fn transaction_blob_ref_applies_modified_time_and_mode() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "before").unwrap();
        fs::set_permissions(
            fixture.path().join("file.txt"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        let after = b"after";
        let modified_at_ms = 1_700_000_123_456.0;
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "metadata-mode-mtime".to_owned(),
                mode: "metadataOnly".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "file.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(true),
                        sha256: Some(hex_sha256(b"before")),
                        file: Some(true),
                        directory: None,
                        identity: None,
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: after.len() as u64,
                        sha256: hex_sha256(after),
                        modified_at_ms: Some(modified_at_ms),
                        mode: Some(0o640),
                    }),
                }],
                publications: Vec::new(),
            })
            .unwrap();
        mutations
            .transaction_chunk(TransactionChunkParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "metadata-mode-mtime".to_owned(),
                blob_id: "file-after".to_owned(),
                offset: 0,
                data_base64: STANDARD.encode(after),
                sha256: Some(hex_sha256(after)),
            })
            .unwrap();

        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "metadata-mode-mtime".to_owned(),
            })
            .unwrap();

        assert_eq!(committed.status, "committed");
        let metadata = fs::metadata(fixture.path().join("file.txt")).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o640);
        let mtime_ms = metadata
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            * 1000.0;
        assert!((mtime_ms - modified_at_ms).abs() < 2.0, "{mtime_ms}");
    }

    #[test]
    fn new_file_transaction_preserves_planned_modified_time() {
        let fixture = TempDir::new().unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        let after = b"after";
        let modified_at_ms = 1_700_000_654_321.0;
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "new-file-mtime".to_owned(),
                mode: "metadataOnly".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "new.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(false),
                        sha256: None,
                        file: None,
                        directory: None,
                        identity: None,
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: after.len() as u64,
                        sha256: hex_sha256(after),
                        modified_at_ms: Some(modified_at_ms),
                        mode: None,
                    }),
                }],
                publications: Vec::new(),
            })
            .unwrap();
        mutations
            .transaction_chunk(TransactionChunkParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "new-file-mtime".to_owned(),
                blob_id: "file-after".to_owned(),
                offset: 0,
                data_base64: STANDARD.encode(after),
                sha256: Some(hex_sha256(after)),
            })
            .unwrap();

        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "new-file-mtime".to_owned(),
            })
            .unwrap();

        assert_eq!(committed.status, "committed");
        let metadata = fs::metadata(fixture.path().join("new.txt")).unwrap();
        let mtime_ms = metadata
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            * 1000.0;
        assert!((mtime_ms - modified_at_ms).abs() < 5.0, "{mtime_ms}");
        assert!((committed.entries[0].mtime_ms - modified_at_ms).abs() < 5.0);
    }

    #[test]
    fn publication_rollback_preserves_existing_blobs_and_restores_overwritten_journal() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "before").unwrap();
        let old_journal = br#"{"schemaVersion":1,"records":["old"]}"#;
        let new_journal = br#"{"schemaVersion":1,"records":["new"]}"#;
        let old_blob = b"old evidence";
        let new_blob = b"new evidence";
        let conflicting_blob = b"conflicting evidence";
        let old_blob_hash = hex_sha256(old_blob);
        let new_blob_hash = hex_sha256(new_blob);
        let conflicting_blob_hash = hex_sha256(conflicting_blob);
        fs::create_dir_all(fixture.path().join(".checkpoints/blobs")).unwrap();
        fs::write(
            fixture.path().join(".checkpoints/mutations.json"),
            old_journal,
        )
        .unwrap();
        fs::write(
            fixture
                .path()
                .join(".checkpoints/blobs")
                .join(&old_blob_hash),
            old_blob,
        )
        .unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        let after = b"after";
        let tx = "publication-rollback-preserves-old";
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: tx.to_owned(),
                mode: "privateBackup".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "file.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(true),
                        sha256: Some(hex_sha256(b"before")),
                        file: Some(true),
                        directory: None,
                        identity: None,
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: after.len() as u64,
                        sha256: hex_sha256(after),
                        modified_at_ms: None,
                        mode: None,
                    }),
                }],
                publications: vec![
                    TransactionPublicationPlan {
                        namespace: "mutationBlob".to_owned(),
                        key: old_blob_hash.clone(),
                        expected: ExpectedState {
                            exists: Some(true),
                            sha256: Some(old_blob_hash.clone()),
                            file: Some(true),
                            directory: None,
                            identity: None,
                        },
                        blob_id: "old-blob".to_owned(),
                        size: old_blob.len() as u64,
                        sha256: old_blob_hash.clone(),
                    },
                    TransactionPublicationPlan {
                        namespace: "mutationJournal".to_owned(),
                        key: "mutations.json".to_owned(),
                        expected: ExpectedState {
                            exists: Some(true),
                            sha256: Some(hex_sha256(old_journal)),
                            file: Some(true),
                            directory: None,
                            identity: None,
                        },
                        blob_id: "new-journal".to_owned(),
                        size: new_journal.len() as u64,
                        sha256: hex_sha256(new_journal),
                    },
                    TransactionPublicationPlan {
                        namespace: "mutationBlob".to_owned(),
                        key: new_blob_hash.clone(),
                        expected: ExpectedState {
                            exists: Some(false),
                            sha256: None,
                            file: None,
                            directory: None,
                            identity: None,
                        },
                        blob_id: "new-blob".to_owned(),
                        size: new_blob.len() as u64,
                        sha256: new_blob_hash.clone(),
                    },
                    TransactionPublicationPlan {
                        namespace: "mutationBlob".to_owned(),
                        key: new_blob_hash.clone(),
                        expected: ExpectedState {
                            exists: Some(false),
                            sha256: None,
                            file: None,
                            directory: None,
                            identity: None,
                        },
                        blob_id: "conflicting-blob".to_owned(),
                        size: conflicting_blob.len() as u64,
                        sha256: conflicting_blob_hash.clone(),
                    },
                ],
            })
            .unwrap();
        for (blob_id, bytes) in [
            ("file-after", after.as_slice()),
            ("old-blob", old_blob.as_slice()),
            ("new-journal", new_journal.as_slice()),
            ("new-blob", new_blob.as_slice()),
            ("conflicting-blob", conflicting_blob.as_slice()),
        ] {
            mutations
                .transaction_chunk(TransactionChunkParams {
                    lease_token: lease.lease_token.clone(),
                    transaction_id: tx.to_owned(),
                    blob_id: blob_id.to_owned(),
                    offset: 0,
                    data_base64: STANDARD.encode(bytes),
                    sha256: Some(hex_sha256(bytes)),
                })
                .unwrap();
        }

        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: tx.to_owned(),
            })
            .unwrap();

        assert_eq!(committed.status, "rolled_back");
        assert_eq!(
            fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
            "before"
        );
        assert_eq!(
            fs::read(fixture.path().join(".checkpoints/mutations.json")).unwrap(),
            old_journal
        );
        assert_eq!(
            fs::read(
                fixture
                    .path()
                    .join(".checkpoints/blobs")
                    .join(&old_blob_hash)
            )
            .unwrap(),
            old_blob
        );
        assert!(!fixture
            .path()
            .join(".checkpoints/blobs")
            .join(&new_blob_hash)
            .exists());
        let plan = read_transaction_plan(
            &fixture
                .path()
                .join(".crewforge/desktop-transactions")
                .join(tx)
                .join("transaction.json"),
        )
        .unwrap()
        .unwrap();
        assert!(plan
            .publication_receipts
            .iter()
            .any(|receipt| receipt.no_op));
        assert!(!fixture
            .path()
            .join(".crewforge/desktop-transactions")
            .join(tx)
            .join("backups")
            .exists());
    }

    #[test]
    fn private_backup_overwrite_failure_restores_preimage() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "before").unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        begin_single_write_with_conflicting_publication(
            &fixture,
            &mutations,
            &lease,
            "overwrite-private-rollback",
            "privateBackup",
            ExpectedState {
                exists: Some(true),
                sha256: Some(hex_sha256(b"before")),
                file: Some(true),
                directory: None,
                identity: None,
            },
        );
        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "overwrite-private-rollback".to_owned(),
            })
            .unwrap();
        assert_eq!(committed.status, "rolled_back");
        assert_eq!(
            fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
            "before"
        );
    }

    #[test]
    fn abort_preserves_applying_recovery_blobs_and_recover_detects_external_edit() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "external").unwrap();
        let tx_root = fixture
            .path()
            .join(".crewforge/desktop-transactions/manual");
        fs::create_dir_all(tx_root.join("blobs")).unwrap();
        fs::write(tx_root.join("blobs/file-after"), "after").unwrap();
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: "manual".to_owned(),
            phase: "applying".to_owned(),
            mode: "metadataOnly".to_owned(),
            owner: owner(),
            files: vec![TransactionFilePlan {
                path: "file.txt".to_owned(),
                operation: "write".to_owned(),
                to_path: None,
                expected: ExpectedState {
                    exists: Some(false),
                    sha256: None,
                    file: None,
                    directory: None,
                    identity: None,
                },
                output: Some(TransactionBlobRef {
                    blob_id: "file-after".to_owned(),
                    size: 5,
                    sha256: hex_sha256(b"after"),
                    modified_at_ms: None,
                    mode: None,
                }),
            }],
            publications: Vec::new(),
            entries: vec![MutationReceipt {
                path: "file.txt".to_owned(),
                previous_path: None,
                operation: "writeFile".to_owned(),
                exists: true,
                is_file: true,
                is_directory: false,
                size: 5,
                mtime_ms: now_ms(),
                sha256: hex_sha256(b"after"),
            }],
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();
        let mutations = Mutations::default();
        let admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner(),
                intent: "editor".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();
        let lease = mutations
            .writer_acquire(AcquireParams {
                admission_token: admission.admission_token,
            })
            .unwrap();
        let aborted = mutations
            .transaction_abort(TransactionAbortParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "manual".to_owned(),
            })
            .unwrap();
        assert_eq!(aborted.phase, "applying");
        assert!(tx_root.join("blobs/file-after").exists());
        let recovered = mutations
            .recover(StatusParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                transaction_id: "manual".to_owned(),
            })
            .unwrap();
        assert_eq!(recovered.status, "needs_attention");
        assert!(tx_root.join("blobs/file-after").exists());
    }

    #[test]
    fn metadata_only_transaction_allows_empty_files_append_plans_and_rejects_unfixed_keys() {
        let fixture = TempDir::new().unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "metadata-only".to_owned(),
                mode: "metadataOnly".to_owned(),
                files: Vec::new(),
                publications: vec![TransactionPublicationPlan {
                    namespace: "mutationJournal".to_owned(),
                    key: "mutations.json".to_owned(),
                    expected: ExpectedState {
                        exists: Some(false),
                        sha256: None,
                        file: None,
                        directory: None,
                        identity: None,
                    },
                    blob_id: "journal".to_owned(),
                    size: 2,
                    sha256: hex_sha256(b"{}"),
                }],
            })
            .unwrap();
        let appended = mutations
            .transaction_append_plans(TransactionAppendPlansParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "metadata-only".to_owned(),
                files: Vec::new(),
                publications: vec![TransactionPublicationPlan {
                    namespace: "repositoryIndex".to_owned(),
                    key: "meta.json".to_owned(),
                    expected: ExpectedState {
                        exists: Some(false),
                        sha256: None,
                        file: None,
                        directory: None,
                        identity: None,
                    },
                    blob_id: "index-meta".to_owned(),
                    size: 2,
                    sha256: hex_sha256(b"{}"),
                }],
            })
            .unwrap();
        assert_eq!(appended.file_count, 0);
        assert_eq!(appended.publication_count, 2);
        match mutations.transaction_append_plans(TransactionAppendPlansParams {
            lease_token: lease.lease_token.clone(),
            transaction_id: "metadata-only".to_owned(),
            files: Vec::new(),
            publications: vec![TransactionPublicationPlan {
                namespace: "mutationJournal".to_owned(),
                key: "evil.json".to_owned(),
                expected: ExpectedState {
                    exists: Some(false),
                    sha256: None,
                    file: None,
                    directory: None,
                    identity: None,
                },
                blob_id: "evil".to_owned(),
                size: 2,
                sha256: hex_sha256(b"{}"),
            }],
        }) {
            Ok(_) => panic!("unexpectedly accepted arbitrary mutation journal key"),
            Err(error) => assert_eq!(error.code, "PATH_ESCAPE"),
        }
    }

    #[test]
    fn transaction_chunk_rejects_undeclared_blob_and_accepts_identical_retry() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "before").unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        let after = b"after";
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "chunk-declared".to_owned(),
                mode: "metadataOnly".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "file.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(true),
                        sha256: Some(hex_sha256(b"before")),
                        file: Some(true),
                        directory: None,
                        identity: None,
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: after.len() as u64,
                        sha256: hex_sha256(after),
                        modified_at_ms: None,
                        mode: None,
                    }),
                }],
                publications: Vec::new(),
            })
            .unwrap();
        let undeclared = expect_core_error(mutations.transaction_chunk(TransactionChunkParams {
            lease_token: lease.lease_token.clone(),
            transaction_id: "chunk-declared".to_owned(),
            blob_id: "other".to_owned(),
            offset: 0,
            data_base64: STANDARD.encode(b"x"),
            sha256: None,
        }));
        assert_eq!(undeclared.code, "CONFLICT");

        let first = mutations
            .transaction_chunk(TransactionChunkParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "chunk-declared".to_owned(),
                blob_id: "file-after".to_owned(),
                offset: 0,
                data_base64: STANDARD.encode(b"af"),
                sha256: Some(hex_sha256(after)),
            })
            .unwrap();
        assert_eq!(first.received_bytes, 2);
        let retry = mutations
            .transaction_chunk(TransactionChunkParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "chunk-declared".to_owned(),
                blob_id: "file-after".to_owned(),
                offset: 0,
                data_base64: STANDARD.encode(b"af"),
                sha256: Some(hex_sha256(after)),
            })
            .unwrap();
        assert_eq!(retry.received_bytes, 2);
        assert_eq!(
            fs::metadata(
                fixture
                    .path()
                    .join(".crewforge/desktop-transactions/chunk-declared/blobs/file-after")
            )
            .unwrap()
            .len(),
            2
        );
        let complete = mutations
            .transaction_chunk(TransactionChunkParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "chunk-declared".to_owned(),
                blob_id: "file-after".to_owned(),
                offset: 2,
                data_base64: STANDARD.encode(b"ter"),
                sha256: Some(hex_sha256(after)),
            })
            .unwrap();
        assert!(complete.complete);
    }

    #[test]
    fn transaction_chunk_requires_plan_owner_and_begun_phase() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "before").unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        let after = b"after";
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "chunk-owner".to_owned(),
                mode: "metadataOnly".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "file.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(true),
                        sha256: Some(hex_sha256(b"before")),
                        file: Some(true),
                        directory: None,
                        identity: None,
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: after.len() as u64,
                        sha256: hex_sha256(after),
                        modified_at_ms: None,
                        mode: None,
                    }),
                }],
                publications: Vec::new(),
            })
            .unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        let tx_root = transaction_root(&workspace, "chunk-owner").unwrap();
        let mut plan = read_transaction_plan(&tx_root.join("transaction.json"))
            .unwrap()
            .unwrap();
        plan.phase = "prepared".to_owned();
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();
        let phase_error = expect_core_error(mutations.transaction_chunk(TransactionChunkParams {
            lease_token: lease.lease_token.clone(),
            transaction_id: "chunk-owner".to_owned(),
            blob_id: "file-after".to_owned(),
            offset: 0,
            data_base64: STANDARD.encode(after),
            sha256: Some(hex_sha256(after)),
        }));
        assert_eq!(phase_error.code, "CONFLICT");
        plan.phase = "begun".to_owned();
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();
        mutations
            .writer_release(ReleaseParams {
                lease_token: lease.lease_token.clone(),
            })
            .unwrap();
        let other_admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: WriterOwner {
                    kind: "agent".to_owned(),
                    id: "other".to_owned(),
                },
                intent: "agent-edit".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();
        let other_lease = mutations
            .writer_acquire(AcquireParams {
                admission_token: other_admission.admission_token,
            })
            .unwrap();
        let owner_error = expect_core_error(mutations.transaction_chunk(TransactionChunkParams {
            lease_token: other_lease.lease_token.clone(),
            transaction_id: "chunk-owner".to_owned(),
            blob_id: "file-after".to_owned(),
            offset: 0,
            data_base64: STANDARD.encode(after),
            sha256: Some(hex_sha256(after)),
        }));
        assert_eq!(owner_error.code, "CONFLICT");
    }

    #[test]
    fn transaction_begin_rejects_oversized_declared_blob() {
        let fixture = TempDir::new().unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        let error = expect_core_error(mutations.transaction_begin(TransactionBeginParams {
            lease_token: lease.lease_token.clone(),
            transaction_id: "too-large".to_owned(),
            mode: "metadataOnly".to_owned(),
            files: vec![TransactionFilePlan {
                path: "file.txt".to_owned(),
                operation: "write".to_owned(),
                to_path: None,
                expected: ExpectedState {
                    exists: Some(false),
                    sha256: None,
                    file: None,
                    directory: None,
                    identity: None,
                },
                output: Some(TransactionBlobRef {
                    blob_id: "file-after".to_owned(),
                    size: MAX_WRITE_BYTES as u64 + 1,
                    sha256: hex_sha256(b"after"),
                    modified_at_ms: None,
                    mode: None,
                }),
            }],
            publications: Vec::new(),
        }));
        assert_eq!(error.code, "LIMIT_EXCEEDED");
    }

    #[test]
    fn writer_release_rejects_applying_owned_transaction() {
        let fixture = TempDir::new().unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        let workspace = Workspace::open(fixture.path()).unwrap();
        let tx_root = transaction_root(&workspace, "manual-applying").unwrap();
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: "manual-applying".to_owned(),
            phase: "applying".to_owned(),
            mode: "metadataOnly".to_owned(),
            owner: lease.owner.clone(),
            files: Vec::new(),
            publications: Vec::new(),
            entries: Vec::new(),
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();

        let error = expect_core_error(mutations.writer_release(ReleaseParams {
            lease_token: lease.lease_token.clone(),
        }));

        assert_eq!(error.code, "CONFLICT");
    }

    #[test]
    fn first_empty_transaction_chunk_creates_declared_blob() {
        let fixture = TempDir::new().unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "empty-chunk".to_owned(),
                mode: "metadataOnly".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "empty.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(false),
                        sha256: None,
                        file: None,
                        directory: None,
                        identity: None,
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "empty".to_owned(),
                        size: 0,
                        sha256: hex_sha256(b""),
                        modified_at_ms: None,
                        mode: None,
                    }),
                }],
                publications: Vec::new(),
            })
            .unwrap();

        let chunk = mutations
            .transaction_chunk(TransactionChunkParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "empty-chunk".to_owned(),
                blob_id: "empty".to_owned(),
                offset: 0,
                data_base64: STANDARD.encode(b""),
                sha256: Some(hex_sha256(b"")),
            })
            .unwrap();

        assert!(chunk.complete);
        let blob = fixture
            .path()
            .join(".crewforge/desktop-transactions/empty-chunk/blobs/empty");
        assert_eq!(fs::metadata(blob).unwrap().len(), 0);
    }

    #[test]
    fn append_commit_and_abort_require_transaction_owner() {
        let fixture = TempDir::new().unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "owner-bound".to_owned(),
                mode: "metadataOnly".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "file.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(false),
                        sha256: None,
                        file: None,
                        directory: None,
                        identity: None,
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: 5,
                        sha256: hex_sha256(b"after"),
                        modified_at_ms: None,
                        mode: None,
                    }),
                }],
                publications: Vec::new(),
            })
            .unwrap();
        mutations
            .writer_release(ReleaseParams {
                lease_token: lease.lease_token.clone(),
            })
            .unwrap();
        let other_admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: WriterOwner {
                    kind: "agent".to_owned(),
                    id: "other".to_owned(),
                },
                intent: "agent-edit".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();
        let other_lease = mutations
            .writer_acquire(AcquireParams {
                admission_token: other_admission.admission_token,
            })
            .unwrap();

        let append = expect_core_error(mutations.transaction_append_plans(
            TransactionAppendPlansParams {
                lease_token: other_lease.lease_token.clone(),
                transaction_id: "owner-bound".to_owned(),
                files: Vec::new(),
                publications: Vec::new(),
            },
        ));
        assert_eq!(append.code, "CONFLICT");
        let commit = expect_core_error(mutations.transaction_commit(TransactionCommitParams {
            lease_token: other_lease.lease_token.clone(),
            transaction_id: "owner-bound".to_owned(),
        }));
        assert_eq!(commit.code, "CONFLICT");
        let abort = expect_core_error(mutations.transaction_abort(TransactionAbortParams {
            lease_token: other_lease.lease_token.clone(),
            transaction_id: "owner-bound".to_owned(),
        }));
        assert_eq!(abort.code, "CONFLICT");
    }

    #[test]
    #[cfg(unix)]
    fn lease_rejects_same_path_replaced_workspace_root() {
        let fixture = TempDir::new().unwrap();
        let root = fixture.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let mutations = Mutations::default();
        let admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: root.to_string_lossy().into_owned(),
                owner: owner(),
                intent: "agent-edit".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();
        let lease = mutations
            .writer_acquire(AcquireParams {
                admission_token: admission.admission_token,
            })
            .unwrap();
        fs::rename(&root, fixture.path().join("workspace-old")).unwrap();
        fs::create_dir(&root).unwrap();

        let error = expect_core_error(mutations.transaction_begin(TransactionBeginParams {
            lease_token: lease.lease_token.clone(),
            transaction_id: "root-replaced".to_owned(),
            mode: "metadataOnly".to_owned(),
            files: vec![TransactionFilePlan {
                path: "file.txt".to_owned(),
                operation: "write".to_owned(),
                to_path: None,
                expected: ExpectedState {
                    exists: Some(false),
                    sha256: None,
                    file: None,
                    directory: None,
                    identity: None,
                },
                output: Some(TransactionBlobRef {
                    blob_id: "file-after".to_owned(),
                    size: 5,
                    sha256: hex_sha256(b"after"),
                    modified_at_ms: None,
                    mode: None,
                }),
            }],
            publications: Vec::new(),
        }));

        assert_eq!(error.code, "PATH_ESCAPE");
    }

    #[test]
    fn committed_transaction_cleans_blobs_and_private_backups() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "before").unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);
        let after = b"after";
        mutations
            .transaction_begin(TransactionBeginParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "cleanup-terminal".to_owned(),
                mode: "privateBackup".to_owned(),
                files: vec![TransactionFilePlan {
                    path: "file.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(true),
                        sha256: Some(hex_sha256(b"before")),
                        file: Some(true),
                        directory: None,
                        identity: None,
                    },
                    output: Some(TransactionBlobRef {
                        blob_id: "file-after".to_owned(),
                        size: after.len() as u64,
                        sha256: hex_sha256(after),
                        modified_at_ms: None,
                        mode: None,
                    }),
                }],
                publications: Vec::new(),
            })
            .unwrap();
        mutations
            .transaction_chunk(TransactionChunkParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "cleanup-terminal".to_owned(),
                blob_id: "file-after".to_owned(),
                offset: 0,
                data_base64: STANDARD.encode(after),
                sha256: Some(hex_sha256(after)),
            })
            .unwrap();

        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "cleanup-terminal".to_owned(),
            })
            .unwrap();

        assert_eq!(committed.status, "committed");
        let tx_root = fixture
            .path()
            .join(".crewforge/desktop-transactions/cleanup-terminal");
        assert!(!tx_root.join("blobs").exists());
        assert!(!tx_root.join("backups").exists());
        assert_eq!(
            fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
            "after"
        );
    }

    #[test]
    fn recover_committing_needs_attention_without_rollback() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "after").unwrap();
        let tx_root = fixture
            .path()
            .join(".crewforge/desktop-transactions/commit-marker-missing");
        fs::create_dir_all(tx_root.join("blobs")).unwrap();
        fs::write(tx_root.join("blobs/file-after"), "after").unwrap();
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: "commit-marker-missing".to_owned(),
            phase: "committing".to_owned(),
            mode: "metadataOnly".to_owned(),
            owner: owner(),
            files: Vec::new(),
            publications: Vec::new(),
            entries: vec![MutationReceipt {
                path: "file.txt".to_owned(),
                previous_path: None,
                operation: "writeFile".to_owned(),
                exists: true,
                is_file: true,
                is_directory: false,
                size: 5,
                mtime_ms: now_ms(),
                sha256: hex_sha256(b"after"),
            }],
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();

        let recovered = Mutations::default()
            .recover(StatusParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                transaction_id: "commit-marker-missing".to_owned(),
            })
            .unwrap();

        assert_eq!(recovered.status, "needs_attention");
        assert_eq!(
            fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
            "after"
        );
        assert!(tx_root.join("blobs/file-after").exists());
    }

    #[test]
    fn recover_unrecorded_created_file_side_effect_needs_attention() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("new.txt"), "after").unwrap();
        let tx_root = fixture
            .path()
            .join(".crewforge/desktop-transactions/unrecorded-new");
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: "unrecorded-new".to_owned(),
            phase: "applying".to_owned(),
            mode: "metadataOnly".to_owned(),
            owner: owner(),
            files: vec![TransactionFilePlan {
                path: "new.txt".to_owned(),
                operation: "write".to_owned(),
                to_path: None,
                expected: ExpectedState {
                    exists: Some(false),
                    sha256: None,
                    file: None,
                    directory: None,
                    identity: None,
                },
                output: None,
            }],
            publications: Vec::new(),
            entries: Vec::new(),
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();

        let recovered = Mutations::default()
            .recover(StatusParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                transaction_id: "unrecorded-new".to_owned(),
            })
            .unwrap();

        assert_eq!(recovered.status, "needs_attention");
        assert_eq!(
            fs::read_to_string(fixture.path().join("new.txt")).unwrap(),
            "after"
        );
    }

    #[test]
    fn recover_unrecorded_overwrite_side_effect_needs_attention() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "after").unwrap();
        let tx_root = fixture
            .path()
            .join(".crewforge/desktop-transactions/unrecorded-overwrite");
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: "unrecorded-overwrite".to_owned(),
            phase: "applying".to_owned(),
            mode: "metadataOnly".to_owned(),
            owner: owner(),
            files: vec![TransactionFilePlan {
                path: "file.txt".to_owned(),
                operation: "write".to_owned(),
                to_path: None,
                expected: ExpectedState {
                    exists: Some(true),
                    sha256: Some(hex_sha256(b"before")),
                    file: Some(true),
                    directory: None,
                    identity: None,
                },
                output: None,
            }],
            publications: Vec::new(),
            entries: Vec::new(),
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();

        let recovered = Mutations::default()
            .recover(StatusParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                transaction_id: "unrecorded-overwrite".to_owned(),
            })
            .unwrap();

        assert_eq!(recovered.status, "needs_attention");
        assert_eq!(
            fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
            "after"
        );
    }

    #[test]
    fn recover_unrecorded_publication_side_effect_needs_attention() {
        let fixture = TempDir::new().unwrap();
        fs::create_dir_all(fixture.path().join(".checkpoints")).unwrap();
        fs::write(
            fixture.path().join(".checkpoints/mutations.json"),
            "new journal",
        )
        .unwrap();
        let tx_root = fixture
            .path()
            .join(".crewforge/desktop-transactions/unrecorded-publication");
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: "unrecorded-publication".to_owned(),
            phase: "applying".to_owned(),
            mode: "metadataOnly".to_owned(),
            owner: owner(),
            files: Vec::new(),
            publications: vec![TransactionPublicationPlan {
                namespace: "mutationJournal".to_owned(),
                key: "mutations.json".to_owned(),
                expected: ExpectedState {
                    exists: Some(false),
                    sha256: None,
                    file: None,
                    directory: None,
                    identity: None,
                },
                blob_id: "journal".to_owned(),
                size: 11,
                sha256: hex_sha256(b"new journal"),
            }],
            entries: Vec::new(),
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();

        let recovered = Mutations::default()
            .recover(StatusParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                transaction_id: "unrecorded-publication".to_owned(),
            })
            .unwrap();

        assert_eq!(recovered.status, "needs_attention");
        assert_eq!(
            fs::read_to_string(fixture.path().join(".checkpoints/mutations.json")).unwrap(),
            "new journal"
        );
    }

    #[test]
    fn recover_untouched_unrecorded_plans_allow_recorded_rollback() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("created.txt"), "after").unwrap();
        fs::create_dir(fixture.path().join("existing-dir")).unwrap();
        let tx_root = fixture
            .path()
            .join(".crewforge/desktop-transactions/unrecorded-untouched");
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: "unrecorded-untouched".to_owned(),
            phase: "applying".to_owned(),
            mode: "metadataOnly".to_owned(),
            owner: owner(),
            files: vec![
                TransactionFilePlan {
                    path: "created.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(false),
                        sha256: None,
                        file: None,
                        directory: None,
                        identity: None,
                    },
                    output: None,
                },
                TransactionFilePlan {
                    path: "untouched.txt".to_owned(),
                    operation: "write".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(false),
                        sha256: None,
                        file: None,
                        directory: None,
                        identity: None,
                    },
                    output: None,
                },
                TransactionFilePlan {
                    path: "existing-dir".to_owned(),
                    operation: "mkdir".to_owned(),
                    to_path: None,
                    expected: ExpectedState {
                        exists: Some(true),
                        sha256: None,
                        file: None,
                        directory: Some(true),
                        identity: None,
                    },
                    output: None,
                },
            ],
            publications: vec![TransactionPublicationPlan {
                namespace: "mutationJournal".to_owned(),
                key: "mutations.json".to_owned(),
                expected: ExpectedState {
                    exists: Some(false),
                    sha256: None,
                    file: None,
                    directory: None,
                    identity: None,
                },
                blob_id: "journal".to_owned(),
                size: 2,
                sha256: hex_sha256(b"{}"),
            }],
            entries: vec![MutationReceipt {
                path: "created.txt".to_owned(),
                previous_path: None,
                operation: "writeFile".to_owned(),
                exists: true,
                is_file: true,
                is_directory: false,
                size: 5,
                mtime_ms: now_ms(),
                sha256: hex_sha256(b"after"),
            }],
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();

        let recovered = Mutations::default()
            .recover(StatusParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                transaction_id: "unrecorded-untouched".to_owned(),
            })
            .unwrap();

        assert_eq!(recovered.status, "rolled_back");
        assert!(!fixture.path().join("created.txt").exists());
        assert!(!fixture.path().join("untouched.txt").exists());
        assert!(fixture.path().join("existing-dir").is_dir());
    }

    #[test]
    #[cfg(unix)]
    fn recursive_delete_rejects_hardlinked_descendant() {
        let fixture = TempDir::new().unwrap();
        fs::create_dir(fixture.path().join("dir")).unwrap();
        fs::write(fixture.path().join("dir/file.txt"), "secret").unwrap();
        fs::hard_link(
            fixture.path().join("dir/file.txt"),
            fixture.path().join("outside-link.txt"),
        )
        .unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();

        let error = expect_core_error(prepare_operation(
            &workspace,
            MutationOperation::Delete {
                path: "dir".to_owned(),
                recursive: true,
            },
        ));

        assert_eq!(error.code, "PATH_ESCAPE");
        assert!(fixture.path().join("dir/file.txt").exists());
    }

    #[test]
    fn repository_index_keys_are_fixed_to_meta_and_two_hex_shards() {
        for key in ["meta.json", "shards/00.json", "shards/af.json"] {
            validate_publication(&TransactionPublicationPlan {
                namespace: "repositoryIndex".to_owned(),
                key: key.to_owned(),
                expected: ExpectedState {
                    exists: Some(false),
                    sha256: None,
                    file: None,
                    directory: None,
                    identity: None,
                },
                blob_id: "blob".to_owned(),
                size: 2,
                sha256: hex_sha256(b"{}"),
            })
            .unwrap();
        }
        for key in [
            "lock",
            "rebuild.lock",
            "shards/abc.json",
            "shards/AF.json",
            "shards/zz.json",
        ] {
            let error = expect_core_error(validate_publication(&TransactionPublicationPlan {
                namespace: "repositoryIndex".to_owned(),
                key: key.to_owned(),
                expected: ExpectedState {
                    exists: Some(false),
                    sha256: None,
                    file: None,
                    directory: None,
                    identity: None,
                },
                blob_id: "blob".to_owned(),
                size: 2,
                sha256: hex_sha256(b"{}"),
            }));
            assert_eq!(error.code, "PATH_ESCAPE");
        }
    }

    fn agent_owner(id: &str) -> WriterOwner {
        WriterOwner {
            kind: "agent".to_owned(),
            id: id.to_owned(),
        }
    }

    #[test]
    fn external_guard_blocks_agent_writes_and_allows_editor_index_and_same_owner_audit() {
        let fixture = TempDir::new().unwrap();
        let mutations = Mutations::default();
        let external_owner = agent_owner("external");
        let external = mutations
            .writer_external_begin(ExternalBeginParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: external_owner.clone(),
                intent: "external-process".to_owned(),
                owner_pid: None,
            })
            .unwrap();

        for intent in ["user-save", "editor", "index", "repository-index"] {
            mutations
                .writer_admit(AdmitParams {
                    workspace_dir: fixture.path().to_string_lossy().into_owned(),
                    owner: owner(),
                    intent: intent.to_owned(),
                    ttl_ms: Some(30_000),
                    external_token: None,
                })
                .unwrap();
        }
        for intent in ["agent-edit", "rollback", "checkpoint", "changeset"] {
            let error = expect_core_error(mutations.writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: agent_owner("blocked"),
                intent: intent.to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            }));
            assert_eq!(error.code, "BUSY");
        }
        let audit_admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: external_owner,
                intent: "external-audit".to_owned(),
                ttl_ms: Some(30_000),
                external_token: Some(external.external_token.clone()),
            })
            .unwrap();
        let audit_lease = mutations
            .writer_acquire(AcquireParams {
                admission_token: audit_admission.admission_token,
            })
            .unwrap();
        mutations
            .writer_release(ReleaseParams {
                lease_token: audit_lease.lease_token,
            })
            .unwrap();

        let second = expect_core_error(mutations.writer_external_begin(ExternalBeginParams {
            workspace_dir: fixture.path().to_string_lossy().into_owned(),
            owner: agent_owner("second"),
            intent: "external-process".to_owned(),
            owner_pid: None,
        }));
        assert_eq!(second.code, "BUSY");
        let wrong = mutations
            .writer_external_end(ExternalEndParams {
                external_token: "wrong".to_owned(),
                workspace_dir: None,
            })
            .unwrap();
        assert!(!wrong.released);
        let ended = mutations
            .writer_external_end(ExternalEndParams {
                external_token: external.external_token,
                workspace_dir: None,
            })
            .unwrap();
        assert!(ended.released);
    }

    #[test]
    fn external_begin_rejects_active_workspace_writer() {
        let fixture = TempDir::new().unwrap();
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);

        let error = expect_core_error(mutations.writer_external_begin(ExternalBeginParams {
            workspace_dir: fixture.path().to_string_lossy().into_owned(),
            owner: agent_owner("external"),
            intent: "external-process".to_owned(),
            owner_pid: None,
        }));

        assert_eq!(error.code, "BUSY");
        mutations
            .writer_release(ReleaseParams {
                lease_token: lease.lease_token,
            })
            .unwrap();
    }

    #[test]
    fn external_end_rejects_owned_applying_transaction_and_keeps_lock() {
        let fixture = TempDir::new().unwrap();
        let mutations = Mutations::default();
        let external_owner = agent_owner("external");
        let external = mutations
            .writer_external_begin(ExternalBeginParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: external_owner.clone(),
                intent: "external-process".to_owned(),
                owner_pid: None,
            })
            .unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        let tx_root = transaction_root(&workspace, "external-applying").unwrap();
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: "external-applying".to_owned(),
            phase: "applying".to_owned(),
            mode: "metadataOnly".to_owned(),
            owner: external_owner,
            files: Vec::new(),
            publications: Vec::new(),
            entries: Vec::new(),
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();

        let error = expect_core_error(mutations.writer_external_end(ExternalEndParams {
            external_token: external.external_token.clone(),
            workspace_dir: None,
        }));

        assert_eq!(error.code, "CONFLICT");
        assert!(external_lock_path(&workspace).unwrap().exists());
    }

    #[test]
    #[cfg(unix)]
    fn external_end_rejects_same_path_replaced_workspace_root() {
        let fixture = TempDir::new().unwrap();
        let root = fixture.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let mutations = Mutations::default();
        let external = mutations
            .writer_external_begin(ExternalBeginParams {
                workspace_dir: root.to_string_lossy().into_owned(),
                owner: agent_owner("external"),
                intent: "external-process".to_owned(),
                owner_pid: None,
            })
            .unwrap();
        fs::rename(&root, fixture.path().join("workspace-old")).unwrap();
        fs::create_dir(&root).unwrap();

        let error = expect_core_error(mutations.writer_external_end(ExternalEndParams {
            external_token: external.external_token,
            workspace_dir: None,
        }));

        assert_eq!(error.code, "PATH_ESCAPE");
    }

    #[test]
    fn external_begin_recovers_dead_owner_lock() {
        let fixture = TempDir::new().unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        let root_identity = directory_identity(workspace.root()).unwrap();
        let lock_path = external_lock_path(&workspace).unwrap();
        fs::create_dir_all(parent(&lock_path).unwrap()).unwrap();
        let stale = ExternalLockFile {
            pid: 999_999,
            token: "dead-token".to_owned(),
            owner: agent_owner("dead"),
            intent: "external-process".to_owned(),
            root_identity: persisted_identity(&root_identity),
            created_at_ms: now_ms(),
        };
        fs::write(&lock_path, serde_json::to_string(&stale).unwrap()).unwrap();
        let mutations = Mutations::default();

        let external = mutations
            .writer_external_begin(ExternalBeginParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: agent_owner("external"),
                intent: "external-process".to_owned(),
                owner_pid: None,
            })
            .unwrap();

        assert_ne!(external.external_token, "dead-token");
        let lock = read_external_lock(&lock_path).unwrap().unwrap();
        assert_eq!(lock.token, external.external_token);
    }

    fn write_manual_plan(fixture: &TempDir, tx: &str, phase: &str) -> PathBuf {
        let tx_root = fixture
            .path()
            .join(".crewforge/desktop-transactions")
            .join(tx);
        fs::create_dir_all(&tx_root).unwrap();
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: tx.to_owned(),
            phase: phase.to_owned(),
            mode: "metadataOnly".to_owned(),
            owner: owner(),
            files: Vec::new(),
            publications: Vec::new(),
            entries: Vec::new(),
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();
        tx_root
    }

    #[test]
    fn agent_acquire_prunes_old_terminal_receipts_but_keeps_limit_latest() {
        let fixture = TempDir::new().unwrap();
        let tx_dir = fixture.path().join(".crewforge/desktop-transactions");
        let count = TERMINAL_TRANSACTION_RECEIPT_LIMIT + 5;
        for index in 0..count {
            let tx_root = write_manual_plan(&fixture, &format!("terminal-{index:02}"), "committed");
            fs::create_dir_all(tx_root.join("blobs")).unwrap();
            fs::write(tx_root.join("blobs/payload"), b"payload").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let mutations = Mutations::default();
        let lease = lease_for(&fixture, &mutations);

        let mut remaining: Vec<_> = fs::read_dir(&tx_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("terminal-"))
            .collect();
        remaining.sort();

        assert_eq!(remaining.len(), TERMINAL_TRANSACTION_RECEIPT_LIMIT);
        assert_eq!(
            remaining[0],
            format!(
                "terminal-{0:02}",
                count - TERMINAL_TRANSACTION_RECEIPT_LIMIT
            )
        );
        assert!(!tx_dir.join("terminal-00").exists());
        assert!(!tx_dir.join("terminal-01/blobs/payload").exists());
        mutations
            .writer_release(ReleaseParams {
                lease_token: lease.lease_token,
            })
            .unwrap();
    }

    #[test]
    fn terminal_receipt_pruning_preserves_unresolved_transactions() {
        let fixture = TempDir::new().unwrap();
        for index in 0..(TERMINAL_TRANSACTION_RECEIPT_LIMIT + 3) {
            write_manual_plan(&fixture, &format!("terminal-{index:02}"), "rolled_back");
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let unresolved = write_manual_plan(&fixture, "manual-attention", "needs_attention");
        let mutations = Mutations::default();
        let admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner(),
                intent: "agent-edit".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();

        let error = expect_core_error(mutations.writer_acquire(AcquireParams {
            admission_token: admission.admission_token,
        }));

        assert_eq!(error.code, "CONFLICT");
        assert!(error.message.contains("manual-attention"));
        assert!(unresolved.join("transaction.json").exists());
    }

    #[test]
    fn agent_acquire_recovers_applying_transaction_before_granting_lease() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("created.txt"), "after").unwrap();
        let tx_root = fixture
            .path()
            .join(".crewforge/desktop-transactions/applying-create");
        fs::create_dir_all(&tx_root).unwrap();
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: "applying-create".to_owned(),
            phase: "applying".to_owned(),
            mode: "metadataOnly".to_owned(),
            owner: owner(),
            files: vec![TransactionFilePlan {
                path: "created.txt".to_owned(),
                operation: "write".to_owned(),
                to_path: None,
                expected: ExpectedState {
                    exists: Some(false),
                    sha256: None,
                    file: None,
                    directory: None,
                    identity: None,
                },
                output: Some(TransactionBlobRef {
                    blob_id: "file-after".to_owned(),
                    size: 5,
                    sha256: hex_sha256(b"after"),
                    modified_at_ms: None,
                    mode: None,
                }),
            }],
            publications: Vec::new(),
            entries: vec![MutationReceipt {
                path: "created.txt".to_owned(),
                previous_path: None,
                operation: "writeFile".to_owned(),
                exists: true,
                is_file: true,
                is_directory: false,
                size: 5,
                mtime_ms: now_ms(),
                sha256: hex_sha256(b"after"),
            }],
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();
        let mutations = Mutations::default();
        let admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner(),
                intent: "agent-edit".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();

        let lease = mutations
            .writer_acquire(AcquireParams {
                admission_token: admission.admission_token,
            })
            .unwrap();

        assert!(!fixture.path().join("created.txt").exists());
        let recovered = read_transaction_plan(&tx_root.join("transaction.json"))
            .unwrap()
            .unwrap();
        assert_eq!(recovered.phase, "rolled_back");
        mutations
            .writer_release(ReleaseParams {
                lease_token: lease.lease_token,
            })
            .unwrap();
    }

    #[test]
    fn agent_acquire_rejects_committing_transaction_but_editor_can_acquire() {
        let fixture = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "after").unwrap();
        let tx_root = fixture
            .path()
            .join(".crewforge/desktop-transactions/unknown-commit");
        fs::create_dir_all(tx_root.join("blobs")).unwrap();
        fs::write(tx_root.join("blobs/file-after"), "after").unwrap();
        let plan = TransactionPlan {
            schema_version: 1,
            transaction_id: "unknown-commit".to_owned(),
            phase: "committing".to_owned(),
            mode: "metadataOnly".to_owned(),
            owner: owner(),
            files: Vec::new(),
            publications: Vec::new(),
            entries: vec![MutationReceipt {
                path: "file.txt".to_owned(),
                previous_path: None,
                operation: "writeFile".to_owned(),
                exists: true,
                is_file: true,
                is_directory: false,
                size: 5,
                mtime_ms: now_ms(),
                sha256: hex_sha256(b"after"),
            }],
            publication_receipts: Vec::new(),
            attention: None,
        };
        write_transaction_plan(&tx_root.join("transaction.json"), &plan).unwrap();
        let mutations = Mutations::default();
        let agent_admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner(),
                intent: "agent-edit".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();

        let error = expect_core_error(mutations.writer_acquire(AcquireParams {
            admission_token: agent_admission.admission_token,
        }));

        assert_eq!(error.code, "CONFLICT");
        assert!(error.message.contains("unknown-commit"));
        assert_eq!(
            fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
            "after"
        );
        let recovered = read_transaction_plan(&tx_root.join("transaction.json"))
            .unwrap()
            .unwrap();
        assert_eq!(recovered.phase, "needs_attention");
        assert!(tx_root.join("blobs/file-after").exists());

        let editor_admission = mutations
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner(),
                intent: "editor".to_owned(),
                ttl_ms: Some(30_000),
                external_token: None,
            })
            .unwrap();
        let editor_lease = mutations
            .writer_acquire(AcquireParams {
                admission_token: editor_admission.admission_token,
            })
            .unwrap();
        mutations
            .writer_release(ReleaseParams {
                lease_token: editor_lease.lease_token,
            })
            .unwrap();
    }

    #[test]
    fn external_guard_survives_core_restart_for_audit_and_end() {
        let fixture = TempDir::new().unwrap();
        let owner = agent_owner("external");
        let core_a = Mutations::default();
        let external = core_a
            .writer_external_begin(ExternalBeginParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner.clone(),
                intent: "external-process".to_owned(),
                owner_pid: Some(std::process::id()),
            })
            .unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        let lock_path = external_lock_path(&workspace).unwrap();
        assert!(lock_path.exists());
        drop(core_a);
        assert!(lock_path.exists());

        let core_b = Mutations::default();
        let audit = core_b
            .writer_admit(AdmitParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner.clone(),
                intent: "external-audit".to_owned(),
                ttl_ms: Some(30_000),
                external_token: Some(external.external_token.clone()),
            })
            .unwrap();
        let lease = core_b
            .writer_acquire(AcquireParams {
                admission_token: audit.admission_token,
            })
            .unwrap();
        core_b
            .writer_release(ReleaseParams {
                lease_token: lease.lease_token,
            })
            .unwrap();
        let ended = core_b
            .writer_external_end(ExternalEndParams {
                external_token: external.external_token,
                workspace_dir: Some(fixture.path().to_string_lossy().into_owned()),
            })
            .unwrap();

        assert!(ended.released);
        assert!(!lock_path.exists());
    }

    #[test]
    fn external_begin_retry_same_owner_pid_returns_existing_token() {
        let fixture = TempDir::new().unwrap();
        let mutations = Mutations::default();
        let owner = agent_owner("external");
        let owner_pid = std::process::id();
        let first = mutations
            .writer_external_begin(ExternalBeginParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner: owner.clone(),
                intent: "external-process".to_owned(),
                owner_pid: Some(owner_pid),
            })
            .unwrap();
        let retry = mutations
            .writer_external_begin(ExternalBeginParams {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                owner,
                intent: "external-process".to_owned(),
                owner_pid: Some(owner_pid),
            })
            .unwrap();
        let other = expect_core_error(mutations.writer_external_begin(ExternalBeginParams {
            workspace_dir: fixture.path().to_string_lossy().into_owned(),
            owner: agent_owner("other"),
            intent: "external-process".to_owned(),
            owner_pid: Some(owner_pid),
        }));

        assert_eq!(first.external_token, retry.external_token);
        assert_eq!(other.code, "BUSY");
    }
}
