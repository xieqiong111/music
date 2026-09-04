// 标准 Tauri 2 构建脚本。
// 职责：解析 tauri.conf.json（本配置含 JSON5 注释，依赖 Cargo.toml 中
// tauri-build 的 config-json5 feature）、校验配置与 capabilities、
// 生成上下文/资源代码、设置 Windows 下的资源与链接（WebView2Loader）。
fn main() {
    tauri_build::build()
}
