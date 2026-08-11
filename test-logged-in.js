const puppeteer = require('puppeteer');
const fs = require('fs');

// 读取 .env 获取 token（如果有）
let testToken = '';
if (fs.existsSync('.env')) {
  const env = fs.readFileSync('.env', 'utf8');
  const match = env.match(/TEST_AUTH_TOKEN=(.+)/);
  if (match) testToken = match[1].trim();
}

if (!testToken) {
  console.log('❌ 需要在 .env 中设置 TEST_AUTH_TOKEN');
  console.log('请添加这一行到 .env:');
  console.log('TEST_AUTH_TOKEN=你的auth_token');
  process.exit(1);
}

(async () => {
  const b = await puppeteer.launch({headless: 'new'});
  const p = await b.newPage();
  await p.setViewport({width: 1280, height: 900});
  
  console.log('1. 访问 x.com 并注入 token...');
  await p.goto('https://x.com', {waitUntil: 'domcontentloaded', timeout: 15000});
  await p.evaluate(t => {
    document.cookie = `auth_token=${t}; domain=.x.com; path=/; secure`;
  }, testToken);
  await new Promise(r => setTimeout(r, 1000));
  
  console.log('2. 访问视频帖子...');
  await p.goto('https://x.com/BokBear__DMD/status/2086760199927578890', {waitUntil: 'domcontentloaded', timeout: 60000});
  await p.waitForSelector('article', {timeout: 10000});
  await new Promise(r => setTimeout(r, 3000));
  
  console.log('3. 检测视频元素...\n');
  const result = await p.evaluate(() => {
    const article = document.querySelector('article[data-testid="tweet"]');
    if (!article) return {error: 'No article found'};
    
    return {
      hasVideo: !!article.querySelector('video'),
      hasVideoPlayer: !!article.querySelector('[data-testid="videoPlayer"]'),
      videoCount: document.querySelectorAll('video').length,
      allVideoTestIds: [...document.querySelectorAll('[data-testid]')]
        .map(el => el.getAttribute('data-testid'))
        .filter(id => id && (id.toLowerCase().includes('video') || id.toLowerCase().includes('play')))
        .slice(0, 10),
      hasText: !!article.querySelector('[data-testid="tweetText"]'),
      textContent: article.querySelector('[data-testid="tweetText"]')?.innerText?.substring(0, 50)
    };
  });
  
  console.log('结果:', JSON.stringify(result, null, 2));
  await b.close();
})();
