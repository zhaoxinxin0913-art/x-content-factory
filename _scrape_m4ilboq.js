// Scrape @m4ilboq recent posts via puppeteer
const puppeteer = require('/Users/zhaoxinxin/x-content-factory/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TOKEN = '87bdda5811e2219112a546694402dec91268a59f';
const HANDLE = 'm4ilboq';
const OUT = '/Users/zhaoxinxin/x-content-factory/output/m4ilboq';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--no-proxy-server','--proxy-server=direct://','--disable-gpu',
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  console.log('goto x.com...');
  await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.evaluate((t) => { document.cookie = `auth_token=${t}; domain=.x.com; path=/; secure`; }, TOKEN);
  await new Promise(r => setTimeout(r, 1000));

  console.log('goto profile...');
  await page.goto(`https://x.com/${HANDLE}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 30000 });
  } catch (e) {
    console.log('WARN: no tweet selector found. Login wall? Dumping title...');
    console.log('title:', await page.title());
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('body:', bodyText);
  }
  await new Promise(r => setTimeout(r, 2000));

  const seen = new Map();
  // scroll up to 20 times
  for (let s = 0; s < 20; s++) {
    const batch = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('[data-testid="tweet"]').forEach(a => {
        const t = a.querySelector('[data-testid="tweetText"]')?.innerText || '';
        if (!t) return;
        const link = a.querySelector('a[href*="/status/"]');
        const href = link ? link.getAttribute('href') : '';
        const time = a.querySelector('time');
        const datetime = time ? time.getAttribute('datetime') : '';
        const aria = a.querySelector('[role="group"]')?.getAttribute('aria-label') || '';
        const imgs = [];
        a.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach(img => {
          const src = img.src;
          if (src && !src.includes('profile_images')) imgs.push(src);
        });
        const hasVideo = !!a.querySelector('video') || !!a.querySelector('[data-testid="videoPlayer"]');
        out.push({ t, href, datetime, aria, imgs, hasVideo });
      });
      return out;
    });
    let added = 0;
    for (const x of batch) {
      const key = x.href || x.t.slice(0, 60);
      if (!seen.has(key)) { seen.set(key, x); added++; }
    }
    console.log(`scroll ${s}: batch=${batch.length} total_seen=${seen.size} added=${added}`);
    if (s >= 3 && added === 0) break;
    await page.evaluate(() => window.scrollBy(0, 3000));
    await new Promise(r => setTimeout(r, 1300));
  }

  await browser.close();

  const posts = [...seen.values()].map(x => ({
    q: x.t.trim().replace(/\n+/g, ' '),
    date: (x.datetime || '').split('T')[0],
    datetime: x.datetime,
    aria: x.aria,
    link: x.href ? `https://x.com${x.href}` : '',
    images: x.imgs || [],
    hasVideo: x.hasVideo || false
  }));

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'posts.json'), JSON.stringify(posts, null, 2), 'utf8');
  console.log(`\nDONE. total posts=${posts.length}`);
  posts.forEach((p,i)=>console.log(`${i+1}. [${p.date}] ${p.q.slice(0,70)}`));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
