import { createElement, type AnchorHTMLAttributes, type ReactNode } from "react";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ENCODED_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|7f|c2%8[0-9a-f]|c2%9[0-9a-f])/i;
const MALFORMED_PERCENT = /%(?![0-9a-f]{2})/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface SafeExternalHrefOptions {
  allowLoopbackHttp?: boolean;
}

function containsEncodedControl(value: string): boolean {
  let candidate = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (ENCODED_CONTROL.test(candidate)) return true;
    const decodedPercent = candidate.replace(/%25/gi, "%");
    if (decodedPercent === candidate) return false;
    candidate = decodedPercent;
  }
  return ENCODED_CONTROL.test(candidate);
}

export function safeExternalHref(value: unknown, options: SafeExternalHrefOptions = {}): string | undefined {
  if (typeof value !== "string" || !value || value !== value.trim()) return undefined;
  if (CONTROL_CHARACTERS.test(value) || value.includes("\\") || MALFORMED_PERCENT.test(value) || containsEncodedControl(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || !parsed.hostname) return undefined;
    const secure = parsed.protocol === "https:";
    const fixtureLoopback = options.allowLoopbackHttp === true && parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
    return secure || fixtureLoopback ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

interface SafeExternalLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "rel" | "target"> {
  href: unknown;
  children?: ReactNode;
}

export function SafeExternalLink({ href, children, ...props }: SafeExternalLinkProps) {
  const safeHref = safeExternalHref(href);
  if (!safeHref) return null;
  return createElement("a", { ...props, href: safeHref, target: "_blank", rel: "noopener noreferrer" }, children);
}
