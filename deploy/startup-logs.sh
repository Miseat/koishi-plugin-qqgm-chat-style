#!/usr/bin/env bash
set -uo pipefail
echo "=== startup window ==="
sudo -n docker logs --since 15m koishi 2>&1 | sed -n '/16:10:5[0-9]/,/16:11:2[0-9]/p' | head -80
echo "=== any chat-style ==="
sudo -n docker logs koishi 2>&1 | grep -i 'chat-style' | tail -20
echo "=== config block ==="
sudo -n docker exec koishi sed -n '65,78p' /koishi/koishi.yml
