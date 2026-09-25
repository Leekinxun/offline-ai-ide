import React from "react";
import ReactDOM from "react-dom/client";

async function bootstrap() {
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  if (window.location.pathname === "/mobile" || window.location.pathname.startsWith("/mobile/")) {
    document.documentElement.lang = "zh-CN";
    document.documentElement.classList.add("crownforge-mobile-page");
    document.title = "CrownForge · 手机控制台";
    const { MobileApp } = await import("./mobile/MobileApp");
    root.render(<React.StrictMode><MobileApp /></React.StrictMode>);
    return;
  }

  const [{ initializePluginRuntime }, { default: App }, { I18nProvider }] = await Promise.all([
    import("./plugins/runtime"),
    import("./App"),
    import("./i18n"),
  ]);
  await initializePluginRuntime();
  root.render(
    <React.StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </React.StrictMode>
  );
}

void bootstrap();
