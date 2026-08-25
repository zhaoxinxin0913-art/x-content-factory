#!/bin/bash

# AI 翻译流水线平台 - 快速演示脚本

echo "🌍 AI 翻译流水线平台 - 演示脚本"
echo "================================"
echo ""

# 检查 CC Switch
echo "📌 步骤 1: 检查 CC Switch 代理状态"
if curl -s http://127.0.0.1:15721/v1/models > /dev/null 2>&1; then
    echo "✅ CC Switch 代理运行正常"
else
    echo "❌ CC Switch 代理未运行"
    echo ""
    echo "请先启动 CC Switch："
    echo "  1. 打开 CC Switch 应用"
    echo "  2. 确保本地代理端口为 15721"
    echo "  3. 配置以下模型："
    echo "     - kimi-k2.6 （模型 A 和 C）"
    echo "     - deepseek-chat （模型 B）"
    echo ""
    echo "或修改 translation-server.js 中的模型配置使用其他模型"
    echo ""
    read -p "按回车键继续（将使用模拟模式）..."
fi

echo ""
echo "📌 步骤 2: 启动翻译服务"
cd ~/x-content-factory
node translation-server.js &
SERVER_PID=$!
sleep 2

echo ""
echo "📌 步骤 3: 打开浏览器"
echo "访问地址: http://localhost:5051"
open http://localhost:5051

echo ""
echo "================================"
echo "🎯 演示步骤："
echo "1. 上传测试文件 test-translation-data.csv"
echo "2. 选择「字段名」列作为待翻译列"
echo "3. 勾选目标语言（如：English、ภาษาไทย）"
echo "4. 点击「启动翻译流水线」"
echo "5. 等待三模型协作处理"
echo "6. 复核问题项（如有）"
echo "7. 导出翻译结果"
echo ""
echo "按 Ctrl+C 停止服务"
echo "================================"

wait $SERVER_PID
