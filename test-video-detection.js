const puppeteer = require('puppeteer');

(async () => {
  console.log('🔍 测试视频检测...\n');
  
  const browser = await puppeteer.launch({
    headless: false,  // 有头模式，可以看到浏览器
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({width: 1280, height: 900});
    
    // 访问视频帖子（无需登录也能看到）
    const videoUrl = 'https://x.com/BokBear__DMD/status/2086760199927578890';
    console.log('1. 访问视频帖子（无登录）...');
    await page.goto(videoUrl, {waitUntil: 'domcontentloaded', timeout: 60000});
    
    console.log('2. 等待页面加载...');
    await page.waitForSelector('article', {timeout: 10000});
    await new Promise(r => setTimeout(r, 3000));
    
    // 检测视频元素
    console.log('3. 检测视频元素...\n');
    const result = await page.evaluate(() => {
      const article = document.querySelector('article');
      if (!article) return {error: 'No article found'};
      
      return {
        hasVideo: !!document.querySelector('video'),
        hasVideoPlayer: !!document.querySelector('[data-testid="videoPlayer"]'),
        hasVideoComponent: !!document.querySelector('[data-testid="videoComponent"]'),
        videoCount: document.querySelectorAll('video').length,
        allVideoTestIds: [...document.querySelectorAll('[data-testid]')]
          .map(el => el.getAttribute('data-testid'))
          .filter(id => id && (id.toLowerCase().includes('video') || id.toLowerCase().includes('play')))
          .slice(0, 20),
        pageTitle: document.title,
        hasLoginPrompt: !!document.querySelector('a[href="/login"]')
      };
    });
    
    console.log('📊 检测结果:');
    console.log(JSON.stringify(result, null, 2));
    
    if (result.hasLoginPrompt) {
      console.log('\n⚠️  页面显示登录提示，需要登录才能看视频！');
    }
    
    if (result.hasVideo || result.hasVideoPlayer) {
      console.log('\n✅ 视频元素已检测到！');
    } else {
      console.log('\n❌ 未检测到视频元素');
      console.log('可能原因：');
      console.log('  1. 页面需要登录');
      console.log('  2. 视频需要点击播放才加载');
      console.log('  3. X 改了 DOM 结构');
    }
    
    console.log('\n浏览器将保持打开20秒，请手动检查页面...');
    await new Promise(r => setTimeout(r, 20000));
  } catch (e) {
    console.error('❌ 错误:', e.message);
  } finally {
    await browser.close();
  }
})();
