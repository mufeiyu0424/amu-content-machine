// No-cache static server for the dashboard + self-serve pipeline endpoints.
//
//   GET  /*              -> dashboard files (no-store, so rebuilt data shows up)
//
// Self-serve pipeline endpoints (run pull scripts as queued background jobs):
//   POST /api/refresh_me          -> re-pull your own notes + rebuild dashboard
//   POST /api/add_creator         -> { input } profile link / URL / 24-hex id
//   POST /api/discover            -> { keywords: "a,b,c", top: 12 }
//   POST /api/fix_links           -> attach xsec_token to stored note URLs
//   GET  /api/jobs                -> job list with status + log tail
//
// Usage: node scripts/serve.mjs [port]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'dashboard');
const port = +(process.argv[2] || 8420);
// host: default localhost-only (safe). Pass 0.0.0.0 to allow LAN devices
// (iPad/phone on the same Wi-Fi) — anyone on the network can then reach it.
const host = process.argv[3] || '127.0.0.1';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

const cors = () => ({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Workbench-Password',
  // 让浏览器扩展/secure 页面可以访问本机 localhost（Chrome Private Network Access）
  'Access-Control-Allow-Private-Network': 'true' });

// ── 访问密码门 ────────────────────────────────────────────────────────────
function workbenchPassword() {
  if (process.env.WORKBENCH_PASSWORD) return process.env.WORKBENCH_PASSWORD.trim();
  const env = path.resolve(root, '.env.local');
  if (fs.existsSync(env)) {
    const m = fs.readFileSync(env, 'utf8').match(/^WORKBENCH_PASSWORD=(.*)$/m);
    if (m) return m[1].trim();
  }
  return null; // 未配置 → 不启用密码门
}

function authed(req) {
  const pw = workbenchPassword();
  if (!pw) return true;
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(c => c.startsWith('wb_auth='));
  const c = cookie ? decodeURIComponent(cookie.slice('wb_auth='.length)) : null;
  const h = req.headers['x-workbench-password'];
  return c === pw || h === pw;
}

const LOGIN_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 小红书 AI 内容工作台</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fbf7ee;font-family:-apple-system,"PingFang SC",sans-serif}
  .card{background:#fff;border:1px solid #efe9da;border-radius:16px;padding:32px;width:320px;box-shadow:0 8px 30px rgba(0,0,0,.05)}
  h1{font-size:18px;margin:0 0 4px;color:#3a362f}
  .sub{font-size:13px;color:#9a968b;margin:0 0 20px}
  input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #e5dfce;border-radius:10px;font-size:15px}
  button{width:100%;margin-top:12px;padding:11px;background:#7aa97a;color:#fff;border:0;border-radius:10px;font-size:15px;cursor:pointer}
  #msg{font-size:13px;color:#c0392b;min-height:18px;margin-top:8px}
</style></head><body><div class="card"><h1>小红书 AI 内容工作台</h1><p class="sub">请输入访问密码</p>
<input id="pw" type="password" placeholder="密码" autofocus>
<button onclick="login()">进入</button><div id="msg"></div></div>
<script>
async function login(){
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
  const j=await r.json();
  if(j.ok){location.href='/';}else{document.getElementById('msg').textContent='密码错误';}
}
document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
</script></body></html>`;

// ── Self-serve pipeline jobs ────────────────────────────────────────────────
// One job at a time (TikHub rate limits make parallel pulls counterproductive).
const NODE = process.execPath;
const jobs = []; const jobQueue = [];
let jobSeq = 0, jobRunning = false;
const FINALIZE = [['build_dashboard.mjs', '--lang', 'zh']];

function enqueue(label, steps) {
  const job = { id: ++jobSeq, label, status: '排队中', log: '', ts: Date.now() };
  jobs.unshift(job); if (jobs.length > 30) jobs.pop();
  jobQueue.push({ job, steps });
  pump();
  return job;
}

function pump() {
  if (jobRunning) return;
  const next = jobQueue.shift();
  if (!next) return;
  jobRunning = true;
  const { job, steps } = next;
  job.status = '运行中';
  const runStep = i => {
    if (i >= steps.length) { job.status = '完成'; job.cp = null; jobRunning = false; pump(); return; }
    const [script, ...args] = steps[i];
    job.log += `\n$ node ${script} ${args.join(' ')}\n`;
    const cp = spawn(NODE, [path.join(root, 'scripts', script), ...args], { cwd: root });
    job.cp = cp;
    cp.stdout.on('data', d => { job.log += d; if (job.log.length > 20000) job.log = job.log.slice(-20000); });
    cp.stderr.on('data', d => { job.log += d; if (job.log.length > 20000) job.log = job.log.slice(-20000); });
    cp.on('close', code => {
      if (job.status === '已停止') { job.cp = null; jobRunning = false; pump(); return; }
      if (code !== 0) { job.status = '失败'; job.cp = null; job.log += `\n✗ 步骤退出码 ${code}`; jobRunning = false; pump(); return; }
      runStep(i + 1);
    });
  };
  runStep(0);
}

// Accept a 24-hex id, a profile URL, or an xhslink short link; return the hash id.
async function resolveCreatorId(raw) {
  const input = (raw || '').trim();
  const direct = input.match(/[0-9a-f]{24}/i);
  if (direct) return direct[0];
  if (!/^https?:\/\//i.test(input)) return null;
  let url = input;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, {
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
      });
      const loc = r.headers.get('location');
      if (!loc) break;
      const h = loc.match(/[0-9a-f]{24}/i);
      if (h) return h[0];
      url = loc;
    } catch { return null; }
  }
  return null;
}

function myUserId() {
  try {
    const me = JSON.parse(fs.readFileSync(path.join(root, 'me.json'), 'utf8'));
    return me.profile?.userId || me.userId || me.id || null;
  } catch { return null; }
}

const readBody = req => new Promise(r => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => { try { r(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { r({}); } });
});

async function api(req, res) {
  const send = (code, obj) => { res.writeHead(code, cors()); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url.startsWith('/api/jobs')) {
    return send(200, jobs.map(j => ({ id: j.id, label: j.label, status: j.status, ts: j.ts, log: j.log.slice(-3000) })));
  }
  if (req.method === 'GET' && req.url.startsWith('/api/materials')) {
    const matPath = path.join(root, 'materials', 'materials.json');
    const list = fs.existsSync(matPath) ? JSON.parse(fs.readFileSync(matPath, 'utf8')) : [];
    return send(200, list);
  }
  if (req.method === 'DELETE' && req.url.startsWith('/api/materials/')) {
    const id = decodeURIComponent(req.url.split('/api/materials/')[1] || '').trim();
    if (!id) return send(400, { error: '缺少素材 id' });
    const matPath = path.join(root, 'materials', 'materials.json');
    let list = fs.existsSync(matPath) ? JSON.parse(fs.readFileSync(matPath, 'utf8')) : [];
    const before = list.length;
    list = list.filter(m => m.id !== id);
    if (list.length === before) return send(404, { error: '未找到该素材' });
    fs.writeFileSync(matPath, JSON.stringify(list, null, 2));
    enqueue('刷新面板数据', [['build_dashboard.mjs', '--lang', 'zh']]);
    return send(200, { ok: true, total: list.length });
  }
  if (req.method === 'DELETE' && req.url.startsWith('/api/idea/by-material/')) {
    const key = decodeURIComponent(req.url.split('/api/idea/by-material/')[1] || '').trim();
    if (!key) return send(400, { error: '缺少素材标识' });
    const vaultPath = path.join(root, 'vault', 'vault.json');
    const vault = fs.existsSync(vaultPath) ? JSON.parse(fs.readFileSync(vaultPath, 'utf8')) : {};
    const before = (vault.ideas || []).length;
    // 同时按 materialId 和 material 标题匹配（兼容早期没存 materialId 的）
    vault.ideas = (vault.ideas || []).filter(v => v.materialId !== key && v.material !== key);
    if (vault.ideas.length === before) return send(404, { error: '未找到该素材的选题' });
    fs.writeFileSync(vaultPath, JSON.stringify(vault, null, 2));
    enqueue('刷新面板数据', [['build_dashboard.mjs', '--lang', 'zh']]);
    return send(200, { ok: true, removed: before - vault.ideas.length, total: vault.ideas.length });
  }
  if (req.method === 'DELETE' && req.url.startsWith('/api/idea/')) {
    const id = decodeURIComponent(req.url.split('/api/idea/')[1] || '').trim();
    if (!id) return send(400, { error: '缺少选题 id' });
    const vaultPath = path.join(root, 'vault', 'vault.json');
    const vault = fs.existsSync(vaultPath) ? JSON.parse(fs.readFileSync(vaultPath, 'utf8')) : {};
    const before = (vault.ideas || []).length;
    vault.ideas = (vault.ideas || []).filter(v => v.id !== id);
    if (vault.ideas.length === before) return send(404, { error: '未找到该选题' });
    fs.writeFileSync(vaultPath, JSON.stringify(vault, null, 2));
    enqueue('刷新面板数据', [['build_dashboard.mjs', '--lang', 'zh']]);
    return send(200, { ok: true, total: vault.ideas.length });
  }
  if (req.method === 'DELETE' && req.url.startsWith('/api/draft/')) {
    const id = decodeURIComponent(req.url.split('/api/draft/')[1] || '').trim();
    if (!id) return send(400, { error: '缺少草稿 id' });
    const draftsPath = path.join(root, 'drafts', 'index.json');
    const drafts = fs.existsSync(draftsPath) ? JSON.parse(fs.readFileSync(draftsPath, 'utf8')) : {};
    if (!drafts[id]) return send(404, { error: '未找到该草稿' });
    delete drafts[id];
    fs.writeFileSync(draftsPath, JSON.stringify(drafts, null, 2));
    enqueue('刷新面板数据', [['build_dashboard.mjs', '--lang', 'zh']]);
    return send(200, { ok: true, total: Object.keys(drafts).length });
  }
  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
  const body = await readBody(req);

  if (req.url.startsWith('/api/job-stop')) {
    const jobId = +body.jobId;
    const job = jobs.find(j => j.id === jobId);
    if (!job) return send(404, { error: '任务不存在' });
    if (job.status === '完成' || job.status === '失败' || job.status === '已停止') {
      return send(200, { ok: true, status: job.status });
    }
    // 若还在排队，直接从队列移除；若在运行，杀进程
    const qi = jobQueue.findIndex(x => x.job.id === jobId);
    if (qi >= 0) jobQueue.splice(qi, 1);
    job.status = '已停止';
    job.log += '\n⛔ 用户手动停止';
    if (job.cp) { try { job.cp.kill('SIGTERM'); } catch {} }
    return send(200, { ok: true, status: '已停止' });
  }

  if (req.url.startsWith('/api/refresh_me')) {
    const id = myUserId();
    if (!id) return send(400, { error: '找不到 me.json——请先在对话中让 WorkBuddy 跑一次 onboarding' });
    return send(200, enqueue('刷新我的数据', [['xhs_me.mjs', id], ...FINALIZE]));
  }

  if (req.url.startsWith('/api/add_creator')) {
    const id = await resolveCreatorId(body.input || '');
    if (!id) return send(400, { error: '无法识别——请粘贴博主主页链接（App 分享 → 复制链接）或 24 位 ID' });
    return send(200, enqueue(`添加博主 ${id.slice(0, 8)}…`,
      [['xhs_creator.mjs', id], ['xhs_upsert_author.mjs', id, body.keyword || ''], ...FINALIZE]));
  }

  if (req.url.startsWith('/api/discover')) {
    const kws = (body.keywords || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
    if (kws.some(k => k.includes(' '))) return send(400, { error: '关键词不能含空格（接口限制）' });
    const top = Math.min(Math.max(+body.top || 12, 1), 24);
    // 关键词留空 → 用脚本内置的赛道默认关键词（独居vlog、下班后的生活…）
    const args = kws.length ? ['xhs_discover.mjs', kws.join(',')] : ['xhs_discover.mjs'];
    const label = kws.length ? `发现创作者：${kws.join(' / ')}` : '发现创作者（赛道默认关键词）';
    return send(200, enqueue(label,
      [args, ['xhs_creator.mjs', '--top', String(top)], ...FINALIZE]));
  }

  if (req.url.startsWith('/api/fix_links')) {
    return send(200, enqueue('修复笔记链接（附加 xsec_token）',
      [['xhs_fix_links.mjs'], ...FINALIZE]));
  }

  // ── AI 内容流水线（DeepSeek）──────────────────────────────────────────
  // 多篇草稿模型：drafts/index.json 按 ideaId 键控。起草/改稿/评审走任务队列。
  if (req.url.startsWith('/api/draft')) {
    const ideaId = (body.ideaId || '').trim();
    if (!ideaId) return send(400, { error: '缺少选题 id' });
    const args = ['ai_draft.mjs', ideaId];
    if (MODELS.includes(body.model)) args.push(body.model);
    const blogger = (body.blogger || '').trim();
    if (blogger) args.push('--blogger', blogger);
    return send(200, enqueue('AI 生成草稿（DeepSeek）',
      [args, ['build_dashboard.mjs', '--lang', 'zh']]));
  }

  if (req.url.startsWith('/api/revise')) {
    const ideaId = (body.ideaId || '').trim();
    const fb = (body.feedback || '').trim();
    if (!ideaId) return send(400, { error: '缺少选题 id' });
    if (!fb) return send(400, { error: '请先填写修改意见' });
    fs.writeFileSync(path.join(root, 'drafts', '.revise-feedback.txt'), fb);
    const args = ['ai_revise.mjs', ideaId];
    if (MODELS.includes(body.model)) args.push(body.model);
    return send(200, enqueue('AI 按意见改稿（DeepSeek）',
      [args, ['build_dashboard.mjs', '--lang', 'zh']]));
  }

  if (req.url.startsWith('/api/council')) {
    const ideaId = (body.ideaId || '').trim();
    if (!ideaId) return send(400, { error: '缺少选题 id' });
    const args = ['ai_council.mjs', ideaId];
    if (MODELS.includes(body.model)) args.push(body.model);
    return send(200, enqueue('评审团评审（6 位评委）',
      [args, ['build_dashboard.mjs', '--lang', 'zh']]));
  }

  if (req.url.startsWith('/api/oracle-from-material')) {
    const mid = (body.materialId || '').trim();
    if (!mid) return send(400, { error: '缺少素材 id' });
    const args = ['ai_oracle_from_material.mjs', mid];
    if (MODELS.includes(body.model)) args.push(body.model);
    return send(200, enqueue('基于素材生成选题',
      [args, ['build_dashboard.mjs', '--lang', 'zh']]));
  }

  if (req.url.startsWith('/api/oracle')) {
    const args = ['ai_oracle.mjs'];
    if (MODELS.includes(body.model)) args.push(body.model);
    return send(200, enqueue('生成灵感库（三源合一）',
      [args, ['build_dashboard.mjs', '--lang', 'zh']]));
  }

  // ── 素材库 ────────────────────────────────────────────────────────────
  if (req.url.startsWith('/api/materials')) {
    const matPath = path.join(root, 'materials', 'materials.json');
    const list = fs.existsSync(matPath) ? JSON.parse(fs.readFileSync(matPath, 'utf8')) : [];
    // POST：手动导入或浏览器插件收录
    const title = (body.title || '').trim();
    const url = (body.url || '').trim();
    if (!title && !url) return send(400, { error: '标题和链接至少填一个' });
    list.unshift({
      id: 'm' + Date.now(),
      title: title || url,
      url,
      note: (body.note || '').trim(),
      type: body.type || 'article',
      source: body.source || 'manual',
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(matPath, JSON.stringify(list, null, 2));
    enqueue('刷新面板数据', [['build_dashboard.mjs', '--lang', 'zh']]);
    return send(200, { ok: true, total: list.length });
  }

  send(404, { error: 'unknown api' });
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors()); return res.end(); }

  // 登录接口
  if (req.method === 'POST' && req.url.startsWith('/api/login')) {
    const send = (code, obj) => { res.writeHead(code, cors()); res.end(JSON.stringify(obj)); };
    readBody(req).then(body => {
      const pw = workbenchPassword();
      if (!pw || body.password === pw) {
        res.writeHead(200, { ...cors(), 'Set-Cookie': `wb_auth=${encodeURIComponent(pw)}; Path=/; Max-Age=31536000; SameSite=Lax` });
        return res.end(JSON.stringify({ ok: true }));
      }
      send(401, { ok: false });
    });
    return;
  }

  // 未登录 → 拦下（静态页面给登录页，接口给 401）
  if (!authed(req)) {
    if (req.url.startsWith('/api/')) { res.writeHead(401, cors()); return res.end(JSON.stringify({ error: 'unauthorized' })); }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    return res.end(LOGIN_PAGE);
  }

  if (req.url.startsWith('/api/')) return api(req, res);

  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(dir, p);
  if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store, must-revalidate',
  });
  fs.createReadStream(file).pipe(res);
}).listen(port, host, () => {
  console.log(`Content Machine dashboard -> http://${host === '0.0.0.0' ? 'localhost' : host}:${port}${host === '0.0.0.0' ? '（局域网可见）' : ''}`);
  if (!fs.existsSync(path.join(dir, 'me.js'))) console.log('  (no me.js — run scripts/build_dashboard.mjs)');
});
