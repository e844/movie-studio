'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, session, Menu } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const S = require('./subs');
const A = require('./align');

if (process.env.MS_USER_DATA) app.setPath('userData', process.env.MS_USER_DATA);
if (!app.requestSingleInstanceLock()) { app.exit(0); process.exit(0); }

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

function ffmpegPath() {
  if (process.env.SC_FFMPEG) return process.env.SC_FFMPEG;
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return 'ffmpeg';
}

let win = null;
let previewVideo = null;
const created = new Set(); // קבצים שהתוכנה יצרה – רק אותם מותר "להציג בתיקייה"
let dub = null; // { english, dubbed, eng, heb, result }
let job = null;
let cancelled = false;

const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
const loadPrefs = () => { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) || {}; } catch { return {}; } };
const savePrefs = (p) => { try { fs.mkdirSync(path.dirname(prefsFile()), { recursive: true }); fs.writeFileSync(prefsFile(), JSON.stringify(p)); } catch { /* ignore */ } };

const VIDEO = ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'ts', 'm2ts', 'mts', 'wmv', 'webm', 'mpg', 'mpeg', 'vob'];
const AUDIO = ['mka', 'ac3', 'eac3', 'dts', 'aac', 'm4a', 'mp3', 'flac', 'wav', 'opus', 'ogg', 'thd'];
const FILTERS = {
  subs: [{ name: 'כתוביות', extensions: ['srt', 'vtt'] }],
  video: [{ name: 'סרטים', extensions: VIDEO }],
  dubbed: [{ name: 'סרט או ערוץ שמע מדובב', extensions: [...VIDEO, ...AUDIO] }],
};

function probe(file) {
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  if (r.error) throw new Error(r.error.code === 'ENOENT' ? 'ffmpeg-missing' : 'unreadable');
  return A.parseMedia(r.stderr || '');
}

function serveFile(file, request) {
  const stat = fs.statSync(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const types = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime' };
  const headers = { 'content-type': types[ext] || 'application/octet-stream', 'accept-ranges': 'bytes' };
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (range) {
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Number(range[2]) : stat.size - 1;
    if (!range[1] && range[2]) { start = Math.max(0, stat.size - Number(range[2])); end = stat.size - 1; }
    end = Math.min(end, stat.size - 1);
    if (start > end) return new Response(null, { status: 416 });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': String(end - start + 1) },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'content-length': String(stat.size) } });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 980, minHeight: 680, title: 'סטודיו כתוביות ודיבוב', backgroundColor: '#111318', show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (win && !win.isVisible()) win.show(); }, 3000);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

const handle = (name, fn) => ipcMain.handle(name, async (_e, ...args) => {
  try { return await fn(...args); } catch (e) { return { error: e.message || 'error' }; }
});
const send = (ch, v) => { if (win) win.webContents.send(ch, v); };

handle('pickFile', async (kind) => {
  const testKey = { subs: 'MS_TEST_SUBS', video: 'MS_TEST_VIDEO', dubbed: 'MS_TEST_DUBBED' }[kind];
  if (testKey && process.env[testKey]) return process.env[testKey];
  const prefs = loadPrefs();
  const r = await dialog.showOpenDialog(win, {
    title: { subs: 'בחר קובץ כתוביות', video: 'בחר את הסרט באנגלית', dubbed: 'בחר את הסרט המדובב' }[kind] || 'בחר קובץ',
    defaultPath: prefs[`dir_${kind}`] || app.getPath('videos'),
    properties: ['openFile'],
    filters: [...(FILTERS[kind] || []), { name: 'כל הקבצים', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  savePrefs({ ...prefs, [`dir_${kind}`]: path.dirname(r.filePaths[0]) });
  return r.filePaths[0];
});

// ---------- כתוביות ----------
const SUB_EXT = /\.(srt|vtt)$/i;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** בחירת כמה קבצי כתוביות, או תיקייה שלמה (עונה) */
handle('pickSubsMany', async (folder) => {
  if (process.env.MS_TEST_SUBS) return process.env.MS_TEST_SUBS.split(path.delimiter);
  const prefs = loadPrefs();
  const r = await dialog.showOpenDialog(win, {
    title: folder ? 'בחר תיקייה עם כתוביות (עונה שלמה)' : 'בחר קבצי כתוביות (אפשר כמה)',
    defaultPath: prefs.dir_subs || app.getPath('videos'),
    properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
    filters: folder ? [] : [...FILTERS.subs, { name: 'כל הקבצים', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  let files = r.filePaths;
  if (folder) files = fs.readdirSync(files[0]).filter((f) => SUB_EXT.test(f)).sort(natural).map((f) => path.join(r.filePaths[0], f));
  savePrefs({ ...prefs, dir_subs: folder ? r.filePaths[0] : path.dirname(files[0] || '') });
  return files.sort((a, b) => natural(path.basename(a), path.basename(b)));
});

/** שמירת כל הקבצים לתיקייה אחת שבוחרים */
handle('saveSubsBatch', async ({ items, sourceDir }) => {
  const prefs = loadPrefs();
  let dir = process.env.MS_TEST_SAVE_DIR || null;
  if (!dir) {
    const r = await dialog.showOpenDialog(win, {
      title: `איפה לשמור את ${items.length} קבצי הכתוביות?`,
      defaultPath: prefs.dir_save_subs || sourceDir || app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'שמור כאן',
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    dir = r.filePaths[0];
    savePrefs({ ...prefs, dir_save_subs: dir });
  }
  let first = null;
  for (const it of items) {
    const out = path.join(dir, path.basename(String(it.name)));
    fs.writeFileSync(out, `\uFEFF${String(it.text).replace(/^\uFEFF/, '')}`, 'utf8');
    created.add(out);
    if (!first) first = out;
  }
  return { ok: true, count: items.length, dir, first };
});
handle('readSubs', (file) => {
  const st = fs.statSync(file);
  if (st.size > 20 * 1024 * 1024) return { error: 'too-big' };
  const { text, encoding } = S.decodeText(fs.readFileSync(file));
  return { ok: true, name: path.basename(file), path: file, text, encoding };
});

handle('saveSubs', async ({ text, suggested, fmt, sourcePath }) => {
  const prefs = loadPrefs();
  let out = process.env.MS_TEST_SAVE_DIR ? path.join(process.env.MS_TEST_SAVE_DIR, suggested) : null;
  if (!out) {
    const r = await dialog.showSaveDialog(win, {
      title: 'איפה לשמור את הכתוביות?',
      defaultPath: path.join(prefs.dir_save_subs || (sourcePath ? path.dirname(sourcePath) : app.getPath('videos')), suggested),
      filters: [{ name: fmt === 'vtt' ? 'WebVTT' : 'SubRip (SRT)', extensions: [fmt === 'vtt' ? 'vtt' : 'srt'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    out = r.filePath;
    savePrefs({ ...prefs, dir_save_subs: path.dirname(out) });
  }
  // UTF-8 עם BOM – כך נגנים ב-Windows מזהים עברית נכון
  fs.writeFileSync(out, `﻿${String(text).replace(/^﻿/, '')}`, 'utf8');
  created.add(out);
  return { ok: true, path: out, name: path.basename(out) };
});

handle('previewVideo', (file) => {
  if (!fs.statSync(file).isFile()) return { error: 'missing' };
  previewVideo = file;
  return { ok: true, url: `media://video/${encodeURIComponent(path.basename(file))}?v=${Date.now()}`, name: path.basename(file) };
});

// ---------- דיבוב ----------
handle('probe', (file) => {
  if (!fs.statSync(file).isFile()) return { error: 'missing' };
  const info = probe(file);
  if (!info.audio.length) return { error: 'no-audio' };
  return { ok: true, name: path.basename(file), path: file, size: fs.statSync(file).size, ...info };
});

handle('dubAnalyze', async ({ english, dubbed, engTrack = 0, hebTrack = 0 }) => {
  cancelled = false;
  const isCancelled = () => cancelled;
  send('dubProgress', { stage: 1, value: 0 });
  const eng = await A.extractEnergy(ffmpegPath(), english, { track: engTrack, isCancelled, onProgress: (v) => send('dubProgress', { stage: 1, value: v }) });
  send('dubProgress', { stage: 2, value: 0 });
  const heb = await A.extractEnergy(ffmpegPath(), dubbed, { track: hebTrack, isCancelled, onProgress: (v) => send('dubProgress', { stage: 2, value: v }) });
  send('dubProgress', { stage: 3, value: 0.5 });
  await new Promise((r) => setImmediate(r));
  const eo = A.onsets(eng.energy);
  const ho = A.onsets(heb.energy);
  const g = A.globalAlign(eo, ho, { maxOffsetSec: Math.min(900, Math.max(eng.duration, heb.duration)) });
  const lc = A.localCheck(eo, ho, g.ratio, g.offset);
  const segments = lc.segments.length ? lc.segments : [{ start: 0, end: eng.duration, offset: g.offset }];
  dub = { english, dubbed, engTrack, hebTrack, engDuration: eng.duration, ratio: g.ratio, segments };
  send('dubProgress', { stage: 3, value: 1 });
  return {
    ok: true, ratio: g.ratio, offset: g.offset, score: g.score, confident: g.score > 0.15 && lc.syncedPercent >= 50,
    syncedPercent: lc.syncedPercent, segments, windows: lc.windows.map((w) => ({ start: w.start, end: w.end, ok: w.ok, deltaMs: w.deltaMs ?? null, offset: w.offset ?? null, reason: w.reason })),
    engDuration: eng.duration, hebDuration: heb.duration,
  };
});

handle('dubExport', async ({ keepEnglish = true, keepSubs = true }) => {
  if (!dub) return { error: 'not-analyzed' };
  const prefs = loadPrefs();
  const suggested = `${path.basename(dub.english).replace(/\.[^.]+$/, '')}.עברית.mkv`;
  let out = process.env.MS_TEST_SAVE_DIR ? path.join(process.env.MS_TEST_SAVE_DIR, suggested) : null;
  if (!out) {
    const r = await dialog.showSaveDialog(win, {
      title: 'איפה לשמור את הסרט עם הדיבוב?',
      defaultPath: path.join(prefs.dir_save_dub || path.dirname(dub.english), suggested),
      filters: [{ name: 'Matroska (MKV)', extensions: ['mkv'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    out = r.filePath.toLowerCase().endsWith('.mkv') ? r.filePath : `${r.filePath}.mkv`;
    savePrefs({ ...prefs, dir_save_dub: path.dirname(out) });
  }
  if ([dub.english, dub.dubbed].some((f) => path.resolve(f) === path.resolve(out))) return { error: 'same-file' };
  const args = A.muxArgs({ english: dub.english, dubbed: dub.dubbed, output: out, ratio: dub.ratio, segments: dub.segments, engDuration: dub.engDuration, hebTrack: dub.hebTrack, keepEnglish, keepSubs });
  cancelled = false;
  const ok = await new Promise((resolve) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    job = p;
    let errTail = '';
    p.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/g; let r; let last = null;
      while ((r = m.exec(String(d)))) last = Number(r[1]) / 1e6;
      if (last !== null) send('dubProgress', { stage: 4, value: Math.min(1, last / dub.engDuration) });
    });
    p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-4000); });
    p.on('error', () => resolve(false));
    p.on('close', (code) => { job = null; resolve(code === 0 && !cancelled); });
  });
  if (!ok) { try { fs.unlinkSync(out); } catch { /* ignore */ } return cancelled ? { canceled: true } : { error: 'export-failed' }; }
  created.add(out);
  return { ok: true, path: out, name: path.basename(out) };
});

handle('cancel', () => { cancelled = true; if (job) job.kill(); return { ok: true }; });
handle('showInFolder', (file) => { if (created.has(file) && fs.existsSync(file)) shell.showItemInFolder(file); return { ok: created.has(file) }; });
handle('version', () => app.getVersion());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => cb({ cancel: true }));
  protocol.handle('media', (request) => {
    if (!previewVideo) return new Response(null, { status: 404 });
    try { return serveFile(previewVideo, request); } catch { return new Response(null, { status: 404 }); }
  });
  createWindow();
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { cancelled = true; if (job) job.kill(); app.quit(); });
