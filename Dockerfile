FROM m.daocloud.io/docker.io/library/node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制package.json和package-lock.json（如果存在）
COPY package*.json ./

# 安装依赖，使用npm ci以获得更快、更可靠的构建
RUN npm ci --only=production && npm cache clean --force

# 复制应用程序源代码
COPY . .

# 创建非root用户以增强安全性
RUN addgroup -g 1001 -S nodejs && \
    adduser -S fileRocket -u 1001

# 更改应用程序文件的所有权
RUN chown -R fileRocket:nodejs /app
USER fileRocket

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=3000

# 添加健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1

# 启动应用程序
CMD ["node", "server.js"]
