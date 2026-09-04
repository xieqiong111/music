# 验证记录：Tauri 2 打包流程（第六阶段）

- 日期：2026-09-05
- 交付物：`apps/desktop/**`（Tauri 2 脚手架）、`apps/desktop/README.md`（构建命令）、本文件
- 范围声明：本机**无 Rust 工具链、无 Android SDK**（下有实测证据），本阶段交付的是
  **可审查脚手架 + 精确构建命令**；**未执行任何 Tauri/cargo/Gradle 构建，下述所有构建
  目标全部处于"未验证"状态**。

## 1. 结论

| 项 | 状态 |
| --- | --- |
| 脚手架文件（Cargo.toml / tauri.conf.json / capabilities / main.rs / lib.rs / build.rs / 平台覆盖 conf / 占位图标） | 已创建，仅静态审查 |
| Windows x64 NSIS / MSI | **未构建，未验证** |
| Windows arm64 NSIS / MSI | **未构建，未验证** |
| macOS arm64 / x86_64 / universal 的 App / DMG | **未构建，未验证** |
| Android aarch64 APK（debug 签名 / 未签名 release） | **未构建，未验证** |
| `tauri dev`（桌面开发模式 + CSP 运行时行为） | **未运行，未验证** |
| 前端接入 plugin-dialog / 写盘 / 安全存储 | 未实现（后续任务），未验证 |

## 2. 环境探测记录（实测）

环境：Windows 11（10.0.26200 x64），Git Bash。全部命令为只读探测。

| 探测命令 | 期望 | 实际结果 |
| --- | --- | --- |
| `command -v cargo` | 无 Rust 工具链 | `(not found)` |
| `command -v rustc` | 无 Rust 工具链 | `(not found)` |
| `command -v rustup` | 无 Rust 工具链 | `(not found)` |
| `command -v adb` | 无 Android 平台工具 | `(not found)` |
| `command -v keytool` | 无 JDK 工具在 PATH | `(not found)` |
| `cargo --version` | 失败 | `command not found`，**exit=127** |
| `rustc --version` | 失败 | `command not found`，**exit=127** |
| `rustup --version` | 失败 | `command not found`，**exit=127** |
| `adb --version` | 失败 | `command not found`，**exit=127** |
| `echo $ANDROID_HOME` | 空 | 空（`ANDROID_SDK_ROOT`/`ANDROID_NDK_HOME`/`NDK_HOME`/`JAVA_HOME` 同样为空） |
| `ls "$LOCALAPPDATA/Android/Sdk"` | SDK 缺失 | `No such file or directory` |
| `java -version` | 记录在位 Java | Java 8（1.8.0_451）——不满足 AGP 8 所需 JDK 17 |
| `ls "C:/Program Files/Android"` | 记录在位组件 | 仅 `jdk-8.0.302.8-hotspot`，无 SDK/NDK |
| `node --version` / `pnpm --version` | 记录 JS 工具链 | v24.20.0 / pnpm 11.25.0（仓库声明 packageManager pnpm@11.19.0） |
| vswhere 查 VC.Tools.x86.x64 | 记录 MSVC 状态 | VS2022 Community 在位（`C:\Program Files\Microsoft Visual Studio\2022\Community`） |
| reg query WebView2 | 记录 WebView2 | WebView2 Runtime 152.0.4191.62 在位 |
| `ls` 工作副本根 | 仓库实体核对 | **空目录：本工作副本不存在 monorepo（apps/web、pnpm-workspace.yaml 等均不在）**，脚手架按任务描述的仓库现状撰写 |

结论：桌面构建链缺 Rust（若安装 rustup 即可基本补齐——MSVC 与 WebView2 已在位，
但按任务边界禁止安装）；Android 构建链完全缺失（无 SDK/NDK/JDK17）。

## 3. 静态核对记录（本阶段实际做过的验证）

- 联网核对 Tauri 2 官方文档与源码（2026-09）：
  - v2 配置参考：`app.withGlobalTauri`（默认 false）、`bundle.targets` 取值、identifier
    仅允许字母/数字/连字符/点；`frontendDist` 相对**配置文件**解析。
  - `tauri-cli` 2.11.4 的 `Cargo.toml`：`tauri-utils` 启用 `config-json5`（CLI 默认可解析
    带注释的 `tauri.conf.json`）；`tauri-build` 默认仅严格 JSON → 本脚手架显式开启
    `config-json5` feature。
  - crates.io / GitHub：tauri 2.10.2（MSRV 1.77.2）、tauri-cli 2.11.4、tauri-plugin-dialog
    2.7.3、tauri-plugin-opener 2.5.3。
  - plugin-dialog 权限名：`dialog:allow-save` 等（capabilities 只放行保存所需权限）。
  - Android applicationId 禁止连字符、`tauri android init` 遇连字符失败：
    tauri-apps/tauri#9707、#10764 → 以 `tauri.android.conf.json` 覆盖 identifier。
- 本地文件校验：`tauri.conf.json`（JSON5）与三份平台覆盖 conf、`capabilities/default.json`、
  `package.json` 均通过脚本化解析校验；占位图标（PNG/ICO/ICNS）由 Node 内置 zlib 构造并做
  结构校验（IHDR/IDAT/IEND CRC32、ICO 头/ICNS 头）。
- **未做**：任何 cargo 编译、clippy、`tauri build`、`tauri android init/build`、Gradle 构建。

## 4. 未执行构建目标清单（逐项）

| # | 目标 | 命令（见 apps/desktop/README.md） | 状态 |
| --- | --- | --- | --- |
| 1 | Windows x64 NSIS | `pnpm --filter @playlist-exporter/desktop exec tauri build` | 未执行 |
| 2 | Windows x64 MSI | 同上（bundle.targets 含 msi） | 未执行 |
| 3 | Windows arm64 NSIS/MSI | `… tauri build --target aarch64-pc-windows-msvc` | 未执行（rustup target 未装） |
| 4 | macOS arm64 App/DMG | `… tauri build --target aarch64-apple-darwin` | 未执行（无 macOS 环境） |
| 5 | macOS x86_64 App/DMG | `… tauri build --target x86_64-apple-darwin` | 未执行 |
| 6 | macOS universal App/DMG | `… tauri build --target universal-apple-darwin` | 未执行 |
| 7 | Android aarch64 APK（debug 签名） | `tauri android init` → `tauri android build --target aarch64 --apk` | 未执行（无 SDK/NDK/JDK17） |
| 8 | Android release APK（未签名产物形态） | 同上（release variant） | 未执行 |
| 9 | `tauri dev` 烟雾测试（窗口/CSP/IPC） | `pnpm --filter @playlist-exporter/desktop exec tauri dev` | 未执行 |
| 10 | 前端 plugin-dialog 保存对话框端到端 | 依赖 apps/web 接入（后续任务） | 未实现 |

## 5. 未来验证者回填清单

在具备工具链的机器上按 `apps/desktop/README.md` 执行后，请逐项回填（复制本表填写）：

| # | 回填项 | 期望核对点 | 回填（待填） |
| --- | --- | --- | --- |
| 1 | Rust/工具链版本 | `rustc --version`、`cargo --version`、`pnpm exec tauri --version` | 待填 |
| 2 | Cargo.lock | 首建成功后入库；记录 tauri/tauri-plugin-dialog 解析到的精确版本 | 待填 |
| 3 | Windows x64 产物 | `target/release/bundle/nsis/*.exe`、`bundle/msi/*.msi` 存在且可安装 | 待填 |
| 4 | Windows arm64 产物 | `target/aarch64-pc-windows-msvc/release/bundle/…`；arm64 机器上可运行 | 待填 |
| 5 | macOS 产物 | `bundle/macos/Playlist Exporter.app`、`bundle/dmg/*.dmg`；x86_64/arm64/universal 各一份 | 待填 |
| 6 | Android 产物 | `gen/android/app/build/outputs/apk/…` aarch64 APK；设备可安装（debug 签名） | 待填 |
| 7 | android init identifier | `tauri.android.conf.json` 覆盖是否使 init 通过（否则按 README 第 4 节回退） | 待填 |
| 8 | CSP 运行时行为 | devtools 无 CSP 违规告警；对非白名单远程地址的 fetch 被拒；回环 127.0.0.1:4319 可连 | 待填 |
| 9 | 保存对话框 | save() 弹出系统保存框并返回路径（需前端接入后测） | 待填 |
| 10 | 图标 | 以 `tauri icon` 生成品替换占位图标后重打包通过 | 待填 |
| 11 | release profile | 产物体积与 lto/strip 生效（对比 dev） | 待填 |
| 12 | 平台 targets 覆盖 | Windows 只出 nsis+msi、macOS 只出 app+dmg | 待填 |

## 6. 风险与需按 tauri stable 校准的点

1. 版本漂移：依赖锁主版本 `2`，首建时解析到比本文核对（tauri 2.10.2 / dialog 2.7.3 /
   cli 2.11.4）更新的小版本；权限名、配置键以当时 stable 为准。
2. `tauri.conf.json` 含 JSON5 注释：依赖 `tauri`/`tauri-build` 的 `config-json5` feature
   与 CLI ≥2.x 的默认支持；回归严格 JSON 即删注释、去 feature。
3. Android identifier 连字符：`tauri.android.conf.json` 覆盖方案未实测（tauri#9707）。
4. `devUrl` 端口与 `connect-src` 的 4319 端口需与 apps/web、apps/server 实际配置对齐
   （撰写环境无仓库实体，未能读取其配置）。
5. 占位图标未经打包实测；如 bundler 对占位 ICO/ICNS 挑剔，以 `tauri icon` 生成品为准。
6. MSVC arm64 交叉编译、macOS universal lipo 均为社区常规路径，但本阶段未验证。
