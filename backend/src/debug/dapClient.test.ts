import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DapClient, type DapEvent } from "./dapClient.js";

function encode(message: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

test("DAP client frames requests and parses split responses and events", async () => {
  const adapterOutput = new PassThrough();
  const adapterInput = new PassThrough();
  const client = new DapClient(adapterOutput, adapterInput);
  let requestBuffer = Buffer.alloc(0);
  const requestMessage = new Promise<any>((resolve) => {
    adapterInput.on("data", (chunk) => {
      requestBuffer = Buffer.concat([requestBuffer, chunk]);
      const headerEnd = requestBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(requestBuffer.subarray(0, headerEnd).toString("ascii").match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (requestBuffer.length < headerEnd + 4 + length) return;
      resolve(JSON.parse(requestBuffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8")));
    });
  });

  const response = client.request("threads");
  const request = await requestMessage;
  assert.equal(request.command, "threads");
  const encodedResponse = encode({
    seq: 2,
    type: "response",
    request_seq: request.seq,
    success: true,
    command: "threads",
    body: { threads: [{ id: 7, name: "MainThread" }] },
  });
  adapterOutput.write(encodedResponse.subarray(0, 11));
  adapterOutput.write(encodedResponse.subarray(11));
  assert.deepEqual(await response, { threads: [{ id: 7, name: "MainThread" }] });

  const receivedEvent = new Promise<DapEvent>((resolve) => client.once("event", resolve));
  adapterOutput.write(encode({
    seq: 3,
    type: "event",
    event: "stopped",
    body: { reason: "breakpoint", threadId: 7 },
  }));
  assert.equal((await receivedEvent).body.threadId, 7);

  client.dispose();
  adapterInput.destroy();
  adapterOutput.destroy();
});

test("DAP client surfaces failed adapter responses", async () => {
  const adapterOutput = new PassThrough();
  const adapterInput = new PassThrough();
  const client = new DapClient(adapterOutput, adapterInput);
  adapterInput.once("data", () => {
    adapterOutput.write(encode({
      seq: 2,
      type: "response",
      request_seq: 1,
      success: false,
      command: "launch",
      message: "debugpy launch failed",
    }));
  });
  await assert.rejects(() => client.request("launch"), /debugpy launch failed/);
  client.dispose();
  adapterInput.destroy();
  adapterOutput.destroy();
});
