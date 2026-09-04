# @playlist-exporter/desktop —— Tauri 2 桌面/Android 壳

跨平台流媒体歌单导出工具的第六阶段交付：以 Tauri 2（稳定线 2.x）包装既有
`apps/web`（Vite 多页 PWA）产物，覆盖 Windows（NSIS/MSI）、macOS（App/DMG）、
Android（aarch64 APK）三个分发面。

> **验证状态（务必先读）**：本目录为可审查脚手架。撰写本 README 的机器上没有 Rust
> 工具链与 Android SDK（`cargo`/`rustc`/`rustup`/`adb` 全部 `command not found`，退出码 127），
> 因此**本阶段未执行过任何 Tauri/cargo 构建**，所有命令均未验证。命令清单、探测证据与
> 回填模板见 [`docs/verification/tauri.md`](../../docs/verification/tauri.md)。

## 1. 目录结构

```
apps/desktop/
├── package.json                  # workspace 包 @playlist-exporter/desktop；devDep @tauri-apps/cli ^2
├── README.md                     # 本文件
└── src-tauri/                    # Tauri 2 应用（Rust 侧）
    ├── Cargo.toml                # tauri 2 + tauri-plugin-dialog 2；profile.release lto/strip
    ├── build.rs                  # 标准 tauri_build::build()
    ├── tauri.conf.json           # 主配置（含 JSON5 注释，见下「注释兼容性」）
    ├── tauri.windows.conf.json   # 平台覆盖：bundle.targets = ["nsis","msi"]
    ├── tauri.macos.conf.json     # 平台覆盖：bundle.targets = ["app","dmg"]
    ├── tauri.android.conf.json   # 平台覆盖：identifier 去连字符（Android applicationId 限制）
    ├── capabilities/
    │   └── default.json          # 最小权限：core:default + dialog:allow-save
    ├── src/
    │   ├── main.rs               # 桌面 bin 薄壳
    │   └── lib.rs                # 共享构建（桌面 bin + Android cdylib 复用）
    └── icons/                    # 占位图标（见 icons/README.md，发布前用 tauri icon 替换）
```

关键配置事实（均已对照 Tauri 2 官方文档/schema 核对）：

- `build.frontendDist = "../../web/dist"`：相对**配置文件所在目录**（`src-tauri/`）解析，
  `src-tauri/../../` 即仓库根，因此指向 `apps/web/dist`。
- `build.beforeDevCommand` / `beforeBuildCommand` 用 `pnpm --filter @playlist-exporter/web …`
  在 monorepo 内任意子目录均可解析到 `apps/web`。
- `app.withGlobalTauri = false`：不注入 `window.__TAURI__`；前端需显式 npm 包调用 IPC
  （见第 5 节，接入属后续任务）。
- CSP 最小化：`default-src 'self'; img-src 'self' data:; connect-src 'self'
  http://127.0.0.1:4319`。connect-src 为白名单语义：白名单之外的一切远程主机连接被拒绝；
  仅放行回环本地服务（apps/server 本地端口 4319）。Tauri 会自动向 connect-src 追加 IPC
  所需源（Windows 上为 `http://ipc.localhost`），不要手工放宽。
- **注释兼容性**：`tauri.conf.json` 含 JSON5 注释。tauri-cli 2.11.x 已默认按 JSON5 解析；
  为让 `tauri-build`（build.rs）与 `generate_context!`（运行时宏）也能解析，Cargo.toml 中
  显式启用了 `tauri-build` 与 `tauri` 的 `config-json5` feature。若希望回归严格 JSON，
  删除注释并移除这两个 feature 即可。capabilities/*.json 按严格 JSON 解析，不能写注释。

## 2. 前置要求

| 平台 | 要求 |
| --- | --- |
| 通用 | Node ≥ 20、pnpm（仓库声明 `packageManager: pnpm@11.19.0`）；Rust stable（`rustup`，桌面构建的 MSRV 以 tauri 2.x 元数据为准，撰写时 tauri 2.10.2 声明 1.77.2，tauri-cli 2.11.x 声明 1.90 —— 以 stable 为准） |
| Windows | MSVC Build Tools（VS2022 “使用 C++ 的桌面开发”，含 `cl.exe` 与 Windows SDK；构建 arm64 还需勾选 MSVC ARM64 组件）；WebView2 Runtime（Win11 自带） |
| macOS | Xcode Command Line Tools（`xcode-select --install`）；跨架构构建需额外 rust target（见第 4 节） |
| Android | Android Studio + SDK Platform + Build-Tools + **NDK** + **JDK 17**（AGP 8 要求；JDK 8 不够），环境变量 `ANDROID_HOME`、`NDK_HOME`、`JAVA_HOME` |

Tauri CLI 二选一（本仓库采用 A）：

- A（devDep 方案，已写入 `apps/desktop/package.json`）：仓库根 `pnpm install` 后用
  `pnpm --filter @playlist-exporter/desktop exec tauri …`。
- B（免安装方案）：`pnpm dlx @tauri-apps/cli@^2 tauri …`。
- 也可在 `apps/desktop` 内直接 `cargo tauri …`（需另装 `cargo install tauri-cli --version "^2"`）。

> 注意：`apps/desktop/package.json` 是新增 workspace 成员，首次使用前需确认根
> `pnpm-workspace.yaml` 的 globs 已覆盖 `apps/*`（撰写环境未见仓库实体，此为按现状假设）。

## 3. 桌面构建（Windows / macOS）

```bash
# 0) 一次性：安装 workspace 依赖（含 @tauri-apps/cli）
pnpm install

# 1) 先产出前端静态产物（tauri build 的 beforeBuildCommand 也会自动执行，这里显式跑一次便于排错）
pnpm --filter @playlist-exporter/web build

# 2) 构建并打包（当前宿主平台默认 target）
pnpm --filter @playlist-exporter/desktop exec tauri build
```

### Windows

- x64（宿主默认）：上述命令即可。产物：
  - NSIS 安装器：`apps/desktop/src-tauri/target/release/bundle/nsis/*.exe`
  - MSI（WiX）：`apps/desktop/src-tauri/target/release/bundle/msi/*.msi`
- arm64 交叉编译（在 x64 宿主上）：

  ```bash
  rustup target add aarch64-pc-windows-msvc
  pnpm --filter @playlist-exporter/desktop exec tauri build --target aarch64-pc-windows-msvc
  ```

  前提：VS Installer 中已安装 “MSVC v143 - VS 2022 C++ ARM64 生成工具”。产物在
  `target/aarch64-pc-windows-msvc/release/bundle/…`。
  （MSVC 交叉编译 Rust/WebView2 在 Tauri 社区为常见做法，但**本阶段未验证**。）

### macOS

```bash
# Apple Silicon 宿主默认 aarch64；Intel 宿主默认 x86_64
pnpm --filter @playlist-exporter/desktop exec tauri build            # 本机架构
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# 显式单架构（在任一架构宿主上）
pnpm --filter @playlist-exporter/desktop exec tauri build --target aarch64-apple-darwin
pnpm --filter @playlist-exporter/desktop exec tauri build --target x86_64-apple-darwin

# Universal 2（CLI 自动 lipo 合并双架构；需两个 rust target 均已安装）
pnpm --filter @playlist-exporter/desktop exec tauri build --target universal-apple-darwin
```

产物：`target/<target>/release/bundle/macos/Playlist Exporter.app` 与
`bundle/dmg/*.dmg`。**未签名/未公证**：Gatekeeper 会拦截，首次打开需右键 → 打开，
或 `xattr -cr "Playlist Exporter.app"`；签名与公证属后续任务（需要 Apple Developer 账号）。

## 4. Android（aarch64 APK）

```bash
# 前提：ANDROID_HOME / NDK_HOME / JAVA_HOME(17) 已设置（见第 2 节）
# 1) 生成 gen/android 工程（首次；gen/ 属生成物，签名材料一律不得入库）
pnpm --filter @playlist-exporter/desktop exec tauri android init

# 2) 构建 aarch64 APK（--apk 只出 APK；不加该 flag 会同时产出 AAB）
pnpm --filter @playlist-exporter/desktop exec tauri android build --target aarch64 --apk
```

- 产物：`apps/desktop/src-tauri/gen/android/app/build/outputs/apk/…`。
- **签名现状**：`debug` 构建用 Android debug keystore 自动签名（仅本机测试）；
  `release` APK 未配置签名时无法安装。正式签名需在 `gen/android` 配置 keystore
  （keystore/密码不进 git），属后续任务。
- **identifier 特殊处理**：Android applicationId 不允许连字符，`tauri android init` 遇
  `com.localfirst.playlist-exporter` 会失败（tauri-apps/tauri#9707）。本脚手架以
  `tauri.android.conf.json` 把 Android 侧 identifier 覆盖为
  `com.localfirst.playlistexporter`（仅字母/数字/点，同时满足 Tauri 配置规范与 Android
  规则）。**该覆盖本身未验证**；若 init 仍报 identifier 错误，回退方案是临时将主配置的
  identifier 改为无连字符变体后重新 init，并在此记录。

## 5. 系统保存对话框、写盘与安全存储（架构位置已留，接入为后续任务）

- **保存对话框**（本阶段已就绪的部分）：Rust 侧注册 `tauri-plugin-dialog`，capability 仅放行
  `dialog:allow-save`（见 `capabilities/default.json`）。前端用法（后续在 `apps/web` 接入，
  本阶段白名单不允许改 apps/web）：

  ```js
  // 运行于 Tauri WebView 时按需动态加载；产物来自 @playlist-exporter/exporters 本地生成
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({
    defaultPath: 'playlist.json',
    filters: [{ name: 'Playlist', extensions: ['json', 'm3u8'] }],
  });
  ```

- **写盘**：拿到 `path` 后把导出内容写入磁盘，需要 `tauri-plugin-fs`（最小 `fs:scope`/写
  权限）或一个自定义 Rust command。本阶段刻意不引入，避免放大攻击面；接入时同步收紧
  capability。
- **安全存储**（凭据/令牌）：目标对应 Windows Credential Manager / macOS Keychain /
  Android Keystore。建议方案：
  1. `tauri-plugin-stronghold`（Tauri 官方插件，加密存储库，三端覆盖一致）；或
  2. 以 Rust `keyring` crate 自封装插件（`keyring` 底层即 Windows Credential Manager /
     macOS Keychain；Android 无系统级 Keychain 等价物，需走 Keystore +
     EncryptedSharedPreferences 的原生侧实现）。
  二者均标注为**后续任务**：本阶段仅在 `src/lib.rs` 的 Builder 链上留出注册位置并在本节
  留档，不引入依赖、不放行任何相关 capability。

## 6. 图标

`src-tauri/icons/` 当前是脚本生成的**占位图标**（见 `src-tauri/icons/README.md`）。
发布前替换：

```bash
pnpm --filter @playlist-exporter/desktop exec tauri icon path/to/app-icon.png   # >= 1024x1024
```

## 7. 待校准项（首次构建前逐项核对）

1. `build.devUrl` 端口：Vite 默认 5173，须与 `apps/web` 的实际 dev server 端口一致。
2. `connect-src http://127.0.0.1:4319` 端口：须与 `apps/server` 本地服务实际端口一致。
3. Cargo 依赖精确版本：首建成功后提交 `Cargo.lock`；npm 侧 `@tauri-apps/cli` 锁定 `^2`。
4. `pnpm-workspace.yaml` globs 是否已覆盖 `apps/*`（本脚手架新增了 workspace 成员）。
5. `tauri.android.conf.json` 的 identifier 覆盖在 `tauri android init` 上是否生效（见第 4 节）。
