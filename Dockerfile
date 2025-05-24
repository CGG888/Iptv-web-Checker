# 构建阶段
FROM node:18-alpine AS builder

WORKDIR /build

# 只复制 package 文件
COPY package*.json ./

# 安装生产环境依赖
RUN npm install --omit=dev --no-optional

# 复制源代码
COPY . .

# 最终阶段
FROM node:18-alpine

# 安装 ffmpeg，使用 --no-cache 避免保存 apk 缓存
RUN apk add --no-cache ffmpeg

# 创建 app 用户，避免使用 root 运行应用
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# 只从构建阶段复制必要的文件
COPY --from=builder /build/package.json .
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/src ./src
COPY --from=builder /build/public ./public

# 设置应用目录的所有权
RUN chown -R appuser:appgroup /app

# 切换到非 root 用户
USER appuser

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV NODE_ENV=production

# 启动应用
CMD ["npm", "start"]