#!/usr/bin/env bash
set -uo pipefail
echo "=== session.onebot in adapter packages ==="
sudo -n docker exec koishi sh -c "grep -rn 'session\\.onebot' /koishi/node_modules/@koishijs/plugin-adapter-onebot /koishi/node_modules/@satorijs 2>/dev/null | head -10" || echo "not found"
echo "=== onebot internal assignment ==="
sudo -n docker exec koishi sh -c "grep -rn 'onebot =' /koishi/node_modules/@koishijs/plugin-adapter-onebot/lib 2>/dev/null | head -10" || true
echo "=== get_image definition ==="
sudo -n docker exec koishi sh -c "grep -rn 'get_image' /koishi/node_modules/@koishijs/plugin-adapter-onebot/lib 2>/dev/null | head -5" || true
