#!/bin/bash
cd "$(dirname "$0")"
echo "🌍 启动 AI 翻译流水线平台..."
node translation-server.js
