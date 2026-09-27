export const COMPACT_WORKBENCH_MAX_WIDTH = 1100;
export const NARROW_WORKBENCH_MAX_WIDTH = 860;
export const MOBILE_WORKBENCH_MAX_WIDTH = 640;

export type WorkspaceView = "chat" | "files";

export type WorkspaceDrawer =
  | "sidebar"
  | "chat"
  | "terminal"
  | "team"
  | "agents"
  | "git"
  | "checkpoints"
  | "problems"
  | "run-center"
  | "debug";

export interface ChatRestoreState {
  viewportWidth: number;
  workspaceView: WorkspaceView;
  chatVisible: boolean;
}

export interface WorkspaceDrawerState {
  viewportWidth: number;
  workspaceView: WorkspaceView;
  sidebarVisible: boolean;
  chatVisible: boolean;
  terminalVisible: boolean;
  teamVisible: boolean;
  agentsVisible: boolean;
  gitVisible: boolean;
  checkpointsVisible: boolean;
  problemsVisible: boolean;
  runCenterVisible: boolean;
  debugVisible: boolean;
}

export function isCompactWorkbench(viewportWidth: number): boolean {
  return viewportWidth <= COMPACT_WORKBENCH_MAX_WIDTH;
}

export function isNarrowWorkbench(viewportWidth: number): boolean {
  return viewportWidth <= NARROW_WORKBENCH_MAX_WIDTH;
}

export function isMobileWorkbench(viewportWidth: number): boolean {
  return viewportWidth <= MOBILE_WORKBENCH_MAX_WIDTH;
}

export function shouldRestoreChatAfterToolDrawerOpen(state: ChatRestoreState): boolean {
  return isNarrowWorkbench(state.viewportWidth) && state.workspaceView === "chat" && state.chatVisible;
}

export function chatVisibleAfterToolDrawerClose(state: Omit<ChatRestoreState, "chatVisible"> & { restorePending: boolean }): boolean | null {
  if (!isNarrowWorkbench(state.viewportWidth)) return null;
  return state.workspaceView === "chat" && state.restorePending;
}

export function terminalUsesDrawerMode(state: Pick<WorkspaceDrawerState, "viewportWidth" | "workspaceView" | "terminalVisible">): boolean {
  if (!state.terminalVisible || !isCompactWorkbench(state.viewportWidth)) return false;
  return state.workspaceView === "chat" || isMobileWorkbench(state.viewportWidth);
}

export function getActiveWorkspaceDrawer(state: WorkspaceDrawerState): WorkspaceDrawer | null {
  if (!isCompactWorkbench(state.viewportWidth)) return null;
  if (terminalUsesDrawerMode(state)) return "terminal";
  if (state.teamVisible) return "team";
  if (state.agentsVisible) return "agents";
  if (state.gitVisible) return "git";
  if (state.checkpointsVisible) return "checkpoints";
  if (state.problemsVisible) return "problems";
  if (state.runCenterVisible) return "run-center";
  if (state.debugVisible) return "debug";
  if (isMobileWorkbench(state.viewportWidth) && state.sidebarVisible) return "sidebar";
  if (isMobileWorkbench(state.viewportWidth) && state.chatVisible) return "chat";
  return null;
}

export function isModalWorkspaceDrawer(viewportWidth: number, drawer: WorkspaceDrawer | null, options: { terminalDrawerMode?: boolean } = {}): boolean {
  if (!drawer) return false;
  if (!isCompactWorkbench(viewportWidth)) return false;
  if (drawer === "terminal") return Boolean(options.terminalDrawerMode);
  return drawer === "git"
    || drawer === "agents"
    || drawer === "team"
    || drawer === "checkpoints"
    || drawer === "problems"
    || drawer === "run-center"
    || drawer === "debug";
}
