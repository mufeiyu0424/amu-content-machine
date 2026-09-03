// Generate a draft for ONE idea via the configured LLM (DeepSeek / Kimi …),
// grounded in the voice guide.
// Reads drafts/index.json (keyed by ideaId), vault/vault.json (idea title),
// voice/voice-guide.md (writing style), prompts/draft.md (rules).
//
// Usage: node scripts/ai_draft.mjs <ideaId> [model]
// Env: 见 scripts/lib/ai.mjs（各厂商 Key 从 .env.local 读）

import fs from 'node:fs';
import path from 'node:path';
import { MODELS, chatOnce, resolveProvider } from './lib/ai.mjs';

const root = path.resolve(import.meta.dirname, '..');
const ideaId = (process.argv[2] || '').trim();
if (!ideaId) { console.error('✗ 缺少 ideaId 参数'); process.exit(1); }
const model = MODELS.includes(process.argv[3]) ? process.argv[3] : 'deepseek-v4-flash';

// idea title + angle + style_hint + format from vault
let idea = ideaId, angle = '', styleHint = '', format = '';
try {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vault', 'vault.json'), 'utf8'));
  const it = (v.ideas || []).find(x => x.id === ideaId);
  if (it) { idea = it.title || it.idea || ideaId; angle = it.angle || ''; styleHint = it.style_hint || ''; format = it.format || ''; }
} catch {}

// voice guide (may be empty / still a template)
let voice = '';
const vg = path.join(root, 'voice', 'voice-guide.md');
if (fs.existsSync(vg)) {
  const t = fs.readFileSync(vg, 'utf8');
  if (!/NOT YET GENERATED/.test(t)) voice = t;
}

// ── 借鉴博主风格（蒸馏档案 style_hint，四层优先级）────────────────────
function loadStyles() {
  const out = {};
  const dir = path.join(root, 'styles');
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const name = a?.博主?.name || f.replace(/\.json$/, '');
      if (name) out[name] = a;
    } catch {}
  }
  return out;
}

function archiveToText(a) {
  if (!a || typeof a !== 'object') return '';
  const b = a.博主 || {};
  const cog = a.认知层 || {};
  const con = a.内容层 || {};
  const dna = con.语言DNA || {};
  const lines = [`## 参考博主风格：${b.name || ''}（完整蒸馏档案，务必贴合）`];
  if (b.定位) lines.push(`定位：${b.定位}`);
  if (b.底层公式) lines.push(`底层公式：${b.底层公式}`);
  if (Array.isArray(cog.核心信念) && cog.核心信念.length) lines.push('', '【核心信念】', ...cog.核心信念.map(x => `- ${x}`));
  if (Array.isArray(con.标题公式) && con.标题公式.length) lines.push('', '【标题公式】', ...con.标题公式.map(x => `- ${x.名称}：${x.模板}（例：${x.示例}）`));
  if (Array.isArray(con.开头模板) && con.开头模板.length) lines.push('', '【开头模板】', ...con.开头模板.map(x => `- ${x.名称}：${x.示例 || x.结构 || ''}`));
  if (dna && typeof dna === 'object') {
    lines.push('', '【语言DNA】');
    if (Array.isArray(dna.开场白)) lines.push(`- 开场白：${dna.开场白.join(' / ')}`);
    if (Array.isArray(dna.高频词)) lines.push(`- 高频词：${dna.高频词.join('、')}`);
    if (Array.isArray(dna.收尾)) lines.push(`- 收尾：${dna.收尾.join(' / ')}`);
    if (dna.句式节奏) lines.push(`- 句式：${dna.句式节奏}`);
  }
  if (Array.isArray(a.禁区) && a.禁区.length) lines.push('', '【禁区（不要犯）】', ...a.禁区.map(x => `- ${x}`));
  return lines.join('\n');
}

// 四层优先级：手动 --blogger > style_hint 命中档案 > style_hint 原文 > 无
const styles = loadStyles();
const bloggerArgIdx = process.argv.indexOf('--blogger');
const bloggerArg = bloggerArgIdx >= 0 ? (process.argv[bloggerArgIdx + 1] || '').trim() : '';
let refStyle = '';
if (bloggerArg && styles[bloggerArg]) {
  refStyle = archiveToText(styles[bloggerArg]);
} else if (styleHint) {
  const hit = Object.keys(styles).find(n => styleHint.includes(n));
  refStyle = hit ? archiveToText(styles[hit]) : styleHint;
}

const promptPath = path.join(root, 'prompts', 'draft.md');
if (!fs.existsSync(promptPath)) { console.error('✗ 找不到 prompts/draft.md——先跑 ./scripts/init.sh'); process.exit(1); }
const rules = fs.readFileSync(promptPath, 'utf8');

const userMsg = [
  `## 选题\n${idea}`,
  angle ? `## 角度\n${angle}` : '',
  format ? `## 呈现格式\n${format}` : '',
  refStyle ? `## 借鉴博主风格（参考其手法，不要照抄原文）\n${refStyle}` : '',
  voice ? `## 声音指南（务必贴合这个写作风格）\n${voice}` : '## 声音指南\n（未提供——用自然、口语化的中文短句，治愈系口吻）',
  `## 要求\n按上方起草规则，为这个选题写一版完整草稿。没有访谈材料，所有内容围绕选题本身展开，不要编造具体数字或故事。`,
].filter(Boolean).join('\n\n');

const p = resolveProvider(model);
console.log(`→ 调用 ${p.label} 起草：[${ideaId}] ${idea}（模型 ${model}）`);

let out;
try {
  out = await chatOnce({
    model,
    messages: [
      { role: 'system', content: rules },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.8,
    max_tokens: 32000,
    timeout: 300000,
  });
} catch (e) {
  console.error('✗ ' + e.message);
  process.exit(1);
}
const text = out.text || out.reasoning; // 推理模型偶发 content 空，兜底用思考内容
if (!text) { console.error('✗ 模型返回为空'); process.exit(1); }

// persist into index.json[ideaId]
const idxPath = path.join(root, 'drafts', 'index.json');
const idx = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, 'utf8')) : {};
const prev = idx[ideaId] || {};
const n = (prev.aiGen || 0) + 1;
const now = new Date();
idx[ideaId] = {
  ideaId, idea, angle,
  version: `AI-v${n}`,
  aiGen: n,
  createdAt: prev.createdAt || now.toLocaleDateString('sv-SE'),
  updatedAt: now.toISOString(),
  text,
  revisions: prev.revisions || [],
};
delete idx[ideaId].council; // new draft invalidates old review
fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));

// archive a readable .md copy
const slug = ideaId.replace(/[^\w-]/g, '');
const date = now.toLocaleDateString('sv-SE');
fs.writeFileSync(path.join(root, 'drafts', `${date}-${slug}-AI-v${n}.md`),
  `# 草稿 AI-v${n}：${idea}\n\n- 生成时间：${now.toLocaleString('zh-CN')}\n\n---\n\n${text}\n`);

console.log(`✓ 草稿已生成：[${ideaId}] version = AI-v${n}（${p.label} ${model}）`);
console.log(`  tokens: ${out.usage?.total_tokens ?? '?'}`);
