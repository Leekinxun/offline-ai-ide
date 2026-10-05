#![allow(dead_code)]

use crate::{
    error::{CoreError, Result},
    workspace::Workspace,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_OPERATIONS: usize = 20_000;
const MAX_WRITE_BYTES: usize = 64 * 1024 * 1024;
const TX_DIR: &str = ".crewforge/desktop-transactions";

#[derive(Default)]
pub struct Mutations {
    state: Mutex<WriterState>,
}

#[derive(Default)]
struct WriterState {
    admissions: HashMap<String, Admission>,
    leases: HashMap<String, Lease>,
}

#[derive(Clone)]
struct Admission {
    canonical_root: PathBuf,
    owner: WriterOwner,
    intent: String,
    expires_at_ms: f64,
}

#[derive(Clone)]
struct Lease {
    admission_token: String,
    canonical_root: PathBuf,
    owner: WriterOwner,
    lock_path: PathBuf,
    expires_at_ms: f64,
}

#[derive(Deserialize, Serialize, Clone)]
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

#[derive(Deserialize, Serialize, Clone)]
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmitParams {
    pub workspace_dir: String,
    pub owner: WriterOwner,
    pub intent: String,
    #[serde(default)]
    pub ttl_ms: Option<u64>,
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

#[derive(Deserialize, Serialize, Clone)]
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

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransactionPublicationPlan {
    pub namespace: String,
    pub key: String,
    pub expected: ExpectedState,
    pub blob_id: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Deserialize, Serialize, Clone)]
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
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct PreparedOp {
    operation: MutationOperation,
    path: String,
    new_path: Option<String>,
    staged: Option<PathBuf>,
    bytes: Option<Vec<u8>>,
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

impl Mutations {
    pub fn writer_admit(&self, params: AdmitParams) -> Result<AdmitResponse> {
        validate_owner(&params.owner)?;
        if params.intent.trim().is_empty() || params.intent.len() > 128 {
            return Err(CoreError::invalid("Invalid writer intent"));
        }
        let workspace = Workspace::open(&params.workspace_dir)?;
        let token = opaque_token("admit");
        let ttl = params.ttl_ms.unwrap_or(30_000).clamp(1_000, 300_000) as f64;
        let expires_at_ms = now_ms() + ttl;
        let admission = Admission {
            canonical_root: workspace.root().to_path_buf(),
            owner: params.owner,
            intent: params.intent,
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
        let workspace = Workspace::open(&admission.canonical_root)?;
        let tx_root = metadata_dir(&workspace, TX_DIR)?;
        let lock_path = tx_root.join("workspace.lock");
        recover_stale_lock(&lock_path)?;
        let lock = create_lock_file(&lock_path)?;
        let lease_token = opaque_token("lease");
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
            let _ = fs::remove_file(lease.lock_path);
            return Ok(ReleaseResponse { released: true });
        }
        Ok(ReleaseResponse { released: false })
    }

    pub fn writer_revoke(&self, params: RevokeParams) -> Result<ReleaseResponse> {
        let mut state = self.state.lock().unwrap();
        let released = state.admissions.remove(&params.admission_token).is_some();
        let tokens: Vec<_> = state
            .leases
            .iter()
            .filter_map(|(token, lease)| {
                (lease.admission_token == params.admission_token).then_some(token.clone())
            })
            .collect();
        for token in tokens {
            if let Some(lease) = state.leases.remove(&token) {
                let _ = fs::remove_file(lease.lock_path);
            }
        }
        Ok(ReleaseResponse { released })
    }

    pub fn shutdown(&self) {
        let mut state = self.state.lock().unwrap();
        for (_, lease) in state.leases.drain() {
            let _ = fs::remove_file(lease.lock_path);
        }
        state.admissions.clear();
    }

    pub fn writer_inspect(&self, params: InspectParams) -> Result<InspectResponse> {
        let admission = self.admission(&params.admission_token)?;
        let workspace = Workspace::open(&admission.canonical_root)?;
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
        let workspace = Workspace::open(&lease.canonical_root)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        if params.files.is_empty() && params.publications.is_empty() {
            return Err(CoreError::invalid(
                "Transaction requires file or publication plans",
            ));
        }
        if params.files.len() > MAX_OPERATIONS || params.publications.len() > MAX_OPERATIONS {
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
        let tx_root = transaction_root(&workspace, &tx_id)?;
        fs::create_dir_all(tx_root.join("blobs"))?;
        let plan_path = tx_root.join("transaction.json");
        if let Some(plan) = read_transaction_plan(&plan_path)? {
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
        let workspace = Workspace::open(&lease.canonical_root)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        if params.files.len() > MAX_OPERATIONS || params.publications.len() > MAX_OPERATIONS {
            return Err(CoreError::invalid("Plan append accepts at most 128 plans"));
        }
        let tx_root = transaction_root(&workspace, &tx_id)?;
        let plan_path = tx_root.join("transaction.json");
        let mut plan = read_transaction_plan(&plan_path)?
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Transaction is missing"))?;
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
        let workspace = Workspace::open(&lease.canonical_root)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        validate_blob_id(&params.blob_id)?;
        let bytes = STANDARD
            .decode(params.data_base64)
            .map_err(|_| CoreError::invalid("Invalid transaction chunk base64"))?;
        if bytes.len() > 512 * 1024 {
            return Err(CoreError::new(
                "LIMIT_EXCEEDED",
                "Transaction chunks are limited to 512 KiB",
            ));
        }
        let blob_path = transaction_root(&workspace, &tx_id)?
            .join("blobs")
            .join(&params.blob_id);
        fs::create_dir_all(parent(&blob_path)?)?;
        let current = fs::metadata(&blob_path).map(|meta| meta.len()).unwrap_or(0);
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
        let received = current + bytes.len() as u64;
        let complete = if let Some(expected) = params.sha256 {
            file_sha256(&blob_path)? == expected
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
        let workspace = Workspace::open(&lease.canonical_root)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        let tx_root = transaction_root(&workspace, &tx_id)?;
        let plan_path = tx_root.join("transaction.json");
        let mut plan = read_transaction_plan(&plan_path)?
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Transaction is missing"))?;
        if matches!(
            plan.phase.as_str(),
            "committed" | "rolled_back" | "needs_attention"
        ) {
            return Ok(TransactionCommitResponse {
                transaction_id: plan.transaction_id,
                status: plan.phase,
                entries: plan.entries,
                publications: plan.publication_receipts,
            });
        }
        let result = self.commit_plan(&workspace, &tx_root, &mut plan);
        if let Err(error) = result {
            plan.attention = Some(error.to_string());
            let rollback = rollback_transaction_plan(&workspace, &tx_root, &mut plan);
            if rollback.is_ok() {
                plan.phase = "rolled_back".to_owned();
            } else {
                plan.phase = "needs_attention".to_owned();
                plan.attention = Some(format!("{error}; rollback: {}", rollback.unwrap_err()));
            }
            write_transaction_plan(&plan_path, &plan)?;
            return Ok(TransactionCommitResponse {
                transaction_id: plan.transaction_id,
                status: plan.phase,
                entries: plan.entries,
                publications: plan.publication_receipts,
            });
        }
        plan.phase = "committed".to_owned();
        write_transaction_plan(&plan_path, &plan)?;
        if plan.mode == "metadataOnly" {
            let _ = fs::remove_dir_all(tx_root.join("blobs"));
        }
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
        let workspace = Workspace::open(&lease.canonical_root)?;
        let tx_id = transaction_id(&params.transaction_id)?;
        let tx_root = transaction_root(&workspace, &tx_id)?;
        let plan_path = tx_root.join("transaction.json");
        let mut plan = read_transaction_plan(&plan_path)?
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Transaction is missing"))?;
        if matches!(plan.phase.as_str(), "begun" | "prepared") {
            plan.phase = "aborted".to_owned();
            write_transaction_plan(&plan_path, &plan)?;
            let _ = fs::remove_dir_all(tx_root.join("blobs"));
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
        for op in &mut prepared {
            if let Some(bytes) = &op.bytes {
                let target = workspace_path(&workspace, &op.path, true)?;
                fs::create_dir_all(parent(&target)?)?;
                let staged = unique_temp_path(&target);
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&staged)?;
                file.write_all(bytes)?;
                file.sync_all()?;
                op.staged = Some(staged);
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
            });
        }
        let tx_file = metadata_dir(&workspace, TX_DIR)?.join(format!("{tx_id}.json"));
        Ok(StatusResponse {
            transaction_id: tx_id,
            status: read_wal(&tx_file)?
                .map(|value| value.phase)
                .unwrap_or_else(|| "missing".to_owned()),
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
        if matches!(plan.phase.as_str(), "applying" | "needs_attention") {
            match rollback_transaction_plan(&workspace, &tx_root, &mut plan) {
                Ok(()) => {
                    plan.phase = "rolled_back".to_owned();
                    write_transaction_plan(&plan_path, &plan)?;
                }
                Err(error) => {
                    plan.phase = "needs_attention".to_owned();
                    plan.attention = Some(error.to_string());
                    write_transaction_plan(&plan_path, &plan)?;
                }
            }
        }
        Ok(StatusResponse {
            transaction_id: tx_id,
            status: plan.phase,
        })
    }

    fn acquire(&self, workspace: &Workspace, tx_root: &Path) -> Result<WorkspaceLock> {
        let lock_path = tx_root.join("workspace.lock");
        let _ = workspace;
        create_lock_file(&lock_path)
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
        let now = now_ms();
        self.state
            .lock()
            .unwrap()
            .leases
            .get(token)
            .filter(|lease| lease.expires_at_ms > now)
            .cloned()
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Writer lease is missing or expired"))
    }

    fn commit_plan(
        &self,
        workspace: &Workspace,
        tx_root: &Path,
        plan: &mut TransactionPlan,
    ) -> Result<()> {
        plan.phase = "prepared".to_owned();
        write_transaction_plan(&tx_root.join("transaction.json"), plan)?;
        let mut prepared = Vec::new();
        for file in &plan.files {
            check_expected(workspace, &file.path, Some(&file.expected))?;
            let op = transaction_file_to_operation(tx_root, file)?;
            prepared.push(prepare_operation(workspace, op)?);
        }
        backup_private_preimages(workspace, tx_root, plan)?;
        for op in &mut prepared {
            if let Some(bytes) = &op.bytes {
                let target = workspace_path(workspace, &op.path, true)?;
                fs::create_dir_all(parent(&target)?)?;
                let staged = unique_temp_path(&target);
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&staged)?;
                file.write_all(bytes)?;
                file.sync_all()?;
                op.staged = Some(staged);
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
        let publications = publish_transaction_metadata(workspace, tx_root, &plan.publications)?;
        plan.publication_receipts = publications;
        Ok(())
    }
}

fn create_lock_file(path: &Path) -> Result<WorkspaceLock> {
    fs::create_dir_all(parent(path)?)?;
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(CoreError::new("BUSY", "Workspace writer is busy"));
        }
        Err(error) => return Err(error.into()),
    };
    let owner = serde_json::json!({ "pid": std::process::id(), "createdAt": now_ms() });
    file.write_all(owner.to_string().as_bytes())?;
    file.sync_all()?;
    Ok(WorkspaceLock {
        path: path.to_path_buf(),
    })
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
    }
    Ok(())
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // SAFETY: kill(pid, 0) does not send a signal; it only checks process visibility.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    true
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
    publications: &[TransactionPublicationPlan],
) -> Result<Vec<PublicationReceipt>> {
    let mut receipts = Vec::new();
    for publication in publications {
        validate_publication(publication)?;
        let target = publication_path(workspace, publication)?;
        let current = publication_expected(workspace, publication)?;
        if publication
            .expected
            .exists
            .is_some_and(|expected| current.exists != expected)
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
        fs::create_dir_all(parent(&target)?)?;
        let staged = unique_temp_path(&target);
        fs::copy(&blob, &staged)?;
        fs::rename(&staged, &target)?;
        sync_parent(&target);
        receipts.push(PublicationReceipt {
            namespace: publication.namespace.clone(),
            key: publication.key.clone(),
            sha256: file_sha256(&target)?,
            mtime_ms: fs::metadata(&target)?
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs_f64() * 1000.0)
                .unwrap_or_else(now_ms),
        });
    }
    Ok(receipts)
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
                    File::open(&target)?.sync_all()?;
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
    rollback_publications(workspace, plan)?;
    Ok(())
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
        sync_parent(&target);
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
            sync_parent(&target);
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
    sync_parent(&target);
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
    sync_parent(&current);
    sync_parent(&original);
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
    sync_parent(&target);
    Ok(())
}

fn rollback_publications(workspace: &Workspace, plan: &TransactionPlan) -> Result<()> {
    for receipt in plan.publication_receipts.iter().rev() {
        let publication = TransactionPublicationPlan {
            namespace: receipt.namespace.clone(),
            key: receipt.key.clone(),
            expected: ExpectedState {
                exists: Some(false),
                sha256: None,
                file: None,
                directory: None,
            },
            blob_id: "rollback".to_owned(),
            size: 0,
            sha256: String::new(),
        };
        let target = publication_path(workspace, &publication)?;
        if target.exists() && file_sha256(&target)? == receipt.sha256 {
            fs::remove_file(&target)?;
            sync_parent(&target);
        } else if target.exists() {
            return Err(CoreError::new(
                "NEEDS_ATTENTION",
                "Metadata publication changed after transaction",
            ));
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
    if !target.exists() {
        return Ok(InspectResponse {
            path: publication.key.clone(),
            exists: false,
            kind: "missing".to_owned(),
            size: 0,
            mtime_ms: 0.0,
            sha256: None,
            bytes_base64: None,
        });
    }
    Ok(InspectResponse {
        path: publication.key.clone(),
        exists: true,
        kind: "file".to_owned(),
        size: fs::metadata(&target)?.len(),
        mtime_ms: 0.0,
        sha256: Some(file_sha256(&target)?),
        bytes_base64: None,
    })
}

fn publication_path(
    workspace: &Workspace,
    publication: &TransactionPublicationPlan,
) -> Result<PathBuf> {
    let base = match publication.namespace.as_str() {
        "mutationJournal" => ".checkpoints",
        "mutationBlob" => ".checkpoints/blobs",
        "repositoryIndex" => ".history/repository-index/v1",
        "changeSetWal" => ".history/change-sets/transactions",
        _ => return Err(CoreError::invalid("Unsupported metadata namespace")),
    };
    validate_publication_key(&publication.key)?;
    metadata_dir(workspace, &format!("{base}/{}", publication.key))
}

fn read_transaction_plan(path: &Path) -> Result<Option<TransactionPlan>> {
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
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
    sync_parent(path);
    Ok(())
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
            if meta.is_dir() && !recursive {
                return Err(CoreError::new(
                    "CONFLICT",
                    "Directory delete requires recursive=true",
                ));
            }
            Ok(PreparedOp {
                operation,
                path,
                new_path: None,
                staged: None,
                bytes: None,
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
        MutationOperation::WriteFile { .. } => {
            let target = workspace_path(workspace, &prepared.path, true)?;
            fs::create_dir_all(parent(&target)?)?;
            let staged = prepared
                .staged
                .as_ref()
                .ok_or_else(|| CoreError::failed("Missing staged write"))?;
            fs::rename(staged, &target)?;
            sync_parent(&target);
            receipts.push(receipt(workspace, &prepared.path, None, "writeFile")?);
        }
        MutationOperation::Mkdir { recursive, .. } => {
            let target = workspace_path(workspace, &prepared.path, true)?;
            if *recursive {
                fs::create_dir_all(&target)?;
            } else {
                fs::create_dir(&target)?;
            }
            sync_parent(&target);
            receipts.push(receipt(workspace, &prepared.path, None, "mkdir")?);
        }
        MutationOperation::Delete { recursive, .. } => {
            let target = workspace_path(workspace, &prepared.path, false)?;
            let was_dir = lstat(&target)?.is_dir();
            if was_dir {
                if *recursive {
                    fs::remove_dir_all(&target)?;
                } else {
                    fs::remove_dir(&target)?;
                }
            } else {
                fs::remove_file(&target)?;
            }
            sync_parent(&target);
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
            fs::create_dir_all(parent(&target)?)?;
            fs::rename(&source, &target)?;
            sync_parent(&source);
            sync_parent(&target);
            receipts.push(receipt(
                workspace,
                new_path,
                Some(prepared.path.clone()),
                "rename",
            )?);
        }
        MutationOperation::Copy { .. } => {
            let new_path = prepared.new_path.as_ref().unwrap();
            let source = workspace_path(workspace, &prepared.path, false)?;
            let target = workspace_path(workspace, new_path, true)?;
            copy_entry(&source, &target)?;
            sync_parent(&target);
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
    let protected = [
        ".git",
        ".history",
        ".checkpoints",
        ".team",
        ".codex",
        ".omx",
        ".crewforge",
        ".crownforge-worktrees",
    ];
    if normalized.is_empty()
        || normalized.contains('\0')
        || normalized.starts_with('/')
        || normalized.as_bytes().get(1) == Some(&b':')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || protected.contains(&part))
    {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Mutation path must stay inside user workspace files",
        ));
    }
    Ok(())
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

fn is_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_index_store_key(value: &str) -> bool {
    value == "meta.json"
        || value == "lock"
        || value == "rebuild.lock"
        || (value.starts_with("shards/") && value.ends_with(".json"))
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
    } else if expected.sha256.is_some() {
        return Err(CoreError::new("CONFLICT", "File content changed"));
    }
    Ok(())
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
    sync_parent(path);
    Ok(())
}

fn read_wal(path: &Path) -> Result<Option<WalRecord>> {
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}

fn copy_entry(source: &Path, target: &Path) -> Result<()> {
    let meta = lstat(source)?;
    if meta.file_type().is_symlink() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Mutation refuses symbolic links",
        ));
    }
    if meta.is_file() {
        fs::create_dir_all(parent(target)?)?;
        fs::copy(source, target)?;
        return Ok(());
    }
    if !meta.is_dir() {
        return Err(CoreError::new("CONFLICT", "Unsupported entry type"));
    }
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        copy_entry(&entry.path(), &target.join(entry.file_name()))?;
    }
    Ok(())
}

fn reject_tree_symlinks(source: &Path) -> Result<()> {
    let meta = lstat(source)?;
    if meta.file_type().is_symlink() {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Mutation refuses symbolic links",
        ));
    }
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

fn sync_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
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
            })
            .unwrap();
        mutations
            .writer_acquire(AcquireParams {
                admission_token: admission.admission_token,
            })
            .unwrap()
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
    fn metadata_only_overwrite_failure_keeps_recovery_data_and_needs_attention() {
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
            },
        );
        let committed = mutations
            .transaction_commit(TransactionCommitParams {
                lease_token: lease.lease_token.clone(),
                transaction_id: "overwrite-attention".to_owned(),
            })
            .unwrap();
        assert_eq!(committed.status, "needs_attention");
        assert_eq!(
            fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
            "after"
        );
        assert!(fixture
            .path()
            .join(".crewforge/desktop-transactions/overwrite-attention/blobs/file-after")
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
        let lease = lease_for(&fixture, &mutations);
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
}
