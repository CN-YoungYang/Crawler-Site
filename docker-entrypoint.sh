#!/bin/sh
set -e
# 宿主机 bind-mount 的 file/logs 可能是 root 属主（首次 mkdir 时），容器内 USER node(1000) 会 EACCES。
# 此处以 root 起步，尽力 chown 后再降权到 node 执行，避免每次部署都需宿主机手动 chown。
mkdir -p /app/file /app/logs
chown -R node:node /app/file /app/logs 2>/dev/null || true
# 若 su-exec 可用则降权，否则直接以当前用户执行（兼容无 su-exec 的旧镜像）
if command -v su-exec >/dev/null 2>&1; then
  exec su-exec node node index.js "$@"
else
  # 已是 node 或无降权工具，直接执行
  if [ "$(id -u)" = "0" ]; then
    # 回退：用 su 降权
    exec su node -c "exec node index.js $*"
  else
    exec node index.js "$@"
  fi
fi
