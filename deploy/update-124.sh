#!/usr/bin/env bash
set -uo pipefail
echo "=== yarn add 1.2.4 ==="
sudo -n docker exec -w /koishi koishi yarn add @nestim/koishi-plugin-qq-group-manager@1.2.4 2>&1 | tail -8
echo "=== installed ==="
sudo -n docker exec koishi node -p "require('/koishi/node_modules/@nestim/koishi-plugin-qq-group-manager/package.json').version"
echo "=== diagnostic log removed? ==="
sudo -n docker exec koishi grep -c '\[ai-image\]' /koishi/node_modules/@nestim/koishi-plugin-qq-group-manager/lib/ai/engine.js || true

echo "=== restart ==="
sudo -n docker restart koishi
sleep 25

echo "=== logs ==="
sudo -n docker logs --since 3m koishi 2>&1 | grep -E '\[qqgm\]|qqgm-chat-style|qq-health|\[E\]' | tail -12
