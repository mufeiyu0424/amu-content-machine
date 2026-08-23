// Generate the vault (灵感库) via DeepSeek — three-way synthesis:
//   1) 自身账号分析 (analysis/me-analysis.json, fallback me.json)
//   2) 小红书创作者爆款 (analysis/creators/*-digest.md, top titles)
//   3) 素材库 (materials/materials.json)
// Borrows creators' viral 写法/结构/情绪 into each idea's style_hint.
// Full rewrite: replaces vault/vault.json.ideas.
//
// Usage: node scripts/ai_oracle.mjs
// Env: DEEPSEEK_API_KEY (or .env.local at repo root)

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const env = path.join(root, '.env.local');
  if (fs.existsSync(env)) {
    const m = fs.readFileSync(env, 'utf8').match(/^DEEPSEEK_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}
const key = apiKey();
if (!key) { console.error('✗ 找不到 DEEPSEEK_API_KEY（.env.local）'); process.exit(1); }
const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];
const model = MODELS.includes(process.argv[2]) ? process.argv[2] : 'deepseek-v4-pro';

const promptPath = path.join(root, 'prompts', 'oracle.md');
if (!fs.existsSync(promptPath)) { console.error('✗ 找不到 prompts/oracle.md'); process.exit(1); }
const rules = fs.readFileSync(promptPath, 'utf8');

// ── 1) 我的账号分析 ──
let myText = '（无我的账号分析）';
const meAnalysis = path.join(root, 'analysis', 'me-analysis.json');
if (fs.existsSync(meAnalysis)) {
  myText = JSON.stringify(JSON.parse(fs.readFileSync(meAnalysis, 'utf8')), null, 2);
} else {
  const me = path.join(root, 'me.json');
  if (fs.existsSync(me)) {
    const d = JSON.parse(fs.readFileSync(me, 'utf8'));
    const notes = (d.notes || []).map(n => `《${n.title}》赞${n.likes} 藏${n.saves} 评${n.comments}`).join('\n');
    myText = `Bio: ${d.profile?.bio || ''}\n笔记：\n${notes}`;
  }
}

// ── 2) 创作者爆款（每号 TOP 10 标题+赞）──
function digestTop(dir, limit = 10) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('-digest.md')) continue;
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    const name = (t.match(/^# (.+?) — /m) || [])[1]?.trim() || f;
    const bio = (t.match(/^Bio: (.+)$/m) || [])[1]?.trim() || '';
    const rows = [];
    for (const line of t.split('\n')) {
      const c = line.split('|').map(s => s.trim());
      if (c.length < 5 || !c[1] || /^[-:]+$/.test(c[1]) || c[1] === 'title') continue;
      rows.push({ title: c[1], likes: parseInt((c[2] || '0').replace(/[^\d]/g, ''), 10) || 0 });
    }
    const top = rows.slice(0, limit).map(r => `「${r.title}」(${r.likes}赞)`).join('\n');
    out.push(`## ${name}\n${bio}\n${top}`);
  }
  return out;
}
const creators = digestTop(path.join(root, 'analysis', 'creators'), 10);
const creatorsText = creators.length
  ? creators.join('\n\n')
  : '（无创作者 digest——先拉取并分析对标账号）';

// ── 3) 素材库（长文先提炼核心观点，再供选题策划参考）──
async function distillMaterial(title, note) {
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',   // 提炼用快模型，够用且快
      messages: [
        { role: 'system', content: '你是内容提炼助手。通读全文，输出紧凑要点供选题策划参考。只输出提炼内容，不要寒暄、不要评价。' },
        { role: 'user', content: `标题：${title}\n\n全文：\n${note}\n\n请提炼输出：\n1. 核心观点（2-3句）\n2. 3-5个适合在小红书表达的切入角度\n3. 3-5句可直接引用的金句` },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json();
  return (r.ok && j.choices?.[0]?.message?.content) || '';
}

let materialsText = '（素材库为空）';
const matPath = path.join(root, 'materials', 'materials.json');
if (fs.existsSync(matPath)) {
  const list = JSON.parse(fs.readFileSync(matPath, 'utf8'));
  if (list.length) {
    console.log(`→ 提炼素材库全文（${list.length} 篇）…`);
    const parts = await Promise.all(list.map(async m => {
      const note = (m.note || '').trim();
      if (!note) return `- ${m.title}（无内容）`;
      // 短内容直接用原文；长文先提炼核心观点，避免整篇塞进 prompt 撑爆上下文
      const body = note.length <= 600
        ? note
        : (await distillMaterial(m.title, note)) || note.slice(0, 600);
      return `## ${m.title}\n${body}`;
    }));
    materialsText = parts.join('\n\n');
  }
}

const userMsg = [
  `## 我的账号分析\n${myText}`,
  `## 小红书创作者爆款清单（每号 TOP10）\n${creatorsText}`,
  `## 素材库\n${materialsText}`,
].join('\n\n');

console.log(`→ 调用 DeepSeek 生成灵感库（三源合一，${creators.length} 个创作者号）`);

const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: rules },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.7,
    max_tokens: 16000,
  }),
  signal: AbortSignal.timeout(300000),
});
const j = await r.json();
if (!r.ok) { console.error('✗ DeepSeek 报错：', JSON.stringify(j).slice(0, 500)); process.exit(1); }
let content = j.choices?.[0]?.message?.content || '';
if (!content.trim()) { console.error('✗ 模型返回为空'); process.exit(1); }

// 解析 JSON（容忍 markdown 代码块包裹）
content = content.replace(/```json|```/g, '').trim();
const start = content.indexOf('{');
const end = content.lastIndexOf('}');
if (start < 0 || end < 0) { console.error('✗ 返回内容不是 JSON：', content.slice(0, 300)); process.exit(1); }
let data;
try { data = JSON.parse(content.slice(start, end + 1)); }
catch (e) { console.error('✗ JSON 解析失败：', e.message, content.slice(0, 300)); process.exit(1); }

const ideas = data.ideas || data;
if (!Array.isArray(ideas) || !ideas.length) { console.error('✗ 没有解析到选题'); process.exit(1); }

// 规范化 + 写入 vault.json（全量重写）
// 选题 id 用「日期+序号」生成永久唯一 id（如 v20260821-01），
// 避免每次全量重写都用 v01-v15 导致草稿/评审按 id 错位。
const vaultPath = path.join(root, 'vault', 'vault.json');
const vault = fs.existsSync(vaultPath) ? JSON.parse(fs.readFileSync(vaultPath, 'utf8')) : {};
// 时间戳到秒（YYYYMMDDHHMMSS），确保同一天内多次刷新也不会撞编号
const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
vault.ideas = ideas.slice(0, 15).map((v, i) => ({
  id: `v${ts}-${String(i + 1).padStart(2, '0')}`,
  score: Math.round((+v.score || 0) * 10) / 10,
  type: String(v.type || '常青').includes('热点') ? '热点' : '常青',
  source: v.source || 'track',
  title: v.title || '',
  angle: v.angle || '',
  why: v.why || '',
  format: v.format || '',
  inspiration: v.inspiration || '',
  style_hint: v.style_hint || '',
}));
vault.generatedAt = new Date().toISOString();
vault.generatedBy = 'ai_oracle';
fs.writeFileSync(vaultPath, JSON.stringify(vault, null, 2));

console.log(`✓ 灵感库已重写：${vault.ideas.length} 条选题`);
console.log(`  tokens: ${j.usage?.total_tokens ?? '?'}`);
