# 🌍 AI 翻译流水线平台

基于 PRD v1.0 实现的多模型协作翻译系统。

## 核心特性

✅ **三模型协作流水线**
- **模型 A（生成器）**：kimi-k2.6 初译 + 置信度评估
- **模型 B（校验器）**：deepseek-chat 质检打分 + 问题标注
- **模型 C（提取器）**：kimi-k2.6 汇总问题项，按严重度排序

✅ **人工智能复核**
- 只复核「有问题」的项，不做全量审核
- 模型 A/B/C 输出对照展示
- 支持采纳/修正/驳回三种操作

✅ **反向训练闭环**
- 人工修正结果自动沉淀为训练样本
- 术语表管理（实时注入模型上下文）
- 为后续微调/Prompt 优化做准备

✅ **批量高效处理**
- 支持 Excel (.xlsx) / CSV 上传
- 近万字段并发翻译（批次处理 + 节流）
- 支持多语言一键导出

## 快速开始

### 1. 启动服务

```bash
# 方式一：直接运行
cd ~/x-content-factory
node translation-server.js

# 方式二：使用启动脚本
./start-translation.sh
```

服务启动后访问：**http://localhost:5051**

### 2. 使用流程

#### Step 1: 上传文件
- 支持拖拽或点击上传
- 文件格式：`.xlsx` / `.csv`
- 示例文件：`test-translation-data.csv`

#### Step 2: 配置任务
- 选择待翻译列（如「字段名」列）
- 选择目标语言（可多选）：
  - 简体中文、繁体中文、English
  - ภาษาไทย、Filipino、日本語、한국어

#### Step 3: 自动处理
系统自动执行三模型流水线：
```
源字段 → 模型A翻译 → 模型B校验 → 模型C提取问题
```

#### Step 4: 人工复核
- 系统只展示「需要复核」的问题项
- 每项显示：
  - 源字段、模型 A 翻译
  - 模型 B 评分（1-10）+ 问题描述 + 修改建议
  - 严重程度标签（high/medium）
- 操作：
  - ✅ **采纳**：接受模型 A 翻译
  - ✏️ **修正**：输入正确翻译（自动加入训练数据）
  - ❌ **驳回**：标记为不合格

#### Step 5: 导出结果
- 点击「下载 Excel」
- 文件包含原始列 + 各语言翻译列
- 人工修正的内容已替换模型翻译

### 3. 术语表管理

在界面底部「📚 术语表管理」区域：
- 添加专业术语映射（如 `user_status → 用户状态`）
- 术语会实时注入模型 A 和 B 的上下文
- 确保专业术语翻译一致性

## 技术架构

```
前端（translation-ui.html）
  ↓
后端 API（translation-server.js）
  ↓
三模型流水线
  ├─ 模型 A: kimi-k2.6（生成翻译）
  ├─ 模型 B: deepseek-chat（质检）
  └─ 模型 C: kimi-k2.6（提取问题）
  ↓
CC Switch 本地代理（127.0.0.1:15721/v1）
  ↓
Kimi / DeepSeek 等模型
```

## 数据存储

- **翻译记录**：`translation-db.json`
  - tasks: 任务列表
  - results: 翻译结果（含校验信息）
  - reviews: 人工复核记录
  - trainingSamples: 训练样本（人工修正数据）
  - glossary: 术语表

- **文件存储**：
  - 上传：`translation-uploads/`
  - 导出：`translation-output/`

## 模型配置

默认配置（可在 `translation-server.js` 中修改）：

```javascript
// 模型 A - 生成器
model: 'kimi-k2.6'
temperature: 0.3

// 模型 B - 校验器  
model: 'deepseek-chat'
temperature: 0.2

// 模型 C - 提取器
model: 'kimi-k2.6'
temperature: 0.2
```

也可替换为同一模型 + 不同 System Prompt。

## 反向训练

### v1.0 实现（已完成）
✅ 术语表管理 + 实时注入
✅ 训练样本自动收集

### 后续规划
- 当训练样本 ≥ 5000 条时
- 启动模型微调（LoRA/全参）
- 优化 System Prompt（根据高频错误）

## 示例数据

已提供测试数据：`test-translation-data.csv`
- 15 个常见数据库字段
- 涵盖用户、订单、支付、库存等场景

## 注意事项

1. **CC Switch 代理**
   - 确保 CC Switch 已启动（127.0.0.1:15721）
   - 配置了 kimi-k2.6 和 deepseek-chat 模型

2. **并发限制**
   - 当前批次大小：10 条/批
   - 可根据 API 限额调整

3. **数据安全**
   - 所有数据本地存储
   - 不上传到外部服务器

## API 文档

### POST /api/upload
上传 Excel/CSV 文件

### POST /api/translate
启动翻译流水线
```json
{
  "taskId": "task_xxx",
  "columnIndex": 0,
  "targetLangs": ["zh-CN", "en"]
}
```

### GET /api/task/:taskId
获取任务状态和结果

### POST /api/review
提交人工复核
```json
{
  "taskId": "task_xxx",
  "resultId": "result_xxx",
  "decision": "fix",
  "finalText": "正确翻译"
}
```

### GET /api/export/:taskId
导出翻译结果（Excel）

### GET/POST /api/glossary
术语表管理

## 下一步优化

根据 PRD 里程碑：

**阶段二：闭环强化**
- [ ] 任务队列优化（Redis/Bull）
- [ ] 断点续传机制
- [ ] WebSocket 实时进度推送

**阶段三：进阶功能**
- [ ] 模型微调（≥5000 训练样本）
- [ ] 质量报告可视化
- [ ] 多任务并行处理
- [ ] 翻译记忆库（Translation Memory）

## 问题排查

### CC Switch 连接失败
```bash
# 检查代理是否启动
curl http://127.0.0.1:15721/v1/models

# 如端口不同，修改 translation-server.js 中的 baseURL
```

### 模型调用报错
- 检查 CC Switch 配置中的模型名称
- 确认 API 额度充足
- 查看后端日志（终端输出）

## 更新日志

### v1.0 (2026-08-25)
- ✅ 完整三模型流水线
- ✅ 人工复核界面
- ✅ 术语表管理
- ✅ 训练样本收集
- ✅ 多语言导出

---

**作者**: Hermes Agent  
**基于**: AI 翻译流水线平台 PRD v1.0  
**项目**: x-content-factory/translation
