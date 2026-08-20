FROM node:20-alpine

# 时区：容器内 Date 需与北京时间一致，否则 readRecentIds / publishTime 分区错一天
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

ENV TZ=Asia/Shanghai

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

RUN chown -R node:node /app && mkdir -p /app/file /app/logs

EXPOSE 8080

USER node

ENTRYPOINT ["node", "index.js"]
