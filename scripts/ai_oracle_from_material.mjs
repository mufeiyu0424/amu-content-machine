// Generate 1-3 ideas from ONE specified material (素材) via DeepSeek — material-led synthesis.
//   1) 指定素材 (materials/materials.json 里的某一篇，全文提炼后为主导源)
//   2) 自身账号分析 (analysis/me-analysis.json, fallback me.json)
//   3) 小红书同赛道创作者 (creators/*.json — 看板里拉过详情的博主)
// Appends new ideas to vault/vault.json (does NOT rewrite existing ideas).
//
// Usage: node scripts/ai_oracle_from_material.mjs <materialId> [model]
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
const model = MODELS.includes(process.argv[3]) ? process.argv[3] : 'deepseek-v4-pro';

const materialId = (process.argv[2] || '').trim();
if (!materialId) { console.error('✗ 缺少素材 id 参数'); process.exit(1); }

const promptPath = path.join(root, 'prompts', 'oracle-from-material.md');
if (!fs.existsSync(promptPath)) { console.error('✗ 找不到 prompts/oracle-from-material.md'); process.exit(1); }
const rules = fs.readFileSync(promptPath, 'utf8');

// ── 指定素材 ──
const matPath = path.join(root, 'materials', 'materials.json');
const list = fs.existsSync(matPath) ? JSON.parse(fs.readFileSync(matPath, 'utf8')) : [];
const material = list.find(m => m.id === materialId);
if (!material) { console.error(`✗ 素材库里找不到 id=${materialId} 的素材`); process.exit(1); }
const note = (material.note || '').trim();
if (!note) { console.error('✗ 该素材没有正文内容（note 为空）'); process.exit(1); }

async function distillMaterial(title, text) {
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: '你是内容提炼助手。通读全文，输出紧凑要点供选题策划参考。只输出提炼内容，不要寒暄、不要评价。' },
        { role: 'user', content: `标题：${title}\n\n全文：\n${text}\n\n请提炼输出：\n1. 核心观点（2-3句）\n2. 3-5个适合在小红书表达的切入角度\n3. 3-5句可直接引用的金句` },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json();
  return (r.ok && j.choices?.[0]?.message?.content) || '';
}

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

// ── 2) 同赛道创作者 ──
function creatorsFromBoard(dir, limit = 10) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const notes = (c.notes || []).slice().sort((a, b) => (b.likes || 0) - (a.likes || 0));
      const top = notes.slice(0, limit).map(n => `「${n.title}」(${n.likes}赞)`).join('\n');
      out.push(`## ${c.name || f}\n${c.desc || ''}\n${top}`);
    } catch {}
  }
  return out;
}
const creators = creatorsFromBoard(path.join(root, 'creators'), 10);
const creatorsText = creators.length
  ? creators.join('\n\n')
  : '（尚无同赛道创作者——先在看板拉取对标账号）';

// ── 提炼指定素材（长文先提炼）──
console.log(`→ 提炼素材全文：[${material.title}]`);
const distilled = note.length <= 600
  ? note
  : (await distillMaterial(material.title, note)) || note.slice(0, 600);

const userMsg = [
  `## 我的账号分析\n${myText}`,
  `## 小红书同赛道创作者爆款（每号 TOP10）\n${creatorsText}`,
  `## 指定素材（本次选题的唯一主题来源）\n标题：${material.title}\n\n${distilled}`,
].join('\n\n');

console.log(`→ 调用 DeepSeek 基于素材生成选题（模型：${model}）`);

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
    max_tokens: 8000,
  }),
  signal: AbortSignal.timeout(300000),
});
const j = await r.json();
if (!r.ok) { console.error('✗ DeepSeek 报错：', JSON.stringify(j).slice(0, 500)); process.exit(1); }
let content = j.choices?.[0]?.message?.content || '';
if (!content.trim()) { console.error('✗ 模型返回为空'); process.exit(1); }

content = content.replace(/```json|```/g, '').trim();
const start = content.indexOf('{');
const end = content.lastIndexOf('}');
if (start < 0 || end < 0) { console.error('✗ 返回内容不是 JSON：', content.slice(0, 300)); process.exit(1); }
let data;
try { data = JSON.parse(content.slice(start, end + 1)); }
catch (e) { console.error('✗ JSON 解析失败：', e.message, content.slice(0, 300)); process.exit(1); }

const ideas = data.ideas || data;
if (!Array.isArray(ideas) || !ideas.length) { console.error('✗ 没有解析到选题'); process.exit(1); }

// ── 追加到 vault.json（不覆盖现有选题）──
const vaultPath = path.join(root, 'vault', 'vault.json');
const vault = fs.existsSync(vaultPath) ? JSON.parse(fs.readFileSync(vaultPath, 'utf8')) : {};
const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
const newIdeas = ideas.slice(0, 3).map((v, i) => ({
  id: `v${ts}-${String(i + 1).padStart(2, '0')}`,
  score: Math.round((+v.score || 0) * 10) / 10,
  type: String(v.type || '常青').includes('热点') ? '热点' : '常青',
  source: '素材',
  title: v.title || '',
  angle: v.angle || '',
  why: v.why || '',
  format: v.format || '',
  inspiration: v.inspiration || `素材：${material.title}`,
  style_hint: v.style_hint || '',
}));
vault.ideas = [...newIdeas, ...(vault.ideas || [])];
vault.generatedAt = new Date().toISOString();
vault.generatedBy = 'ai_oracle_from_material';
fs.writeFileSync(vaultPath, JSON.stringify(vault, null, 2));

console.log(`✓ 已基于素材生成 ${newIdeas.length} 条选题并追加到灵感库（现共 ${vault.ideas.length} 条）`);
