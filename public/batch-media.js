// 批量媒体搬运前端逻辑
let currentMediaMode = 'single';

function switchMediaMode(mode) {
  currentMediaMode = mode;
  const singleEl = document.getElementById('single-mode');
  const batchEl = document.getElementById('batch-mode');
  const singleBtn = document.getElementById('modeSingle');
  const batchBtn = document.getElementById('modeBatch');
  
  if (mode === 'single') {
    singleEl.style.display = 'block';
    batchEl.style.display = 'none';
    singleBtn.style.background = '#000';
    singleBtn.style.color = '#fff';
    batchBtn.style.background = '#fff';
    batchBtn.style.color = '#000';
    batchBtn.style.border = '1.5px solid #000';
  } else {
    singleEl.style.display = 'none';
    batchEl.style.display = 'block';
    singleBtn.style.background = '#fff';
    singleBtn.style.color = '#000';
    singleBtn.style.border = '1.5px solid #000';
    batchBtn.style.background = '#000';
    batchBtn.style.color = '#fff';
  }
}

async function runBatchMedia() {
  const urlsText = document.getElementById('burls').value.trim();
  const t = document.getElementById('mtoken').value.trim();
  const MB = document.getElementById('mBtn');
  const ML = document.getElementById('mlog');
  const MR = document.getElementById('mresult');
  
  if (!urlsText || !t) return alert('请填写链接和 auth_token');
  
  const urls = urlsText.split('\n').map(u => u.trim()).filter(u => u);
  if (urls.length === 0) return alert('请至少输入一个链接');
  if (urls.length > 40) return alert('单次最多处理40条');
  
  MB.disabled = true;
  MB.textContent = '⏳ 批量处理中 (' + urls.length + '条)...';
  MR.classList.remove('show');
  ML.innerHTML = '';
  ML.classList.add('show');
  
  function MA(m,c){
    const d = document.createElement('div');
    d.className = 'ln' + (c ? ' ' + c : '');
    d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + m;
    ML.appendChild(d);
    ML.scrollTop = ML.scrollHeight;
  }
  
  // 自动分批：每批8条，避免单次请求过长导致 failed to fetch
  const BATCH_SIZE = 8;
  const totalBatches = Math.ceil(urls.length / BATCH_SIZE);
  MA('📦 共 ' + urls.length + ' 条，自动分 ' + totalBatches + ' 波处理（每波' + BATCH_SIZE + '条）...', 'info');

  // 累积合并各波结果
  const d = { total: urls.length, succeeded: 0, failed: 0, results: [], errors: [] };

  try {
    for (let bi = 0; bi < totalBatches; bi++) {
      const chunk = urls.slice(bi * BATCH_SIZE, (bi + 1) * BATCH_SIZE);
      MA('🚀 第 ' + (bi + 1) + '/' + totalBatches + ' 波开始（' + chunk.length + '条）...', 'info');
      MB.textContent = '⏳ 处理中 (第' + (bi + 1) + '/' + totalBatches + '波)...';

      let bd;
      try {
        const r = await fetch('/api/batch-media', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({urls: chunk, token: t})
        });
        bd = await r.json();
      } catch(e) {
        // 单波网络失败：标记该波全部为失败，继续下一波，不中断整体
        MA('⚠️ 第 ' + (bi + 1) + ' 波网络异常: ' + e.message + '，该波跳过', 'err');
        chunk.forEach(function(u){ d.failed++; d.errors.push({url: u, error: '网络异常: ' + e.message}); });
        continue;
      }

      if (bd.error) {
        MA('⚠️ 第 ' + (bi + 1) + ' 波返回错误: ' + bd.error, 'err');
        chunk.forEach(function(u){ d.failed++; d.errors.push({url: u, error: bd.error}); });
        continue;
      }

      // 合并本波结果
      d.succeeded += bd.succeeded || 0;
      d.failed += bd.failed || 0;
      if (bd.results) d.results = d.results.concat(bd.results);
      if (bd.errors) d.errors = d.errors.concat(bd.errors);
      MA('✅ 第 ' + (bi + 1) + '/' + totalBatches + ' 波完成: ' + (bd.succeeded||0) + ' 成功, ' + (bd.failed||0) + ' 失败', 'ok');
    }

    MA('🎉 全部完成: ' + d.succeeded + ' 成功, ' + d.failed + ' 失败', 'ok');
    
    // 渲染结果
    let html = '<h3>✅ 批量搬运完成</h3>';
    html += '<div style="display:flex;gap:12px;margin:14px 0">';
    html += '<div style="background:#e8f5e9;padding:10px 16px;border-radius:8px"><strong>' + d.succeeded + '</strong> 成功</div>';
    if (d.failed > 0) {
      html += '<div style="background:#ffebee;padding:10px 16px;border-radius:8px"><strong>' + d.failed + '</strong> 失败</div>';
    }
    html += '</div>';
    
    if (d.results && d.results.length > 0) {
      // 添加批量发送到飞书按钮
      html += '<div style="margin:16px 0"><button onclick="batchSendToFeishu()" id="batchFeishuBtn" style="padding:10px 20px;background:#00ba7c;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500">📤 批量发送到飞书 (' + d.results.length + '条)</button></div>';
      
      html += '<h4 style="margin:20px 0 10px 0">📋 提取结果</h4>';
      // 保存结果到全局，供批量发送使用
      window.batchResults = d.results;
      console.log('🔍 保存的批量结果:', window.batchResults);
      console.log('🔍 第一条数据示例:', window.batchResults[0]);
      
      d.results.forEach(function(item, idx) {
        html += '<div style="border:1px solid #e0e0e0;border-radius:10px;padding:16px;margin-bottom:12px">';
        html += '<div style="font-size:11px;color:#999;margin-bottom:6px">#' + (idx+1) + ' - ' + (item.category || 'General') + '</div>';
        html += '<div style="font-size:13px;color:#333;margin-bottom:8px;line-height:1.5">' + (item.text || '[无文本]') + '</div>';
        html += '<div style="font-size:12px;color:#666;margin-bottom:8px">📎 ' + (item.images || 0) + ' 图片' + (item.video ? ' + 视频' : '') + '</div>';
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap">';
        html += '<a href="' + (item.postUrl || '#') + '" target="_blank" style="font-size:11px;color:#1d9bf0;text-decoration:none">🔗 原帖</a>';
        if (item.imagePaths && item.imagePaths.length > 0) {
          item.imagePaths.forEach(function(p, i) {
            // p 格式是 'media/img_01.jpg'，需要直接拼接到 outputDir
            const url = '/output/_media/' + item.handle + '_' + item.tweetId + '/' + p;
            html += '<a href="' + url + '" target="_blank" style="font-size:11px;color:#1d9bf0;text-decoration:none" download>📷 图' + (i+1) + '</a>';
          });
        }
        if (item.videoPath) {
          // videoPath 格式是 'media/video.mp4'
          const vurl = '/output/_media/' + item.handle + '_' + item.tweetId + '/' + item.videoPath;
          html += '<a href="' + vurl + '" target="_blank" style="font-size:11px;color:#1d9bf0;text-decoration:none" download>🎬 视频</a>';
        }
        html += '</div></div>';
      });
    }
    
    if (d.errors && d.errors.length > 0) {
      html += '<h4 style="margin:20px 0 10px 0;color:#d32f2f">❌ 失败列表</h4>';
      d.errors.forEach(function(err) {
        html += '<div style="background:#ffebee;border-radius:8px;padding:12px;margin-bottom:8px;font-size:12px">';
        html += '<strong>' + err.url + '</strong><br><span style="color:#666">' + err.error + '</span>';
        html += '</div>';
      });
    }
    
    MR.innerHTML = html;
    MR.classList.add('show');
  } catch(e) {
    MA(e.message, 'err');
  }
  
  MB.disabled = false;
  MB.textContent = '🎬 开始搬运';
}

// 批量发送到飞书
async function batchSendToFeishu() {
  if (!window.batchResults || window.batchResults.length === 0) {
    return alert('没有可发送的结果');
  }
  
  const btn = document.getElementById('batchFeishuBtn');
  if (!btn) return;
  
  btn.disabled = true;
  btn.textContent = '⏳ 正在发送 (0/' + window.batchResults.length + ')...';
  
  let successCount = 0;
  let failCount = 0;
  const errors = [];
  
  // 并发发送（每次5个）
  const concurrency = 5;
  for (let i = 0; i < window.batchResults.length; i += concurrency) {
    const batch = window.batchResults.slice(i, i + concurrency);
    
    await Promise.allSettled(batch.map(async (item) => {
      try {
        console.log('🔍 准备发送到飞书的数据:', {
          imagePaths: item.imagePaths,
          videoPath: item.videoPath,
          outputDir: item.outputDir,
          handle: item.handle,
          tweetId: item.tweetId
        });
        
        // 防御性检查
        if (!item.outputDir || !item.imagePaths) {
          console.error('⚠️ 数据不完整:', item);
          throw new Error('缺少outputDir或imagePaths');
        }
        
        const res = await fetch('/api/send-to-feishu-batch', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            content: item.text,  // 使用原文，不用翻译
            tags: item.origTags || item.cnTags || '',  // 优先原文标签
            images: item.images || 0,
            mediaType: item.mediaType || (item.video ? '视频' : '图片'),
            imagePaths: item.imagePaths || [],  // 传递相对路径数组
            videoPath: item.videoPath || '',     // 传递视频相对路径
            outputDir: item.outputDir            // 传递输出目录
          })
        });
        
        const data = await res.json();
        if (data.success) {
          successCount++;
        } else {
          failCount++;
          errors.push({ url: item.postUrl, error: data.error || '未知错误' });
        }
      } catch (e) {
        failCount++;
        errors.push({ url: item.postUrl, error: e.message });
      }
      
      // 更新进度
      btn.textContent = '⏳ 正在发送 (' + (successCount + failCount) + '/' + window.batchResults.length + ')...';
    }));
  }
  
  // 完成
  btn.textContent = '✅ 发送完成';
  btn.style.background = '#00ba7c';
  
  let message = '批量发送完成！\\n\\n';
  message += '✅ 成功: ' + successCount + '\\n';
  if (failCount > 0) {
    message += '❌ 失败: ' + failCount + '\\n\\n';
    message += '失败详情：\\n';
    errors.slice(0, 3).forEach(err => {
      message += '• ' + err.url + ': ' + err.error + '\\n';
    });
    if (errors.length > 3) {
      message += '... 还有 ' + (errors.length - 3) + ' 个失败';
    }
  }
  
  alert(message);
  
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '📤 批量发送到飞书';
  }, 2000);
}

// 导出到全局
window.switchMediaMode = switchMediaMode;
window.runBatchMedia = runBatchMedia;
window.batchSendToFeishu = batchSendToFeishu;
window.currentMediaMode = function() { return currentMediaMode; };
