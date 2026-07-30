// X 内容工厂 — Token 自动填充脚本
(function(){
  // 在所有 token 输入框旁边添加"一键授权"按钮
  function addAuthButtons(){
    const tokenInputs = document.querySelectorAll('input[type], input');
    tokenInputs.forEach(inp => {
      // 只处理 token 相关的输入框
      if (!inp.id || (!inp.id.includes('token') && !inp.id.includes('Token'))) return;
      if (inp.dataset.authAdded) return;
      inp.dataset.authAdded = '1';

      const btn = document.createElement('button');
      btn.textContent = '🔐 一键授权';
      btn.style.cssText = 'width:100%;padding:10px;margin-bottom:10px;border-radius:8px;border:1.5px solid #1d9bf0;background:#fff;color:#1d9bf0;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s';
      btn.onmouseenter = () => { btn.style.background = '#1d9bf0'; btn.style.color = '#fff'; };
      btn.onmouseleave = () => { btn.style.background = '#fff'; btn.style.color = '#1d9bf0'; };
      btn.onclick = async () => {
        btn.textContent = '⏳ 获取中...';
        btn.disabled = true;
        try {
          const cookie = await chrome.cookies.get({ url: 'https://x.com', name: 'auth_token' });
          if (cookie && cookie.value) {
            // 填充当前模块的所有 token 输入框
            document.querySelectorAll('input[id*="token"], input[id*="Token"]').forEach(ti => {
              ti.value = cookie.value;
              // 触发 input 事件让框架感知
              ti.dispatchEvent(new Event('input', { bubbles: true }));
            });
            btn.textContent = '✅ 已授权';
            btn.style.background = '#00ba7c'; btn.style.color = '#fff';
            btn.style.borderColor = '#00ba7c';
            setTimeout(() => {
              btn.textContent = '🔐 一键授权';
              btn.style.background = '#fff'; btn.style.color = '#1d9bf0';
              btn.style.borderColor = '#1d9bf0';
              btn.disabled = false;
            }, 2000);
          } else {
            btn.textContent = '❌ 未登录 X，请先登录 x.com';
            btn.style.background = '#fee'; btn.style.color = '#c00';
            btn.style.borderColor = '#c00';
            setTimeout(() => {
              btn.textContent = '🔐 一键授权';
              btn.style.background = '#fff'; btn.style.color = '#1d9bf0';
              btn.style.borderColor = '#1d9bf0';
              btn.disabled = false;
            }, 3000);
          }
        } catch(e) {
          btn.textContent = '❌ 获取失败: ' + e.message;
          btn.style.color = '#c00';
          btn.disabled = false;
        }
      };
      inp.parentNode.insertBefore(btn, inp);
    });
  }

  // 初始加载
  addAuthButtons();
  // 监听 tab 切换（页面动态内容变化）
  const observer = new MutationObserver(addAuthButtons);
  observer.observe(document.body, { childList: true, subtree: true });
})();
