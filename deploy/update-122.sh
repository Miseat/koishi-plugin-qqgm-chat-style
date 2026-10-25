#!/usr/bin/env bash
set -uo pipefail
echo "=== yarn add 1.2.2 ==="
sudo -n docker exec -w /koishi koishi yarn add @nestim/koishi-plugin-qq-group-manager@1.2.2 2>&1 | tail -8
echo "=== installed ==="
sudo -n docker exec koishi node -p "require('/koishi/node_modules/@nestim/koishi-plugin-qq-group-manager/package.json').version"

echo "=== update style plugin ==="
sudo -n docker cp /tmp/qqgm-style/index.js koishi:/koishi/node_modules/koishi-plugin-qqgm-chat-style/index.js
sudo -n docker cp /tmp/qqgm-style/package.json koishi:/koishi/node_modules/koishi-plugin-qqgm-chat-style/package.json
sudo -n docker exec koishi node -p "require('/koishi/node_modules/koishi-plugin-qqgm-chat-style/package.json').version"

echo "=== restart ==="
sudo -n docker restart koishi
sleep 25

echo "=== logs ==="
sudo -n docker logs --since 3m koishi 2>&1 | grep -E 'qqgm-chat-style|\[qqgm\]|qq-health|\[E\]' | tail -20
