# 🌍 AI 翻译流水线平台 - 使用指南

## ✅ 已完成部署

服务已启动在：**http://localhost:5051**

当前运行模式：**Fallback Mode（Google Translate + 规则校验）**

---

## 🚀 快速开始（3 分钟演示）

### 1. 打开浏览器
访问：http://localhost:5051

### 2. 上传测试文件
- 点击上传区域或拖拽文件
- 使用提供的测试文件：`test-translation-data.csv`（15 个数据库字段）

### 3. 配置翻译任务
- **选择待翻译列**：字段名
- **选择目标语言**（可多选）：
  - ✅ English（推荐测试）
  - ✅ ภาษาไทย（泰语）
  - 简体中文、繁体中文、Filipino、日本語、한국어

### 4. 启动流水线
点击「🚀 启动翻译流水线」，系统自动执行：
```
源字段 → 模型A翻译 → 模型B校验 → 模型C提取问题
```

### 5. 查看进度
实时进度条显示处理状态

### 6. 人工复核（如有问题项）
- 查看模型 A 翻译
- 查看模型 B 评分（1-10）和问题描述
- 操作选项：
  - ✅ **采纳**：接受模型翻译
  - ✏️ **修正**：输入正确翻译（自动加入训练数据）
  - ❌ **驳回**：标记为不合格

### 7. 导出结果
点击「⬇️ 下载 Excel」，获取包含所有语言翻译的文件

---

## 📚 两种运行模式

### 模式 1: Fallback Mode（当前）
**无需 CC Switch**，使用：
- 模型 A（翻译）：Google Translate API
- 模型 B（校验）：规则引擎（长度、重复检测）
- 模型 C（提取）：分数阈值筛选

**适用场景**：
- 快速演示和测试
- 不需要高级 LLM 的场景
- 开发调试

**优点**：
- 零配置，开箱即用
- 翻译速度快
- 无 API 额度限制

**缺点**：
- 校验质量一般（基于规则）
- 无法理解复杂语境

### 模式 2: CC Switch Mode（完整功能）
**需要 CC Switch 本地代理**，使用：
- 模型 A（翻译）：kimi-k2.6
- 模型 B（校验）：deepseek-chat
- 模型 C（提取）：kimi-k2.6

**适用场景**：
- 生产环境
- 需要高质量翻译和校验
- 复杂专业术语

**优点**：
- 翻译质量高
- 智能校验和问题提取
- 支持术语表和上下文

**启用方法**：
```bash
# 1. 启动 CC Switch 并配置模型
# 2. 重启服务
export USE_CC_SWITCH=true
export CC_SWITCH_URL=http://127.0.0.1:15721/v1
node translation-server.js
```

---

## 🎯 核心功能

### ✅ 已实现（v1.0）

#### 1. 三模型协作流水线
- **模型 A - 生成器**：翻译 + 置信度评估
- **模型 B - 校验器**：质检打分 + 问题标注
- **模型 C - 提取器**：汇总问题项 + 严重度排序

#### 2. 人工复核界面
- 只展示「有问题」的项（模型 C 筛选）
- A/B/C 输出对照显示
- 采纳/修正/驳回三种操作

#### 3. 反向训练准备
- ✅ 术语表管理（实时注入模型上下文）
- ✅ 训练样本自动收集（人工修正数据）
- 📊 查看训练样本：`/api/training-samples`

#### 4. 批量处理
- 支持 Excel (.xlsx) / CSV 上传
- 并发翻译 + 批次处理 + 节流控制
- 多语言一键导出

---

## 📁 文件结构

```
x-content-factory/
├── translation-server.js           # 后端服务（主程序）
├── translation-ui.html             # 前端界面
├── test-translation-data.csv       # 测试数据（15个字段）
├── start-translation.sh            # 启动脚本
├── demo-translation.sh             # 演示脚本
├── TRANSLATION_README.md           # 详细文档
├── TRANSLATION_GUIDE.md            # 使用指南（本文档）
├── translation-db.json             # 数据库（任务/结果/复核）
├── translation-uploads/            # 上传文件目录
└── translation-output/             # 导出文件目录
```

---

## 🔧 管理命令

### 启动服务
```bash
# 方式 1: 直接启动
node ~/x-content-factory/translation-server.js

# 方式 2: 使用脚本
~/x-content-factory/start-translation.sh

# 方式 3: 启用 CC Switch
USE_CC_SWITCH=true node ~/x-content-factory/translation-server.js
```

### 查看数据
```bash
# 查看所有任务
cat ~/x-content-factory/translation-db.json | jq '.tasks'

# 查看训练样本
cat ~/x-content-factory/translation-db.json | jq '.trainingSamples | length'

# 查看术语表
cat ~/x-content-factory/translation-db.json | jq '.glossary'
```

### 清空数据
```bash
# 重置数据库（保留术语表）
echo '{"tasks":[],"results":[],"reviews":[],"trainingSamples":[],"glossary":{}}' > ~/x-content-factory/translation-db.json

# 清空上传文件
rm -rf ~/x-content-factory/translation-uploads/*
rm -rf ~/x-content-factory/translation-output/*
```

---

## 🎨 界面操作

### 术语表管理
1. 滚动到页面底部「📚 术语表管理」
2. 输入源术语和翻译（如：`user_status → User Status`）
3. 点击「➕ 添加」
4. 术语会自动注入到后续翻译的上下文中

### 查看历史任务
刷新页面后，之前的任务会保留在数据库中。
可以通过 API 查询：`http://localhost:5051/api/task/<taskId>`

---

## 📊 数据模型

### 核心实体
```javascript
// 任务
{
  "id": "task_1234567890",
  "filename": "data.xlsx",
  "headers": ["字段名", "描述", "类型"],
  "rowCount": 100,
  "status": "completed",
  "targetLangs": ["en", "th"],
  "columnIndex": 0
}

// 翻译结果
{
  "id": "result_xxx",
  "taskId": "task_xxx",
  "sourceText": "user_status",
  "translation": "User Status",
  "confidence": 85,
  "validationScore": 8,
  "validationIssues": [],
  "needsReview": false
}

// 人工复核
{
  "id": "review_xxx",
  "resultId": "result_xxx",
  "decision": "fix",
  "finalText": "User Account Status"
}

// 训练样本
{
  "sourceText": "user_status",
  "targetLang": "en",
  "modelA_text": "User Status",
  "human_text": "User Account Status",
  "score": 8
}
```

---

## 🌟 最佳实践

### 1. 术语表管理
**建议**：先添加常用术语，再启动翻译
```
user → 用户
order → 订单
payment → 支付
status → 状态
```

### 2. 分批处理
- 小于 100 行：一次处理
- 100-1000 行：分批上传
- 大于 1000 行：考虑拆分文件

### 3. 人工复核策略
- **评分 ≤ 5**：必须复核并修正
- **评分 6-7**：快速浏览，可采纳
- **评分 ≥ 8**：直接采纳

### 4. 训练数据积累
目标：收集 ≥ 5000 条人工修正样本
- 当前进度：`/api/training-samples`
- 达标后启动模型微调

---

## 🐛 常见问题

### Q1: 上传文件后没有反应？
- 检查文件格式（只支持 .xlsx 和 .csv）
- 检查文件大小（建议 < 10MB）
- 打开浏览器控制台查看错误

### Q2: 翻译速度很慢？
- Fallback Mode：使用 Google Translate，速度较快
- CC Switch Mode：受 API 限速影响，可调整 `translation-server.js` 中的节流时间

### Q3: 如何切换到 CC Switch 模式？
```bash
# 1. 确保 CC Switch 运行
curl http://127.0.0.1:15721/v1/models

# 2. 重启服务
export USE_CC_SWITCH=true
node translation-server.js
```

### Q4: 如何查看训练样本？
访问：`http://localhost:5051/api/training-samples`
或查看：`translation-db.json` 中的 `trainingSamples` 数组

### Q5: 数据库文件太大怎么办？
```bash
# 导出重要数据
cat translation-db.json | jq '.trainingSamples' > training-backup.json
cat translation-db.json | jq '.glossary' > glossary-backup.json

# 重置数据库
echo '{"tasks":[],"results":[],"reviews":[],"trainingSamples":[],"glossary":{}}' > translation-db.json

# 恢复关键数据
# 手动合并 training-backup.json 和 glossary-backup.json
```

---

## 🚧 下一步开发

### 阶段二：闭环强化
- [ ] 任务队列（Redis/Bull）
- [ ] 断点续传
- [ ] WebSocket 实时推送
- [ ] 批量复核界面

### 阶段三：进阶功能
- [ ] 模型微调（≥5000 样本）
- [ ] 质量报告可视化
- [ ] 翻译记忆库（TM）
- [ ] 多项目管理

---

## 📞 技术支持

- **文档**：`TRANSLATION_README.md`
- **PRD**：`AI 翻译流水线平台PRD.html`
- **数据库**：`translation-db.json`
- **日志**：终端输出

---

## 🎉 总结

你现在拥有一个完整的 AI 翻译流水线平台：

✅ **三模型协作**：生成 → 校验 → 提取  
✅ **人工复核**：聚焦问题项，不做全量审核  
✅ **反向训练**：自动收集训练样本  
✅ **批量高效**：支持近万字段处理  
✅ **两种模式**：Fallback（零配置）+ CC Switch（完整功能）  

**立即体验**：http://localhost:5051

上传 `test-translation-data.csv`，选择 English 或 ภาษาไทย，点击启动，3 分钟完成翻译！
