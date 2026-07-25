import fs from "fs";
import path from "path";
import { safePath } from "../utils/safePath.js";

export type CopyEntryErrorCode =
  | "COPY_SOURCE_REQUIRED"
  | "COPY_SOURCE_NOT_FOUND"
  | "COPY_TARGET_NOT_FOUND"
  | "COPY_TARGET_NOT_DIRECTORY"
  | "COPY_CONFLICT"
  | "COPY_INTO_SELF"
  | "COPY_UNSUPPORTED_ENTRY";

export class CopyEntryError extends Error {
  constructor(
    public readonly code: CopyEntryErrorCode,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "CopyEntryError";
  }
}

export interface CopyEntryResult {
  sourcePath: string;
  path: string;
  type: "file" | "directory";
}

function assertNoSymbolicLinks(fullPath: string): void {
  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    throw new CopyEntryError(
      "COPY_UNSUPPORTED_ENTRY",
      "Symbolic links cannot be copied",
      400
    );
  }
  if (!stat.isDirectory()) return;

  for (const entry of fs.readdirSync(fullPath)) {
    assertNoSymbolicLinks(path.join(fullPath, entry));
  }
}

function toWorkspacePath(workspaceDir: string, fullPath: string): string {
  return path.relative(path.resolve(workspaceDir), fullPath).split(path.sep).join("/");
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ERR_FS_CP_EEXIST";
}

export function copyWorkspaceEntry(
  workspaceDir: string,
  sourcePath: string,
  targetDirectory = ""
): CopyEntryResult {
  if (!sourcePath.trim()) {
    throw new CopyEntryError("COPY_SOURCE_REQUIRED", "source_path required", 400);
  }

  const workspaceRoot = fs.realpathSync(path.resolve(workspaceDir));
  const sourceFullPath = safePath(sourcePath, workspaceRoot);
  if (sourceFullPath === workspaceRoot || !fs.existsSync(sourceFullPath)) {
    throw new CopyEntryError("COPY_SOURCE_NOT_FOUND", "Source not found", 404);
  }

  const targetDirectoryFullPath = safePath(targetDirectory || "", workspaceRoot);
  if (!fs.existsSync(targetDirectoryFullPath)) {
    throw new CopyEntryError("COPY_TARGET_NOT_FOUND", "Target directory not found", 404);
  }
  if (!fs.statSync(targetDirectoryFullPath).isDirectory()) {
    throw new CopyEntryError(
      "COPY_TARGET_NOT_DIRECTORY",
      "Paste target must be a directory",
      400
    );
  }
  if (
    fs.realpathSync(sourceFullPath) !== sourceFullPath ||
    fs.realpathSync(targetDirectoryFullPath) !== targetDirectoryFullPath
  ) {
    throw new CopyEntryError(
      "COPY_UNSUPPORTED_ENTRY",
      "Symbolic link paths cannot be copied",
      400
    );
  }

  const sourceStat = fs.lstatSync(sourceFullPath);
  const type = sourceStat.isDirectory()
    ? "directory"
    : sourceStat.isFile()
      ? "file"
      : null;
  if (!type) {
    throw new CopyEntryError(
      "COPY_UNSUPPORTED_ENTRY",
      "Only files and directories can be copied",
      400
    );
  }
  assertNoSymbolicLinks(sourceFullPath);

  if (
    type === "directory" &&
    (targetDirectoryFullPath === sourceFullPath ||
      targetDirectoryFullPath.startsWith(sourceFullPath + path.sep))
  ) {
    throw new CopyEntryError(
      "COPY_INTO_SELF",
      "A directory cannot be copied into itself",
      400
    );
  }

  const destinationFullPath = path.join(targetDirectoryFullPath, path.basename(sourceFullPath));
  safePath(toWorkspacePath(workspaceRoot, destinationFullPath), workspaceRoot);
  if (fs.existsSync(destinationFullPath)) {
    throw new CopyEntryError("COPY_CONFLICT", "Target already exists", 409);
  }

  let destinationCreated = false;
  try {
    if (type === "file") {
      fs.copyFileSync(sourceFullPath, destinationFullPath, fs.constants.COPYFILE_EXCL);
      destinationCreated = true;
    } else {
      fs.mkdirSync(destinationFullPath, { mode: sourceStat.mode });
      destinationCreated = true;
      for (const entry of fs.readdirSync(sourceFullPath)) {
        fs.cpSync(
          path.join(sourceFullPath, entry),
          path.join(destinationFullPath, entry),
          {
            recursive: true,
            force: false,
            errorOnExist: true,
            dereference: false,
            preserveTimestamps: true,
          }
        );
      }
    }
  } catch (error) {
    if (destinationCreated) {
      fs.rmSync(destinationFullPath, { recursive: true, force: true });
    }
    if (isAlreadyExistsError(error)) {
      throw new CopyEntryError("COPY_CONFLICT", "Target already exists", 409);
    }
    throw error;
  }

  return {
    sourcePath: toWorkspacePath(workspaceRoot, sourceFullPath),
    path: toWorkspacePath(workspaceRoot, destinationFullPath),
    type,
  };
}
