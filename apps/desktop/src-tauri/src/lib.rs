// Tauri 2 共享应用构建（桌面 bin 与 Android cdylib 共用此入口，见 Cargo.toml [lib]）。
//
// 架构说明：
// - 系统保存对话框由前端通过 plugin-dialog 的 JS API（@tauri-apps/plugin-dialog 的 save()）
//   直接调用并拿到用户选择的目标路径；Rust 侧只需注册插件，并在 capabilities/default.json
//   中以最小权限 dialog:allow-save 放行。
// - 歌单导出本身仍由前端调用 @playlist-exporter/exporters 在本地（WebView 内）生成文件内容；
//   把生成的内容写入所选路径需要 plugin-fs（最小作用域）或自定义 Rust command——属后续任务，
//   本阶段只留出插件注册与 capability 的架构位置（见 apps/desktop/README.md「保存对话框与写盘」）。
// - 凭据安全存储（Windows Credential Manager / macOS Keychain / Android Keystore）同为后续
//   任务（tauri-plugin-stronghold 或 Rust keyring 封装）；接入点即下方 Builder 插件链。

#[cfg(all(windows, not(debug_assertions)))]
mod backend;
#[cfg(all(windows, not(debug_assertions)))]
mod windows;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(windows, not(debug_assertions)))]
    windows::run();

    #[cfg(not(all(windows, not(debug_assertions))))]
    tauri::Builder::default()
        // 系统保存对话框插件（capability：dialog:allow-save，见 capabilities/default.json）
        .plugin(tauri_plugin_dialog::init())
        // 后续任务接入点：安全存储（stronghold/keyring）、opener（打开外部链接）等插件
        // 统一在此链上注册，并同步收紧对应 capability。
        .run(tauri::generate_context!())
        .expect("无法启动 Playlist Exporter 桌面壳（Tauri 运行时初始化失败）")
}
