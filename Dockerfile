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
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV FFPROBE_PATH=/usr/bin/ffprobe
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web/dist
ENV NODE_ENV=production
CMD ["node", "--enable-source-maps", "dist/cli/index.js", "watch"]
