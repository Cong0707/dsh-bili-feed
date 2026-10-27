/**
 * bili_* 工具注册。
 *
 * 全部只读：
 *   bili_video     看一个视频（标题/UP/数据/简介）
 *   bili_feed      刷首页
 *   bili_subtitle  读 AI 字幕
 *   bili_comments  读评论
 *   bili_danmaku   读弹幕
 *   bili_tags      看标签
 *   bili_watch     真的"看"——抽帧拼图，返回图片路径给 read_image
 *   bili_share     拼分享文案
 *
 * 不接任何写接口：不发评论、不点赞、不投币、不收藏、不关注、不发弹幕。
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { contactSheet, detectFfmpeg } from './media.js';
import { look } from './look.js';

function text(s) { return [{ type: 'text', text: String(s ?? '') }]; }

/** 抽帧图存这儿，模型靠绝对路径读。 */
function mediaRoot() {
  const dir = join(homedir(), '.dsh', 'plugins-data', 'bili-feed', 'media');
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return join(homedir(), '.dsh', 'plugins-data', 'bili-feed');
}

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
    name: 'bili_search',
    description: '搜 B 站视频。给关键词返回视频列表（标题/UP/播放/时长/BV号）。想找某个话题、某个 UP 的东西、或者查一个梗出处在哪，用这个。只读。',
    parameters: {
      keyword: { type: 'string', required: true, description: '搜索关键词' },
      page: { type: 'number', description: '第几页（默认 1）' },
      pageSize: { type: 'number', description: '每页几条（默认 10，上限 20）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const kw = String(args?.keyword ?? '').trim();
        if (!kw) return { ok: false, error: '关键词是空的', summary: '要给个关键词。' };
        const list = await sync().search(kw, {
          page: Number(args?.page) || 1,
          pageSize: Number(args?.pageSize) || 10,
        });
        const lines = list.map((x, i) =>
          (i + 1) + '. 《' + x.title + '》 ' + x.owner + ' ｜ ' + x.durationText + ' ｜ ' + x.viewText + ' ｜ ' + x.bvid);
        return {
          ok: true,
          count: list.length,
          keyword: kw,
          videos: list,
          summary: '搜到 ' + list.length + ' 条（' + kw + '）：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)),
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '搜索失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_related',
    description: '看一个视频的相关推荐：平台看完这条之后还会推什么。用来顺着一个话题往外爬。只读。',
    parameters: {
      id: { type: 'string', required: true, description: 'BV 号 / av 号 / 视频链接' },
      limit: { type: 'number', description: '最多几条（默认 10，上限 30）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const id = String(args?.id ?? '').trim();
        if (!id) return { ok: false, error: '没有给视频号', summary: '需要一个 BV 号、av 号或链接。' };
        const list = await sync().related(id, { limit: Number(args?.limit) || 10 });
        const lines = list.map((x, i) => (i + 1) + '. 《' + x.title + '》 ' + x.owner + ' ｜ ' + x.viewText + ' ｜ ' + x.bvid);
        return {
          ok: true,
          count: list.length,
          videos: list,
          summary: '相关推荐 ' + list.length + ' 条：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)),
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '拉相关推荐失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_ranking',
    description: 'B 站排行榜。rid=0 是全站榜，其它是分区榜（1 动画 3 音乐 4 游戏 5 娱乐 36 科技 129 舞蹈 160 生活 181 影视 188 数码 211 美食）。比推荐流稳定。只读。',
    parameters: {
      rid: { type: 'number', description: '分区 id，0 = 全站（默认 0）' },
      limit: { type: 'number', description: '几条（默认 20，上限 50）' },
      day: { type: 'number', description: '1=日榜 3=三日榜 7=周榜（默认 3）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const list = await sync().ranking({
          rid: Number(args?.rid) || 0,
          limit: Number(args?.limit) || 20,
          day: Number(args?.day) || 3,
        });
        const lines = list.map((x, i) =>
          (i + 1) + '. 《' + x.title + '》 ' + x.owner + ' ｜ ' + x.viewText + ' ｜ ' + x.bvid);
        return {
          ok: true,
          count: list.length,
          videos: list,
          summary: '排行榜 ' + list.length + ' 条：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)),
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '拉排行榜失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_precious',
    description: 'B 站「入站必刷」：98 条全站经典老片固定榜。想看这个站的文化底色、或者不知道看什么的时候刷它。只读。',
    parameters: {
      limit: { type: 'number', description: '几条（默认 20，上限 50）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const list = await sync().precious({ pageSize: Number(args?.limit) || 20 });
        const lines = list.map((x, i) =>
          (i + 1) + '. 《' + x.title + '》 ' + x.owner + ' ｜ ' + x.viewText + ' ｜ ' + x.bvid);
        return {
          ok: true,
          count: list.length,
          videos: list,
          summary: '入站必刷 ' + list.length + ' 条：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)),
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '拉必刷榜失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_subreplies',
    description: '看某条评论下面的楼中楼回复。B 站只有两层，rpid 传主评论的 id（从 bili_comments 拿）。只读。',
    parameters: {
      id: { type: 'string', required: true, description: 'BV 号 / av 号 / 视频链接' },
      rpid: { type: 'number', required: true, description: '主评论的 rpid' },
      limit: { type: 'number', description: '几条（默认 20，上限 20）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const id = String(args?.id ?? '').trim();
        const rpid = Number(args?.rpid) || 0;
        if (!id || !rpid) return { ok: false, error: '缺 id 或 rpid', summary: '要视频 id + 主评论 rpid。' };
        const list = await sync().subReplies(id, rpid, { limit: Number(args?.limit) || 20 });
        const lines = list.map((c, i) => (i + 1) + '. ' + c.user + '：' + c.text);
        return {
          ok: true,
          count: list.length,
          replies: list,
          summary: list.length ? '楼中楼 ' + list.length + ' 条：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) : '这条评论没有回复。',
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '拉楼中楼失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_whoami',
    description: '查 B 站登录状态：cookie 有没有效、当前是谁。排查「为什么字幕/画面拿不到」时先看这个。只读。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute() {
      try {
        const me = await sync().whoami();
        const head = me.isLogin
          ? '已登录：' + me.uname + '（mid ' + me.mid + '）' + (me.vip ? ' 大会员' : '')
          : '未登录（只能看基本信息，字幕/高清画面拿不到）';
        const ck = cookie();
        const extra = ck ? 'cookie 已配置（' + ck.length + ' 字节）' : 'cookie 是空的';
        return { ok: true, ...me, hasCookie: Boolean(ck), summary: head + String.fromCharCode(10) + extra };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '查登录状态失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_user',
    description: '看 B 站用户的空间名片：昵称、签名、等级、粉丝数、关注数。传 mid。只读。',
    parameters: {
      mid: { type: 'number', required: true, description: '用户 mid（数字）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const mid = Number(args?.mid) || 0;
        if (!mid) return { ok: false, error: '缺 mid', summary: '要一个数字 mid。' };
        const u = await sync().user(mid);
        const lines = [
          u.name + '（mid ' + u.mid + '）',
          'Lv' + u.level + (u.vip ? ' 大会员' : ''),
          '粉丝 ' + u.follower + ' ｜ 关注 ' + u.following,
        ];
        if (u.sign) lines.push('签名：' + u.sign);
        return { ok: true, user: u, summary: lines.join(String.fromCharCode(10)) };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '看用户失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_user_videos',
    description: '看某个 B 站用户投过哪些视频（按发布时间倒序）。只读。',
    parameters: {
      mid: { type: 'number', required: true, description: '用户 mid' },
      page: { type: 'number', description: '第几页（默认 1）' },
      pageSize: { type: 'number', description: '每页几条（默认 10，上限 30）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const mid = Number(args?.mid) || 0;
        if (!mid) return { ok: false, error: '缺 mid', summary: '要一个数字 mid。' };
        const list = await sync().userVideos(mid, {
          page: Number(args?.page) || 1,
          pageSize: Number(args?.pageSize) || 10,
        });
        const lines = list.map((x, i) => (i + 1) + '. 《' + x.title + '》 ' + x.durationText + ' ｜ ' + x.viewText + ' ｜ ' + x.bvid);
        return {
          ok: true,
          count: list.length,
          videos: list,
          summary: list.length ? '投稿 ' + list.length + ' 条：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) : '这个用户没有公开投稿。',
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '看投稿失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_fav_folders',
    description: '列我自己（登录账号）的 B 站收藏夹。要 cookie。只读。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute() {
      try {
        const list = await sync().favFolders({});
        const lines = list.map((f, i) => (i + 1) + '. ' + f.title + '（' + f.mediaCount + ' 个）｜ id ' + f.id);
        return {
          ok: true,
          count: list.length,
          folders: list,
          summary: list.length ? '收藏夹 ' + list.length + ' 个：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) : '没有收藏夹（cookie 可能失效了）。',
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '列收藏夹失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_fav_media',
    description: '看某个 B 站收藏夹里有什么视频。folderId 从 bili_fav_folders 拿。要 cookie。只读。',
    parameters: {
      folderId: { type: 'number', required: true, description: '收藏夹 id' },
      page: { type: 'number', description: '第几页（默认 1）' },
      pageSize: { type: 'number', description: '每页几条（默认 20，上限 20）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const fid = Number(args?.folderId) || 0;
        if (!fid) return { ok: false, error: '缺 folderId', summary: '要收藏夹 id。' };
        const list = await sync().favMedia(fid, {
          page: Number(args?.page) || 1,
          pageSize: Number(args?.pageSize) || 20,
        });
        const lines = list.map((x, i) => (i + 1) + '. 《' + x.title + '》 ' + x.owner + ' ｜ ' + x.bvid);
        return {
          ok: true,
          count: list.length,
          videos: list,
          summary: list.length ? '收藏夹里有 ' + list.length + ' 条：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) : '这个收藏夹是空的。',
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '看收藏夹失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_history',
    description: '看我自己的 B 站观看历史（最近一批）。要 cookie。能看出最近在关注什么。只读。',
    parameters: {
      limit: { type: 'number', description: '几条（默认 20，上限 30）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const list = await sync().history({ pageSize: Number(args?.limit) || 20 });
        const lines = list.map((x, i) =>
          (i + 1) + '. 《' + x.title + '》 ' + x.owner + ' ｜ 看到 ' + x.progressText + '/' + x.durationText + ' ｜ ' + x.viewedAtText);
        return {
          ok: true,
          count: list.length,
          history: list,
          summary: list.length ? '历史 ' + list.length + ' 条：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) : '没有观看历史（cookie 可能失效了）。',
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '看历史失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_look',
    description: '主动刷一轮 B 站：从多个来源（热门/排行/必刷/分区榜）拉候选，过滤掉短视频和黑名单，去重，然后对选中的几条深读——详情、标签、热评、弹幕全都拉下来，拼成一段素材。返回的是一段文字，看完你自己判断值不值得看画面（要看画面用 bili_watch）。只读。',
    parameters: {
      sources: { type: 'string', description: '来源，逗号分隔。可选 popular / ranking / precious / ranking-tid。默认 popular,ranking' },
      limit: { type: 'number', description: '深读几条（默认 4，上限 10）' },
      deepRead: { type: 'number', description: '每条拉几条热评（默认 3，上限 20）' },
      danmaku: { type: 'number', description: '每条抽几条弹幕（默认 8，上限 30）' },
      minDuration: { type: 'number', description: '最短时长（秒），太短的过滤掉。默认 60' },
      avoidKeywords: { type: 'string', description: '黑名单关键词，逗号分隔。标题/UP/标签命中就跳过' },
      relatedTo: { type: 'string', description: '顺着某个 BV 号往外爬（sources 里带 related 时生效）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const cfg = {
          sources: String(args?.sources ?? 'popular,ranking').split(',').map((x) => x.trim()).filter(Boolean),
          limit: Number(args?.limit) || 4,
          deepRead: Number(args?.deepRead) || 3,
          danmaku: Number(args?.danmaku) || 8,
          minDuration: args?.minDuration === undefined ? 60 : Number(args.minDuration),
          avoidKeywords: String(args?.avoidKeywords ?? '').split(',').map((x) => x.trim()).filter(Boolean),
        };
        const r = await look({
          client: sync(),
          cfg,
          seen: new Set(),
          relatedTo: String(args?.relatedTo ?? '').trim(),
        });
        if (!r.ok) return { ok: false, error: r.why, summary: '这一轮没逛到东西：' + r.why };
        const head = '刷到 ' + r.items.length + ' 条（' + cfg.sources.join('/') + '）：';
        return {
          ok: true,
          count: r.items.length,
          videos: r.videos,
          material: r.material,
          summary: head + String.fromCharCode(10, 10) + r.material,
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '刷 B 站失败：' + String(e?.message ?? e) };
      }
    },
  }));

  tools.register(defineTool({
    name: 'bili_watch',
    description: '真的"看"一条 B 站视频：从 dash 直链抽 N 帧拼成一张 contact sheet，返回本地图片路径。拿到路径后用 read_image 读它，就等于看到了这条视频的关键画面。只抽帧，不下载整段视频、不落盘整片。',
    parameters: {
      id: { type: 'string', required: true, description: 'BV 号 / av 号 / 视频链接' },
      frames: { type: 'number', description: '取几帧（默认 9 = 3×3，最多 16）' },
      fromSec: { type: 'number', description: '只看某一段的起点（秒），可选' },
      toSec: { type: 'number', description: '只看某一段的终点（秒），可选' },
      page: { type: 'number', description: '第几个分P（从 0 开始，默认 0）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.summary) },
    async execute(args) {
      try {
        const id = String(args?.id ?? '').trim();
        if (!id) return { ok: false, error: '没有给视频号', summary: '需要一个 BV 号、av 号或链接。' };

        const ff = detectFfmpeg();
        if (!ff.ok) {
          return {
            ok: false,
            error: 'ffmpeg 不可用：' + ff.why,
            summary: '本机没有可用的 ffmpeg（' + ff.why + '）。装好后重试，或者先只看字幕/评论。',
          };
        }

        const c = sync();
        const pu = await c.playurl(id, {
          page: Number(args?.page) || 0,
          qn: 64,
        });
        const root = mediaRoot();
        const sheet = await contactSheet({
          url: pu.url,
          duration: pu.duration,
          bvid: pu.bvid,
          cookie: cookie(),
          root,
          frames: Number(args?.frames) || 9,
          fromSec: Number(args?.fromSec) || 0,
          toSec: Number(args?.toSec) || 0,
          bin: ff.bin,
        });
        if (!sheet.ok) {
          return { ok: false, error: sheet.why, summary: '抽帧失败：' + sheet.why };
        }
        const lines = [
          '《' + pu.title + '》',
          '抽了 ' + sheet.shots + ' 帧，拼成 ' + sheet.cols + '×' + sheet.rows + ' 的图：' + sheet.path,
          '用 read_image 读这个路径就能看到画面。',
        ];
        return {
          ok: true,
          bvid: pu.bvid,
          title: pu.title,
          path: sheet.path,
          shots: sheet.shots,
          cols: sheet.cols,
          rows: sheet.rows,
          duration: sheet.duration,
          summary: lines.join(String.fromCharCode(10)),
        };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e), summary: '看视频画面失败：' + String(e?.message ?? e) };
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