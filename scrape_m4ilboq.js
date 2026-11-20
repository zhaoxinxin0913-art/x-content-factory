const puppeteer = require('puppeteer');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const AUTH_TOKEN = '87bdda5811e2219112a546694402dec91268a59f';
const CT0 = '08a30b2749c78b31cb802eb8ac0c064ebe7d67e6';
const HANDLE = 'm4ilboq';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Set cookies (httpOnly properly via CDP)
  await page.setCookie(
    { name: 'auth_token', value: AUTH_TOKEN, domain: '.x.com', path: '/', secure: true, httpOnly: true },
    { name: 'ct0', value: CT0, domain: '.x.com', path: '/', secure: true }
  );

  console.error('navigating to profile...');
  await page.goto(`https://x.com/${HANDLE}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 30000 });
  } catch (e) {
    console.error('WARN: no tweet selector found, dumping body snippet');
    const body = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.error(body);
  }
  await new Promise(r => setTimeout(r, 2000));

  const seen = new Map(); // statusId -> post
  let noNewStreak = 0;

  for (let s = 0; s < 40; s++) {
    const batch = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('[data-testid="tweet"]').forEach(a => {
        const textEl = a.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText : '';
        const link = a.querySelector('a[href*="/status/"]');
        const href = link ? link.getAttribute('href') : '';
        const m = href.match(/\/status\/(\d+)/);
        const statusId = m ? m[1] : '';
        const timeEl = a.querySelector('time');
        const datetime = timeEl ? timeEl.getAttribute('datetime') : '';
        const aria = a.querySelector('[role="group"]')?.getAttribute('aria-label') || '';
        const imgs = [];
        a.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach(img => {
          if (img.src && !img.src.includes('profile_images')) imgs.push(img.src);
        });
        const hasVideo = !!a.querySelector('video') || !!a.querySelector('[data-testid="videoPlayer"]');
        if (statusId) out.push({ statusId, text, datetime, aria, href, images: imgs, hasVideo });
      });
      return out;
    });

    let added = 0;
    for (const p of batch) {
      if (p.statusId && !seen.has(p.statusId)) {
        seen.set(p.statusId, p);
        added++;
      }
    }
    console.error(`scroll ${s}: +${added} new (total ${seen.size})`);

    if (added === 0) {
      noNewStreak++;
      if (noNewStreak >= 4) break;
    } else {
      noNewStreak = 0;
    }

    await page.evaluate(() => window.scrollBy(0, 3000));
    await new Promise(r => setTimeout(r, 1200));
  }

  await browser.close();

  const posts = [...seen.values()];
  console.log(JSON.stringify({ handle: HANDLE, scrapedAt: new Date().toISOString(), total: posts.length, posts }, null, 0));
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
