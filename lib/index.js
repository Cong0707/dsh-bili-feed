/**
 * dsh-bili-feed —— 让模型能看 B 站、刷 B 站、分享视频。
 *
 * 只有三件事，全是只读：
 *   bili_video  看一个视频（BV/av/链接 → 标题、UP、数据、简介）
 *   bili_feed   刷首页推荐（或热门兜底）
 *   bili_share  按 B 站分享格式拼文案
 *
 * 明确不做：发评论、点赞、投币、收藏、关注。需要写的接口一个都没接。
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
  vdSource: z.string().default('afe7444fb0a17db50bfb3bdb60168af2').volatile()
    .description('分享链接末尾的 vd_source。想用别的就改这里。'),
  cookie: z.string().default('').volatile()
    .description('B 站 cookie（可选）。不填也能用，但推荐流会更随机；填了更贴近你自己的首页。'),
  feedCount: z.string().default('12').volatile()
    .description('每次刷首页默认返回几条（1-30）。'),
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
  log.info('已注册 4 个 B 站工具');
}
