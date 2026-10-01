import assert from "node:assert/strict";
import test from "node:test";
import {
  chatVisibleAfterToolDrawerClose,
  getActiveWorkspaceDrawer,
  isModalWorkspaceDrawer,
  shouldRestoreChatAfterToolDrawerOpen,
  terminalUsesDrawerMode,
  type WorkspaceView,
} from "../frontend/src/utils/workbenchLayout.ts";

function openToolDrawer(viewportWidth: number, workspaceView: WorkspaceView, chatVisible: boolean) {
  const restorePending = shouldRestoreChatAfterToolDrawerOpen({
    viewportWidth,
    workspaceView,
    chatVisible,
  });
  return {
    restorePending,
    chatVisible: viewportWidth <= 860 ? false : chatVisible,
  };
}

function closeToolDrawer(viewportWidth: number, workspaceView: WorkspaceView, restorePending: boolean, chatVisible: boolean) {
  return chatVisibleAfterToolDrawerClose({
    viewportWidth,
    workspaceView,
    restorePending,
  }) ?? chatVisible;
}

test("narrow tool drawers restore the active AI task after closing", () => {
  const opened = openToolDrawer(640, "chat", true);
  assert.equal(opened.chatVisible, false);
  assert.equal(opened.restorePending, true);
  assert.equal(closeToolDrawer(640, "chat", opened.restorePending, opened.chatVisible), true);
});

test("narrow file workbench tool drawers do not reopen chat on close", () => {
  const opened = openToolDrawer(640, "files", false);
  assert.equal(opened.chatVisible, false);
  assert.equal(opened.restorePending, false);
  assert.equal(closeToolDrawer(640, "files", opened.restorePending, opened.chatVisible), false);
});

test("chat terminal is a visible drawer at tablet width and restores the AI task", () => {
  const opened = openToolDrawer(768, "chat", true);
  const terminalDrawerMode = terminalUsesDrawerMode({
    viewportWidth: 768,
    workspaceView: "chat",
    terminalVisible: true,
  });
  const activeDrawer = getActiveWorkspaceDrawer({
    viewportWidth: 768,
    workspaceView: "chat",
    sidebarVisible: false,
    chatVisible: opened.chatVisible,
    terminalVisible: true,
    teamVisible: false,
    agentsVisible: false,
    gitVisible: false,
    checkpointsVisible: false,
    problemsVisible: false,
    runCenterVisible: false,
    debugVisible: false,
  });
  assert.equal(opened.chatVisible, false);
  assert.equal(opened.restorePending, true);
  assert.equal(terminalDrawerMode, true);
  assert.equal(activeDrawer, "terminal");
  assert.equal(isModalWorkspaceDrawer(768, activeDrawer, { terminalDrawerMode }), true);
  assert.equal(closeToolDrawer(768, "chat", opened.restorePending, opened.chatVisible), true);
});

test("file terminal stays inline above the mobile drawer breakpoint", () => {
  const terminalDrawerMode = terminalUsesDrawerMode({
    viewportWidth: 768,
    workspaceView: "files",
    terminalVisible: true,
  });
  const activeDrawer = getActiveWorkspaceDrawer({
    viewportWidth: 768,
    workspaceView: "files",
    sidebarVisible: false,
    chatVisible: false,
    terminalVisible: true,
    teamVisible: false,
    agentsVisible: false,
    gitVisible: false,
    checkpointsVisible: false,
    problemsVisible: false,
    runCenterVisible: false,
    debugVisible: false,
  });
  assert.equal(terminalDrawerMode, false);
  assert.equal(activeDrawer, null);
  assert.equal(isModalWorkspaceDrawer(768, activeDrawer, { terminalDrawerMode }), false);
});

test("fixed utility drawers are modal through the compact workbench", () => {
  const gitDrawer = getActiveWorkspaceDrawer({
    viewportWidth: 900,
    workspaceView: "files",
    sidebarVisible: false,
    chatVisible: false,
    terminalVisible: false,
    teamVisible: false,
    agentsVisible: false,
    gitVisible: true,
    checkpointsVisible: false,
    problemsVisible: false,
    runCenterVisible: false,
    debugVisible: false,
  });
  const checkpointsDrawer = getActiveWorkspaceDrawer({
    viewportWidth: 900,
    workspaceView: "chat",
    sidebarVisible: false,
    chatVisible: true,
    terminalVisible: false,
    teamVisible: false,
    agentsVisible: false,
    gitVisible: false,
    checkpointsVisible: true,
    problemsVisible: false,
    runCenterVisible: false,
    debugVisible: false,
  });
  assert.equal(gitDrawer, "git");
  assert.equal(checkpointsDrawer, "checkpoints");
  assert.equal(isModalWorkspaceDrawer(900, gitDrawer), true);
  assert.equal(isModalWorkspaceDrawer(900, checkpointsDrawer), true);
  assert.equal(isModalWorkspaceDrawer(1200, "git"), false);
});
