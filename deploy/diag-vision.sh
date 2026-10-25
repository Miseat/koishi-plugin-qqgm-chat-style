#!/usr/bin/env bash
set -uo pipefail
echo "=== now ==="
date '+%F %T'
echo "=== config: ai model / image ==="
sudo -n docker exec koishi grep -nE 'aiModel|aiBaseUrl|aiEnableImage|aiImage|aiVision|aiMaxOutputTokens' /koishi/koishi.yml | head -20

echo "=== image/vision logs 8h ==="
sudo -n docker logs --since 8h koishi 2>&1 | grep -iE 'image|vision|multimodal|degraded|识别|图片' | tail -60

echo "=== ai-reply with images 8h ==="
sudo -n docker logs --since 8h koishi 2>&1 | grep -E '\[ai-reply\]' | tail -30
