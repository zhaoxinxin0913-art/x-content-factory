const https = require('https');
const fs = require('fs');

// 加载环境变量
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
      "fldZfXeC45": "测试帖子内容",
      "fldRKyXFT6": "General",
      "fldUJirSPl": "#测试 #test"
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
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        const result = JSON.parse(body);
        console.log('响应:', JSON.stringify(result, null, 2));
        if (result.code === 0) {
          console.log('✅ 添加成功！');
          resolve(result.data.record);
        } else {
          console.error('❌ 添加失败:', result.msg);
          reject(new Error(result.msg));
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
    console.log('测试添加记录...');
    await testAddRecord(token);
  } catch (e) {
    console.error('错误:', e.message);
    process.exit(1);
  }
})();
