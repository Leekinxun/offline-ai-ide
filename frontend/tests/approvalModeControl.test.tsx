import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalModeStatus, approvalModeEnableIntent } from "../src/components/ApprovalModeStatus.tsx";
import type { ApprovalModeState } from "../src/hooks/approvalModeClient.ts";
import { EN_MESSAGES, ZH_CN_MESSAGES } from "../src/i18n/messages.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const t = (key: string, values?: Record<string, string | number>) => (EN_MESSAGES[key] || key).replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? `{${name}}`));
const noop = () => {};
const initial: ApprovalModeState = { snapshot: null, verified: false, busy: false, loading: true, error: null };
const ready = (mode: "ask" | "full_access", overrides: Partial<ApprovalModeState> = {}): ApprovalModeState => ({ ...initial, loading: false, verified: true, snapshot: { mode, conversationId: "task-a", workspaceDir: "/synthetic/workspace", canEnable: true, revision: 0 }, ...overrides });
const render = (state: ApprovalModeState, options: { conversationId?: string | null; connected?: boolean } = {}) => renderToStaticMarkup(<ApprovalModeStatus state={state} conversationId={options.conversationId === undefined ? "task-a" : options.conversationId} workspaceDir="/synthetic/workspace" taskTitle="Synthetic task" connected={options.connected ?? true} t={t} onEnable={noop} onDisable={noop} onRetry={noop} />);

test("loading does not imply individual approvals; missing task and unsupported sessions cannot enable", () => {
  const loading = render(initial);
  assert.match(loading, /Approval mode not yet verified/);
  assert.doesNotMatch(loading, /Individual approvals/);
  assert.match(loading, /disabled=""/);
  assert.match(render(initial, { conversationId: null }), /Start a task before enabling/);
  const unsupported = ready("ask"); unsupported.snapshot!.canEnable = false;
  assert.match(render(unsupported), /Full access is unavailable for this session/);
  assert.match(render(unsupported), /disabled=""/);
  assert.match(render(ready("ask"), { connected: false }), /disabled=""/);
});

test("confirmed full access has a persistent warning, visible scope and one-click turn-off action", () => {
  const html = render(ready("full_access"));
  assert.match(html, /is-full-access/);
  assert.match(html, /data-approval-mode="full_access"/);
  assert.match(html, /Full access enabled/);
  assert.match(html, /Turn off full access/);
  assert.match(html, /Synthetic task/);
  assert.match(html, /\/synthetic\/workspace/);
  assert.match(html, /administrator-permitted network/);
  assert.match(html, /Pending approvals still need a decision/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /disabled=""/);
  assert.doesNotMatch(render(ready("full_access"), { connected: false }), /disabled=""/, "A disconnected chat socket must not block HTTP revocation");
});

test("failed or unverified revocation keeps the warning and cannot visually claim ask", () => {
  const html = render(ready("full_access", { verified: false, error: "update" }));
  assert.match(html, /is-full-access/);
  assert.match(html, /status unverified/);
  assert.match(html, /data-approval-mode="unknown"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Refresh status/);
  assert.doesNotMatch(html, /Individual approvals/);
  assert.match(render(ready("ask")), /data-approval-mode="ask"/);
});

test("both languages disclose risk, precise scope, pending decisions and hard boundaries before enabling", () => {
  for (const messages of [EN_MESSAGES, ZH_CN_MESSAGES]) {
    for (const key of Object.keys(EN_MESSAGES).filter(key => key.startsWith("chat.approvalMode."))) assert.ok(messages[key]?.trim(), key);
    const translate = (key: string, values?: Record<string, string | number>) => messages[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? `{${name}}`));
    const intent = approvalModeEnableIntent(translate, "/synthetic/workspace", "task-a", "Synthetic task");
    assert.equal(intent.tone, "danger");
    assert.match(intent.description, /Synthetic task/);
    assert.match(intent.description, /task-a/);
    assert.match(intent.description, /\/synthetic\/workspace/);
    assert.doesNotMatch(intent.description, /\{(?:workspace|task|conversationId)\}/);
  }
  const description = approvalModeEnableIntent(t, "/synthetic/workspace", "task-a", "Synthetic task").description;
  for (const text of ["deletion", "Workspace information", "Network access not granted", "Tenant, path, credential and sandbox", "Plan content", "Existing pending approvals are not approved", "isolated windows", "Logging out or restarting", "actions already started"]) {
    assert.ok(description.includes(text), text);
  }
});

test("control binds its lifecycle to login, workspace and task and uses server invalidation rather than storage or model flags", () => {
  const chat = fs.readFileSync(path.join(root, "frontend/src/components/ChatPanel.tsx"), "utf8");
  const hook = fs.readFileSync(path.join(root, "frontend/src/hooks/useApprovalMode.ts"), "utf8");
  const control = fs.readFileSync(path.join(root, "frontend/src/components/ApprovalModeControl.tsx"), "utf8");
  assert.ok(chat.includes("<ApprovalModeControl key={JSON.stringify([token, workspaceDir, currentConversationId, isolatedWindow])}"));
  assert.ok(chat.indexOf("<ApprovalModeControl") < chat.indexOf("{changesOpen ?"), "The warning remains visible in the changes view and outside folded details");
  for (const event of ["focus", "online", "visibilitychange", "BroadcastChannel", "15_000", "client.dispose()"]) assert.ok(hook.includes(event), event);
  assert.doesNotMatch(hook + control, /localStorage|sessionStorage|\.send\(/);
  assert.ok(control.includes('mode.setMode("full_access", true)'), "Only the risk dialog confirms enabling");
  assert.ok(control.includes('onDisable={() => { setConfirmOpen(false); void mode.setMode("ask"); }}'), "Turning off needs no second confirmation");
  assert.ok(control.includes("confirmDisabled={!connected || !mode.verified || !mode.snapshot?.canEnable}"));
});
