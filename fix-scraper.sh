#!/bin/bash
# X内容工厂 - 一键修复脚本
# 用途：抓取"全部失败/无法加载推文"时，清理残留 Chrome 进程并重启服务
# 用法：bash ~/x-content-factory/fix-scraper.sh

set -e
APP="x-content-factory"

echo "🔧 X内容工厂 一键修复"
echo "========================================"

# 1. 统计并清理 headless/automation 残留 Chrome（不动你日常使用的 Chrome）
BEFORE=$(ps aux | grep -i "Google Chrome" | grep -iE "headless|enable-automation|AutomationControlled" | grep -v grep | wc -l | tr -d ' ')
echo "🔍 检测到 $BEFORE 个残留 headless Chrome 进程"

if [ "$BEFORE" -gt 0 ]; then
  echo "🧹 清理残留 Chrome（保留你正常使用的浏览器）..."
  pkill -f "Google Chrome.*headless" 2>/dev/null || true
  pkill -f "Google Chrome.*enable-automation" 2>/dev/null || true
  pkill -f "Google Chrome.*AutomationControlled" 2>/dev/null || true
  sleep 2
  AFTER=$(ps aux | grep -i "Google Chrome" | grep -iE "headless|enable-automation|AutomationControlled" | grep -v grep | wc -l | tr -d ' ')
  echo "   ✅ 已清理，剩余 $AFTER 个"
else
  echo "   ✅ 无残留，跳过"
fi

# 2. 重启服务
echo ""
echo "🔄 重启服务..."
pm2 restart "$APP" --update-env >/dev/null 2>&1
sleep 4

STATUS=$(pm2 list | grep "$APP" | grep -o "online" | head -1)
if [ "$STATUS" = "online" ]; then
  echo "   ✅ 服务已重启并在线"
else
  echo "   ⚠️  服务状态异常，请运行 pm2 logs $APP 查看"
fi

# 3. 磁盘空间检查
echo ""
echo "💾 磁盘空间检查..."
DISK=$(df -h /System/Volumes/Data 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
if [ -n "$DISK" ] && [ "$DISK" -ge 90 ]; then
  echo "   ⚠️  磁盘已用 ${DISK}%，空间紧张！建议清理 output/_media 旧文件"
  MEDIA_SIZE=$(du -sh ~/x-content-factory/output/_media 2>/dev/null | awk '{print $1}')
  echo "   📁 output/_media 当前占用: ${MEDIA_SIZE:-未知}"
else
  echo "   ✅ 磁盘充足（已用 ${DISK:-?}%）"
fi

# 4. 健康检查：实际跑一个抓取测试
echo ""
echo "🧪 健康检查（抓取测试）..."
TEST_URL="https://x.com/cb_doge/status/2124436902661197916"
TOKEN="${XCF_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "   ℹ️  跳过（未设置 token）。如需自检：XCF_TOKEN=你的token bash fix-scraper.sh"
else
  RESP=$(curl -s -X POST http://localhost:5050/api/media \
    -H 'Content-Type: application/json' \
    -d "{\"url\":\"$TEST_URL\",\"token\":\"$TOKEN\"}" --max-time 90)
  if echo "$RESP" | grep -q '"imagePaths"'; then
    echo "   ✅ 抓取正常，附件提取成功"
  else
    echo "   ❌ 抓取仍失败，响应：$(echo "$RESP" | head -c 150)"
  fi
fi

echo ""
echo "========================================"
echo "✅ 修复完成！打开 http://localhost:5050 即可使用"
