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
  const DEFAULT_VD = 'afe7444fb0a17db50bfb3bdb60168af2';
  const vdSource = () => String(val(config, 'vdSource', DEFAULT_VD) ?? '').trim() || DEFAULT_VD;
  const cookie = () => String(val(config, 'cookie', '') ?? '').trim();
  const feedCount = () => Math.min(Math.max(Number(val(config, 'feedCount', '12')) || 12, 1), 30);

  const sync = () => {
    client.setOptions({ vdSource: vdSource(), cookie: cookie() });
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
