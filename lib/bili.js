/**
 * B 站接口客户端。
 *
 * 只做三件事：看一个视频、刷首页推荐、拼分享文案。
 * 不碰评论、不点赞、不投币 —— 全是只读的 GET。
 *
 * 接口可用性（实测）：
 *   x/web-interface/view          无需签名，稳定
 *   x/web-interface/popular       无需签名，稳定
 *   x/web-interface/ranking/v2    被风控（-352），别用
 *   x/web-interface/wbi/index/top/feed/rcmd  要 wbi 签名，能用
 *
 * wbi 签名：用 nav 返回的 img_url/sub_url 拼出 mixinKey，
 * 参数按 key 排序拼 query，md5(query + mixinKey) 就是 w_rid。
 */

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** wbi 混淆表的固定顺序，B 站前端写死的。 */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const KEY_TTL_MS = 60 * 60 * 1000;
/** 字幕正文缓存有效期。url 一次性，缓存正文比缓存 url 靠谱。 */
const SUB_CACHE_TTL_MS = 30 * 60 * 1000;

/** 12345 → 1.2万 */
export function fmtCount(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v < 10000) return String(v);
  if (v < 100000000) return (v / 10000).toFixed(1).replace(/\\.0$/, '') + '万';
  return (v / 100000000).toFixed(1).replace(/\\.0$/, '') + '亿';
}

/** 去 HTML 实体和 <em> 高亮标签（搜索结果里 B 站会塞 <em class="keyword">） */
export function stripEm(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

/** "3:52" / "1:02:05" → 秒 */
export function parseDurText(s) {
  const parts = String(s ?? '').split(':').map((x) => Number(x) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

/** 232 → 3:52，3725 → 1:02:05 */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec ?? 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
}

/**
 * 字幕轨排序：语言优先（ai-zh > zh-CN > zh-Hans > zh > 其它），
 * 同语言保持接口顺序。
 */
export function rankSubtitleTracks(subs, want = '') {
  const w = String(want ?? '').trim().toLowerCase();
  const rank = (lan) => {
    const s = String(lan ?? '').toLowerCase();
    if (w && (s === w || s.startsWith(w))) return 100;
    if (/^ai-zh/.test(s)) return 90;
    if (/^zh-cn/.test(s) || /^zh-hans/.test(s)) return 85;
    if (/^zh/.test(s)) return 80;
    if (/^ai-/.test(s)) return 60;
    return 10;
  };
  return [...(subs ?? [])].sort((a, b) => rank(b.lan) - rank(a.lan));
}

/**
 * 字幕质量打分。
 *
 *   coverage = 最后一条的时间 / 视频时长
 *   uniq     = 不同内容的条数（占位字幕全是同一句）
 *
 * good 的标准：覆盖率 >= 60% 且不同内容 >= 8 条。
 * 占位字幕（反复「音乐」）覆盖率可能还行，但 uniq 只有 1-2，会被判不合格。
 */
export function subtitleScore(lines, durationSec = 0) {
  const list = Array.isArray(lines) ? lines : [];
  const lastTo = list.length ? Number(list[list.length - 1].to ?? 0) : 0;
  const dur = Number(durationSec ?? 0);
  const coverage = dur > 0 ? Math.min(lastTo / dur, 1) : 1;
  const uniq = new Set(list.map((x) => x.content)).size;
  const good = coverage >= 0.6 && uniq >= 8;
  // 排序用：覆盖率为主，不同内容数为辅
  const total = coverage * 100 + Math.min(uniq, 200) * 0.3;
  return { coverage, uniq, good, total, lastTo };
}

/**
 * 从各种写法里认出视频。认不出返回 null。
 *   BV1y7nf6tEZa / bv1y7nf6teza
 *   av117508812117912 / 117508812117912
 *   https://www.bilibili.com/video/BV1y7nf6tEZa/?p=1
 *   https://b23.tv/xxxxx （短链，要另外解析）
 */
export function parseVideoId(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const bv = s.match(/BV([0-9A-Za-z]{10})/i);
  if (bv) return { bvid: 'BV' + bv[1] };
  const av = s.match(/(?:^|[^0-9A-Za-z])(?:av)?(\d{6,})/i);
  if (av && !/^BV/i.test(s)) return { aid: Number(av[1]) };
  return null;
}

export class BiliClient {
  constructor({ log, cookie, vdSource } = {}) {
    this.log = log;
    this.cookie = String(cookie ?? '').trim();
    this.vdSource = String(vdSource ?? '').trim();
    this.mixinKey = '';
    this.mixinAt = 0;
    this.sessionCookie = '';
    this.subCache = new Map();
  }

  setOptions({ cookie, vdSource } = {}) {
    if (cookie !== undefined) this.cookie = String(cookie ?? '').trim();
    if (vdSource !== undefined) this.vdSource = String(vdSource ?? '').trim();
  }

  async request(url, { retry = 1, okCodes = [] } = {}) {
    const headers = {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    const ck = [this.cookie, this.sessionCookie].filter(Boolean).join('; ');
    if (ck) headers.Cookie = ck;

    let lastErr = null;
    for (let i = 0; i <= retry; i++) {
      try {
        const res = await fetch(url, { headers });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {
          throw new Error('B 站返回的不是 JSON（' + res.status + '），可能被风控了');
        }
        if (json?.code !== 0 && !okCodes.includes(json?.code)) {
          const code = json?.code;
          const msg = json?.message || json?.msg || String(code);
          const hint =
            code === -352 ? '（风控：这个接口没签名或频率太高）' :
            code === -400 ? '（参数不对）' :
            code === -404 ? '（视频不存在或已删除）' :
            code === -101 ? '（要登录，配一下 cookie）' : '';
          const err = new Error('B 站接口报错 ' + code + '：' + msg + hint);
          err.biliCode = code;
          throw err;
        }
        return json.data;
      } catch (e) {
        lastErr = e;
        if (e.biliCode && e.biliCode !== -352) break;
        if (i < retry) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw lastErr;
  }

  /** 字幕 JSON 没有 code 字段，不能走 request() 的校验。 */
  async fetchJson(url) {
    const headers = {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Accept: '*/*',
    };
    const ck = [this.cookie, this.sessionCookie].filter(Boolean).join('; ');
    if (ck) headers.Cookie = ck;
    const res = await fetch(url, { headers });
    const text = await res.text();
    try { return JSON.parse(text); } catch {
      throw new Error('字幕返回的不是 JSON（HTTP ' + res.status + '）');
    }
  }

  /**
   * 拉字幕。
   *
   * 注意：字幕接口必须登录（need_login_subtitle），没 cookie 一律返回空列表。
   * 字幕是 B 站 AI 生成的，通常有 ai-zh / ai-en / ai-ja 等几种语言。
   */
  /**
   * 拉字幕。
   *
   * 两个坑：
   *   1. 必须登录。没 cookie 时接口返回空列表。
   *   2. subtitle_url 是一次性的 —— 同一个 aid+cid 第二次请求，6 种语言全都返回空 url。
   *      所以必须缓存。这里缓存的是解析后的正文，不是 url（url 有 auth_key 时效）。
   */
  /**
   * 拉字幕。
   *
   * 三个坑（都实测过）：
   *   1. 必须登录。没 cookie 时接口返回空列表。
   *   2. subtitle_url 是**一次性**的：同一个 aid+cid 第二次请求，6 种语言全返回空 url。
   *   3. **更要命**：B 站有时返回的是「占位字幕」——只有几条反复的「♪ 音乐 ♪」，
   *      或者干脆是别的视频的字幕。拿它当台词会把整段内容读错。
   *
   * 所以这里不只是"拿第一条"：先按语言挑（ai-zh 优先），拿到后**校验质量**，
   * 质量差就换下一条轨重试，全都差才用最差的那条并明确给 warning。
   * 缓存只存校验通过的，避免把占位内容缓存 30 分钟。
   */
  async subtitle(input, { lang = '', page = 0, withTime = false } = {}) {
    const v = await this.video(input);
    const pages = v.pages ?? [];
    const target = pages[Number(page)] ?? null;
    const cid = target?.cid ?? v.cid;
    if (!cid) throw new Error('这个视频拿不到 cid，没法拉字幕');

    const key = v.aid + ':' + cid;
    const dur = Number(v.durationSec ?? 0);

    // 1) 先吃缓存（只存过校验的）
    const cached = this.subCache.get(key);
    if (cached && Date.now() - cached.at < SUB_CACHE_TTL_MS) {
      const hit = this.pickCachedLang(cached, lang);
      if (hit) return this.buildSubResult(v, cid, target, hit, cached.langs, withTime);
    }

    // 2) 拉字幕轨列表，按质量优先级排序。
    //
    //    坑：B 站有时候只返回一条「占位字幕」——一整段反复的「♪ 音乐 ♪」。
    //    再请求一次往往就恢复正常（实测同一视频第一次 19 条占位、第二次 122 条完整）。
    //    所以这里最多跑 3 轮，拿到合格的立刻停。
    let subs = [];
    let best = null;
    let bestScore = -1;
    const tried = [];

    for (let round = 0; round < 3; round++) {
      subs = await this.fetchSubtitleList(v.aid, cid);
      const ranked = rankSubtitleTracks(subs, lang);

      for (const track of ranked.slice(0, 4)) {
        let url = String(track.subtitle_url ?? '');
        if (!url) continue;
        if (url.startsWith('//')) url = 'https:' + url;
        try {
          const sub = await this.fetchJson(url);
          const body = Array.isArray(sub?.body) ? sub.body : [];
          const lines = body.map((x) => ({
            from: Number(x.from ?? 0),
            to: Number(x.to ?? 0),
            content: String(x.content ?? '').trim(),
          })).filter((x) => x.content);
          if (!lines.length) continue;

          const score = subtitleScore(lines, dur);
          tried.push('第' + (round + 1) + '轮 ' + track.lan + ':' + lines.length + '条/' + Math.round(score.coverage * 100) + '%');
          if (score.total > bestScore) {
            bestScore = score.total;
            best = { track, lines, score };
          }
          if (score.good) break;
        } catch (e) { /* 单轨失败不影响别的轨 */ }
      }

      if (best && best.score.good) break;
      if (round < 2) await new Promise((r) => setTimeout(r, 700));
    }

    if (!best) throw new Error('这个视频没有能用的字幕' + (tried.length ? '（' + tried.slice(-4).join('、') + '）' : ''));

    const entry = {
      lan: best.track.lan,
      langDoc: best.track.lan_doc,
      lines: best.lines,
      plain: best.lines.map((x) => x.content).join(''),
      timeline: best.lines.map((x) => '[' + fmtDuration(x.from) + '] ' + x.content).join(String.fromCharCode(10)),
    };

    const langs = subs.map((x) => ({ lan: x.lan, doc: x.lan_doc }));
    // 只缓存过校验的；占位的也缓存但只缓存 5 分钟，避免反复撞接口
    const ttl = best.score.good ? SUB_CACHE_TTL_MS : 5 * 60 * 1000;
    if (best.score.good) {
      const byLang = { ...(cached?.byLang ?? {}), [best.track.lan]: entry };
      this.subCache.set(key, { at: Date.now(), langs, byLang, ttl });
    }

    const out = this.buildSubResult(v, cid, target, entry, langs, withTime);
    if (!best.score.good && tried.length) out.warning = (out.warning || '') +
      (out.warning ? ' ' : '') + '（试过 ' + tried.join('、') + '，没有一条是完整的）';
    return out;
  }

  buildSubResult(v, cid, target, entry, langs, withTime) {
    const dur = Number(v.durationSec ?? 0);
    const lastTo = entry.lines.length ? entry.lines[entry.lines.length - 1].to : 0;
    const coverage = dur > 0 ? Math.min(lastTo / dur, 1) : 1;

    // B 站不是每个视频都有 AI 字幕。没有的时候会给一段占位内容（反复的「音乐」），
    // 或者只覆盖开头几十秒。这两种都得让模型知道，别拿它当正文。
    const uniq = new Set(entry.lines.map((x) => x.content)).size;
    let warning = '';
    if (uniq <= 3 && entry.lines.length >= 8) {
      warning = '这段字幕是占位内容（只有「' + entry.lines[0].content.slice(0, 12) + '」之类重复），这个视频大概率没有 AI 字幕';
    } else if (coverage < 0.5) {
      warning = '字幕只覆盖到第 ' + Math.round(lastTo) + ' 秒 / 共 ' + dur + ' 秒（' + Math.round(coverage * 100) + '%）。' +
        'B 站对一部分视频根本不生成 AI 字幕，遇到这种情况会返回残缺、甚至是别的视频的字幕 —— 用之前先拿内容和标题对一下。';
    }

    return {
      bvid: v.bvid,
      durationSec: dur,
      coverage: Math.round(coverage * 100) / 100,
      warning,
      aid: v.aid,
      cid,
      title: v.title,
      page: target ? target.page : 1,
      lang: entry.lan,
      langDoc: entry.langDoc,
      languages: langs,
      lines: entry.lines,
      plain: entry.plain,
      timeline: entry.timeline,
      withTime,
      cached: true,
    };
  }

  pickCachedLang(cached, lang) {
    const have = cached.byLang ?? {};
    const want = String(lang ?? '').trim().toLowerCase();
    if (want) {
      if (have[want]) return have[want];
      const hit = Object.keys(have).find((k) => k.toLowerCase().startsWith(want));
      if (hit) return have[hit];
    }
    const zh = Object.keys(have).find((k) => /zh/i.test(k));
    return zh ? have[zh] : (Object.values(have)[0] ?? null);
  }

  /**
   * 拉字幕轨列表。
   *
   * **先走 wbi 签名版**（x/player/wbi/v2），这是 dsh-fish 用的那条路，一次就能拿全。
   * 之前我先试不带签名的 x/player/v2 —— 那条路返回的 subtitle_url 时好时坏，
   * 有时候给的是「占位轨」（一整段反复的♪音乐♪），看起来有字幕其实是废的。
   *
   * 不带签名的只做兜底：签名拿不到时才退回去试一次。
   */
  async fetchSubtitleList(aid, cid) {
    let lastNeedLogin = false;

    // 1) 签名版优先
    try {
      await this.ensureBuvid();
      await this.ensureMixinKey();
      const qs = this.signParams({ aid, cid });
      const data = await this.request('https://api.bilibili.com/x/player/wbi/v2?' + qs, { okCodes: [-400, -404] });
      const subs = data?.subtitle?.subtitles ?? [];
      if (subs.some((s) => s.subtitle_url)) return subs;
      lastNeedLogin = Boolean(data?.need_login_subtitle);
    } catch { /* 签名版失败，落到匿名版 */ }

    // 2) 匿名版兜底
    try {
      const data = await this.request(
        'https://api.bilibili.com/x/player/v2?aid=' + aid + '&cid=' + cid,
        { okCodes: [-400, -404] },
      );
      const subs = data?.subtitle?.subtitles ?? [];
      if (subs.some((s) => s.subtitle_url)) return subs;
      if (data?.need_login_subtitle) lastNeedLogin = true;
    } catch { /* ignore */ }

    if (lastNeedLogin && !this.cookie) {
      throw new Error('这个视频的字幕要登录才能看，先配 cookie');
    }
    throw new Error(lastNeedLogin ? '这个视频没有字幕（它标记了需要登录）' : '这个视频没有字幕');
  }
  /** 选语言：没指定就挑中文，再退到第一条。 */
  pickSubtitle(subs, lang) {
    const want = String(lang ?? '').trim().toLowerCase();
    if (want) {
      const direct = subs.find((x) => String(x.lan).toLowerCase() === want);
      if (direct) return direct;
      const pref = subs.find((x) => String(x.lan).toLowerCase().startsWith(want));
      if (pref) return pref;
    }
    const zh = subs.find((x) => /zh/i.test(String(x.lan)));
    return zh ?? subs[0];
  }
  /** 拿 buvid3，没有它推荐流会空。 */
  async ensureBuvid() {
    if (this.sessionCookie.includes('buvid3=')) return;
    try {
      const res = await fetch('https://www.bilibili.com/', {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
      });
      await res.text();
      const arr = res.headers.getSetCookie?.() ?? [];
      const parts = [];
      for (const c of arr) {
        const kv = c.split(';')[0];
        if (/^(buvid3|buvid4|b_nut|_uuid)=/.test(kv)) parts.push(kv);
      }
      if (parts.length) this.sessionCookie = parts.join('; ');
    } catch (e) {
      this.log?.warn?.('拿 buvid 失败：' + (e?.message ?? e));
    }
  }

  /** 刷新 wbi mixinKey（1 小时过期）。 */
  async ensureMixinKey() {
    if (this.mixinKey && Date.now() - this.mixinAt < KEY_TTL_MS) return;
    // nav 未登录时返回 -101，但 wbi_img 照样给 —— 这是无头账号的正常情况。
    const data = await this.request('https://api.bilibili.com/x/web-interface/nav', { okCodes: [-101] });
    const imgKey = String(data?.wbi_img?.img_url ?? '').split('/').pop()?.split('.')[0] ?? '';
    const subKey = String(data?.wbi_img?.sub_url ?? '').split('/').pop()?.split('.')[0] ?? '';
    if (!imgKey || !subKey) throw new Error('拿不到 wbi key，B 站接口可能改版了');
    const raw = imgKey + subKey;
    let mixin = '';
    for (const i of MIXIN_TAB) mixin += raw[i] ?? '';
    this.mixinKey = mixin.slice(0, 32);
    this.mixinAt = Date.now();
  }

  /** 给参数加 wts 并算 w_rid。 */
  signParams(params) {
    const withTs = { ...params, wts: Math.floor(Date.now() / 1000) };
    const qs = Object.keys(withTs)
      .sort()
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, '')))
      .join('&');
    const w_rid = createHash('md5').update(qs + this.mixinKey).digest('hex');
    return qs + '&w_rid=' + w_rid;
  }

  /**
   * 解析 b23.tv 短链。
   *
   * 坑：用 redirect:'follow' 时 Node 的 fetch 有时**不更新 res.url**，
   * 拿回来还是 b23.tv 那个短链，于是 parseVideoId 认不出、报「认不出这个视频」。
   * 改成 redirect:'manual' 直接读 Location 头，302 一次就到真地址。
   */
  async resolveShortUrl(input) {
    const s = String(input ?? '').trim();
    if (!/b23\.tv/i.test(s)) return s;
    const url = s.startsWith('http') ? s : 'https://' + s;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
        redirect: 'manual',
      });
      await res.text().catch(() => {});
      const loc = res.headers.get('location');
      if (loc && /bilibili\.com/i.test(loc)) return loc;
      if (res.url && /bilibili\.com/i.test(res.url)) return res.url;
    } catch { /* ignore */ }
    // 兜底：跟一次
    try {
      const res2 = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      await res2.text().catch(() => {});
      return res2.url || url;
    } catch { return url; }
  }

  /** 视频详情。传 BV/AV/链接都行。 */
  async video(input) {
    let id = parseVideoId(input);
    if (!id && /b23\.tv/i.test(String(input ?? ''))) {
      const real = await this.resolveShortUrl(input);
      id = parseVideoId(real);
    }
    if (!id) throw new Error('认不出这个视频：' + input + '。给 BV 号、av 号或完整链接。');
    const q = id.bvid ? 'bvid=' + id.bvid : 'aid=' + id.aid;
    const d = await this.request('https://api.bilibili.com/x/web-interface/view?' + q);
    if (!d) throw new Error('B 站没返回视频数据');
    return {
      bvid: d.bvid,
      aid: d.aid,
      title: d.title,
      desc: String(d.desc ?? '').trim(),
      owner: d.owner?.name ?? '',
      ownerMid: d.owner?.mid ?? 0,
      cover: d.pic ?? '',
      duration: d.duration ?? 0,
      durationText: fmtDuration(d.duration),
      pubdate: d.pubdate ?? 0,
      pubdateText: d.pubdate ? new Date(d.pubdate * 1000).toISOString() : '',
      view: d.stat?.view ?? 0,
      viewText: fmtCount(d.stat?.view),
      danmaku: d.stat?.danmaku ?? 0,
      like: d.stat?.like ?? 0,
      coin: d.stat?.coin ?? 0,
      favorite: d.stat?.favorite ?? 0,
      reply: d.stat?.reply ?? 0,
      share: d.stat?.share ?? 0,
      tname: d.tname ?? '',
      cid: d.cid ?? d.pages?.[0]?.cid ?? 0,
      durationSec: Number(d.duration ?? 0),
      pageCount: (d.pages ?? []).length,
      pages: (d.pages ?? []).map((x) => ({ cid: x.cid, page: x.page, part: x.part ?? '', duration: x.duration ?? 0 })),
    };
  }

  /**
   * 首页推荐。
   *
   * 返回的 item 里混着直播、番剧、广告（goto 不是 av），只留普通视频。
   */
  async feed({ count = 12 } = {}) {
    await this.ensureBuvid();
    await this.ensureMixinKey();
    const want = Math.min(Math.max(Number(count) || 12, 1), 30);
    const qs = this.signParams({
      web_location: 1430650,
      y_num: 4,
      fresh_type: 4,
      feed_version: 'V8',
      ps: Math.min(Math.max(want * 3, 12), 30),
    });
    const data = await this.request(
      'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?' + qs,
    );
    const items = Array.isArray(data?.item) ? data.item : [];
    return items
      .filter((it) => it && it.bvid && (it.goto === 'av' || it.goto === undefined))
      .slice(0, want)
      .map((it) => ({
        bvid: it.bvid,
        aid: it.id,
        title: it.title,
        owner: it.owner?.name ?? it.name ?? '',
        duration: it.duration ?? 0,
        durationText: fmtDuration(it.duration),
        view: it.stat?.view ?? 0,
        viewText: fmtCount(it.stat?.view),
        danmaku: it.stat?.danmaku ?? 0,
        like: it.stat?.like ?? 0,
        cover: it.pic ?? '',
        tname: it.tname ?? '',
        pubdate: it.pubdate ?? 0,
      }));
  }

  /** 热门（备用，推荐流出问题时用）。 */
  async popular({ count = 12 } = {}) {
    const want = Math.min(Math.max(Number(count) || 12, 1), 50);
    const data = await this.request(
      'https://api.bilibili.com/x/web-interface/popular?ps=' + want + '&pn=1',
    );
    const list = Array.isArray(data?.list) ? data.list : [];
    return list.map((it) => ({
      bvid: it.bvid,
      aid: it.aid,
      title: it.title,
      owner: it.owner?.name ?? '',
      duration: it.duration ?? 0,
      durationText: fmtDuration(it.duration),
      view: it.stat?.view ?? 0,
      viewText: fmtCount(it.stat?.view),
      cover: it.pic ?? '',
      tname: it.tname ?? '',
      pubdate: it.pubdate ?? 0,
    }));
  }

  /**
   * 搜索视频。**必须 wbi 签名**，而且 Referer 要是搜索结果页，否则 -352。
   */
  async search(keyword, { page = 1, pageSize = 10 } = {}) {
    const kw = String(keyword ?? '').trim().slice(0, 40);
    if (!kw) throw new Error('关键词是空的');
    await this.ensureBuvid();
    await this.ensureMixinKey();
    const n = Math.min(Math.max(Number(pageSize) || 10, 1), 20);
    const qs = this.signParams({
      search_type: 'video',
      keyword: kw,
      page: Math.max(1, Number(page) || 1),
      page_size: n,
    });
    const ck = [this.cookie, this.sessionCookie].filter(Boolean).join('; ');
    const res = await fetch('https://api.bilibili.com/x/web-interface/search/type?' + qs, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(kw),
        Accept: 'application/json, text/plain, */*',
        ...(ck ? { Cookie: ck } : {}),
      },
    });
    const json = await res.json();
    if (json?.code !== 0) throw new Error('B 站搜索报错 ' + json?.code + '：' + (json?.message ?? ''));
    const list = json.data?.result ?? [];
    return list.slice(0, n).map((x) => ({
      bvid: x.bvid,
      aid: x.aid,
      title: stripEm(x.title ?? ''),
      owner: x.author ?? '',
      mid: x.mid ?? 0,
      duration: parseDurText(x.duration),
      durationText: x.duration ?? '',
      view: Number(x.play) || 0,
      viewText: fmtCount(Number(x.play) || 0),
      danmaku: Number(x.video_review) || 0,
      like: 0,
      pubdate: x.pubdate ?? 0,
      cover: String(x.pic ?? '').replace(/^\/\//, 'https://'),
      tname: x.typename ?? '',
      desc: stripEm(x.description ?? ''),
    }));
  }

  /** 相关推荐（看完一条，平台又推什么）。 */
  async related(input, { limit = 10 } = {}) {
    const v = await this.video(input);
    const data = await this.request('https://api.bilibili.com/x/web-interface/archive/related?bvid=' + v.bvid);
    const list = Array.isArray(data) ? data : [];
    return list.slice(0, Math.min(Math.max(Number(limit) || 10, 1), 30)).map((x) => ({
      bvid: x.bvid,
      aid: x.aid,
      title: x.title ?? '',
      owner: x.owner?.name ?? '',
      duration: x.duration ?? 0,
      durationText: fmtDuration(x.duration),
      view: x.stat?.view ?? 0,
      viewText: fmtCount(x.stat?.view),
      tname: x.tname ?? '',
      pubdate: x.pubdate ?? 0,
    }));
  }

  /**
   * 排行榜。rid=0 是全站，其它是分区。
   *
   * 坑：ranking/v2 现在**签名也照样 -352**（2026-10-28 实测，带 wbi 也算风控）。
   * 退回老的 ranking/v1（被 v2 取代但还活着），不带签名就能用。
   */
  async ranking({ rid = 0, limit = 20, day = 3 } = {}) {
    const qs = 'rid=' + (Number(rid) || 0) + '&day=' + (Number(day) || 3) + '&type=1';
    const data = await this.request('https://api.bilibili.com/x/web-interface/ranking?' + qs);
    const list = data?.list ?? [];
    return list.slice(0, Math.min(Math.max(Number(limit) || 20, 1), 50)).map((x) => ({
      bvid: x.bvid,
      aid: x.aid,
      title: x.title ?? '',
      owner: x.owner?.name ?? '',
      duration: x.duration ?? 0,
      durationText: fmtDuration(x.duration),
      view: x.stat?.view ?? 0,
      viewText: fmtCount(x.stat?.view),
      danmaku: x.stat?.danmaku ?? 0,
      tname: x.tname ?? '',
      pubdate: x.pubdate ?? 0,
    }));
  }

  /** 入站必刷（全站老片固定榜，98 条）。 */
  async precious({ pageSize = 20 } = {}) {
    const n = Math.min(Math.max(Number(pageSize) || 20, 1), 50);
    const data = await this.request(
      'https://api.bilibili.com/x/web-interface/popular/precious?page_size=' + n + '&page=1',
    );
    const list = data?.list ?? [];
    return list.map((x) => ({
      bvid: x.bvid,
      aid: x.aid,
      title: x.title ?? '',
      owner: x.owner?.name ?? '',
      duration: x.duration ?? 0,
      durationText: fmtDuration(x.duration),
      view: x.stat?.view ?? 0,
      viewText: fmtCount(x.stat?.view),
      tname: x.tname ?? '',
      pubdate: x.pubdate ?? 0,
    }));
  }

  /** 某条评论下面的楼中楼（B 站只有两层，root 是主评论 rpid）。 */
  async subReplies(input, rootRpid, { limit = 20 } = {}) {
    const v = await this.video(input);
    const n = Math.min(Math.max(Number(limit) || 20, 1), 20);
    const data = await this.request(
      'https://api.bilibili.com/x/v2/reply/reply?type=1&oid=' + v.aid + '&root=' + Number(rootRpid) + '&ps=' + n + '&pn=1',
    );
    const list = data?.replies ?? [];
    return list.map((r) => ({
      rpid: r.rpid ?? 0,
      user: r.member?.uname ?? '',
      uid: r.member?.mid ?? 0,
      text: String(r.content?.message ?? '').trim(),
      like: r.like ?? 0,
      ctime: r.ctime ?? 0,
      ctimeText: r.ctime ? new Date(r.ctime * 1000).toISOString().slice(0, 16).replace('T', ' ') : '',
      isUp: Boolean(r.reply_control?.is_up_top) || Boolean(r.member?.mid === v.aid),
    }));
  }

  /**
   * 用户主页信息（空间名片）。传 mid。
   *
   * 坑：x/space/wbi/acc/info 要 wbi 签名 + Referer 是空间页，
   * **还经常 -403/-799**（B 站对空间接口按账号限流）。失败就退回家底名片。
   */
  async user(mid) {
    const id = Number(mid) || 0;
    if (!id) throw new Error('缺 mid');
    await this.ensureBuvid();
    await this.ensureMixinKey();
    const qs = this.signParams({ mid: id, platform: 'web', web_location: 1550101 });
    const ck = [this.cookie, this.sessionCookie].filter(Boolean).join('; ');
    const res = await fetch('https://api.bilibili.com/x/space/wbi/acc/info?' + qs, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://space.bilibili.com/' + id,
        Accept: 'application/json, text/plain, */*',
        ...(ck ? { Cookie: ck } : {}),
      },
    });
    const json = await res.json();
    if (json?.code !== 0) throw new Error('B 站空间接口报错 ' + json?.code + '：' + (json?.message ?? ''));
    const data = json.data;
    return {
      mid: data?.mid ?? id,
      name: data?.name ?? '',
      sign: data?.sign ?? '',
      level: data?.level ?? 0,
      vip: Boolean(data?.vip?.status),
      face: data?.face ?? '',
      following: data?.following ?? 0,
      follower: data?.fans ?? 0,
    };
  }

  /** 某个用户投过的视频（投稿列表）。同样要签名 + 空间页 Referer。 */
  async userVideos(mid, { page = 1, pageSize = 10 } = {}) {
    const id = Number(mid) || 0;
    if (!id) throw new Error('缺 mid');
    await this.ensureBuvid();
    await this.ensureMixinKey();
    const n = Math.min(Math.max(Number(pageSize) || 10, 1), 30);
    const qs = this.signParams({
      mid: id,
      ps: n,
      pn: Number(page) || 1,
      order: 'pubdate',
      platform: 'web',
      web_location: 1550101,
    });
    const ck2 = [this.cookie, this.sessionCookie].filter(Boolean).join('; ');
    const res2 = await fetch('https://api.bilibili.com/x/space/wbi/arc/search?' + qs, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://space.bilibili.com/' + id + '/video',
        Accept: 'application/json, text/plain, */*',
        ...(ck2 ? { Cookie: ck2 } : {}),
      },
    });
    const json2 = await res2.json();
    if (json2?.code !== 0) throw new Error('B 站投稿接口报错 ' + json2?.code + '：' + (json2?.message ?? ''));
    const data = json2.data;
    const list = data?.list?.vlist ?? [];
    return list.map((x) => ({
      bvid: x.bvid,
      aid: x.aid,
      title: x.title ?? '',
      duration: parseDurText(x.length),
      durationText: String(x.length ?? ''),
      view: Number(x.play) || 0,
      viewText: fmtCount(Number(x.play) || 0),
      danmaku: Number(x.video_review) || 0,
      pubdate: x.created ?? 0,
      desc: String(x.description ?? '').slice(0, 120),
    }));
  }

  /** 我的收藏夹列表。**要登录**。 */
  async favFolders({ mid = 0 } = {}) {
    const me = Number(mid) || (await this.whoami()).mid;
    if (!me) throw new Error('拿不到自己的 mid，cookie 可能失效了');
    const data = await this.request('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + me);
    const list = data?.list ?? [];
    return list.map((f) => ({
      id: f.id,
      title: f.title ?? '',
      mediaCount: f.media_count ?? 0,
      favState: f.fav_state ?? 0,
    }));
  }

  /** 某个收藏夹里的视频。**要登录**（私密夹也要）。 */
  async favMedia(folderId, { page = 1, pageSize = 20 } = {}) {
    const fid = Number(folderId);
    if (!fid) throw new Error('缺收藏夹 id');
    const n = Math.min(Math.max(Number(pageSize) || 20, 1), 20);
    const data = await this.request(
      'https://api.bilibili.com/x/v3/fav/resource/list?media_id=' + fid + '&ps=' + n + '&pn=' + (Number(page) || 1) + '&platform=web',
    );
    const list = data?.medias ?? [];
    return list.map((x) => ({
      bvid: x.bvid,
      aid: x.id ?? 0,
      title: x.title ?? '',
      owner: x.upper?.name ?? '',
      duration: x.duration ?? 0,
      durationText: fmtDuration(x.duration),
      view: x.cnt_info?.play ?? 0,
      viewText: fmtCount(x.cnt_info?.play ?? 0),
      intro: String(x.intro ?? '').slice(0, 100),
      pubtime: x.pubtime ?? 0,
      favTime: x.fav_time ?? 0,
    }));
  }

  /** 观看历史（最近一批）。**要登录**。 */
  async history({ pageSize = 20 } = {}) {
    const n = Math.min(Math.max(Number(pageSize) || 20, 1), 30);
    const data = await this.request('https://api.bilibili.com/x/web-interface/history/cursor?ps=' + n + '&type=archive');
    const list = data?.list ?? [];
    return list.map((x) => ({
      bvid: x.history?.bvid ?? '',
      title: x.title ?? '',
      owner: x.author_name ?? '',
      duration: x.duration ?? 0,
      durationText: fmtDuration(x.duration),
      progress: x.progress ?? 0,
      progressText: fmtDuration(x.progress ?? 0),
      viewedAt: x.view_at ?? 0,
      viewedAtText: x.view_at ? new Date(x.view_at * 1000).toISOString().slice(0, 16).replace('T', ' ') : '',
    })).filter((x) => x.bvid);
  }

  /** 当前登录状态（cookie 有没有效）。 */
  async whoami() {
    const data = await this.request('https://api.bilibili.com/x/web-interface/nav', { okCodes: [-101] });
    return {
      isLogin: Boolean(data?.isLogin),
      uname: data?.uname ?? '',
      mid: data?.mid ?? 0,
      vip: Boolean(data?.vipStatus),
      money: data?.money ?? 0,
    };
  }

  /**
   * 取播放地址。**只用来抽几帧看画面**，不下载整段视频。
   *
   * fnval=16 → DASH（视频轨与音频轨分开），我们只要视频轨，音频一点都不要。
   * 返回的 url 带有效期（约两小时），并且要 Referer + UA + cookie 才拉得动 ——
   * 这三样由 media.js 拼进 ffmpeg 的 -headers。
   */
  async playurl(input, { page = 0, qn = 64 } = {}) {
    const v = await this.video(input);
    const pages = v.pages ?? [];
    const idx = Math.min(Math.max(Number(page) || 0, 0), Math.max(pages.length - 1, 0));
    const cid = pages[idx]?.cid ?? v.cid;
    if (!cid) throw new Error('取不到分P信息（cid）');
    const qs = 'bvid=' + v.bvid + '&cid=' + cid + '&qn=' + qn + '&fnval=16&fourk=0';
    const d = await this.request('https://api.bilibili.com/x/player/playurl?' + qs);
    const track = d?.dash?.video?.[0];
    const url = track?.baseUrl ?? track?.base_url ?? d?.durl?.[0]?.url ?? '';
    if (!url) throw new Error('没有可用的视频地址（可能要登录，或这条视频有地区限制）');
    return {
      bvid: v.bvid,
      cid,
      url,
      duration: d?.timelength ? d.timelength / 1000 : Number(v.duration ?? 0),
      width: track?.width ?? 0,
      height: track?.height ?? 0,
      title: v.title,
      backUrl: track?.backupUrl?.[0] ?? track?.backup_url?.[0] ?? '',
    };
  }

  /**
   * 拉评论（第一页，热门排序）。
   *
   * 走 x/v2/reply/wbi/main，要 wbi 签名；返回的 replies 里 rpid 是评论 id。
   * 只读，不点赞不回复。
   */
  async comments(input, { sort = 'hot', limit = 20 } = {}) {
    const v = await this.video(input);
    await this.ensureBuvid();
    await this.ensureMixinKey();
    const mode = sort === 'new' ? 2 : 3;
    const want = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const qs = this.signParams({
      oid: v.aid,
      type: 1,
      mode,
      pagination_str: '{"offset":""}',
      plat: 1,
      web_location: 1315875,
    });
    const data = await this.request('https://api.bilibili.com/x/v2/reply/wbi/main?' + qs);
    const reps = Array.isArray(data?.replies) ? data.replies : [];
    return reps.slice(0, want).map((r) => ({
      rpid: r.rpid ?? 0,
      user: r.member?.uname ?? '',
      uid: r.member?.mid ?? 0,
      text: String(r.content?.message ?? '').trim(),
      like: r.like ?? 0,
      replyCount: r.rcount ?? 0,
      ctime: r.ctime ?? 0,
      ctimeText: r.ctime ? new Date(r.ctime * 1000).toISOString().slice(0, 16).replace('T', ' ') : '',
      location: (r.reply_control?.location ?? ''),
    }));
  }

  /**
   * 拉弹幕。
   *
   * 走 x/v1/dm/list.so?oid=<cid>，返回的是 **raw deflate** 压缩的 XML（不是 gzip）。
   * 别忘了 Referer，不然 412。
   */
  async danmaku(input, { page = 0, limit = 500 } = {}) {
    const v = await this.video(input);
    const pages = v.pages ?? [];
    const idx = Math.min(Math.max(Number(page) || 0, 0), Math.max(pages.length - 1, 0));
    const cid = pages[idx]?.cid ?? v.cid;
    if (!cid) throw new Error('拿不到 cid，拉不了弹幕');
    const ck = [this.cookie, this.sessionCookie].filter(Boolean).join('; ');
    const res = await fetch('https://api.bilibili.com/x/v1/dm/list.so?oid=' + cid, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/video/' + v.bvid,
        ...(ck ? { Cookie: ck } : {}),
      },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let xml = '';
    try { xml = inflateRawSync(buf).toString('utf8'); } catch { xml = buf.toString('utf8'); }
    const want = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const out = [];
    for (const m of xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)) {
      const parts = m[1].split(',');
      out.push({
        time: Number(parts[0] ?? 0),
        mode: Number(parts[1] ?? 0),
        size: Number(parts[2] ?? 0),
        color: Number(parts[3] ?? 0),
        ts: Number(parts[4] ?? 0),
        text: m[2],
      });
      if (out.length >= want) break;
    }
    // 按时间排，方便配合字幕对位
    out.sort((a, b) => a.time - b.time);
    return { cid, total: out.length, list: out };
  }

  /** 视频标签（比分区细，能看出内容画像）。 */
  async tags(input) {
    const v = await this.video(input);
    const data = await this.request('https://api.bilibili.com/x/tag/archive/tags?bvid=' + v.bvid);
    const list = Array.isArray(data) ? data : [];
    return list.map((t) => ({ name: t.tag_name ?? '', id: t.tag_id ?? 0 }));
  }

  /**
   * 分享链接。用户要的格式就长这样：
   *   【标题】 https://www.bilibili.com/video/BVxxx/?share_source=copy_web&vd_source=xxx
   */
  shareUrl(bvid) {
    const u = 'https://www.bilibili.com/video/' + bvid + '/?share_source=copy_web';
    return this.vdSource ? u + '&vd_source=' + this.vdSource : u;
  }

  /** 拼分享文案。 */
  shareText(v, { withDesc = false } = {}) {
    const head = '【' + v.title + '】 ' + this.shareUrl(v.bvid);
    if (!withDesc) return head;
    const lines = [head, ''];
    lines.push('UP：' + v.owner + ' ｜ ' + v.durationText + ' ｜ ' + v.viewText + ' 播放');
    if (v.desc) lines.push('', v.desc.slice(0, 300));
    return lines.join('\n');
  }
}