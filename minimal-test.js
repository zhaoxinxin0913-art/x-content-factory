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
const TABLE_ID = 'tblqDU6VsOPrYvPm';

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

async function testAddRecord(token) {
  const record = {
    fields: {
      "fldZfXeC45": [{"type": "text", "text": "测试内容"}]
    }
  };
  
  const data = JSON.stringify(record);
  console.log('请求体:', data);
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'open.feishu.cn',
      path: `/open-apis/bitable/v1/apps/${BASE_ID}/tables/${TABLE_ID}/records`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        console.log('响应:', body);
        const result = JSON.parse(body);
        if (result.code === 0) {
          console.log('✅ 成功！');
        } else {
          console.error('❌ 失败:', result.msg);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  try {
    const token = await getTenantToken();
    await testAddRecord(token);
  } catch (e) {
    console.error('错误:', e.message);
  }
})();
