# X 内容工厂

输入 X 博主链接 → 自动抓取 → 配图 → 下载

## 使用方法

1. 打开网页
2. 粘贴 X 博主链接（如 https://x.com/m4ilboq）
3. 粘贴 auth_token（Chrome DevTools → Application → Cookies → x.com）
4. 拖动选择抓取数量
5. 点击开始

## 部署到 Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### 手动部署

1. Fork 本仓库
2. 在 [Render](https://render.com) 创建 **Web Service**
3. 选择本仓库
4. Runtime: **Node**
5. Build Command: `npm install`
6. Start Command: `node server.js`
7. 部署！

## 本地运行

```bash
npm install
node server.js
# 打开 http://localhost:5050
```
