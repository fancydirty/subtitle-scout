# Dockerfile
# 阶段 1：构建前端静态资源
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 阶段 2：运行时（tsx 跑后端，托管 web/dist）
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY --from=web /web/dist ./web/dist
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/cli/index.ts", "watch"]
