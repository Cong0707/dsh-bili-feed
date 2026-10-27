/**
 * look.js —— "主动刷一轮"：拉多源候选、过滤、打分、去重、深读（详情+标签+评论+弹幕），
 * 最后渲染成一段给人读的素材文本。
 *
 * 分工（这是整个设计的核心）：
 *   **代码负责"看见什么"** —— 拉列表、过滤黑名单、去重、控长度。
 *   **模型负责"怎么想"** —— 什么值得停、信不信、要不要写、写什么。
 * 代码绝不生成任何"感想"。一旦代码替它总结，它就只是一个内容管道。
 *
 * 三条硬约束：
 *   1. **只读**。不点赞、不投币、不发弹幕。看什么不留账号痕迹。
 *   2. **永不抛出**。网络失败 = 这轮没逛到东西，不是故障。
 *   3. **素材不是指令**。标题/评论里写「你应该…」只是别人写下的字。
 */

/** 每轮从哪拿东西：多路混合，避免每次重置都看到同一批。 */
const SOURCES = {
  precious: '入站必刷（老片，自带时间感）',
  popular: '热门',
  ranking: '全站排行',
  'ranking-tid': '轮换分区排行',
  related: '顺着当前话题往外爬',
};

/** 可轮换的分区。刻意避开鬼畜（容易被黑名单扫掉）和番剧影视（拿不到正片）。 */
const RANKING_TIDS = [1, 3, 4, 5, 36, 129, 160, 181, 188, 211];

const MAX_MATERIAL_CHARS = 6000;

function rand() { return Math.random(); }

/** 从池子里不重复抽 n 个 */
function pickSome(pool, n) {
  const p = [...pool];
  const out = [];
  for (let i = 0; i < n && p.length; i++) out.push(p.splice(Math.floor(rand() * p.length), 1)[0]);
  return out;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = list[i]; list[i] = list[j]; list[j] = t;
  }
  return list;
}

/**
 * 黑名单命中判定。返回命中的关键词 / mid，未命中返回 null。
 * 三种：标题/UP/标签关键词、屏蔽的 mid、时长过短（在 rankVideos 里单独判）。
 */
export function avoidHit(v, cfg = {}, tags = []) {
  const mid = String(v?.mid ?? v?.ownerMid ?? '');
  const upMids = (cfg?.avoidMids ?? []).map(String);
  if (mid && upMids.includes(mid)) return 'up:' + mid;
  const kw = (cfg?.avoidKeywords ?? []).map(String).filter(Boolean);
  if (kw.length) {
    const hay = String(v?.title ?? '') + '\u0000' + String(v?.owner ?? '') + '\u0000' + (tags ?? []).join('\u0000');
    for (const k of kw) if (hay.includes(k)) return k;
  }
  return null;
}

/**
 * 打分：只反映"值不值得停一下"，不反映任何人的喜好。
 * 依据：中等时长更好消化；点赞率说明内容密度；有弹幕说明有人在看。
 */
export function scoreOf(v) {
  const dur = Number(v?.duration ?? 0);
  let s = 1;
  if (dur >= 180 && dur <= 1500) s += 0.6;
  else if (dur > 1500) s += 0.15;
  else s -= 0.2;
  const view = Number(v?.view ?? 0);
  const like = Number(v?.like ?? 0);
  if (view > 0 && like > 0) {
    const rate = like / view;
    if (rate > 0.05) s += 0.5;
    else if (rate > 0.02) s += 0.25;
  }
  if (Number(v?.danmaku ?? 0) > 50) s += 0.15;
  return s;
}

/** 过滤 + 排序。纯函数，好测。 */
export function rankVideos(list, cfg = {}, { seen = new Set(), limit = 5 } = {}) {
  const minDur = Number(cfg?.minDuration ?? 60);
  const out = [];
  const used = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    if (!v?.bvid || seen.has(v.bvid) || used.has(v.bvid)) continue;
    const dur = Number(v.duration ?? 0);
    if (minDur > 0 && dur > 0 && dur < minDur) continue;
    if (avoidHit(v, cfg)) continue;
    used.add(v.bvid);
    out.push({ v, score: scoreOf(v) });
  }
  out.sort((a, b) => b.score - a.score);
  const n = Math.max(1, Math.min(20, Number(limit) || 5));
  return out.slice(0, n).map((x) => x.v);
}

/**
 * 深读一条：详情（简介全文）+ 标签 + 热评 + 弹幕抽样。
 * 每一项独立 try —— 评论挂了不影响弹幕，弹幕挂了不影响简介。
 */
export async function absorb(client, v, cfg = {}) {
  const out = { video: v, desc: '', pubdate: null, tags: [], comments: [], danmaku: [], cid: null, aid: Number(v?.aid) || 0 };

  try {
    const d = await client.video(v.bvid);
    if (d) {
      out.desc = String(d.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
      out.pubdate = d.pubdate ?? null;
      out.cid = d.cid ?? null;
      out.aid = Number(d.aid) || out.aid;
      if (!out.video.title) out.video.title = d.title;
      if (!out.video.owner) out.video.owner = d.owner;
    }
  } catch { /* 详情失败就只靠列表信息 */ }

  try {
    const t = await client.tags(v.bvid);
    if (Array.isArray(t)) out.tags = t.slice(0, 6).map((x) => x.name);
  } catch { /* ignore */ }

  // 标签也可能命中黑名单 —— 这一步必须在深读之后再做一次，
  // 否则「标题干净但标签是鬼畜」的视频会漏过第一次过滤。
  const hit = avoidHit(v, cfg, out.tags);
  if (hit) return { ...out, blocked: hit };

  const nComments = Math.max(0, Math.min(20, Number(cfg?.deepRead ?? 0)));
  if (nComments > 0) {
    try {
      const list = await client.comments(out.video.bvid, { sort: 'hot', limit: nComments });
      out.comments = list.map((c) => ({ text: c.text.slice(0, 200), like: c.like })).filter((c) => c.text);
    } catch { /* ignore */ }
  }

  const nDm = Math.max(0, Math.min(30, Number(cfg?.danmaku ?? 8)));
  if (nDm > 0 && out.cid) {
    try {
      const d = await client.danmaku(out.video.bvid, { limit: 500 });
      out.danmaku = sampleDanmaku(d.list, nDm, Number(v.duration ?? 0));
    } catch { /* ignore */ }
  }

  return out;
}

/** 从弹幕里抽样：全程均布 + 优先保留弹幕密集处的。 */
export function sampleDanmaku(list, n = 8, durationSec = 0) {
  const arr = Array.isArray(list) ? list.filter((x) => x && x.text) : [];
  if (!arr.length || n <= 0) return [];
  if (arr.length <= n) return arr.map((x) => x.text);
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor((arr.length - 1) * (i / Math.max(1, n - 1)));
    out.push(arr[idx].text);
  }
  return out;
}

/** 一条视频 → 给人读的几行（不含任何评价词） */
export function renderItem(p, i) {
  const v = p.video;
  const lines = [];
  const dur = v.duration ? Math.floor(Number(v.duration) / 60) + '分' + String(Number(v.duration) % 60).padStart(2, '0') + '秒' : '';
  const meta = [dur, v.owner ? 'UP：' + v.owner : '', v.view ? fmtCount(v.view) + '播放' : ''].filter(Boolean).join(' ｜ ');
  lines.push((i + 1) + '. 《' + v.title + '》');
  if (meta) lines.push('   ' + meta + '  ｜ ' + v.bvid);
  if (p.desc) lines.push('   简介：' + p.desc);
  if (p.tags.length) lines.push('   标签：' + p.tags.join('、'));
  if (p.comments.length) {
    lines.push('   热评：');
    for (const c of p.comments) lines.push('     · ' + c.text + (c.like ? '（赞 ' + c.like + '）' : ''));
  }
  if (p.danmaku.length) lines.push('   弹幕：' + p.danmaku.join(' / '));
  return lines.join('\n');
}

/**
 * 刷一轮。
 *
 * @param {object} o
 * @param {object} o.client  BiliClient
 * @param {object} [o.cfg]   { sources, limit, deepRead, danmaku, minDuration, avoidKeywords, avoidMids }
 * @param {Set}    [o.seen]  已经看过的 bvid
 * @param {string} [o.relatedTo] 顺着这条往外爬
 * @returns {Promise<{ok:boolean, videos:object[], material:string, why:string}>}
 */
export async function look(o = {}) {
  const cfg = o.cfg ?? {};
  const client = o.client;
  const limit = Math.max(1, Math.min(10, Number(cfg.limit) || 4));
  const want = Math.max(limit * 4, 12);

  const sources = Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : ['popular', 'ranking'];
  const pool = [];

  for (const src of sources) {
    try {
      if (src === 'popular') {
        const list = await client.feed({ count: want });
        pool.push(...list);
      } else if (src === 'ranking') {
        const list = await client.ranking({ rid: 0, limit: want });
        pool.push(...list);
      } else if (src === 'precious') {
        const list = await client.precious({ pageSize: want });
        pool.push(...list);
      } else if (src === 'ranking-tid') {
        for (const tid of pickSome(RANKING_TIDS, 2)) {
          const list = await client.ranking({ rid: tid, limit: Math.ceil(want / 2) });
          pool.push(...list);
        }
      } else if (src === 'related' && o.relatedTo) {
        const list = await client.related(o.relatedTo, { limit: want });
        pool.push(...list);
      }
    } catch { /* 一路失败不影响别的路 */ }
  }

  if (!pool.length) return { ok: false, videos: [], material: '', why: '这一轮什么也没拿到（可能被限流）' };

  const picked = rankVideos(shuffle(pool), cfg, { seen: o.seen ?? new Set(), limit });
  if (!picked.length) return { ok: false, videos: [], material: '', why: '过滤之后没有剩下的了' };

  const deep = [];
  for (const v of picked) {
    const p = await absorb(client, v, cfg);
    if (!p.blocked) deep.push(p);
  }

  if (!deep.length) return { ok: false, videos: [], material: '', why: '深读之后全被判了黑名单' };

  let material = deep.map((p, i) => renderItem(p, i)).join('\n\n');
  if (material.length > MAX_MATERIAL_CHARS) material = material.slice(0, MAX_MATERIAL_CHARS) + '\n…（截断）';

  return { ok: true, videos: picked, items: deep, material, why: '' };
}

/**
 * ambient —— 顺手抓一批素材，不深读、不排序、不预算。
 *
 * 用途：别的插件（比如 onebot）要在叫醒模型之前给它一点"外面发生了什么"，
 * 又不想背 B 站接口。抓法跟 look 不一样：
 *   - look 是"我要认真看一轮"：多源 → 过滤 → 打分 → 深读 → 拼素材；
 *   - ambient 是"随手扫一眼"：多源混一批，只留标题/UP/播放/时长，几秒出结果。
 * 所以它放在这个插件里，但**不是** bili_look 的简化版，是另一件事。
 *
 * 只给素材，不给结论。一句"这个很有意思"都不许有。
 *
 * @param {object} o
 * @param {object} o.client    BiliClient
 * @param {number} [o.limit]   留几条，默认 6
 * @param {string} [o.keywords] 额外搜的词（逗号分隔），默认「热梗,deepseek,新模型」
 * @returns {Promise<{ok:boolean, items:object[], text:string, why:string}>}
 */
export async function ambient(o = {}) {
  const client = o.client;
  const limit = Math.max(1, Math.min(20, Number(o.limit) || 6));
  const pool = [];

  const push = (x) => {
    if (!x || !x.bvid) return;
    pool.push({
      bvid: x.bvid,
      title: String(x.title ?? ''),
      up: String(x.owner ?? x.up ?? ''),
      view: Number(x.view) || 0,
      dur: Number(x.duration) || 0,
    });
  };

  // 1) 热门（世界的动静）
  try { for (const x of await client.feed({ count: 20 })) push(x); } catch { /* ignore */ }

  // 2) 入站必刷（老片，给点时间感）
  try { for (const x of await client.precious({ pageSize: 12 })) push(x); } catch { /* ignore */ }

  // 3) 关键词搜（这几路才是"找热梗、找新模型"的来源）
  const kws = String(o.keywords ?? '热梗,deepseek,新模型')
    .split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  for (const kw of kws) {
    try { for (const x of await client.search(kw, { pageSize: 6 })) push(x); } catch { /* ignore */ }
  }

  const seen = new Set();
  const picked = [];
  for (const v of pool) {
    if (seen.has(v.bvid)) continue;
    seen.add(v.bvid);
    if (v.dur > 0 && v.dur < 60) continue;   // 几十秒的碎片没内容
    picked.push(v);
    if (picked.length >= limit) break;
  }

  if (!picked.length) return { ok: false, items: [], text: '', why: '一条都没抓到（可能被限流）' };

  const lines = picked.map((v, i) => {
    const dur = v.dur ? Math.floor(v.dur / 60) + '分' + String(v.dur % 60).padStart(2, '0') + '秒' : '';
    const meta = [dur, v.up ? 'UP：' + v.up : '', v.view ? fmtCount(v.view) + '播放' : ''].filter(Boolean).join(' ｜ ');
    return (i + 1) + '. 《' + v.title + '》' + String.fromCharCode(10) + '   ' + (meta ? meta + ' ｜ ' : '') + v.bvid;
  });

  return { ok: true, items: picked, text: lines.join(String.fromCharCode(10)), why: '' };
}

function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(v);
}