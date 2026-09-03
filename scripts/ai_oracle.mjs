// Generate the vault (灵感库) via the configured LLM (DeepSeek / Kimi …) — three-way synthesis:
//   1) 自身账号分析 (analysis/me-analysis.json, fallback me.json)
//   2) 小红书同赛道创作者 (creators/*.json — 看板里拉过详情的博主)
//   3) 素材库 (materials/materials.json)
// Borrows creators' viral 写法/结构/情绪 into each idea's style_hint.
// Full rewrite: replaces vault/vault.json.ideas.
//
// Usage: node scripts/ai_oracle.mjs [model]
// Env: 见 scripts/lib/ai.mjs（各厂商 Key 从 .env.local 读）

import fs from 'node:fs';
import path from 'node:path';
import { MODELS, chatOnce, resolveProvider, fastModelFor } from './lib/ai.mjs';

const root = path.resolve(import.meta.dirname, '..');

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

// ── 2) 同赛道创作者（看板里拉过详情的博主，取各自 TOP10 爆款标题）──
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
  : '（尚无同赛道创作者——请先在看板「添加博主 / 发现创作者」拉取对标账号）';

// ── 3) 素材库（长文先提炼核心观点，再供选题策划参考）──
async function distillMaterial(title, note) {
  // 提炼用同厂商的快模型，够用且便宜
  try {
    const res = await chatOnce({
      model: fastModelFor(model),
      messages: [
        { role: 'system', content: '你是内容提炼助手。通读全文，输出紧凑要点供选题策划参考。只输出提炼内容，不要寒暄、不要评价。' },
        { role: 'user', content: `标题：${title}\n\n全文：\n${note}\n\n请提炼输出：\n1. 核心观点（2-3句）\n2. 3-5个适合在小红书表达的切入角度\n3. 3-5句可直接引用的金句` },
      ],
      temperature: 0.3,
      max_tokens: 2000,
      timeout: 120000,
    });
    return res.text || '';
  } catch (e) {
    console.log(`  ⚠ 提炼失败：${e.message}`);
    return '';
  }
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

const p = resolveProvider(model);
console.log(`→ 调用 ${p.label} 生成灵感库（三源合一，${creators.length} 个创作者号，模型 ${model}）`);

let out;
try {
  out = await chatOnce({
    model,
    messages: [
      { role: 'system', content: rules },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.7,
    max_tokens: 16000,
    timeout: 300000,
  });
} catch (e) {
  console.error('✗ ' + e.message);
  process.exit(1);
}
let content = out.text || out.reasoning;
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

// 规范化 + 写入 vault.json（全量重写，但保留「已写草稿」的旧选题）
// 选题 id 用「日期+序号」生成永久唯一 id（如 v20260821-01），
// 避免每次全量重写都用 v01-v15 导致草稿/评审按 id 错位。
const vaultPath = path.join(root, 'vault', 'vault.json');
const vault = fs.existsSync(vaultPath) ? JSON.parse(fs.readFileSync(vaultPath, 'utf8')) : {};
// 时间戳到秒（YYYYMMDDHHMMSS），确保同一天内多次刷新也不会撞编号
const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

// 已写草稿的选题要保留（不被全量重写清掉）——读 drafts/index.json 收集 ideaId
const draftsPath = path.join(root, 'drafts', 'index.json');
const draftedIds = new Set();
if (fs.existsSync(draftsPath)) {
  try {
    const drafts = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
    Object.keys(drafts || {}).forEach(id => draftedIds.add(id));
  } catch {}
}

const newTrackIdeas = ideas.slice(0, 15).map((v, i) => ({
  id: `v${ts}-${String(i + 1).padStart(2, '0')}`,
  score: Math.round((+v.score || 0) * 10) / 10,
  type: String(v.type || '常青').includes('热点') ? '热点' : '常青',
  source: (v.source === '素材' || v.source === 'material') ? '素材' : 'track',
  title: v.title || '',
  angle: v.angle || '',
  why: v.why || '',
  format: v.format || '',
  inspiration: v.inspiration || '',
  style_hint: v.style_hint || '',
}));

// 保留旧灵感库里已写草稿的选题（赛道 + 素材都保留）
const oldIdeas = vault.ideas || [];
const keptIdeas = oldIdeas.filter(v => draftedIds.has(v.id));

vault.ideas = [...newTrackIdeas, ...keptIdeas];
vault.generatedAt = new Date().toISOString();
vault.generatedBy = 'ai_oracle';
fs.writeFileSync(vaultPath, JSON.stringify(vault, null, 2));

console.log(`✓ 灵感库已重写：${vault.ideas.length} 条选题（新增 ${newTrackIdeas.length}，保留已写草稿 ${keptIdeas.length}）`);
console.log(`  tokens: ${j.usage?.total_tokens ?? '?'}`);
