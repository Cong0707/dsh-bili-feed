/**
 * media.js —— 让她真的"看见"视频画面。
 *
 * 思路来自 dsh-fish（ssamurias/dsh-fish）的 video.js：不下载整段视频，
 * 而是用 ffmpeg 从 B 站 dash 直链上做几次短 seek，取 N 帧，拼成一张
 * contact sheet，落到磁盘，然后把路径交回给模型 —— 模型用 read_image 读它。
 *
 * 为什么不下载整段：
 *   - dash 直链支持 http seek，抽 9 帧只要几秒、几 MB；
 *   - 少一个 yt-dlp 依赖就少一处要装的东西；
 *   - 不落整段视频，也就没有版权和磁盘占地问题。
 *
 * 为什么是均布抽帧而不是按镜头切换：
 *   按镜头切换要读完整个流（= 变相全量下载）。均布是"覆盖优先"的折中：
 *   能看出这条视频大致是什么样，想细看可以再对某个时间点单独取。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const FFMPEG_ENV = 'DSH_BILI_FFMPEG';
const FRAME_TIMEOUT_MS = 25_000;

/** 探测 ffmpeg。**只读**，不装任何东西。 */
export function detectFfmpeg(env = process.env) {
  const bin = String(env[FFMPEG_ENV] ?? 'ffmpeg');
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (r.error) {
    const missing = r.error.code === 'ENOENT';
    const why = !missing
      ? String(r.error.message ?? r.error)
      : bin !== 'ffmpeg'
        ? '没找到 ffmpeg（DSH_BILI_FFMPEG 指向的 ' + bin + ' 不可用）'
        : '没找到 ffmpeg';
    return { ok: false, bin, version: '', why };
  }
  const first = String(r.stdout ?? '').split('\n')[0] ?? '';
  const m = first.match(/ffmpeg version (\S+)/);
  return { ok: Boolean(m), bin, version: m ? m[1] : '', why: m ? '' : '跑起来了但不是 ffmpeg' };
}

/** 跑一个命令，不抛（ffmpeg 的进度输出全部吞掉） */
function run(bin, args, timeoutMs = FRAME_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let err = '';
    let done = false;
    const p = spawn(bin, args, { windowsHide: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { p.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ code: -1, stderr: err + '\n(timeout ' + timeoutMs + 'ms)' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    p.stderr.on('data', (c) => { if (err.length < 8000) err += String(c); });
    p.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -2, stderr: String(e?.message ?? e) });
    });
    p.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -3, stderr: err });
    });
  });
}

/** 正斜杠路径。反斜杠写进 markdown 图片会显示成「无法预览」。 */
export function slashed(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

/** 媒体目录。抽出来的图放这儿，模型用 read_image 读绝对路径。 */
export async function mediaDir(root) {
  const dir = join(root, 'media');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 一条视频的直链要 Referer + UA + cookie 才拉得动，缺一样就是 403。 */
function headersFor(bvid, cookie, referer) {
  const lines = [
    'Referer: ' + (referer || ('https://www.bilibili.com/video/' + bvid)),
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept: */*',
  ];
  if (cookie) lines.push('Cookie: ' + cookie);
  return lines.join('\r\n') + '\r\n';
}

/**
 * 抽 N 帧，拼成一张 contact sheet。
 *
 * @param {object} o
 * @param {string} o.url          dash 直链
 * @param {number} o.duration     总时长（秒），0 表示不知道
 * @param {string} o.bvid
 * @param {string} [o.cookie]     B 站 cookie
 * @param {string} o.root         状态目录（图存 root/media/）
 * @param {number} [o.frames]     取几帧，默认 9（3×3）
 * @param {string} [o.bin]        ffmpeg 路径
 * @param {string} [o.fromSec]    只看某段（起点）
 * @param {string} [o.toSec]      只看某段（终点）
 * @returns {Promise<{ok:boolean,path:string,why:string,shots:number,cols:number,rows:number,duration:number}>}
 */
export async function contactSheet(o) {
  const fail = (why) => ({ ok: false, path: '', why, shots: 0, cols: 0, rows: 0, duration: Number(o?.duration) || 0 });
  const url = String(o?.url ?? '').trim();
  if (!url) return fail('没有播放地址');

  const bin = String(o?.bin ?? detectFfmpeg().bin ?? 'ffmpeg');
  const n = Math.max(1, Math.min(16, Number(o?.frames ?? 9)));
  const duration = Number(o?.duration ?? 0) || 0;
  const headers = headersFor(String(o?.bvid ?? ''), String(o?.cookie ?? ''), o?.referer);

  const dir = await mediaDir(String(o?.root ?? '.'));
  const stamp = Date.now() + '-' + randomUUID().slice(0, 6);
  const tmp = join(dir, 'tmp-' + stamp);
  await fs.mkdir(tmp, { recursive: true });

  // 头部：ss 放在 -i 前面才是快速 seek（关键帧定位），放后面要解码到那一帧
  const from = Math.max(0, Number(o?.fromSec ?? 0) || 0);
  const to = Number(o?.toSec ?? 0) || 0;
  const lo = to > from ? from : (duration > 0 ? duration * 0.04 : 0);
  const hi = to > from ? to : (duration > 0 ? duration * 0.96 : 0);

  const times = [];
  for (let i = 0; i < n; i++) {
    if (duration > 0 || to > from) times.push(lo + ((hi - lo) * i) / Math.max(1, n - 1));
    else times.push(i * 5);
  }

  const grab = (t, out) => run(bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-headers', headers,
    '-ss', Math.max(0, t).toFixed(2),
    '-i', url,
    '-frames:v', '1',
    '-vf', 'scale=360:-2',
    out,
  ]);

  let okShots = 0;
  for (let i = 0; i < times.length; i++) {
    const out = join(tmp, 'f' + String(i + 1).padStart(2, '0') + '.png');
    let r = await grab(times[i], out);
    let st = await fs.stat(out).catch(() => null);
    // 一次失败多半是网络抖了或正好 seek 到关键帧边界；往后挪一点重试一次。
    // 不重试的话尾部几帧经常整片空着（实测 9 帧只成 7 帧）。
    if (r.code !== 0 || !st || st.size <= 512) {
      await fs.rm(out, { force: true }).catch(() => {});
      const t2 = duration > 0 ? Math.min(times[i] + 1.5, Math.max(duration - 1, 0)) : times[i] + 1.5;
      r = await grab(t2, out);
      st = await fs.stat(out).catch(() => null);
    }
    if (r.code === 0 && st && st.size > 512) okShots++;
  }

  if (okShots === 0) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return fail('一帧都没取到（可能被风控，或者这条视频不允许外链拉流）');
  }

  const cols = n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const sheet = join(dir, 'sheet-' + (o?.bvid || 'v') + '-' + stamp + '.png');
  const tile = await run(bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', '1',
    '-i', join(tmp, 'f%02d.png'),
    '-vf', 'scale=360:-2,tile=' + cols + 'x' + rows + ':padding=4:margin=4:color=white',
    '-frames:v', '1',
    sheet,
  ], 60_000);
  const st = await fs.stat(sheet).catch(() => null);
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});

  if (!st || st.size < 1024) {
    return fail('拼图失败：' + String(tile.stderr || '未知原因').slice(0, 200));
  }

  return {
    ok: true,
    path: slashed(sheet),
    why: '',
    shots: okShots,
    cols,
    rows,
    duration,
    bytes: st.size,
  };
}

/**
 * 精确取某一秒的帧。跟 contactSheet 的区别：这个只取一张，不拼图，
 * 用来"倒回这一秒看看画面"。
 *
 * @param {{url:string, atSec:number, bvid:string, cookie?:string, root:string, bin?:string,
 *          referer?:string, scale?:number}} o
 * @returns {Promise<{ok:boolean, path:string, why:string, atSec:number}>}
 */
export async function grabFrameAt(o) {
  const url = String(o?.url ?? '').trim();
  if (!url) return { ok: false, path: '', why: '没有播放地址', atSec: 0 };
  const at = Math.max(0, Number(o?.atSec ?? 0) || 0);
  const bin = String(o?.bin ?? detectFfmpeg().bin ?? 'ffmpeg');
  // 注意：Number(undefined) 是 NaN，而 NaN ?? 720 还是 NaN（?? 只接 null/undefined），
  // 直接用 NaN 会拼出 scale=NaN:-2，ffmpeg 报 "Error when evaluating the expression 'NaN'"。
  const scaleRaw = Number(o?.scale);
  const scale = Number.isFinite(scaleRaw) ? Math.max(160, Math.min(1280, scaleRaw)) : 720;
  const headers = headersFor(String(o?.bvid ?? ''), String(o?.cookie ?? ''), o?.referer);

  const dir = await mediaDir(String(o?.root ?? '.'));
  const stamp = Date.now() + '-' + randomUUID().slice(0, 6);
  const out = join(dir, 'frame-' + (o?.bvid || 'v') + '-' + at.toFixed(2).replace('.', '_') + '-' + stamp + '.png');

  let r = await run(bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-headers', headers,
    '-ss', at.toFixed(2),
    '-i', url,
    '-frames:v', '1',
    '-vf', 'scale=' + scale + ':-2',
    out,
  ]);
  let st = await fs.stat(out).catch(() => null);
  if (r.code !== 0 || !st || st.size <= 512) {
    await fs.rm(out, { force: true }).catch(() => {});
    // 往后挪 1.5 秒重试一次：seek 正好落在关键帧边界时会取不到
    r = await run(bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-headers', headers,
      '-ss', (at + 1.5).toFixed(2),
      '-i', url,
      '-frames:v', '1',
      '-vf', 'scale=' + scale + ':-2',
      out,
    ]);
    st = await fs.stat(out).catch(() => null);
  }
  if (!st || st.size <= 512) {
    return { ok: false, path: '', why: '这一秒取不到画面：' + String(r.stderr || '').slice(0, 200), atSec: at };
  }
  return { ok: true, path: slashed(out), why: '', atSec: at, bytes: st.size };
}

/**
 * 按给定的时间点逐个取帧，各自落盘（不拼图），返回 [{atSec, path}]。
 * 用来"按台词/弹幕的时间倒回去看画面"。
 */
export async function grabFramesAt(o) {
  const times = (Array.isArray(o?.times) ? o.times : []).map((x) => Number(x) || 0);
  const out = [];
  for (const t of times.slice(0, 16)) {
    const r = await grabFrameAt({ ...o, atSec: t });
    out.push({ atSec: r.atSec, ok: r.ok, path: r.path, why: r.why });
  }
  return out;
}

/** 抽出来的图留多久。一天够回头看了，也不会积成垃圾。 */
export const MEDIA_TTL_MS = 24 * 60 * 60 * 1000;

/** 清掉过期的抽帧图（只删自己建的 sheet-、tmp-、img- 前缀）。 */
export async function sweepMedia(root) {
  const dir = await mediaDir(root).catch(() => '');
  if (!dir) return 0;
  const now = Date.now();
  let n = 0;
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!/^(sheet-|tmp-|img-)/.test(name)) continue;
    const p = join(dir, name);
    const st = await fs.stat(p).catch(() => null);
    if (!st) continue;
    if (now - st.mtimeMs < MEDIA_TTL_MS) continue;
    await fs.rm(p, { recursive: true, force: true }).catch(() => {});
    n++;
  }
  return n;
}