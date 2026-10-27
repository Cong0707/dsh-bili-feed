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
}