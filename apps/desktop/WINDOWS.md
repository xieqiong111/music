# Windows x64 安装包

下载本 Release 的 `Playlist Exporter_0.1.0_x64-setup.exe`，运行安装后从开始菜单打开 Playlist Exporter。

- 包含 Node 24、本地后端和网页资源，无需自行安装 Node、pnpm 或启动服务器。
- 首次登录账号：`admin`，密码：`admin`。登录后可在账户菜单修改。
- 支持网易云与 QQ 公开歌单元数据读取、Apple Music 文件导入，以及 TXT / CSV / JSON 导出。
- 本地服务只监听 `127.0.0.1` 的动态端口；退出桌面窗口后服务随之退出。
- 账号与本地音乐库数据保存在 `%LOCALAPPDATA%\com.localfirst.playlist-exporter\backend`，不写入安装目录。
- 安装包未签名，Windows 可能显示未知发布者。`SHA256SUMS.txt` 可用于校验下载文件。
- 需要 Microsoft WebView2 Runtime；安装器会在缺少时尝试下载，因此首次安装可能需要联网。

发布流水线仅在 Windows 类型检查、单元测试、安装包构建、后端登录与来源校验、实际 EXE 登录/文件导入/TXT 下载/退出检查全部通过后发布。
在线平台接口受网络与服务商变化影响；上述桌面验收使用合成的本地歌单，不宣称重新验证了所有实时平台接口。

源代码对应本 Release 的 tag。Cargo.lock 随附件提供以记录本次 Rust 依赖解析结果。
