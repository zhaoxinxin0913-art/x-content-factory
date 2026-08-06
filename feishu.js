// 飞书多维表格集成模块
const https = require('https');
const fs = require('fs');
const path = require('path');

const APP_ID = process.env.FEISHU_APP_ID || 'cli_aa87e573e0b99bc9';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const BASE_ID = 'Cc9EwQoQIiLxw1kUzoOcg6DHnUd';
const TABLE_ID = 'tbl2YnuB3tpBZP0o';

// 字段映射
const FIELDS = {
  content: 'fldZfXeC45',      // 帖子内容
  type: 'fldRKyXFT6',         // 帖子类型
  tags: 'fldUJirSPl',         // Tag名称
  attachments: 'fldvxFc4sV'   // 附件
};

// 获取 tenant_access_token
function getTenantToken() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const options = {
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      },
      timeout: 10000
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.code === 0) resolve(result.tenant_access_token);
          else reject(new Error(`获取token失败: ${result.msg}`));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('获取token超时')));
    req.write(data);
    req.end();
  });
}

// 上传文件到飞书（图片或视频）
function uploadFile(token, filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`文件不存在: ${filePath}`));
    }

    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;
    const fileBuffer = fs.readFileSync(filePath);
    const boundary = '----' + Date.now();
    
    let body = '';
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
    body += 'Content-Type: application/octet-stream\r\n\r\n';
    const bodyPrefix = Buffer.from(body, 'utf8');
    
    body = '';
    body += `\r\n--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file_name"\r\n\r\n${fileName}\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="parent_type"\r\n\r\nbitable_file\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="parent_node"\r\n\r\n${BASE_ID}\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="size"\r\n\r\n${fileSize}\r\n`;
    body += `--${boundary}--\r\n`;
    const bodySuffix = Buffer.from(body, 'utf8');
    
    const totalLength = bodyPrefix.length + fileBuffer.length + bodySuffix.length;

    const options = {
      hostname: 'open.feishu.cn',
      path: '/open-apis/drive/v1/files/upload_all',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': totalLength
      },
      timeout: 120000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.code === 0) {
            resolve(result.data.file_token);
          } else {
            reject(new Error(`上传失败: ${result.msg}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('上传超时')));
    req.write(bodyPrefix);
    req.write(fileBuffer);
    req.write(bodySuffix);
    req.end();
  });
}

// 添加记录到多维表格
async function addRecord(token, data) {
  const fileTokens = [];
  
  // 上传附件
  if (data.files && data.files.length > 0) {
    console.log(`上传 ${data.files.length} 个附件...`);
    for (const file of data.files) {
      try {
        const token_file = await uploadFile(token, file);
        fileTokens.push({ file_token: token_file });
        console.log(`✅ 已上传: ${path.basename(file)}`);
      } catch (e) {
        console.error(`⚠️  上传失败 ${path.basename(file)}: ${e.message}`);
      }
    }
  }

  // 构建记录
  const fields = {
    [FIELDS.content]: data.content || '',
    [FIELDS.type]: data.type || 'General',
    [FIELDS.tags]: data.tags || ''
  };

  if (fileTokens.length > 0) {
    fields[FIELDS.attachments] = fileTokens;
  }

  const record = JSON.stringify({ fields });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'open.feishu.cn',
      path: `/open-apis/bitable/v1/apps/${BASE_ID}/tables/${TABLE_ID}/records`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(record)
      },
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.code === 0) {
            resolve(result.data.record);
          } else {
            reject(new Error(`添加记录失败: ${result.msg}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => reject(new Error('添加记录超时')));
    req.write(record);
    req.end();
  });
}

// 导出主函数：从X链接提取并上传到飞书
async function uploadToFeishu(postData) {
  try {
    console.log('🔐 获取飞书token...');
    const token = await getTenantToken();
    
    console.log('📋 准备数据...');
    const data = {
      content: postData.text || '',
      type: postData.category || 'General',
      tags: `${postData.cnTags || ''} ${postData.origTags || ''}`.trim(),
      files: []
    };

    // 收集文件路径
    if (postData.imagePaths && postData.imagePaths.length > 0) {
      postData.imagePaths.forEach(img => {
        const filePath = path.join(postData.outputDir, img);
        if (fs.existsSync(filePath)) data.files.push(filePath);
      });
    }

    if (postData.videoPath) {
      const filePath = path.join(postData.outputDir, postData.videoPath);
      if (fs.existsSync(filePath)) data.files.push(filePath);
    }

    console.log('📤 上传到飞书多维表格...');
    const record = await addRecord(token, data);
    
    console.log('✅ 成功上传到飞书！记录ID:', record.record_id);
    return { success: true, record_id: record.record_id };
  } catch (e) {
    console.error('❌ 飞书上传失败:', e.message);
    return { success: false, error: e.message };
  }
}

module.exports = { uploadToFeishu };
