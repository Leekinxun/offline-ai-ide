import assert from "node:assert/strict";
import test from "node:test";
import {
  uploadEntriesInBatches,
  type UploadEntriesError,
  type UploadFilePayload,
} from "../src/hooks/useFileSystem.ts";

function entry(path: string, size = 1): UploadFilePayload {
  return { path, file: new File([new Uint8Array(size)], path.split("/").pop() || path) };
}

async function withFetch(
  handler: (body: FormData, call: number) => Promise<Response>,
  run: (bodies: FormData[]) => Promise<void>
) {
  const previous = globalThis.fetch;
  const bodies: FormData[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = init?.body as FormData;
    bodies.push(body);
    return handler(body, bodies.length);
  }) as typeof fetch;
  try {
    await run(bodies);
  } finally {
    globalThis.fetch = previous;
  }
}

function success(body: FormData): Response {
  return Response.json({ uploaded: body.getAll("files").length, overwritten: 0 });
}

test("uploads folders sequentially in bounded batches while preserving paths and total count", async () => {
  const files = Array.from({ length: 51 }, (_, i) => entry(`folder/sub/${i}.txt`));
  await withFetch(async (body) => success(body), async (bodies) => {
    assert.deepEqual(await uploadEntriesInBatches(files, {
      targetPath: "target", expectedWorkspaceDir: "/workspace/original",
    }, { Authorization: "Bearer test" }), {
      uploaded: 51,
      overwritten: 0,
    });
    assert.deepEqual(bodies.map((body) => body.getAll("files").length), [50, 1]);
    assert.deepEqual(bodies.flatMap((body) => body.getAll("paths")), files.map((file) => file.path));
    assert.ok(bodies.every((body) => body.get("targetPath") === "target" && body.get("overwrite") === "false"));
    assert.ok(bodies.every((body) => body.get("expectedWorkspaceDir") === "/workspace/original"));
  });
});

test("respects 8 MiB batch size and sends a larger single file alone", async () => {
  const MiB = 1024 * 1024;
  const files = [
    entry("folder/a.bin", 3 * MiB), entry("folder/b.bin", 4 * MiB),
    entry("folder/c.bin", 3 * MiB), entry("folder/d.bin", 17 * MiB), entry("folder/e.txt"),
  ];
  await withFetch(async (body) => success(body), async (bodies) => {
    assert.equal((await uploadEntriesInBatches(files, undefined, {})).uploaded, 5);
    assert.deepEqual(bodies.map((body) => body.getAll("paths")), [
      ["folder/a.bin", "folder/b.bin"], ["folder/c.bin"], ["folder/d.bin"], ["folder/e.txt"],
    ]);
  });
});

test("each late conflict requires confirmation for its own batch", async () => {
  const files = Array.from({ length: 101 }, (_, i) => entry(`folder/${i}.txt`));
  await withFetch(async (body, call) => {
    if (call === 2 || call === 4) {
      const conflict = call === 2 ? "folder/50.txt" : "folder/100.txt";
      return Response.json({ detail: "Already exists", code: "UPLOAD_CONFLICT", conflicts: [conflict] }, { status: 409 });
    }
    return Response.json({ uploaded: body.getAll("files").length, overwritten: call === 1 ? 0 : 1 });
  }, async (bodies) => {
    let remaining: UploadFilePayload[] = [];
    await assert.rejects(uploadEntriesInBatches(files, { expectedWorkspaceDir: "/workspace/original" }, {}), (cause: UploadEntriesError) => {
      assert.equal(cause.code, "UPLOAD_CONFLICT");
      assert.equal(cause.completedUploaded, 50);
      assert.equal(cause.batchMayHaveUploaded, false);
      assert.deepEqual(cause.remainingFiles.map((file) => file.path), files.slice(50).map((file) => file.path));
      remaining = cause.remainingFiles;
      return true;
    });
    await assert.rejects(uploadEntriesInBatches(remaining, {
      overwrite: true, overwriteFirstBatchOnly: true, expectedWorkspaceDir: "/workspace/original",
    }, {}),
      (cause: UploadEntriesError) => {
        assert.equal(cause.code, "UPLOAD_CONFLICT");
        assert.equal(cause.completedUploaded, 50);
        assert.equal(cause.completedOverwritten, 1);
        assert.deepEqual(cause.remainingFiles.map((file) => file.path), ["folder/100.txt"]);
        remaining = cause.remainingFiles;
        return true;
      });
    assert.deepEqual(await uploadEntriesInBatches(remaining, {
      overwrite: true, overwriteFirstBatchOnly: true, expectedWorkspaceDir: "/workspace/original",
    }, {}), {
      uploaded: 1,
      overwritten: 1,
    });
    assert.deepEqual(bodies.map((body) => body.getAll("files").length), [50, 50, 50, 1, 1]);
    assert.deepEqual(bodies.map((body) => body.get("overwrite")), ["false", "false", "true", "false", "true"]);
    assert.ok(bodies.every((body) => body.get("expectedWorkspaceDir") === "/workspace/original"));
    assert.deepEqual(bodies[4].getAll("paths"), ["folder/100.txt"]);
  });
});

test("network retry retains File objects and asks before overwriting an uncertain batch", async () => {
  const files = Array.from({ length: 51 }, (_, i) => entry(`folder/${i}.txt`));
  await withFetch(async (body, call) => {
    if (call === 2) throw new TypeError("Failed to fetch");
    if (call === 3) return Response.json({ error: "Already exists", code: "UPLOAD_CONFLICT", conflicts: ["folder/50.txt"] }, { status: 409 });
    if (call === 4) return Response.json({ uploaded: 1, overwritten: 1 });
    return success(body);
  }, async (bodies) => {
    let remaining: UploadFilePayload[] = [];
    await assert.rejects(uploadEntriesInBatches(files, { expectedWorkspaceDir: "/workspace/original" }, {}), (cause: UploadEntriesError) => {
      assert.equal(cause.message, "Failed to fetch");
      assert.equal(cause.completedUploaded, 50);
      assert.equal(cause.batchMayHaveUploaded, true);
      assert.equal(cause.remainingFiles[0], files[50]);
      remaining = cause.remainingFiles;
      return true;
    });
    await assert.rejects(uploadEntriesInBatches(remaining, { expectedWorkspaceDir: "/workspace/original" }, {}), (cause: UploadEntriesError) => {
      assert.equal(cause.code, "UPLOAD_CONFLICT");
      assert.equal(cause.message, "Already exists");
      assert.equal(cause.batchMayHaveUploaded, false);
      remaining = cause.remainingFiles;
      return true;
    });
    assert.deepEqual(await uploadEntriesInBatches(remaining, {
      overwrite: true, overwriteFirstBatchOnly: true, expectedWorkspaceDir: "/workspace/original",
    }, {}), {
      uploaded: 1,
      overwritten: 1,
    });
    assert.deepEqual(bodies.map((body) => body.get("overwrite")), ["false", "false", "false", "true"]);
    assert.ok(bodies.every((body) => body.get("expectedWorkspaceDir") === "/workspace/original"));
    assert.deepEqual(bodies.slice(1).map((body) => body.getAll("paths")), [
      ["folder/50.txt"], ["folder/50.txt"], ["folder/50.txt"],
    ]);
  });
});

test("workspace mismatch stops later batches without changing the captured workspace", async () => {
  const files = Array.from({ length: 51 }, (_, i) => entry(`folder/${i}.txt`));
  await withFetch(async (body, call) => call === 1
    ? success(body)
    : Response.json({
      code: "UPLOAD_WORKSPACE_CHANGED",
      detail: "Workspace changed during upload",
    }, { status: 409 }), async (bodies) => {
    await assert.rejects(uploadEntriesInBatches(files, {
      expectedWorkspaceDir: "/workspace/original",
    }, {}), (cause: UploadEntriesError) => {
      assert.equal(cause.code, "UPLOAD_WORKSPACE_CHANGED");
      assert.equal(cause.message, "Workspace changed during upload");
      assert.equal(cause.completedUploaded, 50);
      assert.equal(cause.batchMayHaveUploaded, false);
      assert.deepEqual(cause.remainingFiles.map((file) => file.path), ["folder/50.txt"]);
      return true;
    });
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((body) => body.get("expectedWorkspaceDir") === "/workspace/original"));
  });
});

test("uses server error field when detail is absent", async () => {
  await withFetch(async () => Response.json({ error: "File too large" }, { status: 400 }), async () => {
    await assert.rejects(uploadEntriesInBatches([entry("folder/large.bin")], undefined, {}),
      (cause: UploadEntriesError) => cause.message === "File too large" && cause.batchMayHaveUploaded === false);
  });
});
