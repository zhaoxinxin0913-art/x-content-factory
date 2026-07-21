const http=require('http'),fs=require('fs'),path=require('path'),puppeteer=require('puppeteer');
const PORT=process.env.PORT||5050,OUTPUT=path.join(__dirname,'output');
fs.existsSync(OUTPUT)||fs.mkdirSync(OUTPUT,{recursive:true});

// ============================================================
const STYLES=[{cls:'s1',css:'background:#fafafa',txt:'color:#333'},
{cls:'s2',css:'background:#0a0a0a',txt:'color:#ff6ec7;text-shadow:0 0 30px #ff6ec7'},
{cls:'s3',css:'background:linear-gradient(135deg,#e0c3fc,#8ec5fc)',txt:'color:#2d1b69'},
{cls:'s4',css:'background:linear-gradient(135deg,#a8edea,#fed6e3)',txt:'color:#2c3e50'},
{cls:'s5',css:'background:linear-gradient(135deg,#ff9a9e,#fecfef 50%,#a1c4fd)',txt:'color:#fff;text-shadow:0 2px 20px rgba(0,0,0,.3)'},
{cls:'s6',css:'background:#f4e4c1',txt:'color:#5d4037;font-style:italic'},
{cls:'s7',css:'background:#0f0f23',txt:'color:#00f2fe;text-shadow:0 0 40px rgba(0,242,254,.5)'}];
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
  const m={แฟน:'对象',โสด:'单身',ความรัก:'爱情',เลิก:'分手',จีบ:'追',งาน:'工作',ลาออก:'辞职',เพื่อนร่วมงาน:'同事',เจ้านาย:'老板',อาหาร:'美食',กิน:'吃',ขนม:'零食',เซเว่น:'711',ฟิค:'同人小说',นิยาย:'小说',ท่องเที่ยว:'旅行',เกาหลี:'韩国',ญี่ปุ่น:'日本',เพลง:'歌',อกหัก:'失恋',รอยสัก:'纹身',เพื่อน:'朋友',AI:'AI',วิ่ง:'跑步',กีฬา:'运动',ลูก:'孩子',สัตว์เลี้ยง:'宠物',โรงแรม:'酒店',ท้องฟ้า:'天空',ชีวิต:'人生',ฝัน:'梦想',คำถาม:'提问',ร้องไห้:'哭',ความรู้สึก:'感受',สอบ:'考试',เรียน:'学习',ประสบการณ์:'经验',ตลก:'搞笑',ข่าว:'新闻',สังคม:'社会',อาชีพ:'职业',มารยาท:'礼仪',แรงบันดาลใจ:'灵感',ความโสด:'单身生活',แฟชั่น:'时尚'};
  let cn='';
  for(const[k,v] of Object.entries(m)) if(t.includes(k)) cn+=v+' ';
  return cn.trim()||'';
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
    const np=await p.evaluate((mk)=>{
      const f=[];document.querySelectorAll('[data-testid="tweet"]').forEach(a=>{
        const t=a.querySelector('[data-testid="tweetText"]')?.innerText||'';
        if(!t||f.some(x=>x.text===t)||!mk.some(m=>t.includes(m)))return;
        f.push({text:t,date:(a.querySelector('time')?.getAttribute('datetime')||'').split('T')[0],aria:a.querySelector('[role="group"]')?.getAttribute('aria-label')||''});
      });return f;
    },Q);
    np.forEach(x=>{const k=x.text.substring(0,50);if(!posts.has(k))posts.set(k,x)});
    if(posts.size>=maxCount)break;
    await p.evaluate(()=>window.scrollBy(0,3000));await new Promise(r=>setTimeout(r,1200));
  }
  await b.close();
  return{handle,posts:[...posts.values()].slice(0,maxCount).map(x=>({q:x.text.trim().replace(/\n+/g,' '),date:x.date,aria:x.aria,tags:tagText(x.text),cn:basicCN(x.text)}))};
}

// ============================================================
function genCards(jobDir,posts){
  let css='',cards='';
  STYLES.forEach(s=>css+=`.${s.cls}{${s.css}}.${s.cls} .q{${s.txt}}\n`);
  posts.forEach((p,i)=>{const s=STYLES[i%STYLES.length];cards+=`<div class="card ${s.cls}"><div class="q">${p.q}</div></div>\n`});
  fs.writeFileSync(path.join(jobDir,'cards.html'),`<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}body{background:#111;display:flex;flex-wrap:wrap;gap:20px;padding:20px;justify-content:center}
.card{width:900px;height:1200px;border-radius:36px;display:flex;align-items:center;justify-content:center;font-family:-apple-system,'Noto Sans Thai',sans-serif;padding:80px 70px}
.q{font-size:60px;font-weight:800;line-height:1.4;text-align:center}${css}</style></head><body>${cards}</body></html>`,'utf8');
}

async function screenshotCards(jobDir){
  const cp=path.join(jobDir,'cards.html'),id=path.join(jobDir,'imgs');fs.existsSync(id)||fs.mkdirSync(id,{recursive:true});
  const b=await puppeteer.launch({headless:'new',args:['--no-sandbox']}),p=await b.newPage();
  await p.setViewport({width:1200,height:900});await p.goto(`file://${cp}`,{waitUntil:'networkidle0'});
  const cards=await p.$$('.card');
  for(let i=0;i<cards.length;i++)await cards[i].screenshot({path:path.join(id,`card_${String(i+1).padStart(3,'0')}.png`)});
  await b.close();return cards.length;
}

function genPreview(jobDir,handle,posts){
  let blocks='';
  posts.forEach((p,i)=>{const n=String(i+1).padStart(3,'0');
    blocks+=`<div class="post" id="post${i}">
  <img src="imgs/card_${n}.png" style="width:200px;height:267px;object-fit:cover;flex-shrink:0;border-radius:8px 0 0 8px">
  <div class="body">
    <div class="th">${p.q}</div>
    <div class="cn">${p.cn||'[翻译待补充]'}</div>
    <div class="aria">${p.aria}</div>
    <div class="tags">${p.tags.split(' ').map(t=>`<span class="t">${t}</span>`).join('')}</div>
    <div class="actions">
      <a class="dl" href="/api/download/${handle}/imgs/card_${n}.png" download>⬇️</a>
      <button class="pub" onclick="togglePub(${i})" id="btn${i}">📌</button>
    </div>
  </div></div>\n`});
  const html=`<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>@${handle} 素材包</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#fafafa;color:#1a1a1a;font-family:-apple-system,'Noto Sans Thai',sans-serif;padding:24px}
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
.cn{font-size:14px;color:#666;line-height:1.5}
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
</style></head><body><div class="c">
<div class="hero"><h1>X 内容工厂</h1><p>输入链接 → 自动抓取 → 配图下载</p></div>
<div class="box">
  <h2>🔗 X 博主链接</h2>
  <input class="inp" id="url" placeholder="https://x.com/博主用户名">
  <h2 style="margin-top:14px">🔐 Auth Token</h2>
  <p class="dsc">从 Chrome DevTools 复制</p>
  <input class="inp" id="token" placeholder="粘贴 auth_token">
  <details><summary>📖 怎么获取？</summary>
  <div>1. 打开 x.com 并登录<br>2. ⌘+Option+I → Application → Cookies → x.com<br>3. 找到 auth_token → 双击 Value 复制</div></details>
  <div class="range-wrap"><label><span>数量</span><span id="cnt">30</span></label><input type="range" id="count" min="10" max="100" value="30" oninput="document.getElementById('cnt').textContent=this.value"></div>
  <button class="btn btn-go" id="goBtn" onclick="run()">🚀 开始抓取</button>
  <div class="note">仅用于访问公开帖子，不会存储</div>
</div>
<div class="result" id="result"></div><div class="log" id="log"></div></div>
<script>
const L=document.getElementById('log'),R=document.getElementById('result'),B=document.getElementById('goBtn');
function A(m,c=''){L.classList.add('show');const d=document.createElement('div');d.className='ln'+(c?' '+c:'');d.textContent='['+new Date().toLocaleTimeString()+'] '+m;L.appendChild(d);L.scrollTop=L.scrollHeight}
async function run(){
  const u=document.getElementById('url').value.trim(),t=document.getElementById('token').value.trim(),n=document.getElementById('count').value;
  if(!u||!t)return alert('请填写链接和 auth_token');
  B.disabled=true;B.textContent='⏳ 抓取中...';R.classList.remove('show');L.innerHTML='';A('开始...','info');
  try{
    const r=await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:u,token:t,count:parseInt(n)})});
    const d=await r.json();
    if(d.error){A(d.error,'err');B.disabled=false;B.textContent='🚀 开始抓取';return}
    A('完成: '+d.questions+' 条帖, '+d.images+' 张图','ok');
    R.innerHTML='<h3>✅ 完成</h3><div class="stats"><div class="st"><div class="n">@'+d.handle+'</div><div class="l">博主</div></div><div class="st"><div class="n">'+d.questions+'</div><div class="l">提问帖</div></div><div class="st"><div class="n">'+d.images+'</div><div class="l">配图PNG</div></div></div><div class="btns"><a href="/output/'+d.handle+'/preview.html" target="_blank">🔗 查看素材</a><a class="png" href="/output/'+d.handle+'/cards.html" target="_blank">🎨 纯卡片</a></div>';
    R.classList.add('show');
  }catch(e){A(e.message,'err')}
  B.disabled=false;B.textContent='🚀 开始抓取';
}
</script></body></html>`;

// ============================================================
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
  if(u.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(INDEX);return}
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
        genCards(jobDir,data.posts);const imgCount=await screenshotCards(jobDir);
        genPreview(jobDir,handle,data.posts);
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({handle,questions:data.posts.length,images:imgCount}));
      }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}))}
    });return;
  }
  if(u.pathname.startsWith('/output/')){const f=path.join(OUTPUT,u.pathname.replace('/output/',''));if(fs.existsSync(f)){const m={'html':'text/html','png':'image/png','json':'application/json'};res.writeHead(200,{'Content-Type':m[path.extname(f).slice(1)]||'text/plain'});fs.createReadStream(f).pipe(res)}else{res.writeHead(404);res.end()}return}
  if(u.pathname.startsWith('/api/zip/')){const h=u.pathname.split('/')[3],jd=path.join(OUTPUT,h);if(!fs.existsSync(jd)){res.writeHead(404);res.end();return}const{execSync}=require('child_process'),zp=path.join(OUTPUT,h+'.zip');try{try{fs.unlinkSync(zp)}catch(e){}execSync(`cd "${OUTPUT}" && zip -rq "${h}.zip" "${h}" -x "*.js"`,{stdio:'ignore',timeout:30000});const stat=fs.statSync(zp);res.writeHead(200,{'Content-Type':'application/zip','Content-Length':stat.size,'Content-Disposition':`attachment; filename="${h}.zip"`});const stream=fs.createReadStream(zp);stream.pipe(res);stream.on('end',()=>{try{fs.unlinkSync(zp)}catch(e){}})}catch(e){res.writeHead(500);res.end('ZIP failed: '+e.message)}return}
  if(u.pathname.startsWith('/api/download/')){const f=path.join(OUTPUT,u.pathname.replace('/api/download/',''));if(fs.existsSync(f)){res.writeHead(200,{'Content-Type':'image/png','Content-Disposition':`attachment; filename="${path.basename(f)}"`});fs.createReadStream(f).pipe(res)}else{res.writeHead(404);res.end()}return}
  res.writeHead(404);res.end();
});

server.listen(PORT,async()=>{console.log(`\n🏭 X内容工厂 → http://localhost:${PORT}\n`);try{const b=await puppeteer.launch({headless:'new',args:['--no-sandbox']});await b.close();console.log('✅ Puppeteer 就绪\n')}catch(e){console.log('⚠️ Puppeteer 未就绪:',e.message,'\n')}});
