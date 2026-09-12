/**
 * 桌面壳(Tauri)判定。
 *
 * Tauri 2 在 WebView 的 window 上注入 __TAURI_INTERNALS__;静态壳里没有任何
 * /api/* 后端,因此桌面模式下必须跳过服务端会话探测并隐藏联网功能。
 * 按调用时机惰性求值(而非模块加载期常量),便于测试在 jsdom 中注入/移除标记。
 */
export const isDesktopShell = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
