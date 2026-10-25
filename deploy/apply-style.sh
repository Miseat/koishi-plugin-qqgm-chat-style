#!/usr/bin/env bash
set -uo pipefail
TS=$(date +%Y%m%d-%H%M%S)
echo "backup=/koishi/koishi.yml.bak.style-$TS"
sudo -n docker exec koishi cp /koishi/koishi.yml "/koishi/koishi.yml.bak.style-$TS"
sudo -n docker cp /tmp/koishi.style2.yml koishi:/koishi/koishi.yml
sudo -n docker exec koishi grep -n 'qqgm-chat-style' /koishi/koishi.yml

echo "=== restart ==="
sudo -n docker restart koishi
sleep 22

echo "=== logs ==="
sudo -n docker logs --since 3m koishi 2>&1 | grep -E 'qqgm-chat-style|\[qqgm\]|qq-health|error|Error' | tail -20
