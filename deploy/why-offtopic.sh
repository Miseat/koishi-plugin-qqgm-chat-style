#!/usr/bin/env bash
set -uo pipefail
echo "=== now ==="
date '+%F %T'
echo "=== probe last 8 ==="
sudo -n docker exec koishi tail -8 /koishi/qq-event-probe.log | cut -c1-220
echo
echo "=== ai logs 30m ==="
sudo -n docker logs --since 30m koishi 2>&1 | grep -E '\[ai-(trigger|reply|pass)\]' | tail -30
echo "=== last ai-debug line numbers ==="
sudo -n docker logs --since 30m koishi 2>&1 | grep -n '\[ai-debug\]' | tail -4
