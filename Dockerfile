# Dockerfile
# 阶段 1：构建前端静态资源
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 阶段 2：编译后端（tsc 到 dist/，devDependencies 里的 typescript 只在这一层用）
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 阶段 3：运行时（生产 install 只拿 dependencies，plain node 跑编译产物 dist/，不含 tsx）
FROM node:22-slim
WORKDIR /app
# 系统 ffprobe：内嵌字幕探针（src/files/streamProbe.ts）优先走 FFPROBE_PATH，
# 镜像自带后运行时不再依赖 ffprobe-static 这个 ~50MB 的 npm 二进制下载。
# curl：subhd 源（SUBHD_ENABLED=true）必需——Node 的 TLS(JA3) 指纹被 subhd/Cloudflare 在临时页
# 校验上拒（undici/node:https 恒"已失效"），SubhdClient 默认 fetchImpl shell 到 curl（见
# src/adapters/providers/subhd.ts）。不启用 subhd 时 curl 只是闲置，代价极小。
# ca-certificates：curl 做 HTTPS 必需的 CA bundle。node:22-slim 不自带 /etc/ssl/certs/ca-certificates.crt，
# 而 --no-install-recommends 会把它作为 curl 的"推荐依赖"跳过 → curl(77) 证书错误 → subhd 容器内恒失效
# （host 冒烟能过是因 host 有 CA，容器没有——生产实测暴露）。装它，其 postinst 生成 CA bundle。
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV FFPROBE_PATH=/usr/bin/ffprobe
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web/dist
ARG IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision=$IMAGE_REVISION
ENV NODE_ENV=production
CMD ["node", "--enable-source-maps", "dist/cli/index.js", "watch"]
