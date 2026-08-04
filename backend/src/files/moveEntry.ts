import fs from "node:fs";
import path from "node:path";
import { safePath } from "../utils/safePath.js";

export type MoveEntryErrorCode =
  | "MOVE_SOURCE_REQUIRED"
  | "MOVE_SOURCE_NOT_FOUND"
  | "MOVE_TARGET_NOT_FOUND"
  | "MOVE_TARGET_NOT_DIRECTORY"
  | "MOVE_CONFLICT"
  | "MOVE_INTO_SELF"
  | "MOVE_UNSUPPORTED_ENTRY";

export class MoveEntryError extends Error {
  constructor(
    public readonly code: MoveEntryErrorCode,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "MoveEntryError";
  }
}

export interface MoveEntryResult {
  sourcePath: string;
  path: string;
  type: "file" | "directory";
}

function toWorkspacePath(workspaceDir: string, fullPath: string): string {
  return path.relative(path.resolve(workspaceDir), fullPath).split(path.sep).join("/");
}

export function moveWorkspaceEntry(
  workspaceDir: string,
  sourcePath: string,
  targetDirectory = ""
): MoveEntryResult {
  if (!sourcePath.trim()) {
    throw new MoveEntryError("MOVE_SOURCE_REQUIRED", "source_path required", 400);
  }

  const workspaceRoot = fs.realpathSync(path.resolve(workspaceDir));
  const sourceFullPath = safePath(sourcePath, workspaceRoot);
  if (sourceFullPath === workspaceRoot || !fs.existsSync(sourceFullPath)) {
    throw new MoveEntryError("MOVE_SOURCE_NOT_FOUND", "Source not found", 404);
  }

  const targetDirectoryFullPath = safePath(targetDirectory || "", workspaceRoot);
  if (!fs.existsSync(targetDirectoryFullPath)) {
    throw new MoveEntryError("MOVE_TARGET_NOT_FOUND", "Target directory not found", 404);
  }
  if (!fs.statSync(targetDirectoryFullPath).isDirectory()) {
    throw new MoveEntryError(
      "MOVE_TARGET_NOT_DIRECTORY",
      "Move target must be a directory",
      400
    );
  }
  if (
    fs.realpathSync(sourceFullPath) !== sourceFullPath ||
    fs.realpathSync(targetDirectoryFullPath) !== targetDirectoryFullPath
  ) {
    throw new MoveEntryError(
      "MOVE_UNSUPPORTED_ENTRY",
      "Symbolic link paths cannot be moved",
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
    throw new MoveEntryError(
      "MOVE_UNSUPPORTED_ENTRY",
      "Only files and directories can be moved",
      400
    );
  }

  if (
    type === "directory" &&
    (targetDirectoryFullPath === sourceFullPath ||
      targetDirectoryFullPath.startsWith(sourceFullPath + path.sep))
  ) {
    throw new MoveEntryError(
      "MOVE_INTO_SELF",
      "A directory cannot be moved into itself",
      400
    );
  }

  const destinationFullPath = path.join(targetDirectoryFullPath, path.basename(sourceFullPath));
  safePath(toWorkspacePath(workspaceRoot, destinationFullPath), workspaceRoot);
  if (destinationFullPath === sourceFullPath) {
    return {
      sourcePath: toWorkspacePath(workspaceRoot, sourceFullPath),
      path: toWorkspacePath(workspaceRoot, destinationFullPath),
      type,
    };
  }
  if (fs.existsSync(destinationFullPath)) {
    throw new MoveEntryError("MOVE_CONFLICT", "Target already exists", 409);
  }

  fs.renameSync(sourceFullPath, destinationFullPath);
  return {
    sourcePath: toWorkspacePath(workspaceRoot, sourceFullPath),
    path: toWorkspacePath(workspaceRoot, destinationFullPath),
    type,
  };
}
