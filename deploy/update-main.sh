#!/usr/bin/env bash
set -uo pipefail
echo "=== registry check ==="
curl -s -m 10 'https://registry.npmjs.org/@nestim%2Fkoishi-plugin-qq-group-manager/1.2.1' | head -c 120
echo

echo "=== yarn add 1.2.1 ==="
sudo -n docker exec -w /koishi koishi yarn add @nestim/koishi-plugin-qq-group-manager@1.2.1 2>&1 | tail -15

echo "=== installed ==="
sudo -n docker exec koishi node -p "require('/koishi/node_modules/@nestim/koishi-plugin-qq-group-manager/package.json').version"
sudo -n docker exec koishi ls -l /koishi/node_modules/@nestim/koishi-plugin-qq-group-manager/lib/ai/hooks.js
