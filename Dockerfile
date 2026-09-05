# 跨平台流媒体歌单导出工具 — 多阶段构建
# 构建阶段安装依赖并产出 server bundle（esbuild 单文件）与 web 静态资源；
# 运行阶段只携带产物，不含 node_modules 与源码。

# ---------- 构建阶段 ----------
FROM node:24-alpine AS build
WORKDIR /app

# 固定 pnpm 版本，与根 package.json 的 packageManager（pnpm@11.19.0）保持一致。
RUN npm install -g pnpm@11.19.0

# 先只复制清单文件：锁文件未变时依赖安装层可被 Docker 缓存复用。
# 清单必须覆盖 pnpm-workspace.yaml（packages/* + apps/*）下的全部工作区 importer：
# pnpm-lock.yaml 的 importers 含 apps/desktop、packages/importers、provider-apple、
# provider-qq 等条目，缺少任何一个 package.json 都会让 --frozen-lockfile 因
# "锁文件与磁盘清单不一致" 直接失败（server/web 的源码也依赖这些 workspace 包）。
# apps/desktop（Tauri 壳）同样必须提供清单，但其 devDependency（@tauri-apps/cli，
# 锁文件已含 linux-x64-musl 变体）只落在本构建阶段；运行阶段不复制 node_modules，
# 且镜像构建不执行 tauri build（需要 Rust 工具链，桌面打包在 Docker 之外进行），
# 因此不会进入最终镜像。
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/exporters/package.json packages/exporters/package.json
COPY packages/importers/package.json packages/importers/package.json
COPY packages/provider-apple/package.json packages/provider-apple/package.json
COPY packages/provider-netease/package.json packages/provider-netease/package.json
COPY packages/provider-qq/package.json packages/provider-qq/package.json
RUN pnpm install --frozen-lockfile

# 再复制源码并构建（apps/*/dist 已被 .dockerignore 排除，在容器内重新生成）。
COPY . .
RUN pnpm --filter @playlist-exporter/server build \
 && pnpm --filter @playlist-exporter/web build

# ---------- 运行阶段 ----------
FROM node:24-alpine AS runtime
WORKDIR /app

# 数字 UID/GID 的非 root 用户（busybox addgroup/adduser）。
RUN addgroup -g 10001 app \
 && adduser -u 10001 -G app -S -D app

# esbuild 已把全部运行时依赖打包进 dist/index.js，不需要 node_modules。
# apps/server/package.json 含 "type":"module"，必须随包复制，否则 ESM 入口解析失败。
COPY --from=build /app/apps/server/dist/index.js /app/dist/index.js
COPY --from=build /app/apps/server/package.json /app/package.json
COPY --from=build /app/apps/web/dist /app/web/dist

# 构建产物从 build 阶段带入了受限 umask 的权限（如 0660 的 root:root bundle），
# 非 root 运行用户将无法读取。a+rX 为所有用户补读权限；对目录补执行位以保证
# 可遍历，对已有任一执行位的文件补齐执行位（本镜像复制的运行产物均无执行位，
# 因此实际效果是目录可遍历、文件保持不可执行）；属主保持 root，应用用户只读。
# 注意不能用 COPY --chmod=0644：它会把目录也置为 0644，丢掉目录的遍历位。
RUN chmod -R a+rX /app

# HOST 故意不设置：镜像单独运行时保持默认 127.0.0.1（loopback，最安全）；
# docker-compose 部署通过 environment 显式覆盖 HOST=0.0.0.0(认证由账号密码
# 会话体系管理,与监听地址无关)。
# HOME 指向 tmpfs 挂载点，兼容 read_only 根文件系统。
ENV NODE_ENV=production \
    PORT=4319 \
    WEB_DIST=/app/web/dist \
    HOME=/tmp

USER 10001:10001
EXPOSE 4319

# alpine 镜像没有 curl/wget，用 Node 内置 fetch 探活。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4319)+'/healthz').then(r=>{if(!r.ok)throw 0}).catch(()=>process.exit(1))"

CMD ["node", "/app/dist/index.js"]
