/** The wire protocol follows upstream 0.160.0; the binaries are a CrownForge
 * downstream patch build, not an unmodified official release. Receipt identity
 * is a pinned build contract, not a substitute for release signing. */
export const WINDOWS_NATIVE_UPSTREAM_VERSION = "0.160.0" as const;
export const WINDOWS_NATIVE_UPSTREAM_COMMIT = "a956835d020762cb2b570053af06f643a11c0ecc" as const;
export const WINDOWS_NATIVE_RUNTIME_VARIANT = "crownforge-network-v1" as const;
// Exact hash of the reviewed downstream source patch.
export const WINDOWS_NATIVE_PATCH_SHA256 = "9a12990d3e753927962151daea9f31b0d5be7cebfa9353c30ae695fd9c404956" as const;
export const WINDOWS_NATIVE_BASE_ARCHIVE_SHA256 = Object.freeze({
  x64: "7f7fbbc8d6fd4ea2f3b13855ef47ea59663ba7e61fb2e9821df37163b8030891",
  arm64: "0bb6ecbad9c2f5d352ad539bbe43d627b32453bad1d61e5315ec9868f78e1b3c",
});
export const WINDOWS_NATIVE_BUILD_ID = `${WINDOWS_NATIVE_RUNTIME_VARIANT}:${WINDOWS_NATIVE_UPSTREAM_COMMIT}:${WINDOWS_NATIVE_PATCH_SHA256}`;

export interface WindowsNativeRuntimeReceipt {
  schemaVersion: 2;
  upstreamVersion: typeof WINDOWS_NATIVE_UPSTREAM_VERSION;
  upstreamCommit: typeof WINDOWS_NATIVE_UPSTREAM_COMMIT;
  runtimeVariant: typeof WINDOWS_NATIVE_RUNTIME_VARIANT;
  patchSha256: typeof WINDOWS_NATIVE_PATCH_SHA256;
  baseArchiveSha256: string;
  buildId: string;
  platform: "win32";
  arch: "x64" | "arm64";
  runtimeVersion?: typeof WINDOWS_NATIVE_UPSTREAM_VERSION;
  files: Record<string, unknown>;
  patchedFiles: Record<string, string>;
}

export function validateWindowsNativeRuntimeReceipt(value: unknown, arch: string): WindowsNativeRuntimeReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Windows sandbox runtime manifest");
  const receipt = value as Record<string, unknown>;
  const baseHash = arch === "x64" || arch === "arm64" ? WINDOWS_NATIVE_BASE_ARCHIVE_SHA256[arch] : undefined;
  if (!baseHash || receipt.schemaVersion !== 2 || receipt.platform !== "win32" || receipt.arch !== arch ||
      receipt.upstreamVersion !== WINDOWS_NATIVE_UPSTREAM_VERSION || receipt.upstreamCommit !== WINDOWS_NATIVE_UPSTREAM_COMMIT ||
      receipt.runtimeVariant !== WINDOWS_NATIVE_RUNTIME_VARIANT || receipt.patchSha256 !== WINDOWS_NATIVE_PATCH_SHA256 ||
      receipt.baseArchiveSha256 !== baseHash || receipt.buildId !== WINDOWS_NATIVE_BUILD_ID ||
      (receipt.runtimeVersion !== undefined && receipt.runtimeVersion !== WINDOWS_NATIVE_UPSTREAM_VERSION) ||
      (receipt.archiveSha256 !== undefined && receipt.archiveSha256 !== baseHash) ||
      (receipt.sourceTag !== undefined && receipt.sourceTag !== `rust-v${WINDOWS_NATIVE_UPSTREAM_VERSION}`) ||
      !receipt.files || typeof receipt.files !== "object" || Array.isArray(receipt.files)) {
    throw new Error("The Windows sandbox runtime must match the pinned CrownForge downstream patch build and architecture");
  }
  const patched = receipt.patchedFiles;
  const required = ["bin/codex.exe", "codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe"];
  if (!patched || typeof patched !== "object" || Array.isArray(patched) || Object.keys(patched).length !== required.length ||
      required.some(name => typeof (patched as Record<string, unknown>)[name] !== "string" ||
        !/^[a-f0-9]{64}$/.test(String((patched as Record<string, unknown>)[name])) ||
        (patched as Record<string, unknown>)[name] !== (receipt.files as Record<string, unknown>)[name])) {
    throw new Error("The CrownForge sandbox runtime has incomplete or mixed downstream binaries");
  }
  return receipt as unknown as WindowsNativeRuntimeReceipt;
}
