#!/bin/bash
# Cloudflare Tunnel 守护脚本

while true; do
  echo "[$(date)] Starting Cloudflare tunnel..."
  cloudflared tunnel --url http://localhost:5050 --protocol http2
  echo "[$(date)] Tunnel crashed, restarting in 5 seconds..."
  sleep 5
done
