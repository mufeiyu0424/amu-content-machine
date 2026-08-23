const $ = s => document.querySelector(s);
const status = (msg, ok) => { const el = $('#status'); el.textContent = msg; el.className = ok ? 'ok' : (ok === false ? 'err' : ''); };

// 载入配置 + 当前页信息
(async () => {
  const cfg = await chrome.storage.local.get(['server', 'password']);
  $('#server').value = cfg.server || 'http://localhost:8420';
  $('#password').value = cfg.password || '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    $('#title').value = tab.title || '';
    $('#url').value = tab.url || '';
  }
})();

$('#server').addEventListener('change', e => chrome.storage.local.set({ server: e.target.value.trim() }));
$('#password').addEventListener('change', e => chrome.storage.local.set({ password: e.target.value }));

// 抓取当前页正文（滚动触发懒加载 → 等 → 注入所有框架含 iframe 合并取最长正文）
$('#grab').addEventListener('click', async () => {
  status('抓取中（含滚动加载与 iframe 内容）…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 1) 先滚动到底再回顶，触发懒加载/流式渲染
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        window.scrollTo(0, document.body.scrollHeight);
        return true;
      },
    });
    await new Promise(r => setTimeout(r, 700));

    // 2) 注入所有 frame（含跨域 iframe），各自抽取正文
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const root = document.querySelector('article')
          || document.querySelector('[role="article"]')
          || document.querySelector('main article')
          || document.querySelector('.post-content, .article-content, .entry-content, .article-body')
          || document.querySelector('main')
          || document.body;
        if (!root) return '';
        const clone = root.cloneNode(true);
        clone.querySelectorAll('nav, header, footer, aside, form, script, style, noscript, [role="navigation"], [aria-hidden="true"]').forEach(e => e.remove());
        return (clone.innerText || '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n[ \t]+/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      },
    });

    const texts = results.map(r => r && r.result ? r.result : '').filter(Boolean);
    // 取最长的一段作为正文
    const best = texts.sort((a, b) => b.length - a.length)[0] || '';
    if (best) {
      $('#note').value = best;   // 全文保存，不截断
      status('✓ 已抓取正文（' + best.length + ' 字，全文保存）');
    } else {
      status('没抓到正文（可能正文是图片/画布渲染，只能手动复制）', false);
    }
  } catch (e) { status('抓取失败：' + e.message, false); }
});

$('#save').addEventListener('click', async () => {
  const server = $('#server').value.trim().replace(/\/$/, '');
  const title = $('#title').value.trim();
  const url = $('#url').value.trim();
  const note = $('#note').value.trim();
  if (!server) { status('请先填写工作台地址', false); return; }
  if (!title && !url) { status('标题和链接至少填一个', false); return; }
  status('保存中…');
  try {
    const r = await fetch(server + '/api/materials', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workbench-Password': $('#password').value.trim(),
      },
      body: JSON.stringify({ title, url, note, source: 'browser-extension' }),
    });
    const j = await r.json();
    if (j.error) { status('✗ ' + j.error + (r.status === 401 ? '（密码错误？）' : ''), false); return; }
    status('✓ 已保存到素材库（' + j.total + ' 条）', true);
  } catch (e) {
    status('✗ 连不上工作台。确认 Mac 已启动服务，且地址正确（外网用 Tailscale 的 100.x 地址）', false);
  }
});
