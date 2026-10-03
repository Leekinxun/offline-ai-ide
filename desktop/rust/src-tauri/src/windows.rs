use crate::{policy, DesktopState};
use std::sync::atomic::Ordering;
use tauri::{
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::{NewWindowFeatures, NewWindowResponse},
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use url::Url;

pub fn open_external(value: &str, backend: &Url) -> bool {
    policy::external_url(value, backend)
        .is_some_and(|url| open::that_detached(url.as_str()).is_ok())
}

fn bridge_script(backend: &Url, token: &str, bootstrap_token: &str, version: &str) -> String {
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    include_str!("../../runtime/desktop-bridge.js")
        .replace(
            "__CROWNFORGE_ORIGIN_JSON__",
            &serde_json::to_string(&backend.origin().ascii_serialization()).unwrap(),
        )
        .replace(
            "__CROWNFORGE_BRIDGE_TOKEN_JSON__",
            &serde_json::to_string(token).unwrap(),
        )
        .replace(
            "__CROWNFORGE_BOOTSTRAP_TOKEN_JSON__",
            &serde_json::to_string(bootstrap_token).unwrap(),
        )
        .replace(
            "__CROWNFORGE_PLATFORM_JSON__",
            &serde_json::to_string(platform).unwrap(),
        )
        .replace(
            "__CROWNFORGE_VERSION_JSON__",
            &serde_json::to_string(version).unwrap(),
        )
}

pub fn create(
    app: &tauri::AppHandle,
    label: String,
    requested: Option<Url>,
    features: Option<NewWindowFeatures>,
) -> tauri::Result<tauri::WebviewWindow> {
    let state = app.state::<DesktopState>();
    let backend = state.backend_url.clone();
    let url = requested.unwrap_or_else(|| backend.clone());
    let token = uuid::Uuid::new_v4().to_string();
    // A port-specific, path-specific remote capability is installed only after
    // the private child process reports its bound port. No localhost wildcard,
    // fs, shell, dialog, or window-management commands are granted to pages.
    app.add_capability(
        CapabilityBuilder::new(format!("workbench-{label}"))
            .local(false)
            .webview(label.clone())
            .remote(format!("{}/", backend.origin().ascii_serialization()))
            .remote(format!("{}/login", backend.origin().ascii_serialization()))
            .permission("desktop-bridge"),
    )?;
    state
        .registered
        .lock()
        .expect("Desktop window registry")
        .insert(label.clone(), token.clone());
    let navigation_backend = backend.clone();
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let popup_backend = backend.clone();
    let page_backend = backend.clone();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("CrownForge")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 640.0)
        .disable_drag_drop_handler()
        .initialization_script(bridge_script(
            &backend,
            &token,
            &state.bootstrap_token,
            &app.package_info().version.to_string(),
        ))
        .on_navigation(move |url| {
            // WebKit reports iframe navigations here too. Permit the existing
            // sandboxed preview document route without granting native access;
            // the page-load guard below rejects it as a top-level workbench.
            if url.as_str() == "about:blank"
                || policy::trusted_ui(url.as_str(), &navigation_backend)
                || policy::preview_document(url.as_str(), &navigation_backend)
            {
                return true;
            }
            let value = url.to_string();
            let backend = navigation_backend.clone();
            let _ = navigation_app.run_on_main_thread(move || {
                open_external(&value, &backend);
            });
            false
        })
        .on_page_load(move |window, payload| {
            if payload.url().as_str() != "about:blank"
                && !policy::trusted_ui(payload.url().as_str(), &page_backend)
            {
                open_external(payload.url().as_str(), &page_backend);
                let _ = window.navigate(page_backend.clone());
            }
        })
        .on_new_window(move |url, features| {
            if url.as_str() == "about:blank" || policy::trusted_ui(url.as_str(), &popup_backend) {
                let label = format!(
                    "workbench-{}",
                    popup_app
                        .state::<DesktopState>()
                        .next_window
                        .fetch_add(1, Ordering::SeqCst)
                );
                return match create(&popup_app, label, Some(url), Some(features)) {
                    Ok(window) => NewWindowResponse::Create { window },
                    Err(error) => {
                        eprintln!("Could not create desktop workspace window: {error}");
                        NewWindowResponse::Deny
                    }
                };
            }
            open_external(url.as_str(), &popup_backend);
            NewWindowResponse::Deny
        });
    if let Some(features) = features {
        builder = builder.window_features(features);
    }
    let result = builder.build();
    if result.is_err() {
        state
            .registered
            .lock()
            .expect("Desktop window registry")
            .remove(&label);
    }
    result
}

pub fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "desktop_reload", "Reload", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(
                app,
                "desktop_devtools",
                "Developer Tools",
                cfg!(debug_assertions),
                Some("CmdOrCtrl+Alt+I"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "zoom_reset", "Actual Size", true, Some("CmdOrCtrl+0"))?,
            &MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+Plus"))?,
            &MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "desktop_fullscreen",
                "Toggle Full Screen",
                true,
                Some("F11"),
            )?,
        ],
    )?;
    menu.append(&view)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let Some(window) = app
            .webview_windows()
            .into_values()
            .find(|window| window.is_focused().unwrap_or(false))
        else {
            return;
        };
        let state = app.state::<DesktopState>();
        if !state
            .registered
            .lock()
            .is_ok_and(|windows| windows.contains_key(window.label()))
            || !window
                .url()
                .is_ok_and(|url| policy::trusted_ui(url.as_str(), &state.backend_url))
        {
            return;
        }
        match event.id().as_ref() {
            "zoom_reset" => {
                let _ = window.eval("window.__CROWNFORGE_DESKTOP_ZOOM__?.('reset')");
            }
            "zoom_in" => {
                let _ = window.eval("window.__CROWNFORGE_DESKTOP_ZOOM__?.('in')");
            }
            "zoom_out" => {
                let _ = window.eval("window.__CROWNFORGE_DESKTOP_ZOOM__?.('out')");
            }
            "desktop_reload" => {
                let _ = window.eval("window.location.reload()");
            }
            #[cfg(debug_assertions)]
            "desktop_devtools" => window.open_devtools(),
            "desktop_fullscreen" => {
                if let Ok(fullscreen) = window.is_fullscreen() {
                    let _ = window.set_fullscreen(!fullscreen);
                }
            }
            _ => {}
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_uses_top_frame_guard_and_same_frontend_contract() {
        let script = bridge_script(
            &policy::ready_url("http://127.0.0.1:4000").unwrap(),
            "private-token",
            &"a".repeat(64),
            "1.1.1",
        );
        assert!(script.contains("window !== window.top"));
        assert!(script.contains("page.origin === origin"));
        assert!(script.contains("target.origin !== origin"));
        assert!(script.contains("target.pathname !== \"/api/auth/me\""));
        assert!(script.contains("const bootstrapToken ="));
        assert!(!script.contains("window.bootstrapToken"));
        assert!(script.contains("new NativeHeaders(originalHeaders)"));
        for method in [
            "getPreferences",
            "setPreferences",
            "openExternal",
            "onZoomCommand",
        ] {
            assert!(script.contains(method));
        }
    }
}
