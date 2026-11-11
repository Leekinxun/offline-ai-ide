import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createBrowserUuid } from "../frontend/src/utils/browserUuid.js";

function replaceCrypto(t: TestContext, stub: object): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: stub });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else Reflect.deleteProperty(globalThis, "crypto");
  });
}

test("creates an RFC UUID v4 on HTTP when randomUUID is unavailable", (t) => {
  replaceCrypto(t, {
    getRandomValues(bytes: Uint8Array) {
      assert.equal(bytes.length, 16);
      bytes.set([0, 1, 2, 3, 4, 5, 0xff, 7, 0x7f, 9, 10, 11, 12, 13, 14, 15]);
      return bytes;
    },
  });
  const id = createBrowserUuid();
  assert.match(id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.equal(id, "00010203-0405-4f07-bf09-0a0b0c0d0e0f");
});

test("uses native randomUUID when the browser provides it", (t) => {
  const nativeId = "115727c2-6e81-48d0-b746-de91945f8f88";
  replaceCrypto(t, {
    randomUUID: () => nativeId,
    getRandomValues() { assert.fail("Fallback used while native randomUUID was available"); },
  });
  assert.equal(createBrowserUuid(), nativeId);
});
