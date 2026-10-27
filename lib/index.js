/**
 * dsh-bili-feed —— 让模型真的能逛 B 站。
 *
 * 全部只读，不接任何写接口（不发评论、不点赞、不投币、不收藏、不关注、不发弹幕）。
 *
 *   看单条   bili_video / bili_subtitle / bili_comments / bili_danmaku / bili_tags
 *   看画面   bili_watch（ffmpeg 抽帧拼图 → 交给 read_image）
 *   主动逛   bili_look（多源候选 → 过滤去重 → 深读详情/标签/热评/弹幕 → 素材文本）
 *   找东西   bili_search / bili_related / bili_ranking / bili_precious
 *   看账号   bili_whoami / bili_user / bili_user_videos / bili_fav_folders / bili_fav_media / bili_history
 *   其它     bili_feed / bili_subreplies / bili_share
 *
 * @module dsh-bili-feed
 */
import z from '@deepseek-ai/schemastery';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BiliClient } from './bili.js';

export const name = 'bili-feed';
export const inject = ['tools'];

/**
 * 给别的插件用的口子：随手抓一批素材。
 *
 * 为什么暴露这个而不是让它自己去打 B 站接口：
 *   B 站接口的坑（wbi 签名、ranking/v1、空间 Referer、字幕占位轨）
 *   都在这一个插件里处理过了。别的插件再抄一份，就是再多一处会过期的地方。
 *
 * 用 ctx.get('bili-feed') 拿不到时，也可以直接 import('./look.js')。
 */
export async function ambient(opts = {}) {
  const { ambient: run } = await import('./look.js');
  const { BiliClient } = await import('./bili.js');
  const { readFile } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');

  let ck = '';
  try {
    ck = (await readFile(join(homedir(), '.dsh', 'plugins-data', 'bili-feed', 'cookie.txt'), 'utf8')).trim();
  } catch { /* 没 cookie 也能抓热门和必刷 */ }

  const client = new BiliClient({ cookie: ck, vdSource: String(opts.vdSource ?? '') });
  return run({ client, limit: opts.limit, keywords: opts.keywords });
}

const log = {
  info: (m) => console.log('[bili-feed] ' + m),
  warn: (m) => console.warn('[bili-feed] ' + m),
  error: (m) => console.error('[bili-feed] ' + m),
};

/** 面向 dsh-settings 的配置。 */
export const Config = z.object({
  vdSource: z.string().default('').volatile()
    .description('分享链接末尾的 vd_source。想用别的就改这里。'),
  cookie: z.string().default('').volatile()
    .description('B 站 cookie（可选）。不填也能用，但推荐流会更随机；填了更贴近你自己的首页。'),
  feedCount: z.string().default('12').volatile()
    .description('每次刷首页默认返回几条（1-30）。'),
  ffmpegPath: z.string().default('').volatile()
    .description('ffmpeg 可执行文件路径。留空就用 PATH 里的 ffmpeg。bili_watch 需要它。'),
  mediaKeepHours: z.string().default('24').volatile()
    .description('抽帧图保留多少小时（1-720）。过期自动清。'),
  injectPrompt: z.string().default('true').volatile()
    .description('要不要把「怎么用这套工具」写进系统提示词。关掉的话工具还在，只是不主动教。'),
});

/** .volatile() 的字段是 Ref，得 .get() 才拿得到值。 */
function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try { return value.get(); } catch { return undefined; }
  }
  if (value && typeof value === 'object' && 'value' in value) return value.value;
  return value;
}

function val(config, key, fallback) {
  const raw = unwrap(config?.[key]);
  if (raw === undefined || raw === null) return fallback;
  const s = typeof raw === 'string' ? raw : String(raw);
  return s === '' ? fallback : s;
}

/** cookie 存在插件数据目录，别写进 cordis.patch.yml（那是明文配置）。 */
const COOKIE_PATH = join(homedir(), '.dsh', 'plugins-data', 'bili-feed', 'cookie.txt');

async function loadCookieFile() {
  try {
    return (await readFile(COOKIE_PATH, 'utf8')).trim();
  } catch {
    return '';
  }
}

export async function apply(ctx, config) {
  const fileCookie = await loadCookieFile();
  const client = new BiliClient({
    log,
    vdSource: String(val(config, 'vdSource', '') ?? ''),
    ...(fileCookie ? { cookie: fileCookie } : {}),
  });
  if (fileCookie) log.info('已加载 B 站 cookie（' + fileCookie.length + ' 字节写入 client，内容不打印）');

  const tools = ctx.get('tools');
  if (!tools?.register) {
    log.warn('tools 服务不可用，B 站工具没注册');
    return;
  }

  let defineTool = null;
  try { defineTool = (await import('@deepseek-ai/dsh-tools')).defineTool; } catch { /* ignore */ }
  if (typeof defineTool !== 'function') {
    try { defineTool = (await import('@deepseek-ai/dsh-tools/schema')).defineTool; } catch { /* ignore */ }
  }
  if (typeof defineTool !== 'function') {
    log.warn('defineTool 不可用，B 站工具没注册');
    return;
  }

  const api = await import('./tools.js');
  api.registerTools({ tools, defineTool, config, log, val, client });
  log.info('已注册 B 站工具（看/刷/搜/账号/抽帧）');

  // ── 提示词注入 ────────────────────────────────────────────────────
  //
  // 工具注册了不等于模型会用。模型看得到工具 description，但不知道：
  //   这几样合起来能干什么、什么时候该用哪个、哪一步会慢。
  //
  // 塞进 description 太长（每次列工具都占上下文）；塞成 user 消息会留在
  // 对话历史里（用户点开就能看见）。走 systemPrompt.section() 才对：
  // system 角色、不进对话历史、界面上看不到。
  //
  // 每个 agent 单独装（agent/created），并在 agent.ctx.effect() 里登记，
  // 这样 agent 销毁时自动摘掉；卸载插件时也不会留下野的 section。
  if (String(val(config, 'injectPrompt', 'true')) !== 'false') {
    try {
      const { BILI_BRIEF, WATCH_RULE } = await import('./brief.js');
      const fibers = new Map();

      const install = (agent) => {
        if (!agent || fibers.has(agent)) return;
        try {
          const f = agent.ctx.inject(['systemPrompt'], (scope) => {
            scope.systemPrompt.section({
              name: 'bili-feed:tutorial',
              order: 900,
              text: () => BILI_BRIEF + String.fromCharCode(10, 10) + WATCH_RULE,
            });
          });
          fibers.set(agent, f);
        } catch (e) {
          log.warn('装提示词失败：' + (e?.message ?? e));
        }
      };

      const uninstall = (agent) => {
        const f = fibers.get(agent);
        if (!f) return;
        fibers.delete(agent);
        Promise.resolve(f.dispose?.()).catch(() => {});
      };

      const agents = ctx.get('agents');
      // 已存在的 agent 先装上
      try {
        for (const a of (agents?.list?.() ?? [])) install(a);
      } catch { /* ignore */ }

      // 后续新建的也装上
      ctx.on?.('agent/created', (payload) => {
        const a = payload?.agent ?? payload;
        if (a) install(a);
      });
      ctx.on?.('agent/disposed', (payload) => {
        const a = payload?.agent ?? payload;
        if (a) uninstall(a);
      });

      ctx.effect(() => () => {
        for (const a of Array.from(fibers.keys())) uninstall(a);
      }, 'bili-feed: prompt cleanup');

      log.info('已装提示词（bili-feed:tutorial，' + fibers.size + ' 个 agent）');
    } catch (e) {
      log.warn('提示词注入不可用：' + (e?.message ?? e));
    }
  }
}