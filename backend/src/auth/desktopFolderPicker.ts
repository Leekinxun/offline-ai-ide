import crypto from "node:crypto";

type DesktopFolderPickerIpc = NodeJS.Process;

interface DesktopFolderPickerRequest {
  type: "desktop-pick-folder";
  requestId: string;
  defaultPath: string;
}

interface DesktopFolderPickerResult {
  type: "desktop-pick-folder-result";
  requestId: string;
  path: string | null;
  error?: string;
}

export interface PickDesktopFolderOptions {
  timeoutMs?: number;
  ipc?: DesktopFolderPickerIpc;
}

export class DesktopFolderPickerUnavailableError extends Error {
  constructor(message = "Desktop folder picker IPC is unavailable") {
    super(message);
    this.name = "DesktopFolderPickerUnavailableError";
  }
}

export class DesktopFolderPickerTimeoutError extends Error {
  constructor() {
    super("Desktop folder picker timed out");
    this.name = "DesktopFolderPickerTimeoutError";
  }
}

function isDesktopFolderPickerResult(
  message: unknown,
  requestId: string
): message is DesktopFolderPickerResult {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<DesktopFolderPickerResult>;
  return candidate.type === "desktop-pick-folder-result" && candidate.requestId === requestId;
}

export function pickDesktopFolder(
  defaultPath: string,
  options: PickDesktopFolderOptions = {}
): Promise<{ path: string | null }> {
  const ipc = options.ipc ?? process;
  const send = ipc.send?.bind(ipc);
  if (!send) {
    return Promise.reject(new DesktopFolderPickerUnavailableError());
  }

  const requestId = crypto.randomUUID();
  const timeoutMs = options.timeoutMs ?? 300_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      ipc.off("message", onMessage);
      ipc.off("disconnect", onDisconnect);
    };

    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler();
    };

    const onMessage = (message: unknown) => {
      if (!isDesktopFolderPickerResult(message, requestId)) return;
      finish(() => {
        if (typeof message.error === "string" && message.error.trim()) {
          reject(new Error(message.error));
          return;
        }
        resolve({ path: typeof message.path === "string" ? message.path : null });
      });
    };

    const onDisconnect = () => {
      finish(() => reject(new DesktopFolderPickerUnavailableError("Desktop host disconnected")));
    };

    timeout = setTimeout(() => {
      finish(() => reject(new DesktopFolderPickerTimeoutError()));
    }, timeoutMs);
    timeout.unref?.();

    ipc.on("message", onMessage);
    ipc.on("disconnect", onDisconnect);

    const payload: DesktopFolderPickerRequest = {
      type: "desktop-pick-folder",
      requestId,
      defaultPath,
    };

    try {
      send(payload);
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error("Desktop folder picker IPC failed")));
    }
  });
}
