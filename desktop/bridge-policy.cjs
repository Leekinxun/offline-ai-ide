function parseUrl(value) {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

function isTrustedUiUrl(value, backendUrl) {
  const url = parseUrl(value);
  return Boolean(url && backendUrl && url.origin === backendUrl && ["/", "/login"].includes(url.pathname));
}

function isTrustedSender(event, backendUrl, registeredContents) {
  const contents = event?.sender;
  const frame = event?.senderFrame;
  return Boolean(contents && registeredContents.has(contents) && !contents.isDestroyed() && frame &&
    frame === contents.mainFrame && isTrustedUiUrl(frame.url, backendUrl) && isTrustedUiUrl(contents.getURL(), backendUrl));
}

function isLoopbackHost(hostname) {
  hostname = hostname.replace(/\.$/, "");
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "0.0.0.0" ||
    hostname.startsWith("127.") || ["[::]", "[::1]"].includes(hostname) || hostname.startsWith("[::ffff:");
}

function externalUrl(value, backendUrl) {
  const url = parseUrl(value);
  if (!url) return null;
  if (url.origin === backendUrl && url.protocol === "http:" &&
    /^\/preview\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[a-f0-9]{64}\/$/.test(url.pathname) && !url.search && !url.hash) {
    return url.href;
  }
  if (url.protocol === "https:" && !isLoopbackHost(url.hostname)) return url.href;
  return null;
}

function createApplicationMenu(platform, onZoom, onServerConfig) {
  const zoomItem = (label, command) => ({ label, click: (_item, window) => onZoom(command, window) });
  const serverMenu = typeof onServerConfig === "function" ? [
    {
      label: "Server",
      submenu: [
        {
          label: "Switch Server...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: (_item, window) => onServerConfig(window),
        },
      ],
    },
  ] : [];
  return [
    ...(platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
        { type: "separator" },
        zoomItem("Actual Size", "reset"), zoomItem("Zoom In", "in"), zoomItem("Zoom Out", "out"),
        { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    ...serverMenu,
    { role: "windowMenu" },
  ];
}

module.exports = { isTrustedUiUrl, isTrustedSender, externalUrl, createApplicationMenu };
