const http=require('http'),fs=require('fs'),path=require('path'),puppeteer=require('puppeteer');
// 加载环境变量
if(fs.existsSync(path.join(__dirname,'.env'))){
  fs.readFileSync(path.join(__dirname,'.env'),'utf8').split('\n').forEach(line=>{
    const [key,val]=line.trim().split('=');
    if(key&&val)process.env[key]=val;
  });
}
const PORT=5050,OUTPUT=path.join(__dirname,'output');
fs.existsSync(OUTPUT)||fs.mkdirSync(OUTPUT);
const{uploadToFeishu}=require('./feishu.js');

// ============================================================
const STYLES=[{cls:'s1',css:'background:#fafafa',txt:'color:#333'},
{cls:'s2',css:'background:#0a0a0a',txt:'color:#ff6ec7;text-shadow:0 0 30px #ff6ec7'},
{cls:'s3',css:'background:linear-gradient(135deg,#e0c3fc,#8ec5fc)',txt:'color:#2d1b69'},
{cls:'s4',css:'background:linear-gradient(135deg,#a8edea,#fed6e3)',txt:'color:#2c3e50'},
{cls:'s5',css:'background:linear-gradient(135deg,#ff9a9e,#fecfef 50%,#a1c4fd)',txt:'color:#fff;text-shadow:0 2px 20px rgba(0,0,0,.3)'},
{cls:'s6',css:'background:#f4e4c1',txt:'color:#5d4037;font-style:italic'},
{cls:'s7',css:'background:#0f0f23',txt:'color:#00f2fe;text-shadow:0 0 40px rgba(0,242,254,.5)'}];
// 排除：纯个人状态 + 引流其他平台
const EXCLUDE_PERSONAL=/^(สวัสดี|good morning|good night|กู?ด(มอร์นิ่ง|ไนท์)|อรุณสวัสดิ์|ราตรีสวัสดิ์|นอนดึก|ง่วง|เหนื่อย|ตื่นสาย|วันนี้เหนื่อย|ปวดหัว|ไม่สบาย).{0,80}$/i;
const EXCLUDE_PLATFORM=/(?:ig|instagram|tiktok|ติ๊กต๊อก|line ?@|ไลน์|youtube|yt|subscribe|ซับ|ช่อง|คลิป(?:ลิ้งค์|ลิงก์)|bio|link in|linktree)/i;
const INTERACT_SIGNALS=/มั้ย|ไหม|อะไร|ไหน|ยังไง|ใคร|ทำไม|คิดว่า|ชอบ|แนะนำ|เคย|หรือ|บ้าง|\?/;
const EXCLUDE_STATUS=/^.{0,50}$/.source; // very short = likely personal update
function isGoodPost(t){
  if(t.length<30)return false;
  if(EXCLUDE_PLATFORM.test(t))return false;
  // 个人状态：仅排除没有互动信号的短碎碎念
  if(EXCLUDE_PERSONAL.test(t)&&!INTERACT_SIGNALS.test(t))return false;
  return true;
}
// (legacy) question keywords for backward compat
const Q=['มั้ย','ไหม','อะไร','ไหน','ยังไง','ใคร','เมื่อไหร่','ทำไม','กี่','?','ม้าย','ป้ะ','คะ','หรือ'];

function tagText(t){
  const r=[];
  if(/ความรัก|แฟน|โสด|จีบ|เลิก|ความสัมพันธ์|อกหัก/.test(t))r.push('#情感','#ความรัก');
  if(/งาน|ที่ทำงาน|เจ้านาย|เพื่อนร่วมงาน|ลาออก|ออฟฟิศ/.test(t))r.push('#职场','#ที่ทำงาน');
  if(/อาหาร|กิน|ขนม|เซเว่น|อร่อย|ผัดไทย/.test(t))r.push('#美食','#อาหาร');
  if(/ฟิค|นิยาย|อ่าน|เรื่อง/.test(t))r.push('#同人小说','#ฟิค');
  if(/ท่องเที่ยว|เที่ยว|บิน|เกาหลี|ญี่ปุ่น|ต่างประเทศ/.test(t))r.push('#旅行','#ท่องเที่ยว');
  if(/AI|เทคโนโลยี|เว็บ|แอพ/.test(t))r.push('#科技','#เทคโนโลยี');
  if(/เพลง|ฟัง/.test(t))r.push('#音乐','#เพลง');
  if(/วิ่ง|กีฬา|ออกกำลัง/.test(t))r.push('#运动','#กีฬา');
  if(/เพื่อน|กลุ่มเพื่อน/.test(t))r.push('#友情','#เพื่อน');
  if(/รอยสัก|สัก/.test(t))r.push('#纹身','#รอยสัก');
  if(/ลูก|สัตว์เลี้ยง/.test(t))r.push('#生活方式','#ไลฟ์สไตล์');
  if(!r.length)r.push('#生活','#ชีวิตประจำวัน');
  return [...new Set(r)].join(' ');
}

function basicCN(t){
  // 保留作为 fallback，实际翻译在 translatePosts() 中完成
  const m={แฟน:'对象',โสด:'单身',ความรัก:'爱情',เลิก:'分手',จีบ:'追',แต่งงาน:'结婚',คบ:'交往',คิดถึง:'想念',รัก:'爱',
  งาน:'工作',ลาออก:'辞职',เจ้านาย:'老板',เงินเดือน:'工资',
  อาหาร:'美食',กิน:'吃',ร้าน:'店',คาเฟ่:'咖啡馆',เค้ก:'蛋糕',อร่อย:'好吃',
  เพื่อน:'朋友',ครอบครัว:'家人',พ่อ:'爸爸',แม่:'妈妈',
  ชีวิต:'人生',ประสบการณ์:'经验',มาตรฐาน:'标准',อยากรู้:'想知道',วันเกิด:'生日'};
  let cn='';
  for(const[k,v] of Object.entries(m)) if(t.includes(k)) cn+=v+' ';
  return cn.trim()||'';
}

// Google Translate 免费 API 翻译
const https=require('https');
function translateText(text,sl='th',tl='zh-CN'){
  return new Promise((resolve)=>{
    const encoded=encodeURIComponent(text.substring(0,500));
    const url=`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encoded}`;
    https.get(url,(res)=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>{
        try{const j=JSON.parse(d);resolve(j[0].map(x=>x[0]).join(''))}catch(e){resolve('')}
      });
    }).on('error',()=>resolve(''));
  });
}

async function translatePosts(posts){
  // 并行翻译（每批5条）
  for(let i=0;i<posts.length;i+=5){
    const batch=posts.slice(i,i+5).filter(p=>!p.cn||p.cn.length<=20);
    await Promise.all(batch.map(async p=>{
      try{
        const translated=await translateText(p.q);
        if(translated&&translated.length>5)p.cn=translated;
      }catch(e){}
    }));
    if(i+5<posts.length)await new Promise(r=>setTimeout(r,200));
  }
}

function analyzeStyle(posts){
  // 话题分布（中文标签）
  const tc={};posts.forEach(p=>p.tags.split(' ').filter(t=>/[\u4e00-\u9fa5]/.test(t)).forEach(t=>{tc[t]=(tc[t]||0)+1}));
  const topTags=Object.entries(tc).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([t,n])=>({t,n}));
  // 互动均值
  let tl=0,tr=0,tv=0,ve=0;
  posts.forEach(p=>{const a=p.aria||'',l=parseInt(((a.match(/(\d[\d,]*)\s*like/)||['','0'])[1]).replace(/,/g,'')),r=parseInt(((a.match(/(\d[\d,]*)\s*repost/)||['','0'])[1]).replace(/,/g,'')),v=parseInt(((a.match(/(\d[\d,]*)\s*view/)||['','0'])[1]).replace(/,/g,''));if(l||r||v){tl+=l;tr+=r;tv+=v;ve++}});
  const n=ve||1;
  // 提问词频
  const qw={'มั้ย/ไหม':['มั้ย','ไหม'],'อะไร':['อะไร'],'ทำไม':['ทำไม'],'ใคร':['ใคร'],'ยังไง':['ยังไง']};
  const qs={};posts.forEach(p=>Object.entries(qw).forEach(([l,ws])=>{if(ws.some(w=>p.q.includes(w)))qs[l]=(qs[l]||0)+1}));
  const topQ=Object.entries(qs).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([w,c])=>({w,c}));
  // 内容调性
  const all=posts.map(p=>p.q).join(' ');const tones=[];
  if(/ขอบคุณ|รัก|น่ารัก|ซึ้ง|อบอุ่น/.test(all))tones.push('温暖亲和');
  if(/555|ฮา|ตลก|ขำ|เฮฮา/.test(all))tones.push('幽默风趣');
  if(/ชีวิต|ความรู้สึก|ความหมาย|จริงๆ|ลึกๆ/.test(all))tones.push('深度思考');
  if(/กิน|อาหาร|คาเฟ่|ร้าน|ขนม/.test(all))tones.push('生活分享');
  if(!tones.length)tones.push('轻松互动');
  // 最热帖
  let bp=null,bs=0;posts.forEach(p=>{const v=parseInt(((p.aria||'').match(/(\d[\d,]*)\s*view/)||['','0'])[1].replace(/,/g,''));if(v>bs){bs=v;bp=p}});
  return{topTags,avgLikes:Math.round(tl/n),avgReposts:Math.round(tr/n),avgViews:Math.round(tv/n),topQ,tone:tones.slice(0,3).join(' · '),bestPost:bp?{q:bp.q.substring(0,60)+(bp.q.length>60?'…':''),views:bs}:null};
}

// ============================================================
async function scrapeX(url,token,maxCount){
  const b=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36']});
  const p=await b.newPage();await p.setViewport({width:1280,height:900});
  await p.setExtraHTTPHeaders({'Accept-Language':'en-US,en;q=0.9'});
  await p.goto('https://x.com',{waitUntil:'domcontentloaded',timeout:15000});
  await p.evaluate(t=>{document.cookie=`auth_token=${t}; domain=.x.com; path=/; secure`;},token);
  await new Promise(r=>setTimeout(r,1000));
  const m=url.match(/x\.com\/(\w+)/),handle=m?m[1]:'unknown';
  await p.goto(`https://x.com/${handle}`,{waitUntil:'domcontentloaded',timeout:60000});
  await p.waitForSelector('[data-testid="tweet"]',{timeout:30000});
  await new Promise(r=>setTimeout(r,1500));
  const posts=new Map();
  for(let s=0;s<15&&posts.size<maxCount;s++){
    const np=await p.evaluate(()=>{
      const f=[];document.querySelectorAll('[data-testid="tweet"]').forEach(a=>{
        const t=a.querySelector('[data-testid="tweetText"]')?.innerText||'';
        if(!t||f.some(x=>x.text===t))return;
        const link=a.querySelector('a[href*="/status/"]');
        const href=link?link.getAttribute('href'):'';
        f.push({text:t,date:(a.querySelector('time')?.getAttribute('datetime')||'').split('T')[0],aria:a.querySelector('[role="group"]')?.getAttribute('aria-label')||'',href});
      });return f;
    });
    np.filter(x=>isGoodPost(x.text)).forEach(x=>{const k=x.text.substring(0,50);if(!posts.has(k))posts.set(k,x)});
    if(posts.size>=maxCount)break;
    await p.evaluate(()=>window.scrollBy(0,3000));await new Promise(r=>setTimeout(r,1200));
  }
  await b.close();
  const postList=[...posts.values()].slice(0,maxCount).map(x=>({q:x.text.trim().replace(/\n+/g,' '),date:x.date,aria:x.aria,tags:tagText(x.text),cn:basicCN(x.text),link:x.href?`https://x.com${x.href}`:'',comments:[]}));
  return{handle,posts:postList};
}

// ============================================================
function genCards(jobDir,posts){
  let css='',cards='',fullCards='';
  const fontCSS=fs.readFileSync(path.join(__dirname,'fonts','font-face.css'),'utf8');
  STYLES.forEach(s=>css+=`.${s.cls}{${s.css}}.${s.cls} .q{${s.txt}}\n`);
  posts.forEach((p,i)=>{const s=STYLES[i%STYLES.length];
    cards+=`<div class="card ${s.cls}"><div class="q">${p.q}</div></div>\n`;
    fullCards+=`<div class="card ${s.cls}"><div class="q">${p.q}</div></div>\n`;
  });
  // 截图用 HTML（900×1200 原始尺寸）
  fs.writeFileSync(path.join(jobDir,'cards_full.html'),`<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><style>
${fontCSS}
*{margin:0;padding:0;box-sizing:border-box}body{background:#111;display:flex;flex-wrap:wrap;gap:20px;padding:20px;justify-content:center}
.card{width:900px;height:1200px;border-radius:36px;display:flex;align-items:center;justify-content:center;font-family:'Noto Sans Thai',sans-serif;padding:80px 70px;overflow:hidden}
.q{font-size:60px;font-weight:800;line-height:1.4;text-align:center;overflow:hidden;display:-webkit-box;-webkit-line-clamp:10;-webkit-box-orient:vertical}
${css}</style></head><body>${fullCards}</body></html>`,'utf8');
  // 浏览用 HTML（缩略图网格）
  fs.writeFileSync(path.join(jobDir,'cards.html'),`<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><style>
${fontCSS}
*{margin:0;padding:0;box-sizing:border-box}body{background:#111;display:flex;flex-wrap:wrap;gap:14px;padding:20px;justify-content:center}
.card{width:280px;height:373px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-family:'Noto Sans Thai',sans-serif;padding:24px 20px;cursor:pointer;transition:transform .2s;overflow:hidden}
.card:hover{transform:scale(1.03)}
.q{font-size:18px;font-weight:800;line-height:1.4;text-align:center;overflow:hidden;display:-webkit-box;-webkit-line-clamp:12;-webkit-box-orient:vertical}
.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.85);z-index:999;align-items:center;justify-content:center}
.modal.show{display:flex}
.modal .big{width:900px;height:1200px;max-width:90vw;max-height:90vh;border-radius:36px;display:flex;align-items:center;justify-content:center;font-family:'Noto Sans Thai',sans-serif;padding:80px 70px;object-fit:contain}
.modal .big .q{font-size:60px}
.modal .close{position:fixed;top:20px;right:30px;color:#fff;font-size:32px;cursor:pointer;z-index:1000}
${css}</style></head><body>${cards}
<div class="modal" id="modal" onclick="this.classList.remove('show')"><span class="close">✕</span><div class="big" id="bigCard"></div></div>
<script>document.querySelectorAll('.card').forEach(c=>c.onclick=()=>{const m=document.getElementById('modal'),b=document.getElementById('bigCard');b.className='big '+c.className.replace('card ','');b.innerHTML=c.innerHTML;m.classList.add('show')})</script></body></html>`,'utf8');
}

async function screenshotCards(jobDir){
  const cp=path.join(jobDir,'cards_full.html'),id=path.join(jobDir,'imgs');fs.existsSync(id)||fs.mkdirSync(id,{recursive:true});
  const b=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']}),p=await b.newPage();
  await p.setViewport({width:1200,height:900});await p.goto(`file://${cp}`,{waitUntil:'networkidle0',timeout:30000});
  await p.evaluate(()=>document.fonts.ready);
  const cards=await p.$$('.card');
  for(let i=0;i<cards.length;i++)await cards[i].screenshot({path:path.join(id,`card_${String(i+1).padStart(3,'0')}.png`)});
  await b.close();return cards.length;
}

function genPreview(jobDir,handle,posts){
  const fontCSS=fs.readFileSync(path.join(__dirname,'fonts','font-face.css'),'utf8');
  let blocks='';
  posts.forEach((p,i)=>{const n=String(i+1).padStart(3,'0');
    blocks+=`<div class="post" id="post${i}">
  <img src="imgs/card_${n}.png" style="width:200px;height:267px;object-fit:cover;flex-shrink:0;border-radius:8px 0 0 8px">
  <div class="body">
    <div class="th">🇹🇭 ${p.q}</div>
    <div class="cn">🇨🇳 ${p.cn||'—'}</div>
    ${p.comments&&p.comments.length?`<div class="cmts"><div class="cmts-title">💬 热门评论</div>${p.comments.map(c=>`<div class="cmt"><span class="cmt-text">${c.text.replace(/\n/g,' ').substring(0,100)}</span><span class="cmt-likes">❤️${c.likes}</span></div>`).join('')}</div>`:''}
    <div class="aria">${p.aria}</div>
    <div class="tags">${p.tags.split(' ').map(t=>`<span class="t">${t}</span>`).join('')}</div>
    <div class="actions">
      <a class="dl" href="/api/download/${handle}/imgs/card_${n}.png" download>⬇️</a>
      ${p.link?`<a class="dl" href="${p.link}" target="_blank" style="background:#1d9bf0">🔗</a>`:''}
      <button class="pub" onclick="togglePub(${i})" id="btn${i}">📌</button>
    </div>
  </div></div>\n`});
  const html=`<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>@${handle} 素材包</title><style>
${fontCSS}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#fafafa;color:#1a1a1a;font-family:'Noto Sans Thai',-apple-system,sans-serif;padding:24px}
h1{font-size:24px;text-align:center;color:#000;margin-bottom:4px}
.sub{text-align:center;color:#999;margin-bottom:18px;font-size:14px}
.top-bar{display:flex;gap:8px;justify-content:center;margin-bottom:28px;flex-wrap:wrap}
.top-bar a,.top-bar button{background:#000;color:#fff;padding:8px 18px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;border:none;cursor:pointer}
.top-bar .zip{background:#333}
.grid{max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
.post{background:#fff;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden;display:flex}
.post img{width:200px;height:267px;object-fit:cover;flex-shrink:0;border-right:1px solid #f0f0f0}
.body{padding:18px 22px;display:flex;flex-direction:column;gap:8px;min-width:0;flex:1}
.th{font-size:16px;font-weight:700;line-height:1.5;color:#000;word-break:break-word}
.cn{font-size:14px;color:#666;line-height:1.5;border-left:3px solid #e0e0e0;padding-left:10px;margin:4px 0}
.cmts{background:#f8f8f8;border-radius:8px;padding:10px 12px;margin:4px 0}
.cmts-title{font-size:11px;color:#999;font-weight:600;margin-bottom:6px}
.cmt{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:5px;font-size:12px;line-height:1.4}
.cmt-text{color:#333;flex:1}
.cmt-likes{color:#999;font-size:11px;white-space:nowrap}
.aria{color:#bbb;font-size:11px}
.tags{display:flex;flex-wrap:wrap;gap:4px}
.t{background:#f3f3f3;color:#888;padding:2px 8px;border-radius:4px;font-size:11px}
.actions{display:flex;gap:8px;margin-top:auto;padding-top:4px}
.dl{background:#000;color:#fff;padding:5px 12px;border-radius:5px;text-decoration:none;font-size:12px}
.pub{background:#fff;color:#000;border:1.5px solid #ddd;padding:5px 12px;border-radius:5px;cursor:pointer;font-size:12px}
.pub.done{background:#000;color:#fff;border-color:#000}
</style></head><body>
<h1>🐱 @${handle} 发帖素材包</h1>
<p class="sub">${posts.length} 条提问帖</p>
<div class="top-bar">
  <a class="zip" href="/api/zip/${handle}">📦 下载全部 ZIP</a>
  <a href="/output/${handle}/cards.html">🎨 纯卡片页</a>
  <button onclick="showPublished()">✅ 只看已发布</button>
  <button onclick="showAll()">📋 查看全部</button>
</div>
<div class="grid">
${blocks}</div>
<script>
const total=${posts.length};
let published=new Set(JSON.parse(localStorage.getItem('pub_${handle}')||'[]'));
function togglePub(i){
  const btn=document.getElementById('btn'+i);
  if(published.has(i)){published.delete(i);btn.textContent='📌 标记发布';btn.classList.remove('done')}
  else{published.add(i);btn.textContent='✅ 已发布';btn.classList.add('done')}
  localStorage.setItem('pub_${handle}',JSON.stringify([...published]));
}
function showPublished(){document.querySelectorAll('.post').forEach((p,i)=>{p.style.display=published.has(i)?'':'none'})}
function showAll(){document.querySelectorAll('.post').forEach(p=>p.style.display='')}
// restore state
published.forEach(i=>{const btn=document.getElementById('btn'+i);if(btn){btn.textContent='✅ 已发布';btn.classList.add('done')}});
</script></body></html>`;
  fs.writeFileSync(path.join(jobDir,'preview.html'),html,'utf8');
}

// ============================================================
const INDEX=`<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X 内容工厂</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#fff;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
.c{max-width:680px;margin:0 auto;padding:60px 20px}
.hero{text-align:center;margin-bottom:40px}
.hero h1{font-size:32px;font-weight:800;color:#000}
.hero p{color:#999;font-size:15px;margin-top:6px}
.box{border:1.5px solid #e5e5e5;border-radius:14px;padding:28px;margin-bottom:16px}
.box h2{font-size:15px;font-weight:700;margin-bottom:4px;color:#000}
.box .dsc{color:#999;font-size:12px;margin-bottom:14px}
.inp{width:100%;padding:12px 14px;border:1.5px solid #ddd;border-radius:8px;font-size:14px;outline:none;margin-bottom:10px;transition:border .2s}
.inp:focus{border-color:#000}
.btn{width:100%;padding:14px;border-radius:10px;border:none;font-size:16px;font-weight:700;cursor:pointer;transition:all .2s}
.btn-go{background:#000;color:#fff}.btn-go:hover{background:#333}
.btn-go:disabled{opacity:.3}
.result{border:1.5px solid #e5e5e5;border-radius:14px;padding:28px;margin-top:16px;display:none}
.result.show{display:block}
.result h3{font-size:16px;margin-bottom:14px}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px}
.st{border:1.5px solid #eee;border-radius:10px;padding:14px 18px;text-align:center;min-width:80px}
.st .n{font-size:24px;font-weight:800;color:#000}
.st .l{font-size:11px;color:#999;margin-top:2px}
.btns{display:flex;gap:8px;flex-wrap:wrap}
.btns a{background:#000;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600}
.btns a.png{background:#fff;color:#000;border:1.5px solid #000}
.log{border:1.5px solid #eee;border-radius:10px;padding:14px;margin-top:14px;max-height:260px;overflow-y:auto;font-family:monospace;font-size:12px;display:none}
.log.show{display:block}
.log .ln{margin:2px 0;color:#999}.log .ok{color:#000}.log .err{color:#c00}.log .info{color:#666}
.range-wrap{margin:10px 0}.range-wrap label{font-size:12px;color:#999;display:flex;justify-content:space-between}
.range-wrap input[type=range]{width:100%;margin-top:4px}
.note{background:#f9f9f9;border:1px solid #eee;border-radius:8px;padding:10px 14px;font-size:11px;color:#999;margin-top:10px}
details summary{color:#999;font-size:12px;cursor:pointer}
details div{background:#f9f9f9;padding:10px;border-radius:6px;margin-top:6px;font-size:11px;color:#666;line-height:1.7}
.analysis{border:1.5px solid #e5e5e5;border-radius:14px;padding:24px;margin-top:14px}
.analysis h4{font-size:14px;font-weight:700;color:#000;margin-bottom:14px}
.an-row{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
.an-stat{background:#f7f7f7;border-radius:8px;padding:10px 16px;text-align:center;min-width:70px}
.an-stat .v{font-size:20px;font-weight:800;color:#000}
.an-stat .k{font-size:10px;color:#999;margin-top:2px}
.an-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.an-tag{background:#f0f0f0;border-radius:20px;padding:3px 10px;font-size:12px;color:#555}
.an-tag span{color:#000;font-weight:700;margin-left:4px}
.an-tone{font-size:13px;color:#555;margin-bottom:12px}
.an-qrow{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.an-qw{background:#000;color:#fff;border-radius:20px;padding:3px 10px;font-size:12px}
.an-best{background:#f9f9f9;border-radius:8px;padding:10px 14px;font-size:12px;color:#333;line-height:1.5}
.an-best .bv{color:#999;font-size:11px;margin-top:3px}
</style></head><body><div class="c">
<div style="text-align:right;margin-bottom:-30px"><button class="btn" style="width:auto;padding:6px 14px;background:#f0f0f0;color:#333;font-size:11px;border:1px solid #ddd" onclick="toggleLang()" id="langBtn">EN</button></div>
<div class="hero"><h1 data-i18n="title">X 内容工厂</h1><p data-i18n="subtitle">输入链接 → 自动抓取 → 配图下载</p></div>
<div style="display:flex;gap:8px;justify-content:center;margin-bottom:20px">
  <button class="btn" style="width:auto;padding:10px 24px;background:#000;color:#fff;font-size:13px" onclick="showTab('batch')" data-i18n="tabBatch">📋 批量抓取</button>
  <button class="btn" style="width:auto;padding:10px 24px;background:#fff;color:#000;border:1.5px solid #000;font-size:13px" onclick="showTab('media')" data-i18n="tabMedia">🎬 媒体搬运</button>
  <button class="btn" style="width:auto;padding:10px 24px;background:#fff;color:#000;border:1.5px solid #000;font-size:13px" onclick="showTab('monitor')" data-i18n="tabMonitor">📡 监控</button>
</div>
<div id="tab-batch">
<div class="box">
  <h2 data-i18n="lblUrl">🔗 X 博主链接</h2>
  <input class="inp" id="url" data-ph="phUrl" placeholder="https://x.com/博主用户名">
  <h2 style="margin-top:14px" data-i18n="lblToken">🔐 Auth Token</h2>
  <p class="dsc" data-i18n="lblTokenDesc">不知道 token 是什么？→ <a href="/get-token" target="_blank" style="color:#1d9bf0;font-weight:700">点这里获取</a></p>
  <div style="display:flex;gap:8px;margin-bottom:10px">
    <input class="inp" id="token" data-ph="phToken" placeholder="粘贴 auth_token" style="flex:1;margin-bottom:0">
    <button class="btn" style="width:auto;padding:12px 14px;background:#1d9bf0;color:#fff;font-size:13px;white-space:nowrap" onclick="window.open('https://x.com','_blank');alert('登录后按 F12 → Application → Cookies → x.com → 找到 auth_token → 双击复制')">🔐 获取Token</button>
    <button class="btn" style="width:auto;padding:12px 14px;background:#333;color:#fff;font-size:13px;white-space:nowrap" onclick="pasteToken('token',this)">📋 粘贴</button>
  </div>
  <details><summary data-i18n="howTo">📖 怎么获取？</summary>
  <div data-i18n="howToDetail">1. 打开 x.com 并登录<br>2. ⌘+Option+I → Application → Cookies → x.com<br>3. 找到 auth_token → 双击 Value 复制</div></details>
  <div class="range-wrap"><label><span data-i18n="lblCount">数量</span><span id="cnt">30</span></label><input type="range" id="count" min="10" max="100" value="30" oninput="document.getElementById('cnt').textContent=this.value"></div>
  <button class="btn btn-go" id="goBtn" onclick="run()" data-i18n="btnRun">🚀 开始抓取</button>
  <div class="note" data-i18n="note">仅用于访问公开帖子，不会存储</div>
</div>
<div class="result" id="result"></div><div class="log" id="log"></div></div>
<div id="tab-media" style="display:none">
<div class="box">
  <h2 data-i18n="mediaTitle">🎬 媒体搬运</h2>
  <p class="dsc" data-i18n="mediaDesc">输入单条帖子链接，提取文案、图片/视频、优质评论</p>
  <input class="inp" id="murl" data-ph="phMediaUrl" placeholder="https://x.com/用户名/status/帖子ID">
  <h2 style="margin-top:14px" data-i18n="lblToken2">🔐 Auth Token</h2>
  <div style="display:flex;gap:8px;margin-bottom:10px">
    <input class="inp" id="mtoken" data-ph="phToken" placeholder="粘贴 auth_token" style="flex:1;margin-bottom:0">
    <button class="btn" style="width:auto;padding:12px 14px;background:#1d9bf0;color:#fff;font-size:13px;white-space:nowrap" onclick="window.open('https://x.com','_blank');alert('登录后按 F12 → Application → Cookies → x.com → 找到 auth_token → 双击复制')">🔐 获取Token</button>
    <button class="btn" style="width:auto;padding:12px 14px;background:#333;color:#fff;font-size:13px;white-space:nowrap" onclick="pasteToken('mtoken',this)">📋 粘贴</button>
  </div>
  <button class="btn btn-go" id="mBtn" onclick="runMedia()" data-i18n="btnMedia">🎬 开始搬运</button>
</div>
<div class="result" id="mresult"></div><div class="log" id="mlog"></div></div>
<div id="tab-monitor" style="display:none">
<div class="box">
  <h2 data-i18n="monTitle">📡 博主监控</h2>
  <p class="dsc" data-i18n="monDesc">输入博主列表（每行一个用户名），自动监控新帖并存档</p>
  <textarea class="inp" id="monList" rows="5" style="resize:vertical" data-ph="phMon" placeholder="每行一个用户名，如：&#10;m4ilboq&#10;wtffrio&#10;pastloverwarm_"></textarea>
  <h2 style="margin-top:14px" data-i18n="lblToken3">🔐 Auth Token</h2>
  <div style="display:flex;gap:8px;margin-bottom:10px">
    <input class="inp" id="monToken" data-ph="phToken" placeholder="粘贴 auth_token" style="flex:1;margin-bottom:0">
    <button class="btn" style="width:auto;padding:12px 14px;background:#1d9bf0;color:#fff;font-size:13px;white-space:nowrap" onclick="window.open('https://x.com','_blank');alert('登录后按 F12 → Application → Cookies → x.com → 找到 auth_token → 双击复制')">🔐 获取Token</button>
    <button class="btn" style="width:auto;padding:12px 14px;background:#333;color:#fff;font-size:13px;white-space:nowrap" onclick="pasteToken('monToken',this)">📋 粘贴</button>
  </div>
  <div style="display:flex;gap:10px;margin:10px 0;align-items:center">
    <span style="font-size:12px;color:#666" data-i18n="monFreq">监控频率：</span>
    <select id="monFreq" style="padding:6px 12px;border-radius:6px;border:1.5px solid #ddd;font-size:13px">
      <option value="60">每小时</option><option value="180">每3小时</option><option value="360">每6小时</option><option value="720">每12小时</option><option value="1440">每天</option>
    </select>
  </div>
  <button class="btn btn-go" id="monBtn" onclick="saveMonitor()">💾 保存监控</button>
  <button class="btn" style="margin-top:8px;background:#fff;color:#000;border:1.5px solid #000" onclick="runMonitorNow()">▶️ 立即执行一次</button>
</div>
<div class="result" id="monresult"></div><div class="log" id="monlog"></div></div></div>
<script>
const i18n={
  zh:{title:'X 内容工厂',subtitle:'输入链接 → 自动抓取 → 配图下载',tabBatch:'📋 批量抓取',tabMedia:'🎬 媒体搬运',lblUrl:'🔗 X 博主链接',phUrl:'https://x.com/博主用户名',lblToken:'🔐 Auth Token',lblToken2:'🔐 Auth Token',lblTokenDesc:'从 Chrome DevTools 复制',phToken:'粘贴 auth_token',howTo:'📖 怎么获取？',howToDetail:'1. 打开 x.com 并登录<br>2. ⌘+Option+I → Application → Cookies → x.com<br>3. 找到 auth_token → 双击 Value 复制',lblCount:'数量',btnRun:'🚀 开始抓取',note:'仅用于访问公开帖子，不会存储',mediaTitle:'🎬 媒体搬运',mediaDesc:'输入单条帖子链接，提取文案、图片/视频、优质评论',phMediaUrl:'https://x.com/用户名/status/帖子ID',btnMedia:'🎬 开始搬运'},
  en:{title:'X Content Factory',subtitle:'Paste link → Auto scrape → Download cards',tabBatch:'📋 Batch Scrape',tabMedia:'🎬 Media Extract',lblUrl:'🔗 X Profile URL',phUrl:'https://x.com/username',lblToken:'🔐 Auth Token',lblToken2:'🔐 Auth Token',lblTokenDesc:'Copy from Chrome DevTools',phToken:'Paste auth_token',howTo:'📖 How to get it?',howToDetail:'1. Open x.com and log in<br>2. ⌘+Option+I → Application → Cookies → x.com<br>3. Find auth_token → double-click Value to copy',lblCount:'Count',btnRun:'🚀 Start Scraping',note:'Only accesses public posts. Nothing is stored.',mediaTitle:'🎬 Media Extract',mediaDesc:'Paste a single post URL to extract text, images/video, and top comments',phMediaUrl:'https://x.com/username/status/postID',btnMedia:'🎬 Start Extracting'}
};
let curLang='zh';
function toggleLang(){
  curLang=curLang==='zh'?'en':'zh';
  document.getElementById('langBtn').textContent=curLang==='zh'?'EN':'中文';
  const t=i18n[curLang];
  document.querySelectorAll('[data-i18n]').forEach(el=>{const k=el.getAttribute('data-i18n');if(t[k])el.innerHTML=t[k];});
  document.querySelectorAll('[data-ph]').forEach(el=>{const k=el.getAttribute('data-ph');if(t[k])el.placeholder=t[k];});
}
const L=document.getElementById('log'),R=document.getElementById('result'),B=document.getElementById('goBtn');
function A(m,c=''){L.classList.add('show');const d=document.createElement('div');d.className='ln'+(c?' '+c:'');d.textContent='['+new Date().toLocaleTimeString()+'] '+m;L.appendChild(d);L.scrollTop=L.scrollHeight}
function fmt(n){return n>=10000?Math.round(n/10000)+'万':n>=1000?Math.round(n/1000)+'k':n}
function renderAnalysis(a){
  if(!a)return '';
  const tags=a.topTags.map(x=>'<span class="an-tag">'+x.t+'<span>'+x.n+'</span></span>').join('');
  const qs=a.topQ.map(x=>'<span class="an-qw">'+x.w+' ×'+x.c+'</span>').join('');
  const best=a.bestPost?'<div class="an-best">🏆 最热帖子：'+a.bestPost.q+'<div class="bv">👁 '+fmt(a.bestPost.views)+' 次浏览</div></div>':'';
  return '<div class="analysis"><h4>📊 博主内容风格分析</h4>'+
    '<div class="an-row">'+
    '<div class="an-stat"><div class="v">'+fmt(a.avgViews)+'</div><div class="k">均次浏览</div></div>'+
    '<div class="an-stat"><div class="v">'+a.avgReposts+'</div><div class="k">均次转发</div></div>'+
    '<div class="an-stat"><div class="v">'+a.avgLikes+'</div><div class="k">均次点赞</div></div>'+
    '</div>'+
    '<div style="font-size:11px;color:#999;margin-bottom:6px">话题分布</div><div class="an-tags">'+tags+'</div>'+
    '<div style="font-size:11px;color:#999;margin-bottom:6px">高频提问词</div><div class="an-qrow">'+qs+'</div>'+
    '<div class="an-tone">🎨 内容调性：<strong>'+a.tone+'</strong></div>'+
    best+'</div>';
}
async function run(){
  const u=document.getElementById('url').value.trim(),t=document.getElementById('token').value.trim(),n=document.getElementById('count').value;
  if(!u||!t)return alert('请填写链接和 auth_token');
  B.disabled=true;B.textContent='⏳ 抓取中...';R.classList.remove('show');L.innerHTML='';A('开始...','info');
  try{
    const r=await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:u,token:t,count:parseInt(n)})});
    let d;
    try{d=await r.json()}catch(e){A('服务器返回异常，请稍后重试','err');B.disabled=false;B.textContent='🚀 开始抓取';return}
    if(d.error){A(d.error,'err');B.disabled=false;B.textContent='🚀 开始抓取';return}
    A('完成: '+d.questions+' 条帖, '+d.images+' 张图','ok');
    R.innerHTML='<h3>✅ 完成</h3><div class="stats"><div class="st"><div class="n">@'+d.handle+'</div><div class="l">博主</div></div><div class="st"><div class="n">'+d.questions+'</div><div class="l">提问帖</div></div><div class="st"><div class="n">'+d.images+'</div><div class="l">配图PNG</div></div></div><div class="btns"><a href="/output/'+d.handle+'/preview.html" target="_blank">🔗 查看素材</a><a class="png" href="/output/'+d.handle+'/cards.html" target="_blank">🎨 纯卡片</a></div>'+renderAnalysis(d.analysis);
    R.classList.add('show');
  }catch(e){A(e.message,'err')}
  B.disabled=false;B.textContent='🚀 开始抓取';
}
function showTab(t){
  document.getElementById('tab-batch').style.display=t==='batch'?'':'none';
  document.getElementById('tab-media').style.display=t==='media'?'':'none';
  document.getElementById('tab-monitor').style.display=t==='monitor'?'':'none';
}
async function saveMonitor(){
  const list=document.getElementById('monList').value.trim(),token=document.getElementById('monToken').value.trim(),freq=document.getElementById('monFreq').value;
  if(!list||!token)return alert('请填写博主列表和 auth_token');
  const handles=list.split('\\n').map(x=>x.trim().replace('@','')).filter(Boolean);
  const r=await fetch('/api/monitor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handles,token,freq:parseInt(freq)})});
  const d=await r.json();
  const MR=document.getElementById('monresult');
  MR.innerHTML='<h3>'+(d.error?'❌ '+d.error:'✅ 已保存 '+d.count+' 个博主监控（每'+freq+'分钟检查）')+'</h3>';
  MR.classList.add('show');
}
async function runMonitorNow(){
  const token=document.getElementById('monToken').value.trim();
  if(!token)return alert('请填写 auth_token');
  const MB=document.getElementById('monBtn'),MR=document.getElementById('monresult');
  MB.disabled=true;MB.textContent='⏳ 执行中...';
  const r=await fetch('/api/monitor/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
  const d=await r.json();
  MR.innerHTML='<h3>'+(d.error?'❌ '+d.error:'✅ 监控完成：'+d.updated+' 个博主有新内容')+'</h3>';
  MR.classList.add('show');MB.disabled=false;MB.textContent='💾 保存监控';
}
async function runMedia(){
  const u=document.getElementById('murl').value.trim(),t=document.getElementById('mtoken').value.trim();
  const MB=document.getElementById('mBtn'),ML=document.getElementById('mlog'),MR=document.getElementById('mresult');
  if(!u||!t)return alert('请填写帖子链接和 auth_token');
  MB.disabled=true;MB.textContent='⏳ 搬运中...';MR.classList.remove('show');ML.innerHTML='';
  ML.classList.add('show');
  function MA(m,c=''){const d=document.createElement('div');d.className='ln'+(c?' '+c:'');d.textContent='['+new Date().toLocaleTimeString()+'] '+m;ML.appendChild(d);ML.scrollTop=ML.scrollHeight}
  MA('开始搬运...','info');
  try{
    const r=await fetch('/api/media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:u,token:t})});
    let d;
    try{d=await r.json()}catch(e){MA('服务器返回异常','err');MB.disabled=false;MB.textContent='🎬 开始搬运';return}
    if(d.error){MA(d.error,'err');MB.disabled=false;MB.textContent='🎬 开始搬运';return}
    MA('完成: '+d.images+' 张图'+(d.video?' + 视频':'')+' + '+d.comments+' 条优质评论','ok');
    let html='<h3>✅ 搬运完成</h3>';
    html+='<div style="background:#f9f9f9;border-radius:8px;padding:12px;margin:10px 0;font-size:13px;line-height:1.6"><strong>原文：</strong><br>'+d.text.substring(0,300)+(d.text.length>300?'…':'')+'</div>';
    
    // 图片预览
    if(d.images>0&&d.imagePaths){
      html+='<h4 style="margin:16px 0 8px 0;font-size:15px">📸 图片 ('+d.images+')</h4>';
      html+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px">';
      d.imagePaths.forEach((p,i)=>{
        const url='/output/_media/'+d.handle+'_'+d.tweetId+'/'+p;
        const ext=p.split('.').pop();
        html+='<div style="position:relative;border:1px solid #ddd;border-radius:6px;overflow:hidden;background:#fff">';
        html+='<img src="'+url+'" style="width:100%;height:auto;display:block" loading="lazy">';
        html+='<button onclick="downloadFile(&quot;'+url+'&quot;,'+(i+1)+',&quot;'+ext+'&quot;)" style="position:absolute;bottom:6px;right:6px;padding:5px 10px;background:rgba(0,0,0,0.75);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:700">⬇️ 下载</button>';
        html+='</div>';
      });
      html+='</div>';
    }
    
    // 视频预览
    if(d.video&&d.videoPath){
      html+='<h4 style="margin:16px 0 8px 0;font-size:15px">🎬 视频</h4>';
      const vurl='/output/_media/'+d.handle+'_'+d.tweetId+'/'+d.videoPath;
      const ext=d.videoPath.split('.').pop();
      html+='<div style="position:relative;border:1px solid #ddd;border-radius:6px;overflow:hidden;background:#000;max-width:500px">';
      html+='<video src="'+vurl+'" controls style="width:100%;display:block"></video>';
      html+='<button onclick="downloadFile(&quot;'+vurl+'&quot;,1,&quot;'+ext+'&quot;)" style="position:absolute;bottom:12px;right:12px;padding:6px 14px;background:rgba(0,0,0,0.8);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:700">⬇️ 下载视频</button>';
      html+='</div>';
    }
    
    // 评论
    if(d.commentTexts&&d.commentTexts.length){
      html+='<h4 style="margin:16px 0 8px 0;font-size:15px">💬 优质评论 ('+d.comments+')</h4>';
      html+='<div style="background:#f0f7ff;border-radius:6px;padding:10px;font-size:12px;color:#666;line-height:1.8">'+d.commentTexts.map((c,i)=>(i+1)+'. '+c).join('<br>')+'</div>';
    }
    
    // 表格记录
    html+='<h4 style="margin:20px 0 10px 0;font-size:15px">📋 表格记录（可直接复制）</h4>';
    html+='<table id="recordTable" style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:1px solid #ddd"><thead><tr style="background:#f5f5f5">';
    html+='<th style="border:1px solid #ddd;padding:8px;text-align:left">X原文链接</th>';
    html+='<th style="border:1px solid #ddd;padding:8px;text-align:left">帖子类别</th>';
    html+='<th style="border:1px solid #ddd;padding:8px;text-align:left">中文翻译正文</th>';
    html+='<th style="border:1px solid #ddd;padding:8px;text-align:left">原文</th>';
    html+='<th style="border:1px solid #ddd;padding:8px;text-align:left">中文Tag</th>';
    html+='<th style="border:1px solid #ddd;padding:8px;text-align:left">原文Tag</th>';
    html+='<th style="border:1px solid #ddd;padding:8px;text-align:left">媒体内容</th>';
    html+='<th style="border:1px solid #ddd;padding:8px;text-align:left">媒体类型</th>';
    html+='</tr></thead><tbody><tr>';
    html+='<td style="border:1px solid #ddd;padding:8px"><a href="'+d.postUrl+'" target="_blank" style="color:#1d9bf0">'+d.postUrl+'</a></td>';
    html+='<td style="border:1px solid #ddd;padding:8px">'+d.category+'</td>';
    html+='<td style="border:1px solid #ddd;padding:8px">'+d.cnText+'</td>';
    html+='<td style="border:1px solid #ddd;padding:8px">'+d.text.substring(0,100)+(d.text.length>100?'...':'')+'</td>';
    html+='<td style="border:1px solid #ddd;padding:8px">'+d.cnTags+'</td>';
    html+='<td style="border:1px solid #ddd;padding:8px">'+d.origTags+'</td>';
    html+='<td style="border:1px solid #ddd;padding:8px">'+d.images+' 张图片'+(d.video?' + 1 视频':'')+'</td>';
    html+='<td style="border:1px solid #ddd;padding:8px">'+d.mediaType+'</td>';
    html+='</tr></tbody></table>';
    html+='<button onclick="copyTableToClipboard()" style="margin-top:10px;padding:8px 16px;background:#00ba7c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">📋 复制表格</button>';
    
    MR.innerHTML=html;MR.classList.add('show');
  }catch(e){MA(e.message,'err')}
  MB.disabled=false;MB.textContent='🎬 开始搬运';
}
async function pasteToken(inputId,btn){
  try{
    const text=await navigator.clipboard.readText();
    if(text&&text.length>10){document.getElementById(inputId).value=text;btn.textContent='✅';btn.style.background='#00ba7c';setTimeout(()=>{btn.textContent='📋 粘贴';btn.style.background='#333'},2000)}
    else{alert('剪贴板中没有检测到 token，请先在 X 页面复制 auth_token')}
  }catch(e){alert('读取剪贴板失败（需要 HTTPS），请手动粘贴: '+e.message)}
}
let downloadCounter=0;
function downloadFile(url,index,ext){
  const today=new Date().toISOString().slice(0,10).replace(/-/g,'');
  downloadCounter++;
  const filename=today+'_'+String(downloadCounter).padStart(2,'0')+'.'+ext;
  const a=document.createElement('a');
  a.href=url;
  a.download=filename;
  a.click();
}
function copyTableToClipboard(){
  const table=document.getElementById('recordTable');
  if(!table)return alert('表格未找到');
  const range=document.createRange();
  range.selectNode(table);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  try{
    document.execCommand('copy');
    alert('✅ 表格已复制到剪贴板，直接粘贴到 Excel/Sheets 即可');
  }catch(e){
    alert('复制失败: '+e.message);
  }
  window.getSelection().removeAllRanges();
}
</script></body></html>`;

// ============================================================
// 媒体搬运模块
// ============================================================
async function scrapePost(postUrl,token){
  const b=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--disable-dev-shm-usage','--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36']});
  const p=await b.newPage();await p.setViewport({width:1280,height:900});
  await p.goto('https://x.com',{waitUntil:'domcontentloaded',timeout:15000});
  await p.evaluate(t=>{document.cookie=`auth_token=${t}; domain=.x.com; path=/; secure`;},token);
  await new Promise(r=>setTimeout(r,1000));
  await p.goto(postUrl,{waitUntil:'domcontentloaded',timeout:60000});
  
  // 等待主推文加载（增加重试）
  let tweetFound=false;
  for(let i=0;i<3;i++){
    try{
      await p.waitForSelector('[data-testid="tweet"]',{timeout:10000});
      tweetFound=true;
      break;
    }catch(e){
      if(i<2){await new Promise(r=>setTimeout(r,3000));await p.reload({waitUntil:'domcontentloaded'});}
    }
  }
  if(!tweetFound)throw new Error('无法加载推文，请检查链接或 token 是否有效');
  await new Promise(r=>setTimeout(r,2000));

  // 提取主帖内容
  const post=await p.evaluate(()=>{
    const tweet=document.querySelector('article[data-testid="tweet"]');
    if(!tweet)return null;
    const text=tweet.querySelector('[data-testid="tweetText"]')?.innerText||'';
    const time=tweet.querySelector('time')?.getAttribute('datetime')||'';
    const aria=tweet.querySelector('[role="group"]')?.getAttribute('aria-label')||'';
    // 图片
    const imgs=[...tweet.querySelectorAll('img[src*="pbs.twimg.com/media"]')].map(i=>{
      let src=i.src;if(src.includes('name='))src=src.replace(/name=\w+/,'name=orig');else src+='?name=orig';
      return src;
    });
    // 视频检测
    const hasVideo=!!tweet.querySelector('video')||!!tweet.querySelector('[data-testid="videoPlayer"]');
    // 用户信息
    const handle=tweet.querySelector('a[href*="/status/"]')?.closest('article')?.querySelector('a[role="link"][href^="/"]')?.getAttribute('href')?.replace('/','') ||'';
    return{text,time,aria,imgs,hasVideo,handle};
  });

  // 抓取评论（前20条热门）
  await p.evaluate(()=>window.scrollBy(0,1500));
  await new Promise(r=>setTimeout(r,2000));
  const comments=await p.evaluate(()=>{
    const tweets=[...document.querySelectorAll('article[data-testid="tweet"]')];
    return tweets.slice(1,21).map(t=>{
      const text=t.querySelector('[data-testid="tweetText"]')?.innerText||'';
      const aria=t.querySelector('[role="group"]')?.getAttribute('aria-label')||'';
      const links=t.querySelectorAll('a[role="link"][href^="/"]');
      let handle='';links.forEach(l=>{const h=l.getAttribute('href');if(h&&!h.includes('/status/')&&h.startsWith('/'))handle=h.replace('/','');});
      const likes=parseInt(((aria.match(/(\d[\d,]*)\s*like/)||['','0'])[1]).replace(/,/g,''))||0;
      return{handle,text:text.substring(0,300),likes};
    }).filter(c=>c.text.length>5).sort((a,b)=>b.likes-a.likes);
  });

  await b.close();
  return{post,comments};
}

async function downloadMedia(postUrl,token,jobDir){
  const mediaDir=path.join(jobDir,'media');fs.existsSync(mediaDir)||fs.mkdirSync(mediaDir,{recursive:true});
  const{post,comments}=await scrapePost(postUrl,token);
  if(!post)throw new Error('无法读取帖子内容');

  // 下载图片
  const downloadedImgs=[];
  for(let i=0;i<post.imgs.length;i++){
    const imgUrl=post.imgs[i];
    const ext=imgUrl.includes('format=png')?'png':'jpg';
    const fname=`img_${String(i+1).padStart(2,'0')}.${ext}`;
    try{
      const{execSync}=require('child_process');
      execSync(`curl -sL "${imgUrl}" -o "${path.join(mediaDir,fname)}"`,{timeout:30000});
      downloadedImgs.push(fname);
    }catch(e){/* skip */}
  }

  // 下载视频（用 yt-dlp）
  let videoFile=null;
  if(post.hasVideo){
    try{
      const{execSync}=require('child_process');
      const cookieFile=path.join(jobDir,'.cookies.txt');
      fs.writeFileSync(cookieFile,`# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tTRUE\t0\tauth_token\t${token}\n`);
      execSync(`yt-dlp --cookies "${cookieFile}" -f "best[ext=mp4]/best" -o "${path.join(mediaDir,'video.mp4')}" "${postUrl}" 2>/dev/null`,{timeout:120000});
      if(fs.existsSync(path.join(mediaDir,'video.mp4')))videoFile='video.mp4';
      try{fs.unlinkSync(cookieFile)}catch(e){}
    }catch(e){/* video download failed, continue */}
  }

  // 筛选优质评论（top 10 by likes）
  const topComments=comments.slice(0,10);

  return{post,topComments,downloadedImgs,videoFile};
}

// ============================================================
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
  if(u.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(INDEX);return}
  if(u.pathname==='/get-token'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(__dirname,'get-token.html')));return}
  if(u.pathname==='/get-token-en'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(__dirname,'get-token-en.html')));return}
  if(u.pathname==='/api/run'&&req.method==='POST'){
    let body='';req.on('data',c=>body+=c);req.on('end',async()=>{
      try{
        const{url,token,count}=JSON.parse(body),m=url.match(/x\.com\/(\w+)/);
        if(!m)return res.end(JSON.stringify({error:'无效链接'}));
        const handle=m[1],jobDir=path.join(OUTPUT,handle);
        fs.existsSync(jobDir)||fs.mkdirSync(jobDir,{recursive:true});
        const data=await Promise.race([scrapeX(url,token,count||30),new Promise((_,rj)=>setTimeout(()=>rj(new Error('超时90秒')),90000))]);
        fs.writeFileSync(path.join(jobDir,'posts.json'),JSON.stringify(data.posts,null,2));
        // 应用已有翻译
        const tf=path.join(jobDir,'translations.json');
        if(fs.existsSync(tf)){const tmap=JSON.parse(fs.readFileSync(tf,'utf8'));data.posts.forEach(p=>{const q=p.q;let best='',bk='';for(const[k,v]of Object.entries(tmap)){if(q.startsWith(k.substring(0,Math.min(40,k.length)))&&k.length>bk.length){bk=k;best=v}}if(best)p.cn=best})}
        await translatePosts(data.posts);
        // 保存翻译缓存 + 更新 posts.json
        const tmap2={};data.posts.forEach(p=>{if(p.cn&&p.cn.length>5)tmap2[p.q.substring(0,40)]=p.cn});
        fs.writeFileSync(path.join(jobDir,'translations.json'),JSON.stringify({...(fs.existsSync(tf)?JSON.parse(fs.readFileSync(tf,'utf8')):{}),...tmap2},null,2));
        fs.writeFileSync(path.join(jobDir,'posts.json'),JSON.stringify(data.posts,null,2));
        genCards(jobDir,data.posts);const imgCount=await screenshotCards(jobDir);
        genPreview(jobDir,handle,data.posts);
        const analysis=analyzeStyle(data.posts);
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({handle,questions:data.posts.length,images:imgCount,analysis}));
      }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}))}
    });return;
  }
  if(u.pathname==='/api/media'&&req.method==='POST'){
    let body='';req.on('data',c=>body+=c);req.on('end',async()=>{
      try{
        const{url,token}=JSON.parse(body);
        if(!url||!token)return res.end(JSON.stringify({error:'需要 url 和 token'}));
        const sm=url.match(/x\.com\/(\w+)\/status\/(\d+)/);
        if(!sm)return res.end(JSON.stringify({error:'请输入单条帖子链接 (含/status/)'}));
        const handle=sm[1],tweetId=sm[2];
        const jobDir=path.join(OUTPUT,'_media',`${handle}_${tweetId}`);
        fs.existsSync(jobDir)||fs.mkdirSync(jobDir,{recursive:true});
        const result=await Promise.race([downloadMedia(url,token,jobDir),new Promise((_,rj)=>setTimeout(()=>rj(new Error('超时120秒')),120000))]);
        // 保存结果
        fs.writeFileSync(path.join(jobDir,'data.json'),JSON.stringify(result,null,2));
        
        // 翻译（可选，不阻塞响应）
        const cnText=result.post.text; // 默认显示原文
        translateText(result.post.text).then(t=>{
          if(t&&t.length>5){
            // 异步更新翻译结果到文件
            try{
              const dataFile=path.join(jobDir,'data.json');
              const data=JSON.parse(fs.readFileSync(dataFile,'utf8'));
              data.post.cnText=t;
              fs.writeFileSync(dataFile,JSON.stringify(data,null,2));
            }catch(e){}
          }
        }).catch(()=>{});
        
        // 分类
        const text=result.post.text.toLowerCase();
        let category='General';
        if(text.match(/celebrity|star|famous|idol|演员|明星|นักแสดง|artis/i))category='Celebrity';
        else if(text.match(/love|relationship|boyfriend|girlfriend|couple|แฟน|ความรัก|pacar|cinta/i))category='Relationship';
        else if(text.match(/meme|funny|lol|joke|ตลก|lucu|meme/i))category='MEME';
        else if(text.match(/news|breaking|report|ข่าว|berita/i))category='News';
        else if(text.match(/food|recipe|eat|อาหาร|makanan/i))category='Food';
        else if(text.match(/travel|trip|vacation|ท่องเที่ยว|wisata/i))category='Travel';
        
        // 生成tag
        const cnTags=['#'+category];
        const origTags=result.post.text.match(/#[\w\u0E00-\u0E7F]+/g)||[];
        if(category==='Relationship')cnTags.push('#情感');
        if(category==='MEME')cnTags.push('#搞笑');
        if(category==='Food')cnTags.push('#美食');
        
        const responseData={
          handle,tweetId,
          text:result.post.text,
          cnText,
          category,
          cnTags:cnTags.join(' '),
          origTags:origTags.slice(0,5).join(' ')||'#'+category,
          cn:result.post.text?'':'',
          images:result.downloadedImgs.length,
          imagePaths:result.downloadedImgs.map(f=>path.basename(f)),
          video:!!result.videoFile,
          videoPath:result.videoFile?path.basename(result.videoFile):'',
          mediaType:result.videoFile?'视频':'图片',
          comments:result.topComments.length,
          commentTexts:result.topComments.slice(0,3).map(c=>c.text),
          topComments:result.topComments.slice(0,3),
          outputDir:path.join(OUTPUT,'_media',`${handle}_${tweetId}`),
          zipUrl:`/api/zip/_media/${handle}_${tweetId}`,
          postUrl:`https://x.com/${handle}/status/${tweetId}`
        };
        
        // 异步上传到飞书（不阻塞响应）
        uploadToFeishu(responseData).then(r=>{
          if(r.success)console.log('✅ 已同步到飞书，记录ID:',r.record_id);
          else console.error('⚠️  飞书同步失败:',r.error);
        }).catch(e=>console.error('⚠️  飞书同步异常:',e.message));
        
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(responseData));
      }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}))}
    });return;
  }
  // 监控 API
  if(u.pathname==='/api/monitor'&&req.method==='POST'){
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      try{
        const{handles,token,freq}=JSON.parse(body);
        if(!handles||!handles.length||!token)return res.end(JSON.stringify({error:'需要 handles 和 token'}));
        const configPath=path.join(OUTPUT,'_monitor.json');
        const config={handles,token,freq:freq||60,lastRun:0};
        fs.writeFileSync(configPath,JSON.stringify(config,null,2));
        // 启动/重启定时器
        startMonitorTimer(config);
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,count:handles.length}));
      }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}))}
    });return;
  }
  if(u.pathname==='/api/monitor/run'&&req.method==='POST'){
    let body='';req.on('data',c=>body+=c);req.on('end',async()=>{
      try{
        const{token}=JSON.parse(body);
        const configPath=path.join(OUTPUT,'_monitor.json');
        if(!fs.existsSync(configPath))return res.end(JSON.stringify({error:'未设置监控列表'}));
        const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
        const t=token||config.token;
        let updated=0;
        for(const handle of config.handles){
          try{
            const data=await scrapeX(`https://x.com/${handle}`,t,10);
            const jobDir=path.join(OUTPUT,handle);fs.existsSync(jobDir)||fs.mkdirSync(jobDir,{recursive:true});
            // 检查是否有新帖
            const oldPath=path.join(jobDir,'posts.json');
            const oldPosts=fs.existsSync(oldPath)?JSON.parse(fs.readFileSync(oldPath,'utf8')):[];
            const oldTexts=new Set(oldPosts.map(p=>p.q.substring(0,50)));
            const newPosts=data.posts.filter(p=>!oldTexts.has(p.q.substring(0,50)));
            if(newPosts.length>0){
              const allPosts=[...newPosts,...oldPosts].slice(0,50);
              await translatePosts(allPosts.filter(p=>!p.cn||p.cn.length<=20));
              fs.writeFileSync(oldPath,JSON.stringify(allPosts,null,2));
              genCards(jobDir,allPosts);await screenshotCards(jobDir);
              genPreview(jobDir,handle,allPosts);
              updated++;
            }
          }catch(e){/* skip failed handle */}
        }
        config.lastRun=Date.now();fs.writeFileSync(configPath,JSON.stringify(config,null,2));
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,updated}));
      }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}))}
    });return;
  }
  if(u.pathname==='/api/monitor'&&req.method==='GET'){
    const configPath=path.join(OUTPUT,'_monitor.json');
    if(fs.existsSync(configPath)){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(fs.readFileSync(configPath))}
    else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({handles:[],freq:60}))}
    return;
  }
  if(u.pathname.startsWith('/output/')){const f=path.join(OUTPUT,u.pathname.replace('/output/',''));if(fs.existsSync(f)){if(fs.statSync(f).isDirectory()){const files=fs.readdirSync(f).map(x=>`<li><a href="${u.pathname}${u.pathname.endsWith('/')?'':'/'}${x}">${x}</a></li>`).join('');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Files</title></head><body><h2>📁 ${u.pathname}</h2><ul>${files}</ul></body></html>`)}else{const m={'html':'text/html; charset=utf-8','png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','json':'application/json; charset=utf-8','mp4':'video/mp4','webm':'video/webm'};res.writeHead(200,{'Content-Type':m[path.extname(f).slice(1)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)}}else{res.writeHead(404);res.end()}return}
  if(u.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',time:new Date().toISOString()}));return}
  if(u.pathname.startsWith('/api/zip/')){const h=u.pathname.split('/')[3],jd=path.join(OUTPUT,h);if(!fs.existsSync(jd)){res.writeHead(404);res.end();return}const{execSync}=require('child_process'),zp=path.join(OUTPUT,h+'.zip');try{try{fs.unlinkSync(zp)}catch(e){}execSync(`cd "${OUTPUT}" && zip -rq "${h}.zip" "${h}" -x "*.js"`,{stdio:'ignore',timeout:30000});const stat=fs.statSync(zp);res.writeHead(200,{'Content-Type':'application/zip','Content-Length':stat.size,'Content-Disposition':`attachment; filename="${h}.zip"`});const stream=fs.createReadStream(zp);stream.pipe(res);stream.on('end',()=>{try{fs.unlinkSync(zp)}catch(e){}})}catch(e){res.writeHead(500);res.end('ZIP failed: '+e.message)}return}
  if(u.pathname.startsWith('/api/download/')){const f=path.join(OUTPUT,u.pathname.replace('/api/download/',''));if(fs.existsSync(f)){res.writeHead(200,{'Content-Type':'image/png','Content-Disposition':`attachment; filename="${path.basename(f)}"`});fs.createReadStream(f).pipe(res)}else{res.writeHead(404);res.end()}return}
  res.writeHead(404);res.end();
});

// 定时监控
let monitorInterval=null;
function startMonitorTimer(config){
  if(monitorInterval)clearInterval(monitorInterval);
  const ms=(config.freq||60)*60*1000;
  monitorInterval=setInterval(async()=>{
    try{
      const configPath=path.join(OUTPUT,'_monitor.json');
      if(!fs.existsSync(configPath))return;
      const cfg=JSON.parse(fs.readFileSync(configPath,'utf8'));
      for(const handle of cfg.handles){
        try{
          const data=await scrapeX(`https://x.com/${handle}`,cfg.token,10);
          const jobDir=path.join(OUTPUT,handle);fs.existsSync(jobDir)||fs.mkdirSync(jobDir,{recursive:true});
          const oldPath=path.join(jobDir,'posts.json');
          const oldPosts=fs.existsSync(oldPath)?JSON.parse(fs.readFileSync(oldPath,'utf8')):[];
          const oldTexts=new Set(oldPosts.map(p=>p.q.substring(0,50)));
          const newPosts=data.posts.filter(p=>!oldTexts.has(p.q.substring(0,50)));
          if(newPosts.length>0){
            const allPosts=[...newPosts,...oldPosts].slice(0,50);
            await translatePosts(allPosts.filter(p=>!p.cn||p.cn.length<=20));
            fs.writeFileSync(oldPath,JSON.stringify(allPosts,null,2));
            genCards(jobDir,allPosts);await screenshotCards(jobDir);
            genPreview(jobDir,handle,allPosts);
            console.log(`📡 ${handle}: +${newPosts.length} 条新帖`);
          }
        }catch(e){}
      }
      cfg.lastRun=Date.now();fs.writeFileSync(configPath,JSON.stringify(cfg,null,2));
    }catch(e){}
  },ms);
  console.log(`📡 监控已启动: ${config.handles.length} 个博主, 每${config.freq}分钟检查`);
}
// 启动时恢复已有监控
const monConfigPath=path.join(OUTPUT,'_monitor.json');
if(fs.existsSync(monConfigPath)){try{startMonitorTimer(JSON.parse(fs.readFileSync(monConfigPath,'utf8')))}catch(e){}}

server.listen(PORT,async()=>{console.log(`\n🏭 X内容工厂 → http://localhost:${PORT}\n`);try{const b=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});await b.close();console.log('✅ Puppeteer 就绪\n')}catch(e){console.log('⚠️ Puppeteer 预热失败(将在请求时重试):',e.message,'\n')}});
