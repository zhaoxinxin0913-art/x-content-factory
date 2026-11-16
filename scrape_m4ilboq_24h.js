const puppeteer=require('puppeteer');
const fs=require('fs');
const CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TOKEN='87bdda5811e2219112a546694402dec91268a59f';
const CT0='08a30b2749c78b31cb802eb8ac0c064ebe7d67e6';
const HANDLE='m4ilboq';

const Q_WORDS=/มั้ย|ไหม|ม้าย|ป้ะ|อะไร|ไหน|ยังไง|ใคร|เมื่อไหร่|ทำไม|กี่|หรือ|คะ|ครับ|ป่าว|ไหมอ่ะ|มั๊ย/;
const THAI=/[\u0E00-\u0E7F]/;

(async()=>{
  const b=await puppeteer.launch({
    executablePath:CHROME_PATH,
    headless:'new',
    args:['--no-sandbox','--disable-setuid-sandbox','--no-proxy-server','--proxy-server=direct://','--disable-blink-features=AutomationControlled','--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36']
  });
  const p=await b.newPage();
  await p.setViewport({width:1280,height:900});
  await p.setExtraHTTPHeaders({'Accept-Language':'th-TH,th;q=0.9,en;q=0.8'});
  await p.goto('https://x.com',{waitUntil:'domcontentloaded',timeout:20000});
  await p.evaluate((t,c)=>{document.cookie=`auth_token=${t}; domain=.x.com; path=/; secure`;document.cookie=`ct0=${c}; domain=.x.com; path=/`;},TOKEN,CT0);
  await new Promise(r=>setTimeout(r,1200));
  await p.goto(`https://x.com/${HANDLE}`,{waitUntil:'domcontentloaded',timeout:60000});
  try{await p.waitForSelector('[data-testid="tweet"]',{timeout:30000});}catch(e){}
  await new Promise(r=>setTimeout(r,2000));

  const seen=new Map();
  let noNew=0;
  for(let s=0;s<25&&noNew<4;s++){
    const np=await p.evaluate(()=>{
      const f=[];
      document.querySelectorAll('[data-testid="tweet"]').forEach(a=>{
        const t=a.querySelector('[data-testid="tweetText"]')?.innerText||'';
        if(!t)return;
        const link=a.querySelector('a[href*="/status/"]');
        const href=link?link.getAttribute('href'):'';
        const dt=a.querySelector('time')?.getAttribute('datetime')||'';
        const aria=a.querySelector('[role="group"]')?.getAttribute('aria-label')||'';
        f.push({text:t.trim().replace(/\n+/g,' '),dt,href,aria});
      });
      return f;
    });
    let added=0;
    for(const x of np){
      if(!x.dt)continue;
      const key=x.href||x.text.substring(0,60);
      if(!seen.has(key)){seen.set(key,x);added++;}
    }
    if(added===0)noNew++;else noNew=0;
    await p.evaluate(()=>window.scrollBy(0,3500));
    await new Promise(r=>setTimeout(r,1300));
  }
  await b.close();

  const now=new Date();
  const cutoff=now.getTime()-24*3600*1000;
  const all=[...seen.values()].map(x=>({...x,ts:new Date(x.dt).getTime()}));
  // sort by timestamp desc
  all.sort((a,b)=>b.ts-a.ts);

  const result={
    handle:HANDLE,
    now:now.toISOString(),
    cutoff:new Date(cutoff).toISOString(),
    totalScraped:all.length,
    last24h:[],
    questionPosts:[],
    allPosts:[]
  };

  for(const x of all){
    const in24=x.ts>=cutoff;
    const record={text:x.text,dt:x.dt,aria:x.aria,link:x.href?`https://x.com${x.href}`:'',inLast24h:in24,isThai:THAI.test(x.text),isQuestion:Q_WORDS.test(x.text)};
    result.allPosts.push(record);
    if(in24)result.last24h.push(record);
    if(in24&&THAI.test(x.text)&&Q_WORDS.test(x.text))result.questionPosts.push(record);
  }

  fs.writeFileSync('/Users/zhaoxinxin/x-content-factory/output/m4ilboq_scrape.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({totalScraped:all.length,last24hCount:result.last24h.length,questionCount:result.questionPosts.length},null,2));
  console.log('=== QUESTION POSTS (last 24h) ===');
  result.questionPosts.forEach((q,i)=>{
    console.log(`\n[${i+1}] ${q.dt}\nTH: ${q.text}\nLINK: ${q.link}\nARIA: ${q.aria}`);
  });
})().catch(e=>{console.error('ERROR',e.message);process.exit(1)});
