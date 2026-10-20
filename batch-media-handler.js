// 批量媒体搬运处理器
const path = require('path');
const fs = require('fs');

module.exports = async function handleBatchMedia(body, OUTPUT, downloadMedia, translateText) {
  const { urls, token } = JSON.parse(body);
  
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return { error: '需要提供 urls 数组' };
  }
  if (!token) {
    return { error: '需要 token' };
  }
  if (urls.length > 10) {
    return { error: '单次最多处理10个链接' };
  }
  
  console.log(`📦 开始批量处理 ${urls.length} 个帖子...`);
  
  // 并发处理所有帖子
  const results = await Promise.allSettled(urls.map(async (url, idx) => {
    const sm = url.match(/x\.com\/(\w+)\/status\/(\d+)/);
    if (!sm) throw new Error(`无效链接: ${url}`);
    
    const handle = sm[1];
    const tweetId = sm[2];
    const jobDir = path.join(OUTPUT, '_media', `${handle}_${tweetId}`);
    
    if (!fs.existsSync(jobDir)) {
      fs.mkdirSync(jobDir, { recursive: true });
    }
    
    console.log(`  [${idx + 1}/${urls.length}] 处理: ${handle}/${tweetId}`);
    
    const result = await Promise.race([
      downloadMedia(url, token, jobDir),
      new Promise((_, rj) => setTimeout(() => rj(new Error('超时120秒')), 120000))
    ]);
    
    // 翻译
    let cnText = result.post.text;
    try {
      cnText = await Promise.race([
        translateText(result.post.text),
        new Promise(resolve => setTimeout(() => resolve(result.post.text), 5000))
      ]);
      if (!cnText || cnText.length < 5) cnText = result.post.text;
    } catch (e) {
      console.error(`翻译失败 [${idx + 1}]:`, e.message);
    }
    
    // 分类
    const text = result.post.text.toLowerCase();
    let category = 'General';
    if (text.match(/celebrity|star|famous|idol|演员|明星|นักแสดง|artis/i)) category = 'Celebrity';
    else if (text.match(/love|relationship|boyfriend|girlfriend|couple|แฟน|ความรัก|pacar|cinta/i)) category = 'Relationship';
    else if (text.match(/meme|funny|lol|joke|ตลก|lucu|meme/i)) category = 'MEME';
    else if (text.match(/news|breaking|report|ข่าว|berita/i)) category = 'News';
    else if (text.match(/food|recipe|eat|อาหาร|makanan/i)) category = 'Food';
    else if (text.match(/travel|trip|vacation|ท่องเที่ยว|wisata/i)) category = 'Travel';
    
    const cnTags = ['#' + category];
    const origTags = result.post.text.match(/#[\w\u0E00-\u0E7F]+/g) || [];
    if (category === 'Relationship') cnTags.push('#情感');
    if (category === 'MEME') cnTags.push('#搞笑');
    if (category === 'Food') cnTags.push('#美食');
    
    console.log(`  ✅ [${idx + 1}/${urls.length}] 完成: ${result.downloadedImgs.length}图 + ${result.videoFile ? '1视频' : '无视频'}`);
    
    return {
      index: idx,
      handle,
      tweetId,
      text: result.post.text,
      cnText,
      category,
      cnTags: cnTags.join(' '),
      origTags: origTags.slice(0, 5).join(' ') || '#' + category,
      images: result.downloadedImgs.length,
      imagePaths: result.downloadedImgs,
      video: !!result.videoFile,
      videoPath: result.videoFile || '',
      mediaType: result.videoFile ? '视频' : '图片',
      outputDir: path.join(OUTPUT, '_media', `${handle}_${tweetId}`),
      postUrl: url
    };
  }));
  
  // 统计结果
  const succeeded = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const failed = results.filter(r => r.status === 'rejected').map((r, i) => ({
    index: i,
    url: urls[i],
    error: r.reason.message
  }));
  
  console.log(`✅ 批量处理完成: ${succeeded.length} 成功, ${failed.length} 失败`);
  
  return {
    total: urls.length,
    succeeded: succeeded.length,
    failed: failed.length,
    results: succeeded,
    errors: failed
  };
};
