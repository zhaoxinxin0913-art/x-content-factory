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
const TABLE_ID = 'tbl2YnuB3tpBZP0o';

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
      "fldZfXeC45": "测试X帖子：这是一条测试内容",
      "fldUJirSPl": "#测试 #test #内容工厂"
    }
  };
  
  const data = JSON.stringify(record);
  
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
        const result = JSON.parse(body);
        if (result.code === 0) {
          console.log('✅ 添加成功！记录ID:', result.data.record.record_id);
        } else {
          console.error('❌ 添加失败:', result.msg);
          console.log('详细:', JSON.stringify(result, null, 2));
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
    console.log('获取token...');
    const token = await getTenantToken();
    console.log('测试添加记录（不含附件）...');
    await testAddRecord(token);
  } catch (e) {
    console.error('错误:', e.message);
  }
})();
