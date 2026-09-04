# 跨平台流媒体歌单导出工具 — 多阶段构建
# 构建阶段安装依赖并产出 server bundle（esbuild 单文件）与 web 静态资源；
# 运行阶段只携带产物，不含 node_modules 与源码。

# ---------- 构建阶段 ----------
FROM node:24-alpine AS build
WORKDIR /app

# 固定 pnpm 版本，与根 package.json 的 packageManager（pnpm@11.19.0）保持一致。
RUN npm install -g pnpm@11.19.0

# 先只复制清单文件：锁文件未变时依赖安装层可被 Docker 缓存复用。
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/exporters/package.json packages/exporters/package.json
COPY packages/provider-netease/package.json packages/provider-netease/package.json
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

# HOST 故意不设置：镜像单独运行时保持默认 127.0.0.1（loopback，最安全）；
# docker-compose 部署通过 environment 显式覆盖 HOST=0.0.0.0（届时 ACCESS_TOKEN 必填）。
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
