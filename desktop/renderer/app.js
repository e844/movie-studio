'use strict';
/* ממשק הסטודיו: כתוביות + דיבוב */
const S = globalThis.Subs;
const api = window.studio;
const $ = (id) => document.getElementById(id);

const ERR = {
  'ffmpeg-missing': 'רכיב העיבוד (ffmpeg) חסר בתיקיית התוכנה. חלץ את הקובץ מחדש.',
  'no-audio': 'בקובץ הזה אין ערוץ שמע.',
  unreadable: 'לא הצלחתי לקרוא את הקובץ.',
  missing: 'הקובץ לא נמצא.',
  'too-big': 'הקובץ גדול מדי לקובץ כתוביות.',
  'no-cues': 'לא נמצאו כתוביות בקובץ. האם זה קובץ SRT או VTT?',
  'export-failed': 'יצירת הקובץ נכשלה. נסה מקום שמירה אחר (צריך מקום פנוי בגודל הסרט).',
  'same-file': 'אי אפשר לשמור על הקובץ המקורי. בחר שם אחר.',
  cancelled: 'בוטל.',
};
const errText = (e) => ERR[e] || ERR.unreadable;

function snack(text, action, onAction) {
  $('snack-text').textContent = text;
  const b = $('snack-action');
  b.hidden = !action;
  if (action) { b.textContent = action; b.onclick = () => { onAction(); $('snackbar').hidden = true; }; }
  $('snackbar').hidden = false;
  clearTimeout(snack.t);
  snack.t = setTimeout(() => { $('snackbar').hidden = true; }, action ? 9000 : 5000);
}

// ---------- טאבים ----------
let activeTab = 'subs';
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    activeTab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', String(x === t)); });
    $('page-subs').hidden = activeTab !== 'subs';
    $('page-dub').hidden = activeTab !== 'dub';
    if (activeTab !== 'subs') pause();
  };
});

// =====================================================================
// כתוביות
// =====================================================================
const OPTS = [
  // id, מפתח, המרה לממשק (שניות) ↔ מילישניות
  ['extend', 'extendMs', 1000, (v) => `+${v.toFixed(1)} שנ׳`],
  ['min', 'minMs', 1000, (v) => `${v.toFixed(1)} שנ׳`],
  ['cps', 'cps', 1, (v) => (v === 0 ? 'כבוי' : `${v}`)],
  ['max', 'maxMs', 1000, (v) => `${v.toFixed(1)} שנ׳`],
  ['gap', 'gapMs', 1000, (v) => `${v.toFixed(2)} שנ׳`],
  ['shift', 'shiftMs', 1000, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} שנ׳`],
];
const subs = { files: [], cur: 0, file: null, format: 'srt', original: [], result: [], stats: null, compare: 'new' };

function readOptions() {
  const o = {};
  for (const [id, key, mul] of OPTS) o[key] = Number($(`o-${id}`).value) * mul;
  o.tightPunct = $('o-tight').checked;
  o.titleCase = $('o-title').checked;
  o.mergeMs = $('o-merge').checked ? S.DEFAULTS.mergeMs : 0;
  return o;
}
function setOptions(o) {
  for (const [id, key, mul] of OPTS) $(`o-${id}`).value = String(o[key] / mul);
  $('o-tight').checked = !!o.tightPunct;
  $('o-title').checked = !!o.titleCase;
  $('o-merge').checked = (o.mergeMs ?? S.DEFAULTS.mergeMs) > 0;
  showOptionValues();
}
function showOptionValues() {
  for (const [id, , , fmt] of OPTS) $(`v-${id}`).textContent = fmt(Number($(`o-${id}`).value));
}
const saved = (() => { try { return JSON.parse(localStorage.getItem('subsOptions')) || null; } catch { return null; } })();
setOptions({ ...S.DEFAULTS, ...(saved || {}) });

function recompute() {
  showOptionValues();
  const o = readOptions();
  try { localStorage.setItem('subsOptions', JSON.stringify(o)); } catch { /* ignore */ }
  if (!subs.original.length) return;
  const r = S.retime(subs.original, o);
  subs.result = r.cues;
  subs.stats = r.stats;
  renderStats();
  renderList();
  updateScreen();
}
document.querySelectorAll('#subs-editor input').forEach((i) => i.addEventListener('input', recompute));
$('o-reset').onclick = () => { setOptions(S.DEFAULTS); recompute(); };

/** טעינת קובץ אחד או כמה (עונה שלמה) */
async function openSubsMany(paths) {
  if (!paths || !paths.length) return;
  // סדר טבעי: פרק 2 לפני פרק 10
  const nameOf = (p) => p.split(/[\\/]/).pop();
  paths = [...paths].sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' }));
  const files = [];
  const bad = [];
  for (const f of paths) {
    const r = await api.readSubs(f);
    const p = r && !r.error ? S.parse(r.text) : null;
    if (!p || !p.cues.length) { bad.push(f.split(/[\\/]/).pop()); continue; }
    files.push({ info: r, format: p.format, original: p.cues });
  }
  if (!files.length) { snack(paths.length > 1 ? 'לא נמצאו קבצי כתוביות תקינים.' : ERR['no-cues']); return; }
  subs.files = files;
  const sel = $('file-select');
  sel.textContent = '';
  files.forEach((f, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${i + 1}. ${f.info.name} (${f.original.length})`;
    sel.appendChild(o);
  });
  $('subs-files').hidden = files.length < 2;
  $('subs-save-all').hidden = files.length < 2;
  $('subs-save-all').textContent = `💾 שמירת כל ${files.length} הקבצים`;
  $('subs-empty').hidden = true;
  $('subs-editor').hidden = false;
  selectFile(0);
  if (bad.length) snack(`${bad.length} קבצים דולגו (לא קבצי כתוביות תקינים): ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}`);
}

function selectFile(i) {
  const f = subs.files[i];
  if (!f) return;
  pause();
  subs.cur = i;
  subs.file = f.info;
  subs.format = f.format;
  subs.original = f.original;
  $('file-select').value = String(i);
  $('file-prev').disabled = i === 0;
  $('file-next').disabled = i === subs.files.length - 1;
  $('subs-name').textContent = f.info.name;
  const part = subs.files.length > 1 ? `קובץ ${i + 1} מתוך ${subs.files.length} · ` : '';
  $('subs-meta').textContent = `${part}${f.original.length} כתוביות · ${f.format.toUpperCase()} · קידוד ${f.info.encoding} · אורך ${fmtClock(f.original[f.original.length - 1].end)}`;
  clock.t = 0;
  recompute();
}
$('file-select').onchange = () => selectFile(Number($('file-select').value));
$('file-prev').onclick = () => selectFile(subs.cur - 1);
$('file-next').onclick = () => selectFile(subs.cur + 1);

const fmtClock = (ms) => S.fmtTime(ms, ',').replace(/,\d+$/, '');
const fmtSec = (ms) => `${(ms / 1000).toFixed(1)}`;

function renderStats() {
  const st = subs.stats;
  const box = $('subs-stats');
  box.textContent = '';
  const add = (num, label, good) => {
    const d = document.createElement('div');
    d.className = `stat${good ? ' good' : ''}`;
    const b = document.createElement('b'); b.textContent = num;
    const s = document.createElement('span'); s.textContent = label;
    d.append(b, s);
    box.appendChild(d);
  };
  add(`${st.extended}`, `כתוביות הוארכו (מתוך ${st.count})`, true);
  add(`${fmtSec(st.avgBefore)} ← ${fmtSec(st.avgAfter)}`, 'משך ממוצע בשניות (לפני ← אחרי)', st.avgAfter > st.avgBefore);
  add(`${st.shortBefore} ← ${st.shortAfter}`, 'קצרות משנייה (לפני ← אחרי)', st.shortAfter < st.shortBefore);
  add(`${st.overlapsLeft}`, st.overlapsFixed ? `חפיפות (תוקנו ${st.overlapsFixed} מהמקור)` : 'חפיפות', st.overlapsLeft === 0);
  if (st.merged) add(`${st.merged}`, 'אוחדו (התחילו כמעט יחד)', false);
}

let rows = [];
function renderList() {
  const list = $('cue-list');
  list.textContent = '';
  rows = [];
  const frag = document.createDocumentFragment();
  // משכים מקוריים לפי זמן התחלה (אחרי הזזה)
  const shift = readOptions().shiftMs;
  const origByStart = new Map(subs.original.map((c) => [c.start + shift, c.end - c.start]));
  subs.result.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'cue';
    row.dataset.i = String(i);
    const n = document.createElement('span'); n.textContent = String(i + 1);
    const t = document.createElement('span'); t.className = 't'; t.textContent = `${S.fmtTime(c.start, ',')} → ${S.fmtTime(c.end, ',').slice(3)}`;
    const d = document.createElement('span'); d.className = 'd';
    const before = origByStart.get(c.start);
    const after = c.end - c.start;
    if (before !== undefined && after > before + 1) {
      d.append(`${fmtSec(before)} → `);
      const up = document.createElement('span'); up.className = 'up'; up.textContent = fmtSec(after);
      d.append(up);
    } else d.textContent = fmtSec(after);
    const x = document.createElement('span'); x.className = 'x'; x.textContent = S.plain(c.text.replace(/\n/g, ' ⏎ ')).replace(/ ⏎ /g, '\n');
    row.append(n, t, d, x);
    row.onclick = () => { seek(c.start); };
    frag.appendChild(row);
    rows.push(row);
  });
  list.appendChild(frag);
}

$('cmp-new').onclick = () => { subs.compare = 'new'; $('cmp-new').classList.add('on'); $('cmp-old').classList.remove('on'); updateScreen(); };
$('cmp-old').onclick = () => { subs.compare = 'old'; $('cmp-old').classList.add('on'); $('cmp-new').classList.remove('on'); updateScreen(); };

// ---------- נגן תצוגה מקדימה (עם סרט או בלי) ----------
const video = $('video');
const clock = { t: 0, playing: false, last: 0, hasVideo: false };
const totalMs = () => Math.max(
  subs.result.length ? subs.result[subs.result.length - 1].end : 0,
  subs.original.length ? subs.original[subs.original.length - 1].end : 0,
  clock.hasVideo && Number.isFinite(video.duration) ? video.duration * 1000 : 0,
) + 2000;

function play() {
  clock.playing = true;
  clock.last = performance.now();
  if (clock.hasVideo) { video.currentTime = clock.t / 1000; video.play().catch(() => {}); }
  $('p-play').textContent = '⏸';
}
function pause() {
  clock.playing = false;
  if (clock.hasVideo) video.pause();
  $('p-play').textContent = '▶';
}
function seek(ms) {
  clock.t = Math.max(0, Math.min(ms, totalMs()));
  if (clock.hasVideo) video.currentTime = clock.t / 1000;
  updateScreen();
}
function restart() { seek(0); }

$('p-play').onclick = () => (clock.playing ? pause() : play());
$('p-restart').onclick = restart;
$('seek').oninput = () => seek((Number($('seek').value) / 1000) * totalMs());

let lastIndex = -1;
function updateScreen() {
  const list = subs.compare === 'old'
    ? subs.original.map((c) => ({ ...c, start: c.start + readOptions().shiftMs, end: c.end + readOptions().shiftMs }))
    : subs.result;
  const hit = S.cueAt(list, clock.t);
  $('sub-line').textContent = hit ? hit.cue.text.split('\n').map((l) => S.plain(l)).join('\n') : '';
  $('p-time').textContent = fmtClock(clock.t);
  if (document.activeElement !== $('seek')) $('seek').value = String(Math.round((clock.t / totalMs()) * 1000));
  const idx = subs.compare === 'new' && hit ? hit.index : -1;
  if (idx !== lastIndex) {
    if (rows[lastIndex]) rows[lastIndex].classList.remove('now');
    if (rows[idx]) { rows[idx].classList.add('now'); if (clock.playing) rows[idx].scrollIntoView({ block: 'nearest' }); }
    lastIndex = idx;
  }
}
(function tick(now) {
  if (clock.playing) {
    if (clock.hasVideo && !video.paused) clock.t = video.currentTime * 1000;
    else clock.t += now - clock.last;
    clock.last = now;
    if (clock.t >= totalMs()) { pause(); clock.t = totalMs(); }
    updateScreen();
  }
  requestAnimationFrame(tick);
}(performance.now()));

$('p-video').onclick = async () => {
  const f = await api.pickFile('video');
  if (!f) return;
  const r = await api.previewVideo(f);
  if (!r || r.error) { snack(errText(r && r.error)); return; }
  video.src = r.url;
  clock.hasVideo = true;
  $('screen-hint').hidden = true;
  video.onerror = () => {
    clock.hasVideo = false;
    $('screen-hint').hidden = false;
    $('screen-hint').textContent = 'את הסרט הזה אי אפשר להציג כאן (קידוד לא נתמך) – הכתוביות מוצגות על רקע שחור';
  };
  video.onloadedmetadata = () => seek(clock.t);
};

// מקלדת: 0 = מההתחלה, רווח = הפעלה/השהיה, חצים = 5 שניות
document.addEventListener('keydown', (e) => {
  if (activeTab !== 'subs' || !subs.original.length) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if (e.key === '0' || e.code === 'Numpad0' || e.code === 'Digit0') { e.preventDefault(); restart(); }
  else if (e.key === ' ') { e.preventDefault(); if (clock.playing) pause(); else play(); }
  else if (e.key === 'ArrowLeft' && !(e.target instanceof HTMLInputElement)) seek(clock.t - 5000);
  else if (e.key === 'ArrowRight' && !(e.target instanceof HTMLInputElement)) seek(clock.t + 5000);
});

// ---------- שמירה ----------
$('subs-save').onclick = async () => {
  if (!subs.result.length) return;
  const text = S.format(subs.result, subs.format);
  const r = await api.saveSubs({ text, suggested: S.suggestName(subs.file.name, subs.format), fmt: subs.format, sourcePath: subs.file.path });
  if (!r || r.canceled) return;
  if (r.error) { snack(errText(r.error)); return; }
  snack(`✓ נשמר: ${r.name}`, 'הצג בתיקייה', () => api.showInFolder(r.path));
};

// כל הקבצים: אותן הגדרות לכולם, שמירה לתיקייה אחת
$('subs-save-all').onclick = async () => {
  if (subs.files.length < 2) return;
  const o = readOptions();
  const items = subs.files.map((f) => ({ name: S.suggestName(f.info.name, f.format), text: S.format(S.retime(f.original, o).cues, f.format) }));
  const src = subs.files[0].info.path;
  const r = await api.saveSubsBatch({ items, sourceDir: src.slice(0, Math.max(src.lastIndexOf('/'), src.lastIndexOf('\\'))) });
  if (!r || r.canceled) return;
  if (r.error) { snack(errText(r.error)); return; }
  snack(`✓ נשמרו ${r.count} קבצים`, 'הצג בתיקייה', () => api.showInFolder(r.first));
};

// ---------- פתיחה / גרירה ----------
$('subs-pick-files').onclick = async () => openSubsMany(await api.pickSubsMany(false));
$('subs-pick-folder').onclick = async () => openSubsMany(await api.pickSubsMany(true));
$('subs-change').onclick = async () => openSubsMany(await api.pickSubsMany(false));

// =====================================================================
// דיבוב
// =====================================================================
const dubState = { english: null, dubbed: null };

function fmtDur(sec) {
  const h = Math.floor(sec / 3600); const m = Math.floor(sec / 60) % 60; const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fileSize(b) { return b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`; }

function renderSlot(which) {
  const info = dubState[which];
  const body = $(which === 'english' ? 'eng-body' : 'heb-body');
  body.textContent = '';
  if (!info) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'לא נבחר קובץ'; body.appendChild(p); return; }
  const name = document.createElement('div'); name.className = 'file-name'; name.textContent = info.name;
  const badges = document.createElement('div'); badges.className = 'badges';
  const badge = (t, cls = '') => { const b = document.createElement('span'); b.className = `badge ${cls}`; b.textContent = t; badges.appendChild(b); };
  if (info.video) {
    if (info.video.width >= 3800) badge('4K', 'k4');
    else badge(`${info.video.width}×${info.video.height}`);
    if (info.video.hdr) badge('HDR', 'hdr');
    badge(info.video.codec.toUpperCase());
    if (info.video.fps) badge(`${info.video.fps} fps`);
  } else badge('שמע בלבד');
  badge(fmtDur(info.duration));
  badge(fileSize(info.size));
  const label = document.createElement('label'); label.className = 'muted small'; label.textContent = 'ערוץ שמע: ';
  const sel = document.createElement('select');
  sel.id = `${which}-track`;
  info.audio.forEach((a, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${i + 1}. ${a.lang ? `${a.lang} · ` : ''}${a.codec.toUpperCase()} · ${a.layout}`;
    sel.appendChild(o);
  });
  // ברירת מחדל: בסרט המדובב – ערוץ בעברית אם יש; באנגלית – ערוץ באנגלית
  const want = which === 'dubbed' ? /^(heb|he|iw)$/ : /^(eng|en)$/;
  const idx = info.audio.findIndex((a) => want.test(a.lang));
  if (idx >= 0) sel.value = String(idx);
  sel.onchange = () => { $('dub-result').hidden = true; };
  label.appendChild(sel);
  body.append(name, badges, label);
}

async function pickDub(which) {
  const f = await api.pickFile(which === 'english' ? 'video' : 'dubbed');
  if (!f) return;
  const r = await api.probe(f);
  if (!r || r.error) { snack(errText(r && r.error)); return; }
  if (which === 'english' && !r.video) { snack('בסרט באנגלית צריך להיות וידאו.'); return; }
  dubState[which] = r;
  renderSlot(which);
  $('dub-result').hidden = true;
  $('dub-analyze').disabled = !(dubState.english && dubState.dubbed);
}
$('pick-english').onclick = () => pickDub('english');
$('pick-dubbed').onclick = () => pickDub('dubbed');

const STAGES = { 1: 'קורא את הסרט באנגלית…', 2: 'קורא את הסרט המדובב…', 3: 'משווה ומחפש התאמה…', 4: 'יוצר את הסרט עם הדיבוב…' };
api.onDubProgress(({ stage, value }) => {
  $('progress-stage').textContent = `${stage <= 3 ? `שלב ${stage} מתוך 3 · ` : ''}${STAGES[stage]}`;
  const p = stage <= 3 ? Math.round(((stage - 1 + value) / 3) * 100) : Math.round(value * 100);
  $('progress-fill').style.width = `${p}%`;
  $('progress-text').textContent = `${p}%`;
});
function progressOpen(title) {
  $('progress-title').textContent = title;
  $('progress-fill').style.width = '0%';
  $('progress-text').textContent = '0%';
  $('progress-stage').textContent = '';
  $('progress-dialog').showModal();
}
$('progress-cancel').onclick = () => api.cancel();
$('progress-dialog').addEventListener('cancel', (e) => { e.preventDefault(); api.cancel(); });

function speedText(ratio) {
  if (Math.abs(ratio - 1) < 1e-6) return 'זהה';
  const pct = ((1 / ratio - 1) * 100).toFixed(1);
  const names = { [23.976 / 25]: '25 ← 23.976 fps (PAL)', [25 / 23.976]: '23.976 ← 25 fps', [24 / 25]: '25 ← 24 fps', [25 / 24]: '24 ← 25 fps', [23.976 / 24]: '24 ← 23.976 fps', [24 / 23.976]: '23.976 ← 24 fps' };
  const key = Object.keys(names).find((k) => Math.abs(Number(k) - ratio) < 1e-6);
  return `המדובב ${pct > 0 ? 'מהיר' : 'איטי'} ב-${Math.abs(pct)}%${key ? ` · ${names[key]}` : ''}`;
}

$('dub-analyze').onclick = async () => {
  progressOpen('מסנכרן את הדיבוב');
  const r = await api.dubAnalyze({
    english: dubState.english.path, dubbed: dubState.dubbed.path,
    engTrack: Number($('english-track').value), hebTrack: Number($('dubbed-track').value),
  });
  $('progress-dialog').close();
  if (!r || r.error) { if (r && r.error !== 'cancelled') snack(errText(r && r.error)); return; }
  const off = r.segments.length === 1 ? r.segments[0].offset : r.offset;
  $('r-offset').textContent = `${off >= 0 ? '+' : ''}${off.toFixed(3)} שנ׳`;
  $('r-speed').textContent = speedText(r.ratio);
  $('r-sync').textContent = `${r.syncedPercent}%`;
  const title = $('dub-title');
  title.classList.toggle('warn', !r.confident);
  title.textContent = r.confident
    ? (r.segments.length > 1 ? `✓ נמצאה התאמה – בגרסה המדובבת יש ${r.segments.length - 1} סצנות שונות, והתוכנה תסנכרן כל חלק בנפרד` : '✓ נמצאה התאמה – הדיבוב יסונכרן לאורך כל הסרט')
    : '⚠️ ההתאמה לא בטוחה. ודא שזה אותו סרט, ושבחרת את ערוצי השמע הנכונים';
  const tl = $('r-timeline');
  tl.textContent = '';
  for (const w of r.windows) {
    const s = document.createElement('span');
    s.className = !w.ok ? 'na' : Math.abs(w.deltaMs ?? 0) <= 60 || r.segments.some((sg) => w.offset !== null && Math.abs(sg.offset - w.offset) < 0.06) ? 'ok' : 'off';
    s.title = `${fmtDur(w.start)}–${fmtDur(w.end)}${w.ok ? ` · ${w.deltaMs} ms` : ''}`;
    tl.appendChild(s);
  }
  $('r-segments').textContent = r.segments.length > 1
    ? `חלקים: ${r.segments.map((sg) => `${fmtDur(sg.start)}–${fmtDur(sg.end)} (${sg.offset >= 0 ? '+' : ''}${sg.offset.toFixed(2)} שנ׳)`).join(' · ')}`
    : '';
  $('dub-result').hidden = false;
  $('dub-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

$('dub-export').onclick = async () => {
  progressOpen('יוצר את הסרט');
  const r = await api.dubExport({ keepEnglish: $('keep-eng').checked, keepSubs: $('keep-subs').checked });
  if ($('progress-dialog').open) $('progress-dialog').close();
  if (!r || r.canceled) return;
  if (r.error) { snack(errText(r.error)); return; }
  snack(`✓ נוצר: ${r.name}`, 'הצג בתיקייה', () => api.showInFolder(r.path));
};

// גרירת קבצים: בטאב כתוביות – קובץ כתוביות
document.addEventListener('dragover', (e) => { e.preventDefault(); if (activeTab === 'subs') $('subs-empty').classList.add('over'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('subs-empty').classList.remove('over'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  $('subs-empty').classList.remove('over');
  const list = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter((p) => /\.(srt|vtt)$/i.test(p))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (activeTab === 'subs') { if (list.length) openSubsMany(list); else snack('גרור קבצי SRT או VTT.'); }
});

api.version().then((v) => { $('version').textContent = `גרסה ${v}`; });
