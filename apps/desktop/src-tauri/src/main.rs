// 桌面入口（Tauri 2 约定：main.rs 是薄壳，实际构建放在 lib.rs 的 run()，
// 使 Android/iOS 能以 cdylib 复用同一份应用构建）。
// windows_subsystem 属性：release 下隐藏 Windows 控制台窗口（调试构建保留 stderr 便于排错）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    playlist_exporter_lib::run()
}
