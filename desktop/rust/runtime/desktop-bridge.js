(() => {
  if (window !== window.top) return;
  const origin = __CROWNFORGE_ORIGIN_JSON__;
  const NativeURL = window.URL;
  const NativeHeaders = window.Headers;
  const NativeRequest = window.Request;
  const trusted = () => {
    const page = new NativeURL(window.location.href);
    return !page.username && !page.password && page.origin === origin && ["/", "/login"].includes(page.pathname);
  };
  if (!trusted()) return;
  const token = __CROWNFORGE_BRIDGE_TOKEN_JSON__;
  const bootstrapToken = __CROWNFORGE_BOOTSTRAP_TOKEN_JSON__;
  if (typeof bootstrapToken !== "string" || !/^[a-f0-9]{64}$/i.test(bootstrapToken)) {
    throw new Error("Desktop authentication unavailable");
  }

  // The local daemon does not accept unauthenticated loopback clients. This
  // credential remains in this top-frame closure and authenticates only the
  // existing desktop session bootstrap endpoint, never general API traffic.
  const nativeFetch = window.fetch;
  const requestUrl = Object.getOwnPropertyDescriptor(NativeRequest.prototype, "url").get;
  const requestHeaders = Object.getOwnPropertyDescriptor(NativeRequest.prototype, "headers").get;
  window.fetch = function (input, init) {
    if (!trusted()) return Reflect.apply(nativeFetch, window, arguments);
    let target;
    let originalHeaders;
    let isRequest = false;
    try {
      let address = input;
      try {
        // Use the native getters so Request subclasses cannot spoof the URL.
        address = requestUrl.call(input);
        originalHeaders = requestHeaders.call(input);
        isRequest = true;
      } catch { /* Strings and URL objects follow normal fetch URL parsing. */ }
      target = new NativeURL(address, document.baseURI || window.location.href);
    } catch {
      return Reflect.apply(nativeFetch, window, arguments);
    }
    if (target.origin !== origin || target.pathname !== "/api/auth/me" || target.username || target.password) {
      return Reflect.apply(nativeFetch, window, arguments);
    }
    const headers = new NativeHeaders(originalHeaders);
    if (init && init.headers !== undefined) {
      new NativeHeaders(init.headers).forEach((value, name) => headers.set(name, value));
    }
    headers.set("X-CrownForge-Desktop-Bootstrap", bootstrapToken);
    // Freeze the resolved target for non-Request inputs so changing a base URI
    // or a URL object's string conversion cannot forward the credential away.
    return nativeFetch.call(window, isRequest ? input : target.href, { ...init, headers });
  };

  const listeners = new Set();
  const invoke = (command, args = {}) => {
    if (!trusted()) return Promise.reject(new Error("Unauthorized desktop request"));
    return window.__TAURI_INTERNALS__.invoke(command, { ...args, token });
  };
  Object.defineProperty(window, "crownforgeDesktop", { configurable: false, writable: false, value: Object.freeze({
    platform: __CROWNFORGE_PLATFORM_JSON__, version: __CROWNFORGE_VERSION_JSON__,
    workspaceChanges: "cursor",
    getPreferences: () => invoke("get_preferences"),
    setPreferences: (patch) => invoke("set_preferences", { patch }),
    openExternal: (url) => invoke("open_external", { url }),
    onZoomCommand(callback) {
      if (typeof callback !== "function") throw new TypeError("Zoom callback must be a function");
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  }) });
  Object.defineProperty(window, "__CROWNFORGE_DESKTOP_ZOOM__", { configurable: false, writable: false, value(command) {
    if (!trusted() || !["in", "out", "reset"].includes(command)) return;
    for (const callback of listeners) { try { callback(command); } catch (error) { console.error(error); } }
  } });
})();
