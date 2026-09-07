/**
 * 图片搜索模块
 * 从帖子内容提取关键词，搜索真实配图
 */

const https = require('https');

// ============================================================
// 关键词提取（泰语 → 英文）
// ============================================================
const KEYWORD_MAP = {
  // 情感类
  'ความรัก': 'love romance',
  'แฟน': 'couple dating',
  'โสด': 'single alone',
  'จีบ': 'flirting crush',
  'เลิก': 'breakup heartbreak',
  'คิดถึง': 'missing someone',
  'อกหัก': 'heartbreak sad',
  
  // 职场类
  'งาน': 'work office',
  'ลาออก': 'quit job resignation',
  'เจ้านาย': 'boss manager',
  'เพื่อนร่วมงาน': 'coworker teamwork',
  
  // 美食类
  'อาหาร': 'food meal',
  'กิน': 'eating food',
  'คาเฟ่': 'cafe coffee',
  'ร้าน': 'restaurant',
  'อร่อย': 'delicious food',
  
  // 旅行类
  'ท่องเที่ยว': 'travel vacation',
  'เที่ยว': 'trip journey',
  'ทะเล': 'beach sea',
  'ภูเขา': 'mountain nature',
  
  // 生活类
  'เพื่อน': 'friends friendship',
  'ครอบครัว': 'family',
  'สัตว์เลี้ยง': 'pets animals',
  'รอยสัก': 'tattoo',
  'เพลง': 'music',
  'วิ่ง': 'running exercise',
  'ออกกำลัง': 'fitness gym',
  
  // 情绪类
  'เหงา': 'lonely solitude',
  'เบื่อ': 'bored tired',
  'มีความสุข': 'happy joy',
  'เครียด': 'stress anxiety',
  'ง่วง': 'sleepy tired',
};

/**
 * 从帖子内容提取关键词（泰语 → 英文）
 */
function extractKeywords(thaiText, cnText = '') {
  const keywords = [];
  
  // 1. 匹配泰语关键词
  for (const [thai, eng] of Object.entries(KEYWORD_MAP)) {
    if (thaiText.includes(thai)) {
      keywords.push(eng);
    }
  }
  
  // 2. 如果有中文翻译，也提取中文关键词
  const cnKeywords = {
    '爱情': 'love',
    '恋爱': 'romance',
    '单身': 'single',
    '分手': 'breakup',
    '工作': 'work',
    '辞职': 'quit job',
    '美食': 'food',
    '旅行': 'travel',
    '朋友': 'friends',
    '家人': 'family',
  };
  
  for (const [cn, eng] of Object.entries(cnKeywords)) {
    if (cnText.includes(cn) && !keywords.some(k => k.includes(eng))) {
      keywords.push(eng);
    }
  }
  
  // 3. 如果没找到关键词，返回通用关键词
  if (keywords.length === 0) {
    // 根据帖子长度和问号判断主题
    if (thaiText.includes('?') || thaiText.includes('มั้ย') || thaiText.includes('ไหม')) {
      keywords.push('thinking question');
    } else {
      keywords.push('life lifestyle');
    }
  }
  
  return keywords;
}

// ============================================================
// 图片搜索 API（Unsplash）
// ============================================================

/**
 * 搜索 Unsplash 图片
 * 免费额度：50次/小时
 */
async function searchUnsplash(query, count = 1) {
  return new Promise((resolve) => {
    const apiKey = process.env.UNSPLASH_ACCESS_KEY || 'demo'; // 使用 demo key
    const encoded = encodeURIComponent(query);
    const url = `https://api.unsplash.com/search/photos?query=${encoded}&per_page=${count}&orientation=portrait&client_id=${apiKey}`;
    
    https.get(url, {
      headers: { 'Accept-Version': 'v1' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = json.results || [];
          const images = results.map(r => ({
            url: r.urls.regular,
            thumb: r.urls.thumb,
            author: r.user.name,
            authorUrl: r.user.links.html,
            downloadUrl: r.links.download
          }));
          resolve(images);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

/**
 * 搜索 Pexels 图片（备用）
 * 免费额度：200次/小时
 */
async function searchPexels(query, count = 1) {
  return new Promise((resolve) => {
    const apiKey = process.env.PEXELS_API_KEY || '';
    if (!apiKey) return resolve([]);
    
    const encoded = encodeURIComponent(query);
    const url = `https://api.pexels.com/v1/search?query=${encoded}&per_page=${count}&orientation=portrait`;
    
    https.get(url, {
      headers: { 'Authorization': apiKey }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const images = (json.photos || []).map(p => ({
            url: p.src.large,
            thumb: p.src.medium,
            author: p.photographer,
            authorUrl: p.photographer_url,
            downloadUrl: p.src.original
          }));
          resolve(images);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

/**
 * 主搜索函数：依次尝试 Unsplash、Pexels
 */
async function searchImage(thaiText, cnText = '', count = 1) {
  const keywords = extractKeywords(thaiText, cnText);
  const query = keywords.slice(0, 2).join(' '); // 最多用前2个关键词
  
  console.log(`🔍 搜索配图: "${query}" (原文前20字: ${thaiText.substring(0, 20)}...)`);
  
  // 1. 先试 Unsplash
  let images = await searchUnsplash(query, count);
  if (images.length > 0) {
    console.log(`✅ Unsplash 找到 ${images.length} 张图片`);
    return { query, images, source: 'Unsplash' };
  }
  
  // 2. 再试 Pexels
  images = await searchPexels(query, count);
  if (images.length > 0) {
    console.log(`✅ Pexels 找到 ${images.length} 张图片`);
    return { query, images, source: 'Pexels' };
  }
  
  // 3. 都失败了，返回空
  console.log(`⚠️ 未找到配图，关键词: ${query}`);
  return { query, images: [], source: 'none' };
}

/**
 * 批量搜索配图
 */
async function searchImagesForPosts(posts, delayMs = 1000) {
  const results = [];
  
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const result = await searchImage(post.text, post.translationCN, 1);
    
    results.push({
      ...post,
      imageSearch: result
    });
    
    // 延迟，避免API限流
    if (i < posts.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return results;
}

// ============================================================
// 导出
// ============================================================
module.exports = {
  extractKeywords,
  searchImage,
  searchImagesForPosts
};
