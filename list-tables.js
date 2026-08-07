const https = require('https');
const fs = require('fs');

if(fs.existsSync('.env')){
  fs.readFileSync('.env','utf8').split('\n').forEach(line=>{
    const [key,val]=line.trim().split('=');
    if(key&&val)process.env[key]=val;
  });
}

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_ID = 'Cc9EwQoQIiLxw1kUzoOcg6DHnUd';

function getTenantToken() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const options = {
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        const result = JSON.parse(body);
        if (result.code === 0) resolve(result.tenant_access_token);
        else reject(new Error(result.msg));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function listTables(token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'open.feishu.cn',
      path: `/open-apis/bitable/v1/apps/${BASE_ID}/tables`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        const result = JSON.parse(body);
        if (result.code === 0) {
          console.log('✅ 多维表格中的所有表：\n');
          result.data.items.forEach(table => {
            console.log(`表名: ${table.name}`);
            console.log(`表ID: ${table.table_id}`);
            console.log('---');
          });
        } else {
          console.error('❌ 获取失败:', result.msg);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  try {
    const token = await getTenantToken();
    await listTables(token);
  } catch (e) {
    console.error('错误:', e.message);
  }
})();
