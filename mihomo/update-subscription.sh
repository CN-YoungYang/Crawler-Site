#!/bin/sh
# 手动触发 mihomo 订阅刷新（proxy-providers remote）
# 用法：sh mihomo/update-subscription.sh
# 或： docker compose exec mihomo wget -qO- --method=PUT http://127.0.0.1:9090/providers/proxy/remote
set -eu
BASES="${MIHOMO_CONTROLLER:-http://127.0.0.1:9090} http://127.0.0.1:9090 http://mihomo:9090"
AUTH=""
if [ -n "${MIHOMO_SECRET:-}" ]; then
  AUTH="Authorization: Bearer $MIHOMO_SECRET"
fi
for base in $BASES; do
  for path in "/providers/proxy/remote" "/providers/proxies/remote"; do
    url="$base$path"
    echo "Try PUT $url ..."
    if [ -n "$AUTH" ]; then
      if curl -fsS -X PUT -H "$AUTH" "$url" 2>&1 | head -20; then
        echo "OK $url"
        curl -fsS ${AUTH:+-H "$AUTH"} "$base/proxies" | grep -o '"PROXY"' | head -1 && echo "  proxies OK"
        exit 0
      fi
    else
      if curl -fsS -X PUT "$url" 2>&1 | head -20; then
        echo "OK $url"
        curl -fsS "$base/proxies" | grep -o '"PROXY"' | head -1 && echo "  proxies OK"
        exit 0
      fi
    fi
  done
done
echo "WARN: all provider refresh endpoints failed (mihomo may not support PUT /providers/proxy/remote on this version), check docker logs mihomo" >&2
exit 1
