import assert from "node:assert/strict";
import test from "node:test";
import { createClientId } from "../frontend/src/utils/clientId.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("createClientId uses native randomUUID when available with the crypto receiver", () => {
  const cryptoSource = {
    marker: "bound",
    randomUUID(this: { marker: string }) {
      assert.equal(this.marker, "bound");
      return "native-id";
    },
    getRandomValues() {
      throw new Error("fallback should not run");
    },
  };
  assert.equal(createClientId(cryptoSource), "native-id");
});

test("createClientId falls back to RFC 4122 v4 ids from getRandomValues", () => {
  let seed = 0;
  const cryptoSource = {
    marker: "bound",
    getRandomValues(this: { marker: string }, bytes: Uint8Array) {
      assert.equal(this.marker, "bound");
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = (seed + index) & 0xff;
      seed += 16;
      return bytes;
    },
  };
  const first = createClientId(cryptoSource);
  const second = createClientId(cryptoSource);
  assert.match(first, UUID_RE);
  assert.match(second, UUID_RE);
  assert.notEqual(first, second);
  assert.equal(first[14], "4");
  assert.match(first[19], /[89ab]/);
});

test("createClientId fails clearly when secure randomness is unavailable", () => {
  assert.throws(() => createClientId(undefined), /secure randomness is unavailable/);
  assert.throws(() => createClientId({} as Crypto), /secure randomness is unavailable/);
});
