import assert from "node:assert/strict";
import test from "node:test";
import {
  uploadEntriesInBatches,
  type UploadEntriesError,
  type UploadFilePayload,
  type UploadProgress,
} from "../src/hooks/useFileSystem.ts";

function entry(path: string, size = 1): UploadFilePayload {
  return { path, file: new File([new Uint8Array(size)], path.split("/").pop() || path) };
}

interface MockUploadRequest {
  readonly headers: Record<string, string>;
  progress(loaded: number, total?: number): void;
  uploadComplete(): void;
  networkError(): void;
  abort(): void;
}

async function withXhr(
  handler: (body: FormData, call: number, request: MockUploadRequest) => Promise<Response | void> | Response | void,
  run: (bodies: FormData[]) => Promise<void>
) {
  const previous = globalThis.XMLHttpRequest;
  const bodies: FormData[] = [];
  class MockXMLHttpRequest {
    status = 0;
    responseText = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    upload: {
      onprogress: ((event: ProgressEvent) => void) | null;
      onload: (() => void) | null;
    } = {
      onprogress: null,
      onload: null,
    };
    headers: Record<string, string> = {};

    open() {}

    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }

    send(body: FormData) {
      bodies.push(body);
      const request: MockUploadRequest = {
        headers: this.headers,
        progress: (loaded, total) => {
          this.upload.onprogress?.({
            loaded,
            total: total ?? 0,
            lengthComputable: typeof total === "number",
          } as ProgressEvent);
        },
        uploadComplete: () => {
          this.upload.onload?.();
        },
        networkError: () => {
          this.onerror?.();
        },
        abort: () => {
          this.onabort?.();
        },
      };
      Promise.resolve(handler(body, bodies.length, request))
        .then(async (response) => {
          if (!response) return;
          this.status = response.status;
          this.responseText = await response.text();
          this.onload?.();
        })
        .catch(() => {
          this.onerror?.();
        });
    }
  }
  globalThis.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;
  try {
    await run(bodies);
  } finally {
    globalThis.XMLHttpRequest = previous;
  }
}

function success(body: FormData): Response {
  return Response.json({ uploaded: body.getAll("files").length, overwritten: 0 });
}

test("uploads folders sequentially in bounded batches while preserving paths and total count", async () => {
  const files = Array.from({ length: 51 }, (_, i) => entry(`folder/sub/${i}.txt`));
  await withXhr(async (body) => success(body), async (bodies) => {
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
  await withXhr(async (body) => success(body), async (bodies) => {
    assert.equal((await uploadEntriesInBatches(files, undefined, {})).uploaded, 5);
    assert.deepEqual(bodies.map((body) => body.getAll("paths")), [
      ["folder/a.bin", "folder/b.bin"], ["folder/c.bin"], ["folder/d.bin"], ["folder/e.txt"],
    ]);
  });
});

test("each late conflict requires confirmation for its own batch", async () => {
  const files = Array.from({ length: 101 }, (_, i) => entry(`folder/${i}.txt`));
  await withXhr(async (body, call) => {
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
  await withXhr(async (body, call, request) => {
    if (call === 2) {
      request.networkError();
      return;
    }
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
  await withXhr(async (body, call) => call === 1
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
  await withXhr(async () => Response.json({ error: "File too large" }, { status: 400 }), async () => {
    await assert.rejects(uploadEntriesInBatches([entry("folder/large.bin")], undefined, {}),
      (cause: UploadEntriesError) => cause.message === "File too large" && cause.batchMayHaveUploaded === false);
  });
});

test("reports upload, processing, and complete progress without completing before server response", async () => {
  const files = [entry("folder/a.txt", 100), entry("folder/b.txt", 300)];
  const progress: UploadProgress[] = [];

  await withXhr(async (body, _call, request) => {
    assert.equal(request.headers.Authorization, "Bearer test");
    request.progress(25, 100);
    request.progress(100, 100);
    request.uploadComplete();
    assert.equal(progress.at(-1)?.phase, "processing");
    assert.equal(progress.at(-1)?.completedFiles, 0);
    return success(body);
  }, async () => {
    assert.deepEqual(await uploadEntriesInBatches(files, {
      onProgress: (item) => progress.push(item),
    }, { Authorization: "Bearer test" }), {
      uploaded: 2,
      overwritten: 0,
    });
  });

  assert.deepEqual(progress, [
    { uploadedBytes: 0, totalBytes: 400, completedFiles: 0, totalFiles: 2, phase: "uploading" },
    { uploadedBytes: 100, totalBytes: 400, completedFiles: 0, totalFiles: 2, phase: "uploading" },
    { uploadedBytes: 400, totalBytes: 400, completedFiles: 0, totalFiles: 2, phase: "uploading" },
    { uploadedBytes: 400, totalBytes: 400, completedFiles: 0, totalFiles: 2, phase: "processing" },
    { uploadedBytes: 400, totalBytes: 400, completedFiles: 2, totalFiles: 2, phase: "complete" },
  ]);
});

test("keeps progress monotonic across batches and handles zero byte files", async () => {
  const files = Array.from({ length: 51 }, (_, index) => entry(`folder/${index}.txt`, index === 50 ? 0 : 1));
  const progress: UploadProgress[] = [];

  await withXhr(async (body, call, request) => {
    request.progress(1, 2);
    request.uploadComplete();
    return Response.json({ uploaded: body.getAll("files").length, overwritten: call === 2 ? 1 : 0 });
  }, async () => {
    await uploadEntriesInBatches(files, { onProgress: (item) => progress.push(item) }, {});
  });

  assert.ok(progress.every((item, index) => index === 0 || item.uploadedBytes >= progress[index - 1].uploadedBytes));
  assert.deepEqual(progress.at(-1), {
    uploadedBytes: 50,
    totalBytes: 50,
    completedFiles: 51,
    totalFiles: 51,
    phase: "complete",
  });
  assert.ok(progress.some((item) => item.phase === "processing" && item.completedFiles === 50));
});

test("rejects aborted uploads so callers can retry", async () => {
  await withXhr(async (_body, _call, request) => {
    request.progress(1, 1);
    request.abort();
  }, async () => {
    await assert.rejects(uploadEntriesInBatches([entry("folder/a.txt")], undefined, {}),
      (cause: UploadEntriesError) => {
        assert.equal(cause.message, "Failed to fetch");
        assert.equal(cause.batchMayHaveUploaded, true);
        assert.equal(cause.completedUploaded, 0);
        return true;
      });
  });
});

test("does not report complete when a 2xx response has invalid JSON", async () => {
  const progress: UploadProgress[] = [];
  await withXhr(async () => new Response("not json", { status: 200 }), async () => {
    await assert.rejects(uploadEntriesInBatches([entry("folder/a.txt")], {
      onProgress: (item) => progress.push(item),
    }, {}), (cause: UploadEntriesError) => {
      assert.equal(cause.message, "Upload result could not be confirmed");
      assert.equal(cause.batchMayHaveUploaded, true);
      assert.equal(cause.completedUploaded, 0);
      return true;
    });
  });

  assert.equal(progress.some((item) => item.phase === "complete"), false);
});

test("does not report complete when a 2xx response uploaded count is inconsistent", async () => {
  const progress: UploadProgress[] = [];
  await withXhr(async () => Response.json({ uploaded: 1, overwritten: 0 }), async () => {
    await assert.rejects(uploadEntriesInBatches([entry("folder/a.txt"), entry("folder/b.txt")], {
      onProgress: (item) => progress.push(item),
    }, {}), (cause: UploadEntriesError) => {
      assert.equal(cause.message, "Upload result could not be confirmed");
      assert.equal(cause.batchMayHaveUploaded, true);
      assert.deepEqual(cause.remainingFiles.map((file) => file.path), ["folder/a.txt", "folder/b.txt"]);
      return true;
    });
  });

  assert.equal(progress.some((item) => item.phase === "complete"), false);
});
