use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use crate::backend::Backend;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") { window.hide()?; }
            let resources = app.path().resource_dir()?.join("resources");
            let data = app.path().app_local_data_dir()?.join("backend");
            let backend = match Backend::start(&resources, &data) {
                Ok(backend) => backend,
                Err(error) => {
                    app.dialog().message(format!("无法启动本地服务：{error}"))
                        .title("Playlist Exporter").blocking_show();
                    return Err(error.into());
                }
            };
            let origin = backend.origin.clone();
            // Register ownership before navigation, so every later error drops
            // the process guard and closes the backend.
            app.manage(Mutex::new(Some(backend)));
            let window = app.get_webview_window("main").ok_or("Main window is missing")?;
            window.navigate(origin.parse()?)?;
            window.show()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("无法初始化 Playlist Exporter")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<Mutex<Option<Backend>>>() {
                    if let Ok(mut backend) = state.lock() {
                        drop(backend.take());
                    }
                }
            }
        });
}
