/**
 * bili_* 工具注册。
 *
 * 三个工具，全是只读 GET：
 *   bili_video  看一个视频
 *   bili_feed   刷首页
 *   bili_share  拼分享文案
 */

function text(s) { return [{ type: 'text', text: String(s ?? '') }]; }

export function registerTools({ tools, defineTool, config, log, val, client }) {
  // 每次现读配置，面板改了立刻生效
  const vdSource = () => String(val(config, 'vdSource', '') ?? '').trim();
  const cookie = () => String(val(config, 'cookie', '') ?? '').trim();
  const feedCount = () => Math.min(Math.max(Number(val(config, 'feedCount', '12')) || 12, 1), 30);

  const sync = () => {
    const opts = { vdSource: vdSource() };
    // cookie 空就保留 client 里已有的（可能来自 ~/.dsh/plugins-data/bili-feed/cookie.txt）
    const ck = cookie();
    if (ck) opts.cookie = ck;
    client.setOptions(opts);
    return client;
  };

  tools.register(defineTool({
    name: 'bili_video',
    description: '看一个 B 站视频的信息：标题、UP 主、时长、播放/点赞/投币、简介、分区。传 BV 号、av 号或任意 B 站链接都行（含 b23.tv 短链）。只读，不会产生任何交互。',
    parameters: {
      id: { type: 'string', required: true, description: 'BV 号 / av 号 / 视频链接' },
      descLength: { type: 'number', description: '简介最多返回多少字（默认 300）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const id = String(args?.id ?? '').trim();
        if (!id) return { ok: false, error: '没有给视频号', summary: '需要一个 BV 号、av 号或链接。' };
        const v = await sync().video(id);
        const maxDesc = Math.min(Math.max(Number(args?.descLength) || 300, 0), 2000);
        const desc = maxDesc > 0 ? v.desc.slice(0, maxDesc) : '';
        const lines = [];
        lines.push('《' + v.title + '》');
        lines.push('UP：' + v.owner + ' ｜ ' + v.durationText + ' ｜ ' + v.viewText + ' 播放 ｜ 弹幕 ' + v.danmaku);
        lines.push('点赞 ' + v.like + ' ｜ 投币 ' + v.coin + ' ｜ 收藏 ' + v.favorite + ' ｜ 评论 ' + v.reply);
        lines.push(v.bvid + ' ｜ ' + (v.pubdateText ? v.pubdateText.slice(0, 10) : '') + (v.tname ? ' ｜ ' + v.tname : ''));
        if (desc) lines.push('', desc);
        return { ok: true, video: v, summary: lines.join(String.fromCharCode(10)) };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '看视频失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_feed',
    description: '刷 B 站。source=recommend 走首页推荐（默认，每条不一样），source=popular 走热门榜（更稳定，推荐被风控时用这个）。只读。',
    parameters: {
      count: { type: 'number', description: '要几条（1-30，默认看配置）' },
      source: { type: 'string', description: 'recommend（首页推荐，默认）或 popular（热门）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const n = Math.min(Math.max(Number(args?.count) || feedCount(), 1), 30);
        const src = String(args?.source ?? 'recommend').trim().toLowerCase();
        const c = sync();
        let list;
        let used = src;
        if (src === 'popular') {
          list = await c.popular({ count: n });
        } else {
          list = await c.feed({ count: n });
          if (!list.length) {
            used = 'popular（推荐流空了，自动兜底）';
            list = await c.popular({ count: n });
          }
        }
        const lines = list.map((x, i) => {
          return (i + 1) + '. 《' + x.title + '》' + String.fromCharCode(10) +
                 '   ' + x.owner + ' ｜ ' + x.durationText + ' ｜ ' + x.viewText + ' 播放 ｜ ' + x.bvid;
        });
        return {
          ok: true,
          count: list.length,
          source: used,
          videos: list,
          summary: list.length
            ? '刷到 ' + list.length + ' 条（' + used + '）：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10))
            : '一条都没刷到，B 站可能限流了，过会儿再试。',
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '刷 B 站失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_subtitle',
    description: '拉一个 B 站视频的字幕（B 站 AI 自动生成的，通常有中文/英文/日文等）。这是了解视频内容最准的方式 —— 比标题和简介详细得多。需要登录：配置里填 cookie，或把 cookie 存到 ~/.dsh/plugins-data/bili-feed/cookie.txt。只读。',
    parameters: {
      id: { type: 'string', required: true, description: 'BV 号 / av 号 / 视频链接' },
      lang: { type: 'string', description: '语言，比如 zh / en / ja。默认中文' },
      page: { type: 'number', description: '第几个分P（从 0 开始，默认 0）' },
      withTime: { type: 'boolean', description: '是否每行带时间轴 [0:12]' },
      maxChars: { type: 'number', description: '最多返回多少字（默认 8000）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const id = String(args?.id ?? '').trim();
        if (!id) return { ok: false, error: '没有给视频号', summary: '需要一个 BV 号、av 号或链接。' };
        const withTime = args?.withTime === true;
        const maxChars = Math.min(Math.max(Number(args?.maxChars) || 8000, 200), 40000);
        const sub = await sync().subtitle(id, {
          lang: String(args?.lang ?? '').trim(),
          page: Number(args?.page) || 0,
          withTime,
        });
        const raw = withTime ? sub.timeline : sub.plain;
        const body = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
        const langs = sub.languages.map((x) => x.lan).join('/');
        const head = '《' + sub.title + '》字幕（' + sub.langDoc + '，' + sub.lines.length + ' 条，' + sub.plain.length + ' 字）';
        const note = raw.length > maxChars ? String.fromCharCode(10) + '（截断到 ' + maxChars + ' 字）' : '';
        const warn = sub.warning ? String.fromCharCode(10) + '⚠️ ' + sub.warning : '';
        return {
          ok: true,
          bvid: sub.bvid,
          title: sub.title,
          lang: sub.lang,
          languages: langs,
          lineCount: sub.lines.length,
          charCount: sub.plain.length,
          truncated: raw.length > maxChars,
          text: body,
          lines: sub.lines,
          warning: sub.warning || '',
          coverage: sub.coverage ?? 1,
          summary: head + String.fromCharCode(10) + '可用语言：' + langs + note + warn + String.fromCharCode(10, 10) + body,
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '拉字幕失败：' + String(e?.message ?? e) };
      }
    },
  }));
  tools.register(defineTool({
    name: 'bili_comments',
    description: '拉 B 站视频的评论（第一页，默认按热门排序）。想知道观众在聊什么、有没有梗，用这个。只读。',
    parameters: {
      id: { type: 'string', required: true, description: 'BV 号 / av 号 / 视频链接' },
      sort: { type: 'string', description: 'hot（热门，默认）或 new（最新）' },
      limit: { type: 'number', description: '最多几条（默认 20，上限 50）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const id = String(args?.id ?? '').trim();
        if (!id) return { ok: false, error: '没有给视频号', summary: '需要一个 BV 号、av 号或链接。' };
        const list = await sync().comments(id, {
          sort: String(args?.sort ?? 'hot').trim(),
          limit: Number(args?.limit) || 20,
        });
        const lines = list.map((c, i) =>
          (i + 1) + '. ' + c.user + '（赞 ' + c.like + '）：' + c.text);
        return {
          ok: true,
          count: list.length,
          comments: list,
          summary: list.length ? '评论 ' + list.length + ' 条：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) : '这视频一条评论都没有。',
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '拉评论失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_danmaku',
    description: '拉 B 站视频的弹幕。弹幕最能看出观众的情绪和梗（比评论更即时）。返回带时间轴，可以配合字幕对位。只读。',
    parameters: {
      id: { type: 'string', required: true, description: 'BV 号 / av 号 / 视频链接' },
      page: { type: 'number', description: '第几个分P（从 0 开始，默认 0）' },
      limit: { type: 'number', description: '最多几条（默认 500，上限 5000）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const id = String(args?.id ?? '').trim();
        if (!id) return { ok: false, error: '没有给视频号', summary: '需要一个 BV 号、av 号或链接。' };
        const d = await sync().danmaku(id, {
          page: Number(args?.page) || 0,
          limit: Number(args?.limit) || 500,
        });
        const lines = d.list.map((x) => {
          const m = Math.floor(x.time / 60);
          const s = Math.floor(x.time % 60);
          return '[' + m + ':' + String(s).padStart(2, '0') + '] ' + x.text;
        });
        return {
          ok: true,
          cid: d.cid,
          count: d.total,
          list: d.list,
          summary: '弹幕 ' + d.total + ' 条：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)),
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '拉弹幕失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_tags',
    description: '看 B 站视频的标签。标签比分区细，能快速判断内容画像（比如有没有蹭热点、是不是某一类梗）。只读。',
    parameters: {
      id: { type: 'string', required: true, description: 'BV 号 / av 号 / 视频链接' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const id = String(args?.id ?? '').trim();
        if (!id) return { ok: false, error: '没有给视频号', summary: '需要一个 BV 号、av 号或链接。' };
        const list = await sync().tags(id);
        const names = list.map((t) => t.name).filter(Boolean);
        return {
          ok: true,
          count: names.length,
          tags: names,
          summary: names.length ? '标签 ' + names.length + ' 个：' + names.join('、') : '这视频没有标签。',
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '查标签失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_share',
    description: '生成 B 站风格的分享文案：【标题】 链接。默认只给一行（适合直接发出去），withDesc=true 会带上 UP、时长、播放和简介。只读。',
    parameters: {
      id: { type: 'string', required: true, description: 'BV 号 / av 号 / 视频链接' },
      withDesc: { type: 'boolean', description: '是否附带 UP、时长、播放和简介' },
      descLength: { type: 'number', description: '带简介时最多多少字（默认 200）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const id = String(args?.id ?? '').trim();
        if (!id) return { ok: false, error: '没有给视频号', summary: '需要一个 BV 号、av 号或链接。' };
        const withDesc = args?.withDesc === true;
        const v = await sync().video(id);
        const maxDesc = Math.min(Math.max(Number(args?.descLength) || 200, 0), 1000);
        let banner = '【' + v.title + '】 ' + client.shareUrl(v.bvid);
        if (withDesc) {
          const lines = [banner, ''];
          lines.push('UP：' + v.owner + ' ｜ ' + v.durationText + ' ｜ ' + v.viewText + ' 播放');
          if (v.desc && maxDesc > 0) lines.push('', v.desc.slice(0, maxDesc));
          banner = lines.join(String.fromCharCode(10));
        }
        return { ok: true, url: client.shareUrl(v.bvid), title: v.title, text: banner, summary: banner };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '生成分享失败：' + String(e?.message ?? e) };
      }
    },
  }));
}