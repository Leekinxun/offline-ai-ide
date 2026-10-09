type ClientIdCrypto = Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;

function formatUuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

// LAN HTTP hides randomUUID, but getRandomValues still provides secure randomness.
export function createClientId(cryptoSource?: ClientIdCrypto): string {
  if (arguments.length === 0) cryptoSource = globalThis.crypto;
  if (!cryptoSource) throw new Error("Unable to create client id: secure randomness is unavailable.");
  if (typeof cryptoSource.randomUUID === "function") return cryptoSource.randomUUID.call(cryptoSource);
  if (typeof cryptoSource.getRandomValues !== "function") throw new Error("Unable to create client id: secure randomness is unavailable.");
  const bytes = new Uint8Array(16);
  cryptoSource.getRandomValues.call(cryptoSource, bytes);
  return formatUuid(bytes);
}
