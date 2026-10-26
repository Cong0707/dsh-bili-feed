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

/** 12345 → 1.2万 */
export function fmtCount(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v < 10000) return String(v);
  if (v < 100000000) return (v / 10000).toFixed(1).replace(/\\.0$/, '') + '万';
  return (v / 100000000).toFixed(1).replace(/\\.0$/, '') + '亿';
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

  /** 解析 b23.tv 短链。 */
  async resolveShortUrl(input) {
    const s = String(input ?? '').trim();
    if (!/b23\\.tv/i.test(s)) return s;
    const url = s.startsWith('http') ? s : 'https://' + s;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    });
    await res.text().catch(() => {});
    return res.url || url;
  }

  /** 视频详情。传 BV/AV/链接都行。 */
  async video(input) {
    let id = parseVideoId(input);
    if (!id && /b23\\.tv/i.test(String(input ?? ''))) {
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
      pages: (d.pages ?? []).length,
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
