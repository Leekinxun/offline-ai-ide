fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_preferences",
            "set_preferences",
            "open_external",
        ]),
    ))
    .expect("Failed to build the desktop permission manifest");
}
