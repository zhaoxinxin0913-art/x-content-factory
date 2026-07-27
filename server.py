"""
X 内容工厂 - 后端服务
输入 X 博主链接 → 输出中泰双语素材包（正文+标签+配图）
"""
import subprocess, json, os, re, shutil, time, sys
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_from_directory

app = Flask(__name__)
BASE = Path(__file__).parent
OUTPUT = BASE / "output"
OUTPUT.mkdir(exist_ok=True)

# ============================================================
# 卡片样式
# ============================================================
CARD_STYLES = {
    "s1": ("极简白紫", "background:#fafafa; .q{color:#5b4ae0}"),
    "s2": ("暗黑霓虹", "background:#0a0a0a; .q{color:#ff6ec7;text-shadow:0 0 30px #ff6ec7}"),
    "s3": ("毛玻璃", "background:linear-gradient(135deg,#e0c3fc,#8ec5fc); .q{color:#2d1b69}"),
    "s4": ("圆点纹理", "background:linear-gradient(135deg,#a8edea,#fed6e3); .q{color:#2c3e50}"),
    "s5": ("双色调", "background:linear-gradient(135deg,#ff9a9e,#fecfef 50%,#a1c4fd); .q{color:#fff;text-shadow:0 2px 20px rgba(0,0,0,.3)}"),
    "s6": ("复古胶片", "background:#f4e4c1; .q{color:#5d4037;font-style:italic}"),
    "s7": ("科技网格", "background:#0f0f23; .q{color:#00f2fe;text-shadow:0 0 40px rgba(0,242,254,.5)}"),
}

# ============================================================
# HTML 卡片模板
# ============================================================
CARD_HTML = """<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:#111;display:flex;flex-wrap:wrap;gap:20px;padding:20px;justify-content:center}}
.card{{width:900px;height:1200px;border-radius:36px;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,'Noto Sans Thai',sans-serif;padding:80px 70px;position:relative;overflow:hidden}}
.q{{font-size:60px;font-weight:800;line-height:1.4;text-align:center;position:relative;z-index:1}}
.c0{{background:linear-gradient(135deg,#667eea,#764ba2)}}
.c0 .q{{color:#fff}}
{style_blocks}
</style></head><body>{cards}</body></html>"""

def gen_style_blocks():
    blocks = []
    for i, (cls, (name, css)) in enumerate(CARD_STYLES.items()):
        blocks.append(f".{cls}{{{css}}}")
    blocks.append(f".c0{{background:linear-gradient(135deg,#667eea,#764ba2)}}.c0 .q{{color:#fff}}")
    return "\n".join(blocks)

def gen_single_card_style(i, text, style_class):
    """Generate HTML for one card."""
    return f'<div class="card {style_class}"><div class="q">{text}</div></div>'

# ============================================================
# 预览 HTML 模板
# ============================================================
PREVIEW_HTML = """<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:#1a1a2e;color:#e0e0e0;font-family:-apple-system,'Noto Sans Thai',sans-serif;max-width:1000px;margin:0 auto;padding:30px 20px}}
h1{{font-size:28px;text-align:center;margin-bottom:6px;color:#fff}}
.sub{{text-align:center;color:#888;margin-bottom:30px;font-size:14px}}
.post{{border-radius:18px;overflow:hidden;margin-bottom:40px;background:#222;box-shadow:0 4px 24px rgba(0,0,0,.4)}}
.post img{{width:100%;display:block}}
.body{{padding:26px 30px}}
.th{{font-size:20px;color:#fff;font-weight:600;line-height:1.6;margin-bottom:8px}}
.cn{{font-size:16px;color:#aaa;line-height:1.6;margin-bottom:12px}}
.tags{{display:flex;flex-wrap:wrap;gap:6px}}
.tag{{background:#333;color:#aaa;padding:4px 12px;border-radius:12px;font-size:13px}}
.foot{{text-align:center;color:#555;font-size:13px;padding:20px}}
</style></head><body>
<h1>{title}</h1><p class="sub">{count} 条 · 配图可下载 · 正文可复制 · 标签可复制</p>
{posts}
<div class="foot">Built with X内容工厂</div></body></html>"""

POST_BLOCK = """<div class="post">
  <a href="{img_path}" download><img src="{img_path}" alt="{alt}"></a>
  <div class="body">
    <div class="th">{th}</div>
    <div class="cn">{cn}</div>
    <div class="tags">{tag_html}</div>
  </div></div>"""

# ============================================================
# 核心：生成 HTML + 截图
# ============================================================
def generate_cards(handle, posts):
    """生成 HTML 卡片文件并截图"""
    job_dir = OUTPUT / handle
    img_dir = job_dir / "imgs"
    img_dir.mkdir(parents=True, exist_ok=True)
    
    # 分配样式（7种轮换）
    style_keys = list(CARD_STYLES.keys())
    
    # 生成卡片 HTML
    cards_html = []
    for i, post in enumerate(posts):
        style = style_keys[i % len(style_keys)]
        cards_html.append(gen_single_card_style(i, post["q"], style))
    
    # 生成完整的毛玻璃样式变体
    for i, post in enumerate(posts):
        style = style_keys[i % len(style_keys)]
        cls = style
        if cls == "s3":
            cards_html[i] = f'<div class="card s3"><div style="position:absolute;inset:30px;background:rgba(255,255,255,.25);border-radius:24px;border:1px solid rgba(255,255,255,.4);z-index:0"></div><div class="q" style="color:#2d1b69">{post["q"]}</div></div>'
        elif cls == "s4":
            cards_html[i] = cards_html[i].replace('<div class="card s4">', '<div class="card s4"><div style="position:absolute;inset:0;background:radial-gradient(circle,rgba(255,255,255,.5) 2px,transparent 2px);background-size:40px 40px;z-index:0"></div>')
        elif cls == "s5":
            cards_html[i] = cards_html[i].replace('<div class="card s5">', '<div class="card s5"><div style="position:absolute;inset:0;background:linear-gradient(0deg,rgba(0,0,0,.15),transparent 50%);z-index:0"></div>')
        elif cls == "s6":
            cards_html[i] = cards_html[i].replace('<div class="card s6">', '<div class="card s6"><div style="position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,.03) 3px,rgba(0,0,0,.03) 6px);z-index:0"></div>')
        elif cls == "s7":
            cards_html[i] = cards_html[i].replace('<div class="card s7">', '<div class="card s7"><div style="position:absolute;inset:0;background:linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px);background-size:50px 50px;z-index:0"></div>')
    
    card_html = CARD_HTML.format(
        style_blocks=gen_style_blocks(),
        cards="\n".join(cards_html)
    )
    card_path = job_dir / "cards.html"
    card_path.write_text(card_html, encoding="utf-8")
    
    # 用 puppeteer 截图
    screenshot_script = f"""
const puppeteer = require('puppeteer');
(async () => {{
  const browser = await puppeteer.launch({{ headless: 'new' }});
  const page = await browser.newPage();
  await page.setViewport({{ width: 1200, height: 900 }});
  await page.goto('file://{card_path}', {{ waitUntil: 'networkidle0' }});
  const cards = await page.$$('.card');
  for (let i = 0; i < cards.length; i++) {{
    await cards[i].screenshot({{ path: '{img_dir}/card_' + String(i+1).padStart(3,'0') + '.png' }});
  }}
  await browser.close();
}})();
"""
    script_path = job_dir / "_screenshot.js"
    script_path.write_text(screenshot_script)
    
    result = subprocess.run(
        ["node", str(script_path)],
        capture_output=True, text=True, timeout=120,
        cwd=str(BASE)
    )
    
    count = len(list(img_dir.glob("card_*.png")))
    return img_dir, count

# ============================================================
# 生成预览页面
# ============================================================
def generate_preview(handle, posts, img_dir):
    """生成带图文+标签的预览 HTML"""
    post_blocks = []
    for i, p in enumerate(posts):
        n = str(i+1).zfill(3)
        tags_html = " ".join(f'<span class="tag">{t}</span>' for t in p["tags"].split())
        post_blocks.append(POST_BLOCK.format(
            img_path=f"imgs/card_{n}.png",
            alt=f"card {i+1}",
            th=p["q"],
            cn=p["cn"],
            tag_html=tags_html
        ))
    
    preview = PREVIEW_HTML.format(
        title=f"🐱 @{handle} 发帖素材包",
        count=f"{len(posts)} 条",
        posts="\n".join(post_blocks)
    )
    
    preview_path = OUTPUT / handle / "preview.html"
    preview_path.write_text(preview, encoding="utf-8")
    return preview_path

# ============================================================
# Flask 路由
# ============================================================
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/scrape", methods=["POST"])
def scrape():
    """接收抓取请求，返回结果"""
    data = request.get_json()
    url = data.get("url", "").strip()
    
    if not url:
        return jsonify({"error": "请输入X博主链接"}), 400
    
    # 从 URL 提取 handle
    match = re.search(r"x\.com/(\w+)", url)
    if not match:
        return jsonify({"error": "无法识别博主用户名"}), 400
    handle = match.group(1)
    
    # 返回说明：实际抓取需要由 Hermes Agent 完成
    # 这里展示工作流状态
    return jsonify({
        "status": "ready",
        "handle": handle,
        "message": f"已识别博主 @{handle}。请确认 auth_token 已配置。",
        "next": "抓取需要 auth_token，请确保已在 Hermes 浏览器中登录 X。"
    })

@app.route("/output/<handle>/")
def view_output(handle):
    """查看已生成的素材"""
    job_dir = OUTPUT / handle
    preview = job_dir / "preview.html"
    if preview.exists():
        return send_from_directory(str(job_dir), "preview.html")
    return "该博主素材尚未生成", 404

@app.route("/output/<handle>/imgs/<path:filename>")
def serve_img(handle, filename):
    return send_from_directory(str(OUTPUT / handle / "imgs"), filename)

# ============================================================
# 启动
# ============================================================
if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=5050)
    args = p.parse_args()
    
    (BASE / "templates").mkdir(exist_ok=True)
    
    print(f"\n🏭 X内容工厂已启动 → http://localhost:{args.port}\n")
    app.run(host="0.0.0.0", port=args.port, debug=True)
