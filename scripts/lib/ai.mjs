// 统一 AI 调度层：按模型名分派到对应厂商（endpoint + API Key）。
//
// 为什么要抽这一层：
//   - 各 AI 脚本之前各自硬编码 deepseek 的 endpoint 和 DEEPSEEK_API_KEY，
//     每接一家新厂商就得改 5 个文件。现在新增厂商/模型只改本文件。
//   - 密钥一律从 .env.local 读（该文件已 gitignore），绝不写进代码、绝不入库。
//
// 新增一家厂商：在 PROVIDERS 加一项；新增模型：在 MODEL_MAP 加一行。

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

// ── 厂商配置 ──────────────────────────────────────────────────────────
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    envKey: 'DEEPSEEK_API_KEY',
  },
  kimi: {
    label: 'Kimi',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    envKey: 'KIMI_API_KEY',
  },
};

// ── 模型 → 厂商 ───────────────────────────────────────────────────────
const MODEL_MAP = {
  'deepseek-v4-flash': 'deepseek',
  'deepseek-v4-pro': 'deepseek',
  'kimi-k3': 'kimi',
  'kimi-k2.7-code': 'kimi',
  'kimi-k2.7-code-highspeed': 'kimi',
  'kimi-k2.6': 'kimi',
};

// 下拉菜单显示名（带厂商与特性，方便区分）
const MODEL_LABELS = {
  'deepseek-v4-flash': 'DeepSeek V4 Flash（快）',
  'deepseek-v4-pro': 'DeepSeek V4 Pro（强推理）',
  'kimi-k3': 'Kimi K3（1024K 超大上下文）',
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k2.7-code-highspeed': 'Kimi K2.7 Code 高速版',
  'kimi-k2.6': 'Kimi K2.6',
};

export const MODELS = Object.keys(MODEL_MAP);
export const modelLabel = m => MODEL_LABELS[m] || m;
export const MODELS_META = MODELS.map(id => ({
  id,
  label: MODEL_LABELS[id] || id,
  provider: PROVIDERS[MODEL_MAP[id]].label,
}));

export function resolveProvider(model) {
  const pkey = MODEL_MAP[model];
  if (!pkey) return null;
  return { id: pkey, ...PROVIDERS[pkey] };
}

// 同厂商的轻量模型：用于素材提炼这类辅助任务（省钱、快）
const FAST_MODEL = {
  deepseek: 'deepseek-v4-flash',
  kimi: 'kimi-k2.6',
};
export function fastModelFor(model) {
  return FAST_MODEL[MODEL_MAP[model]] || model;
}

// 读 Key：环境变量优先，其次仓库根 .env.local
function readKey(envName) {
  if (process.env[envName]) return process.env[envName].trim();
  const envPath = path.join(root, '.env.local');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8')
      .match(new RegExp('^' + envName + '=(.*)$', 'm'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

/**
 * 统一聊天调用。
 * @returns {Promise<{text:string, reasoning:string, usage:object, raw:object, provider:object}>}
 *   推理模型偶发 content 为空时，reasoning 字段里有思考内容，调用方可兜底。
 */
/**
 * 厂商参数适配：Kimi 的推理模型只接受 temperature=1，
 * 传其它值会 400（invalid temperature: only 1 is allowed）。
 */
function normTemperature(providerId, t) {
  if (providerId === 'kimi') return 1;
  return t;
}

export async function chatOnce({
  model, messages, temperature = 0.7, max_tokens = 32000,
  timeout = 180000, signal,
}) {
  const p = resolveProvider(model);
  if (!p) throw new Error(`未知模型：${model}`);
  const key = readKey(p.envKey);
  if (!key) {
    throw new Error(`找不到 ${p.envKey} —— 请在 .env.local 里配置 ${p.label} 的 Key 才能用 ${model}`);
  }

  const r = await fetch(p.endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature: normTemperature(p.id, temperature),
      max_tokens,
    }),
    signal: signal || AbortSignal.timeout(timeout),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p.label} 报错 ${r.status}：${JSON.stringify(j).slice(0, 400)}`);

  const msg = j.choices?.[0]?.message || {};
  return {
    text: (msg.content || '').trim(),
    reasoning: (msg.reasoning_content || '').trim(),
    usage: j.usage || {},
    raw: j,
    provider: p,
  };
}
