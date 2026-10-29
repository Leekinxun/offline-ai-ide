const bridge = window.crownforgeConnection;
const form = document.getElementById("connection-form");
const input = document.getElementById("server-url");
const errorBox = document.getElementById("form-error");
const retryButton = document.getElementById("retry-button");
const connectButton = document.getElementById("connect-button");
let currentState = null;
let submitting = false;

function showError(error) {
  errorBox.textContent = String(error?.message || error || "连接失败，请重试。").replace(/^Error invoking remote method '[^']+': (?:Error|TypeError): /, "");
  errorBox.hidden = false;
}
function render(state) {
  currentState = state;
  if (!input.value && state.serverUrl) input.value = state.serverUrl;
  document.getElementById("status-dot").className = `dot ${state.status}`;
  const countdown = state.retryAt ? ` ${Math.max(1, Math.ceil((state.retryAt - Date.now()) / 1000))} 秒后重试（${state.attempt}/5）` : "";
  document.getElementById("status-text").textContent = (state.message || "填写服务器地址后连接") + countdown;
  document.getElementById("server-origin").textContent = state.serverUrl || "";
  retryButton.hidden = !state.serverUrl || state.status === "connected";
}
async function invoke(action) {
  if (submitting) return;
  submitting = true; connectButton.disabled = true; retryButton.disabled = true; errorBox.hidden = true;
  try { render(await action()); } catch (error) { showError(error); }
  finally { submitting = false; connectButton.disabled = false; retryButton.disabled = false; }
}
form.addEventListener("submit", (event) => { event.preventDefault(); if (bridge) void invoke(() => bridge.connect(input.value)); });
retryButton.addEventListener("click", () => { if (bridge) void invoke(() => bridge.retry()); });
if (bridge) {
  bridge.onState(render);
  void bridge.getState().then(render).catch(showError);
  setInterval(() => { if (currentState?.retryAt) render(currentState); }, 1000);
} else {
  showError("连接组件无法加载，请重新启动桌面客户端。");
  connectButton.disabled = true;
}
