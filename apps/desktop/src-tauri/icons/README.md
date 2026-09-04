# icons/ 占位图标说明

本目录中的 PNG / ICO / ICNS 均为**脚本生成的占位图标**（纯色双色圆角图案，仅用于让
`tauri build` 的图标引用不悬空），**不是产品视觉**。

正式发布前必须替换为真实产品图标：

```bash
# 准备一张 >= 1024x1024 的源 PNG，然后（在 monorepo 根执行）：
pnpm --filter @playlist-exporter/desktop exec tauri icon path/to/app-icon.png
```

`tauri icon` 会覆盖生成全平台所需图标（含 `icon.icns`、`icon.ico`、Android/iOS 的
mipmap/drawable 资源）。Android 侧图标在 `tauri android init` 之后再执行一次
`tauri icon` 即可同步进 `gen/android`。

占位图标的生成方式：Node 内置 zlib 手工构造 PNG/ICO/ICNS（无外部依赖、无网络下载），
已通过本会话的 PNG 结构校验（IHDR/IDAT/IEND CRC32 均有效），但**未经任何 Tauri 构建
实测**——若首次 `tauri build` 报图标格式错误，以 `tauri icon` 重新生成的一套为准。
