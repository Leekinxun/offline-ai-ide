import { timingSafeEqual } from "node:crypto";

let credential: Buffer | undefined;

function isDesktop(): boolean { return process.env.CREWFORGE_DESKTOP === "1"; }

/** Capture once before server startup; project processes must never inherit it. */
export function initializeDesktopBootstrapCredential(): void {
  credential?.fill(0); credential = undefined;
  if (!isDesktop()) return;
  const value = process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN;
  delete process.env.CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN;
  if (typeof value === "string" && value.length >= 32) credential = Buffer.from(value, "utf8");
}

/** Only a boolean leaves this module; neither callers nor child processes get a getter. */
export function matchesDesktopBootstrapCredential(value: unknown): boolean {
  if (!isDesktop() || !credential || typeof value !== "string") return false;
  const supplied = Buffer.from(value, "utf8");
  return supplied.length === credential.length && timingSafeEqual(supplied, credential);
}
