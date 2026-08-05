#!/bin/bash
# X 内容工厂 - 一键启动脚本

echo "🏭 启动 X 内容工厂..."

# 启动 Node.js 服务
cd /Users/zhaoxinxin/x-content-factory
pm2 start server.js --name x-content-factory 2>/dev/null || pm2 restart x-content-factory

# 启动 Cloudflare 隧道
pm2 start start-tunnel.sh --name cloudflare-tunnel 2>/dev/null || pm2 restart cloudflare-tunnel

# 保存配置
pm2 save

# 显示状态
echo ""
pm2 status

# 等待隧道启动
echo ""
echo "⏳ 等待 Cloudflare 隧道启动..."
sleep 15

# 显示 URL
echo ""
echo "📋 最新 Cloudflare 链接："
pm2 logs cloudflare-tunnel --lines 100 --nostream 2>&1 | grep "https://.*trycloudflare.com" | tail -1 | sed 's/.*https/https/' | sed 's/ .*//'

echo ""
echo "✅ 启动完成！"
echo "本地访问: http://localhost:5050"
