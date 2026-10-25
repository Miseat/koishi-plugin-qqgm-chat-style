#!/usr/bin/env bash
set -uo pipefail
for p in koishi-plugin-qqgm-chat-style koishi-plugin-qq-health koishi-plugin-qq-event-probe; do
  if sudo -n docker exec koishi test -d "/koishi/node_modules/$p"; then
    echo "$p OK"
  else
    echo "$p MISSING"
  fi
done
echo "--- skill ---"
sudo -n docker exec koishi ls /koishi/data/chat-styles/northern-netizen-chat 2>&1 || true
echo "--- installed main ---"
sudo -n docker exec koishi node -p "require('/koishi/node_modules/@nestim/koishi-plugin-qq-group-manager/package.json').version"
