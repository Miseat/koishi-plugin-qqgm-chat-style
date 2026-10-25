#!/usr/bin/env bash
set -uo pipefail
PLUGIN=/koishi/node_modules/koishi-plugin-qqgm-chat-style

echo "=== copy style plugin 0.1.2 ==="
sudo -n docker cp /tmp/qqgm-style/index.js "koishi:$PLUGIN/index.js"
sudo -n docker cp /tmp/qqgm-style/lib/filter.js "koishi:$PLUGIN/lib/filter.js"
sudo -n docker cp /tmp/qqgm-style/lib/prompt.js "koishi:$PLUGIN/lib/prompt.js"
sudo -n docker cp /tmp/qqgm-style/lib/loader.js "koishi:$PLUGIN/lib/loader.js"
sudo -n docker cp /tmp/qqgm-style/package.json "koishi:$PLUGIN/package.json"
sudo -n docker exec koishi node -p "require('$PLUGIN/package.json').version"

echo "=== apply config ==="
TS=$(date +%Y%m%d-%H%M%S)
sudo -n docker exec koishi cp /koishi/koishi.yml "/koishi/koishi.yml.bak.offtopic-$TS"
sudo -n docker cp /tmp/koishi.style4.yml koishi:/koishi/koishi.yml
sudo -n docker exec koishi grep -A10 'qqgm-chat-style' /koishi/koishi.yml | head -12

echo "=== restart ==="
sudo -n docker restart koishi
sleep 25

echo "=== logs ==="
sudo -n docker logs --since 3m koishi 2>&1 | grep -E 'qqgm-chat-style|\[qqgm\]|qq-health|\[E\]' | tail -20
