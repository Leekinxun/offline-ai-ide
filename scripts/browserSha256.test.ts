import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { sha256Text } from "../frontend/src/utils/sha256.js";

function replaceCrypto(t: test.TestContext, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "crypto", previous);
    else Reflect.deleteProperty(globalThis, "crypto");
  });
}

const nodeSha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("browser SHA-256 without SubtleCrypto matches Node for UTF-8 and padding boundaries", async (t) => {
  replaceCrypto(t, {});
  const messages = [
    "", "abc", "CrownForge 中文 🚀\n\0", "Unpaired surrogate \ud800",
    ...[55, 56, 63, 64, 65, 119, 120, 127, 128, 129].map((length) => "a".repeat(length)),
    "0123456789中文".repeat(8_192),
  ];
  for (const message of messages) {
    assert.equal(await sha256Text(message), nodeSha256(message), `SHA-256 mismatch for ${Buffer.byteLength(message)} UTF-8 bytes`);
  }
});

test("browser SHA-256 works when the crypto global is unavailable", async (t) => {
  replaceCrypto(t, undefined);
  assert.equal(await sha256Text("draft"), nodeSha256("draft"));
});

test("browser SHA-256 uses native Web Crypto when available", async (t) => {
  let digestCalls = 0;
  replaceCrypto(t, {
    subtle: {
      digest: (algorithm: string, bytes: Uint8Array) => {
        digestCalls += 1;
        assert.equal(algorithm, "SHA-256");
        return webcrypto.subtle.digest(algorithm, bytes);
      },
    },
  });
  const message = "native UTF-8 中文 🚀";
  assert.equal(await sha256Text(message), nodeSha256(message));
  assert.equal(digestCalls, 1);
});
