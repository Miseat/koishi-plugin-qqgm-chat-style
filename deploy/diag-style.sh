#!/usr/bin/env bash
set -uo pipefail
echo "=== all chat-style logs ==="
sudo -n docker logs --since 8m koishi 2>&1 | grep -iE 'chat-style|skill|聊天风格' | tail -20
echo "=== errors ==="
sudo -n docker logs --since 8m koishi 2>&1 | grep -iE '\[E\]|error|exception|cannot|failed|undefined' | tail -25
echo "=== loader direct ==="
sudo -n docker cp /tmp/qqgm-style-check.js koishi:/tmp/qqgm-style-check.js
sudo -n docker exec -w /koishi koishi node /tmp/qqgm-style-check.js
