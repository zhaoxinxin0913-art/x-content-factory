// 飞书多维表格集成模块
const https = require('https');
const fs = require('fs');
const path = require('path');

const APP_ID = process.env.FEISHU_APP_ID || 'cli_aaff3b15c2395bd9';
const APP_SECRET = process.env.FEISHU_APP_SECRET || 'mXiJ3Z2jJv70Z9eVZrBTbfD16MpyZzH4';
const BASE_ID = 'CRKhbWNx1aktJCslD3lc3jgIn5c'; // 新BASE_ID（2026-11-16更新）
const TABLE_ID = 'tbl9czFw0SwKsffb'; // 新TABLE_ID（2026-11-16更新）
const FOLDER_ID = 'I6GzftxwXlvw9AdOYx9c0jQ6n3c'; // 云空间文件夹ID

// 注意：飞书API创建记录时使用字段名称，而不是字段ID

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
function uploadFile(token, filePath, baseId) {
  const parentNode = baseId || BASE_ID;
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`文件不存在: ${filePath}`));
    }

    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;
    const fileBuffer = fs.readFileSync(filePath);
    
    // 根据文件类型选择parent_type
    const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(fileName);
    const parentType = isVideo ? 'bitable_file' : 'bitable_image';
    console.log(`🔍 文件类型: ${fileName} → ${parentType}${isVideo ? ' (视频)' : ' (图片)'}`);
    
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
    body += `Content-Disposition: form-data; name="parent_type"\r\n\r\n${parentType}\r\n`;  // 动态选择：视频用bitable_file，图片用bitable_image
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="parent_node"\r\n\r\n${parentNode}\r\n`;  // 多维表格token（支持动态）
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="size"\r\n\r\n${fileSize}\r\n`;
    body += `--${boundary}--\r\n`;
    const bodySuffix = Buffer.from(body, 'utf8');
    
    const totalLength = bodyPrefix.length + fileBuffer.length + bodySuffix.length;

    const options = {
      hostname: 'open.feishu.cn',
      path: '/open-apis/drive/v1/medias/upload_all',  // 改用素材上传API
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
          console.log(`🔍 飞书上传响应:`, JSON.stringify(result));
          if (result.code === 0) {
            resolve(result.data.file_token);
          } else {
            reject(new Error(`上传失败: ${result.msg || JSON.stringify(result)}`));
          }
        } catch (e) {
          console.error(`❌ 解析响应失败:`, body);
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
async function addRecord(token, data, baseId, tableId) {
  const useBase = baseId || BASE_ID;
  const useTable = tableId || TABLE_ID;
  const fileTokens = [];
  
  // 上传附件（使用正确的素材上传API）
  if (data.files && data.files.length > 0) {
    console.log(`📎 上传 ${data.files.length} 个附件...`);
    for (const file of data.files) {
      try {
        const token_file = await uploadFile(token, file, useBase);
        fileTokens.push({ file_token: token_file });
        console.log(`✅ 已上传: ${path.basename(file)}`);
      } catch (e) {
        console.error(`⚠️  上传失败 ${path.basename(file)}: ${e.message}`);
      }
    }
  }

  // 构建记录（使用中文字段名）
  const fields = {
    '帖子内容': data.content || '',  // 原文
    'Tag名称': data.tags || '',        // 原文标签
    '是否匿名': '否',
    '随机账号': '是'  // 固定选择"是"
  };
  
  console.log('📝 准备写入字段:', JSON.stringify({
    帖子内容长度: fields['帖子内容'].length,
    Tag名称: fields['Tag名称'],
    原始content: data.content?.substring(0,30),
    原始tags: data.tags
  }));

  // 帖子类型（单选，用中文名称）
  if (data.mediaType === '视频') {
    fields['帖子类型'] = '视频';
  } else if (data.images > 0) {
    fields['帖子类型'] = '图片';
  } else {
    fields['帖子类型'] = '文字';
  }

  // 帖子区域（根据原文语言自动识别）
  const text = data.content || '';
  if (/[\u0E00-\u0E7F]/.test(text)) {
    fields['帖子区域'] = 'TH'; // 泰文
  } else if (/[ก-๙]/.test(text) || text.includes('ng') || text.includes('mga')) {
    fields['帖子区域'] = 'PH'; // 菲律宾语
  } else {
    fields['帖子区域'] = 'OTHERS';
  }

  if (fileTokens.length > 0) {
    console.log(`📎 附件tokens:`, JSON.stringify(fileTokens));
    fields['附件'] = fileTokens;
  } else {
    console.log('⚠️  没有成功上传的附件');
  }

  console.log('📋 即将创建记录，fields:', JSON.stringify(fields).substring(0, 200));
  const record = JSON.stringify({ fields });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'open.feishu.cn',
      path: `/open-apis/bitable/v1/apps/${useBase}/tables/${useTable}/records`,
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
    // 兼容新旧数据格式
    const data = {
      content: postData.content || postData.text || '',
      tags: postData.tags || `${postData.cnTags || ''} ${postData.origTags || ''}`.trim(),
      images: postData.images || 0,
      mediaType: postData.mediaType || '文字',
      filesCount: postData.filesCount || 0,
      files: []
    };
    
    // 收集附件文件路径（兼容新旧格式）
    // 优先使用新格式的 files 数组
    if (postData.files && postData.files.length > 0) {
      postData.files.forEach(filePath => {
        if (filePath && fs.existsSync(filePath)) {
          data.files.push(filePath);
        }
      });
    }
    // 兼容旧格式
    else if (postData.imagePaths && postData.imagePaths.length > 0) {
      postData.imagePaths.forEach(imgPath => {
        if (imgPath && fs.existsSync(imgPath)) {
          data.files.push(imgPath);
        }
      });
    }
    
    if (postData.videoPath && fs.existsSync(postData.videoPath)) {
      data.files.push(postData.videoPath);
    }
    
    // 目标表格（支持用户自定义，留空用默认）
    const targetBase = postData.baseId || BASE_ID;
    const targetTable = postData.tableId || TABLE_ID;
    const isCustom = (postData.baseId && postData.baseId !== BASE_ID) || (postData.tableId && postData.tableId !== TABLE_ID);
    console.log(`📤 上传到飞书多维表格（${data.files.length} 个附件）${isCustom ? ' → 自定义表格 '+targetBase+'/'+targetTable : ''}...`);
    const record = await addRecord(token, data, targetBase, targetTable);
    
    console.log('✅ 成功上传到飞书！记录ID:', record.record_id);
    return { success: true, record_id: record.record_id };
  } catch (e) {
    console.error('❌ 飞书上传失败:', e.message);
    return { success: false, error: e.message };
  }
}

// 解析飞书多维表格链接，提取 base token 和 table id
// 支持形如：https://xxx.feishu.cn/base/BASETOKEN?table=TABLEID&view=VIEWID
//          https://xxx.feishu.cn/wiki/WIKITOKEN?table=TABLEID （wiki节点需额外解析，暂取token）
function parseFeishuUrl(url) {
  if (!url) return {};
  const result = {};
  // base token: /base/xxx 或 /wiki/xxx
  const baseMatch = url.match(/\/(?:base|wiki)\/([A-Za-z0-9]+)/);
  if (baseMatch) result.baseId = baseMatch[1];
  // table id: ?table=xxx 或 &table=xxx
  const tableMatch = url.match(/[?&]table=([A-Za-z0-9]+)/);
  if (tableMatch) result.tableId = tableMatch[1];
  return result;
}

// 列出某个多维表格 base 下的所有数据表（子表）
function listTables(baseId) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getTenantToken();
      const options = {
        hostname: 'open.feishu.cn',
        path: `/open-apis/bitable/v1/apps/${baseId}/tables?page_size=100`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
      };
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const r = JSON.parse(body);
            if (r.code === 0) {
              const tables = (r.data.items || []).map(t => ({ table_id: t.table_id, name: t.name }));
              resolve(tables);
            } else {
              reject(new Error(`列出子表失败: ${r.msg} (code ${r.code})`));
            }
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => reject(new Error('列出子表超时')));
      req.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { uploadToFeishu, listTables, parseFeishuUrl };
