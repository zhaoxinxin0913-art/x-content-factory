#!/bin/bash
cd /Users/zhaoxinxin/x-content-factory
echo "🏭 启动 X 内容工厂..."
node server.js &
sleep 2
IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | head -1 | awk '{print $2}')
echo "----------------------------------------"
echo "  🏠 局域网:  http://$IP:5050"
echo "----------------------------------------"
cloudflared tunnel --url http://localhost:5050 2>&1 | while read line; do
  if [[ "$line" == *"trycloudflare.com"* ]]; then
    URL=$(echo "$line" | grep -o 'https://[^ ]*trycloudflare\.com')
    echo "  ☁️  Cloudflare: $URL"
    echo "----------------------------------------"
  fi
done
