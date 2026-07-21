#!/bin/bash
echo "🏭 X 内容工厂 启动中..."
cd /Users/zhaoxinxin/x-content-factory

# 启动服务器
node server.js &
sleep 1

# 获取局域网 IP
IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | head -1 | awk '{print $2}')

# 启动公网隧道
ssh -o StrictHostKeyChecking=no -R 80:localhost:5050 serveo.net 2>&1 | while read line; do
  if [[ "$line" == *"Forwarding HTTP traffic from"* ]]; then
    PUBLIC_URL=$(echo "$line" | grep -o 'https://[^ ]*')
    echo ""
    echo "================================================"
    echo "  🏭 X 内容工厂"
    echo "================================================"
    echo "  🏠 局域网:  http://$IP:5050"
    echo "  🌐 公网:    $PUBLIC_URL"
    echo "================================================"
    echo ""
    open http://localhost:5050/
  fi
done &

echo "✅ 服务已启动"
echo "   🏠 局域网: http://$IP:5050"
echo "   🌐 公网隧道启动中..."
open http://localhost:5050/ &>/dev/null
