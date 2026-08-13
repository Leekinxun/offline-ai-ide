import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const hook = fs.readFileSync(path.join(root, "frontend/src/hooks/useContextManifest.ts"), "utf8");
const app = fs.readFileSync(path.join(root, "frontend/src/App.tsx"), "utf8");
const inspector = fs.readFileSync(path.join(root, "frontend/src/components/ContextInspector.tsx"), "utf8");
const chatRoutes = fs.readFileSync(path.join(root, "backend/src/routes/chat.ts"), "utf8");

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`Context UI contract failed: ${message}\n`);
    process.exit(1);
  }
}

assert(hook.includes('fetch("/api/chat/context/preview"'), "preview must use the canonical route");
assert(!hook.includes('fetch("/api/chat/context-preview"'), "legacy preview route must not return");
assert(chatRoutes.includes('chatRouter.post("/context/preview", contextPreview)'), "backend must expose the canonical preview route");
assert(hook.includes("previewControllerRef.current?.abort()"), "preview must cancel superseded and unmounted requests");
assert(hook.includes("++previewSequenceRef.current"), "preview must use a monotonic response sequence");
assert(hook.includes("scopeIdentity !== scopeIdentityRef.current"), "preview must reject responses from an old workspace/conversation/run scope");
assert(hook.includes("requestScopeToken !== previewScopeTokenRef.current"), "preview must reject responses from an old file/selection scope");
assert(hook.includes("if (!query)"), "empty preview queries must not call the endpoint");
assert(hook.includes("...(conversationId ? { conversationId } : {})"), "new-conversation preview must omit the optional conversation id safely");
assert(hook.includes("preferenceMutationsAvailable: Boolean(conversationId)"), "new-conversation previews must disable preference writes until a conversation exists");
assert(hook.includes("const [draftManifest, setDraftManifest]"), "next-request preview must be stored outside persisted manifests");
assert(hook.includes("return Object.freeze(normalized)"), "persisted manifest objects must be immutable after normalization");

const updateStart = hook.indexOf("const updateSource");
const refreshStart = hook.indexOf("const refreshSources", updateStart);
assert(updateStart >= 0 && refreshStart > updateStart, "context preference mutation block must be discoverable");
const updateBlock = hook.slice(updateStart, refreshStart);
assert(!updateBlock.includes("setManifests"), "pin/exclude must never rewrite persisted manifests");
assert(!updateBlock.includes("setDraftManifest"), "preference mutations must not forge a draft manifest locally");
assert(updateBlock.includes("await preview(lastPreviewContextRef.current)"), "successful and CAS preference responses must refresh the server preview");
assert(updateBlock.includes("response.status === 409"), "preference CAS conflicts must be handled explicitly");

const previewCall = app.indexOf("chat.contextManifest.preview({");
const previewEffectEnd = app.indexOf("}, [activeFile", previewCall);
assert(previewCall >= 0 && previewEffectEnd > previewCall, "editor preview effect must be discoverable");
assert(!app.slice(previewCall, previewEffectEnd).includes("catch(() => undefined)"), "preview failures must not be silently swallowed by App");
assert(inspector.includes('mode === "draft"'), "source controls must be absent from historical context views");

process.stdout.write("CrewForge context UI contract passed.\n");
