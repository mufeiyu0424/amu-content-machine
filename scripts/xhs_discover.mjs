// 小红书 creator discovery via TikHub.
//
// Searches each keyword, collects note authors, ranks by keyword-breadth (how many
// distinct beats a creator surfaces under) then engagement. Breadth is the signal —
// it separates durable voices from single viral posts.
//
// Cost: $0.001/request. 20 keywords = $0.02/run. Takes ~2 min.
// Usage: node scripts/xhs_discover.mjs   →  writes xhs_authors.json
//
// Two hard-won constraints, do not remove:
//   1. The 4s sleep between calls. TikHub 429s aggressively; without pacing,
//      15 of 20 calls fail.
//   2. Keywords must contain NO spaces. 'AI产品经理' works, 'AI 产品经理' → HTTP 400.

import fs from 'node:fs';
import path from 'node:path';

// Key is read from the repo-root .env.local (see .env.example), or TIKHUB_ENV_PATH.
const ENV_PATH = process.env.TIKHUB_ENV_PATH
  || path.resolve(import.meta.dirname, '../.env.local');

let KEY = process.env.TIKHUB_API_KEY;
if (!KEY) {
  if (!fs.existsSync(ENV_PATH)) {
    console.error(`No TIKHUB_API_KEY set and no env file at ${ENV_PATH}`);
    console.error('Set TIKHUB_API_KEY, or point TIKHUB_ENV_PATH at a file containing it.');
    process.exit(1);
  }
  const m = fs.readFileSync(ENV_PATH, 'utf8').match(/^TIKHUB_API_KEY=(.*)$/m);
  if (!m) { console.error(`TIKHUB_API_KEY not found in ${ENV_PATH}`); process.exit(1); }
  KEY = m[1];
}
KEY = KEY.trim().replace(/^["']|["']$/g, '');
const H = { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const BASE = 'https://api.tikhub.io';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// no spaces — spaces appeared to trigger HTTP 400
// Keywords can be overridden via CLI (comma-separated): node xhs_discover.mjs "治愈,情绪价值"
const DEFAULT_KEYWORDS = [
  '独居vlog', '男生独居', '下班后的生活', '治愈系vlog', '生活方式',
  '打工人下班', '独居日记', '生活感悟', '自我疗愈', '情绪文案',
  '宅家日常', '独居生活',
];
const KEYWORDS = process.argv[2]
  ? process.argv[2].split(/[,，]/).map(s => s.trim()).filter(Boolean)
  : DEFAULT_KEYWORDS;
if (KEYWORDS.some(k => k.includes(' '))) { console.error('Keywords must contain no spaces.'); process.exit(1); }
console.log(`Keywords (${KEYWORDS.length}): ${KEYWORDS.join(', ')}`);

const authors = new Map();
let calls = 0, notes = 0, ok = [], errs = [];

async function search(kw, attempt = 1) {
  const url = `${BASE}/api/v1/xiaohongshu/app_v2/search_notes?keyword=${encodeURIComponent(kw)}&page=1&sort=general`;
  try {
    const r = await fetch(url, { headers: H });
    calls++;
    if (r.status === 429 && attempt <= 4) { await sleep(8000 * attempt); return search(kw, attempt + 1); }
    if (!r.ok) { errs.push(`${kw}: HTTP ${r.status}`); return; }
    const j = await r.json();
    const items = (j?.data?.data?.items || []).filter(x => x?.note);
    if (!items.length) { errs.push(`${kw}: 0 items`); return; }
    ok.push(`${kw}:${items.length}`);
    for (const it of items) {
      const n = it.note, u = n.user || {};
      const name = u.nickname || u.nick_name;
      if (!name) continue;
      notes++;
      const id = u.userid || u.user_id || u.id || name;
      const avatar = String(u.images || u.image || u.avatar || '').split('?')[0];
      if (!authors.has(id)) authors.set(id, { name, id, avatar, hits: 0, eng: 0, col: 0, kws: new Set(), titles: [], vid: 0, img: 0 });
      const a = authors.get(id);
      if (!a.avatar && avatar) a.avatar = avatar;
      a.hits++;
      a.eng += Number(n.liked_count) || 0;
      a.col += Number(n.collected_count) || 0;
      // rough content-type tally from search results, so the dashboard can
      // filter video vs image authors without paying for a deep-pull.
      if (String(n.type || '').toLowerCase() === 'video') a.vid++; else a.img++;
      a.kws.add(kw);
      const t = n.title && String(n.title).slice(0, 62);
      if (t && a.titles.length < 5 && !a.titles.includes(t)) a.titles.push(t);
    }
  } catch (e) { errs.push(`${kw}: ${e.message}`); }
}

for (const kw of KEYWORDS) { await search(kw); await sleep(4000); }

// Merge with any existing discovery list so multiple keyword rounds accumulate
// instead of overwriting each other.
if (fs.existsSync('xhs_authors.json')) {
  try {
    for (const prev of JSON.parse(fs.readFileSync('xhs_authors.json', 'utf8'))) {
      if (!authors.has(prev.id)) {
        authors.set(prev.id, { ...prev, kws: new Set(prev.kws || []) });
      } else {
        const a = authors.get(prev.id);
        for (const k of prev.kws || []) a.kws.add(k);
      }
    }
  } catch {}
}

const ranked = [...authors.values()]
  .map(a => ({ ...a, kws: [...a.kws], score: a.kws.length * 20000 + a.eng + a.col }))
  .sort((x, y) => y.score - x.score);

// Apply the creator blacklist (see sources/creator-quality.md for the standard):
// pure-cooking accounts and non-video accounts that slipped past discovery get
// permanently excluded here, even if they rank high on engagement.
let blacklist = { ids: [], names: [] };
try { blacklist = JSON.parse(fs.readFileSync('sources/creator-blacklist.json', 'utf8')); } catch {}
const blockedIds = new Set(blacklist.ids || []);
const blockedNames = new Set(blacklist.names || []);
const finalRanked = ranked.filter(a => !blockedIds.has(a.id) && !blockedNames.has(a.name));
const blocked = ranked.length - finalRanked.length;
if (blocked) console.log(`Blacklist: excluded ${blocked} author(s) per sources/creator-blacklist.json`);

fs.writeFileSync('xhs_authors.json', JSON.stringify(finalRanked, null, 1));
console.log(JSON.stringify({ calls, notes, uniqueAuthors: finalRanked.length, ok, errs }, null, 1));
console.log('--- TOP 40 ---');
for (const a of finalRanked.slice(0, 40)) {
  console.log(`${a.name} | kw=${a.kws.join(',')} | hits=${a.hits} | 赞${a.eng} 藏${a.col}`);
  console.log(`   ${a.titles.join(' / ')}`);
}
