FROM node:20-alpine

# 时区：容器内 Date 需与北京时间一致，否则 readRecentIds / publishTime 分区错一天
RUN apk add --no-cache tzdata su-exec && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

ENV TZ=Asia/Shanghai

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

RUN mkdir -p /app/file /app/logs && chown -R node:node /app && chmod +x /app/docker-entrypoint.sh

EXPOSE 8080

# 以 root 启动 entrypoint，内部完成宿主机 bind-mount 的 chown 后再降权到 node
USER root
ENTRYPOINT ["/app/docker-entrypoint.sh"]
