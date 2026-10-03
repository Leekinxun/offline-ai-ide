#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod policy;
mod preferences;
mod windows;

use backend::Backend;
use preferences::Preferences;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use url::Url;

struct DesktopState {
    backend_url: Url,
    bootstrap_token: String,
    backend: Arc<Backend>,
    preferences: Mutex<Preferences>,
    registered: Mutex<HashMap<String, String>>,
    next_window: AtomicU64,
    quitting: AtomicBool,
    folder_picker_open: AtomicBool,
}

fn authorize(window: &WebviewWindow, state: &DesktopState, token: &str) -> Result<(), String> {
    let registered = state
        .registered
        .lock()
        .map_err(|_| "Desktop state unavailable")?;
    if registered
        .get(window.label())
        .is_none_or(|expected| expected != token)
        || !policy::trusted_ui(
            window.url().map_err(|error| error.to_string())?.as_str(),
            &state.backend_url,
        )
    {
        return Err("Unauthorized desktop request".into());
    }
    Ok(())
}

#[tauri::command]
fn get_preferences(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    token: String,
) -> Result<Value, String> {
    authorize(&window, &state, &token)?;
    Ok(state
        .preferences
        .lock()
        .map_err(|_| "Desktop preferences unavailable")?
        .get())
}

#[tauri::command]
fn set_preferences(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    token: String,
    patch: Value,
) -> Result<Value, String> {
    authorize(&window, &state, &token)?;
    state
        .preferences
        .lock()
        .map_err(|_| "Desktop preferences unavailable")?
        .set(patch)
}

#[tauri::command]
async fn open_external(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    token: String,
    url: String,
) -> Result<bool, String> {
    authorize(&window, &state, &token)?;
    Ok(windows::open_external(&url, &state.backend_url))
}

fn show_failure(app: &tauri::AppHandle, message: String) {
    eprintln!("CrownForge desktop: {message}");
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("CrownForge 启动失败")
        .show(move |_| handle.exit(1));
}

fn main() {
    let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
        tauri::generate_handler![get_preferences, set_preferences, open_external];
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(move |invoke| {
            // Tauri checks its actual invoking frame URL against the explicit
            // app command manifest before this handler. Require a resolved ACL
            // as well as our window registry; commands also verify their token
            // and current top-level URL. Preview frames get neither the bridge
            // nor a matching remote capability.
            let app = invoke.message.webview().app_handle().clone();
            let allowed = app.try_state::<DesktopState>().is_some_and(|state| {
                invoke.acl.is_some()
                    && state.registered.lock().is_ok_and(|windows| windows.contains_key(invoke.message.webview().label()))
            });
            if !allowed { invoke.resolver.reject("Unauthorized desktop request"); return true; }
            commands(invoke)
        })
        .setup(|app| {
          let startup = (|| -> Result<(), Box<dyn std::error::Error>> {
            if !cfg!(any(target_os = "macos", target_os = "windows")) {
                return Err("The native desktop host currently supports macOS and Windows only; Linux frame isolation has not been verified".into());
            }
            let data = backend::DesktopData::ensure(app.handle())?;
            let preferences = Preferences::load(data.directory.join("preferences.json"))?;
            let initial_password = data.initial_password.clone();
            let backend::BackendStartup { backend, messages, url, bootstrap_token } = Backend::start(app.handle(), &data)?;
            let backend = Arc::new(backend);
            app.manage(DesktopState {
                backend_url: url,
                bootstrap_token,
                backend: backend.clone(),
                preferences: Mutex::new(preferences),
                registered: Mutex::new(HashMap::new()),
                next_window: AtomicU64::new(1),
                quitting: AtomicBool::new(false),
                folder_picker_open: AtomicBool::new(false),
            });
            windows::install_menu(app.handle())?;
            windows::create(app.handle(), "main".into(), None, None)?;
            backend::listen(app.handle().clone(), backend, messages);
            if let Some(password) = initial_password {
                let handle = app.handle().clone();
                let clipboard_password = password.clone();
                app.dialog().message(format!("已创建本机管理员账号 admin\n\n初始密码：{password}\n\n请保存密码。登录后可以在设置中修改。"))
                    .title("CrownForge 首次启动")
                    .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom("复制密码并继续".into(), "继续".into()))
                    .show(move |copy| {
                        if copy && handle.clipboard().write_text(clipboard_password.clone()).is_err() {
                            handle.dialog().message(format!("无法复制初始密码，请手动保存：{clipboard_password}"))
                                .title("复制失败").show(|_| {});
                        }
                    });
            }
            Ok(())
          })();
          if let Err(error) = startup { show_failure(app.handle(), error.to_string()); }
          Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<DesktopState>() {
                    if let Ok(mut registered) = state.registered.lock() { registered.remove(window.label()); }
                }
                if window.label() == "main" { window.app_handle().exit(0); }
            }
        })
        .build(tauri::generate_context!());
    match application {
        Ok(app) => app.run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(state) = app.try_state::<DesktopState>() {
                    if !state.quitting.swap(true, Ordering::SeqCst) {
                        state.backend.stop();
                    }
                }
            }
        }),
        Err(error) => eprintln!("CrownForge desktop failed to start: {error}"),
    }
}
