export type ProcessSignalProbe = (pid: number, signal: 0) => unknown;

/** Fail closed: only the kernel's explicit ESRCH result proves an owner is dead. */
export function isProcessAlive(
  pid: number,
  probe: ProcessSignalProbe = (candidate, signal) => process.kill(candidate, signal)
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
