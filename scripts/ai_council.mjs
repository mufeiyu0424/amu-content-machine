// Run the six-judge Writer's Council on ONE idea's draft via the configured
// LLM (DeepSeek / Kimi …).
// Usage: node scripts/ai_council.mjs <ideaId> [model]
// Env: 见 scripts/lib/ai.mjs（各厂商 Key 从 .env.local 读）

import fs from 'node:fs';
import path from 'node:path';
import { MODELS, chatOnce, resolveProvider } from './lib/ai.mjs';

const root = path.resolve(import.meta.dirname, '..');
const ideaId = (process.argv[2] || '').trim();
if (!ideaId) { console.error('✗ 缺少 ideaId 参数'); process.exit(1); }
const model = MODELS.includes(process.argv[3]) ? process.argv[3] : 'deepseek-v4-pro';

const idxPath = path.join(root, 'drafts', 'index.json');
const idx = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, 'utf8')) : {};
const cur = idx[ideaId];
if (!cur || !(cur.text || '').trim()) { console.error(`✗ [${ideaId}] 还没有草稿——先生成`); process.exit(1); }

const promptPath = path.join(root, 'prompts', 'council.md');
if (!fs.existsSync(promptPath)) { console.error('✗ 找不到 prompts/council.md——先跑 ./scripts/init.sh'); process.exit(1); }
const md = fs.readFileSync(promptPath, 'utf8');

const parts = md.split(/^## 评委 /m);
const shared = parts[0];
const judges = parts.slice(1).map(sec => {
  const header = sec.split('\n')[0];
  const name = header.replace(/^\d+：/, '').trim();
  return { name, prompt: shared + '\n\n## 评委 ' + sec };
});
console.log(`→ 评审团开庭（[${ideaId}] ${cur.idea}，${resolveProvider(model).label} ${model}）：${judges.map(x => x.name).join(' / ')}`);

async function judge({ name, prompt }) {
  // 推理模型偶尔会把 content 返回空（思考吃光额度/并发下不稳定）。
  // 重试最多 3 次；content 空时兜底用 reasoning_content 尾部；仍失败则记 0 分（不计入平均）。
  let out = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await chatOnce({
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `以下是要评审的草稿（选题：${cur.idea}）：\n\n${cur.text}` },
        ],
        temperature: 0.3,
        max_tokens: 32000,
        timeout: 300000,
      });
      out = res.text || '';
      if (!/SCORE/i.test(out) && res.reasoning) out = res.reasoning;
      if (/SCORE/i.test(out)) break;
    } catch (e) {
      if (attempt === 3) { console.log(`  ${name}: ⚠ ${e.message}`); return { name, score: 0, comment: `评审失败：${e.message}` }; }
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
  }
  const grab = k => (out.match(new RegExp(`${k}\\s*[:：]\\s*(.+)`, 'i')) || [])[1]?.trim() || '';
  const scoreRaw = grab('SCORE');
  const score = scoreRaw ? Math.min(10, Math.max(1, parseInt(scoreRaw, 10) || 0)) : 0;
  const comment = [
    grab('STRONGEST') && `✦ 最强：${grab('STRONGEST')}`,
    grab('WEAKEST') && `✧ 最弱：${grab('WEAKEST')}`,
    grab('BLOCKING') && grab('BLOCKING') !== 'none' && `⛔ 必须改：${grab('BLOCKING')}`,
    grab('FIX') && `🛠 改法：${grab('FIX')}`,
  ].filter(Boolean).join('\n');
  if (!score) { console.log(`  ${name}: ⚠ 无有效返回（已重试）`); return { name, score: 0, comment: '⚠ 该评委本次无有效返回' }; }
  console.log(`  ${name}: ${score}/10`);
  return { name, score, comment };
}

const results = await Promise.all(judges.map(j =>
  judge(j).catch(e => ({ name: j.name, score: 0, comment: `评审失败：${e.message}` }))
));

cur.council = results;
cur.councilAt = new Date().toISOString();
fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));

const valid = results.filter(x => x.score > 0);
const avg = valid.length ? (valid.reduce((s, x) => s + x.score, 0) / valid.length).toFixed(1) : '?';
const slop = results.find(x => x.name.includes('AI 味'));
console.log(`✓ 评审完成，综合分 ${avg}/10${slop && slop.score > 0 && slop.score < 7 ? '（AI 味鉴别师行使否决权，需改稿）' : ''}`);
