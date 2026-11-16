'use strict';
/**
 * כתוביות: קריאה (SRT / VTT, כולל עברית בקידוד Windows-1255), תזמון מחדש וכתיבה.
 * בלי Electron – אפשר לבדוק, ונטען גם בממשק.
 */

const DEFAULTS = {
  shiftMs: 0, // הזזת כל הכתוביות (מינוס = מוקדם יותר)
  extendMs: 700, // כמה להאריך כל כתובית
  minMs: 1500, // משך מינימלי – שורות קצרות לא "יחלפו"
  cps: 15, // מהירות קריאה: תווים לשנייה (0 = לא לפי אורך)
  maxMs: 7000, // לא להאריך מעבר לזה (אם הכתובית במקור ארוכה יותר – נשארת)
  gapMs: 80, // רווח מינימלי בין כתוביות – בלי חפיפות
  mergeMs: 250, // שתי כתוביות שמתחילות כמעט יחד → כתובית אחת
  tightPunct: false, // "שלום , מה ?" → "שלום, מה?"
  titleCase: false, // אות גדולה בתחילת כל מילה
};

// ---------- קידוד ----------
/** מחזיר { text, encoding } – UTF-8 / UTF-16 / Windows-1255 (עברית ישנה) */
function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'UTF-8' };
  if (u8[0] === 0xff && u8[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'UTF-16' };
  if (u8[0] === 0xfe && u8[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'UTF-16' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1255').decode(u8), encoding: 'Windows-1255' };
  }
}

// ---------- קריאה ----------
const TIME = '(\\d{1,2}:)?(\\d{1,2}):(\\d{1,2})[,.](\\d{1,3})';
const LINE_RE = new RegExp(`^\\s*${TIME}\\s*-->\\s*${TIME}`);

function toMs(h, m, s, f) {
  const frac = Number(String(f).padEnd(3, '0').slice(0, 3));
  return ((Number(h ? h.slice(0, -1) : 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + frac;
}

/** SRT או VTT → { format, cues: [{ start, end, text }] } (זמנים במילישניות) */
function parse(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const format = /^\s*WEBVTT/.test(text) ? 'vtt' : 'srt';
  const cues = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => LINE_RE.test(l));
    if (i < 0) continue;
    const m = LINE_RE.exec(lines[i]);
    const start = toMs(m[1], m[2], m[3], m[4]);
    const end = toMs(m[5], m[6], m[7], m[8]);
    const body = lines.slice(i + 1).join('\n').replace(/\s+$/, '');
    if (!body.trim()) continue;
    cues.push({ start, end: Math.max(end, start), text: body });
  }
  cues.sort((a, b) => a.start - b.start);
  return { format, cues };
}

// ---------- כתיבה ----------
function fmtTime(ms, sep) {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3600000);
  const m = Math.floor(v / 60000) % 60;
  const s = Math.floor(v / 1000) % 60;
  const f = v % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

function format(cues, fmt = 'srt') {
  if (fmt === 'vtt') {
    return `WEBVTT\n\n${cues.map((c) => `${fmtTime(c.start, '.')} --> ${fmtTime(c.end, '.')}\n${c.text}`).join('\n\n')}\n`;
  }
  return `${cues.map((c, i) => `${i + 1}\r\n${fmtTime(c.start, ',')} --> ${fmtTime(c.end, ',')}\r\n${c.text.replace(/\n/g, '\r\n')}`).join('\r\n\r\n')}\r\n`;
}

// ---------- טקסט ----------
/** אורך לקריאה – בלי תגיות עיצוב ובלי רווחים כפולים */
const plain = (t) => String(t).replace(/<[^>]*>|\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();

/** פיסוק צמוד למילה: בלי רווח לפני , . ! ? : ; … ובלי רווח אחרי ( */
function tightPunctuation(t) {
  return String(t)
    .split('\n')
    .map((line) => line
      .replace(/[ \t]+/g, ' ')
      .replace(/ +([,.!?:;…%)\]»"]*[,.!?:;…%)\]])/g, '$1')
      .replace(/([(\[«]) +/g, '$1')
      .replace(/^ +| +$/g, ''))
    .join('\n');
}

/** אות גדולה בתחילת כל מילה (רק אותיות לטיניות; עברית לא מושפעת). לא נוגע בתגיות. */
function titleCase(t) {
  return String(t).replace(/<[^>]*>|\{[^}]*\}|[^<{]+/g, (part) => {
    if (part.startsWith('<') || part.startsWith('{')) return part;
    return part.replace(/(^|[\s"'(\[\-–—/>¿¡])(\p{Ll})/gu, (_m, pre, ch) => pre + ch.toUpperCase());
  });
}

function applyText(text, opts) {
  let t = text;
  if (opts.tightPunct) t = tightPunctuation(t);
  if (opts.titleCase) t = titleCase(t);
  return t;
}

// ---------- תזמון ----------
/**
 * מאריך כל כתובית כדי שתישאר על המסך מספיק זמן, בלי חפיפות.
 * לא מקצר כתובית מתחת למשך המקורי שלה – אלא אם היא חופפת לבאה אחריה.
 */
function retime(input, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const src = input.map((c) => ({ start: c.start + o.shiftMs, end: c.end + o.shiftMs, text: applyText(c.text, o) }))
    .filter((c) => c.end > 0)
    .map((c) => ({ ...c, start: Math.max(0, c.start) }))
    .sort((a, b) => a.start - b.start);

  // מיזוג כתוביות שמתחילות כמעט באותו רגע (למשל שני דוברים)
  const cues = [];
  let merged = 0;
  for (const c of src) {
    const prev = cues[cues.length - 1];
    if (prev && o.mergeMs > 0 && c.start - prev.start < o.mergeMs) {
      prev.text = `${prev.text}\n${c.text}`;
      prev.end = Math.max(prev.end, c.end);
      merged++;
    } else cues.push({ ...c });
  }

  let extended = 0;
  let overlapsFixed = 0;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const orig = c.end - c.start;
    const reading = o.cps > 0 ? (plain(c.text).length / o.cps) * 1000 : 0;
    let want = Math.max(orig + o.extendMs, o.minMs, reading);
    if (o.maxMs > 0) want = Math.min(want, Math.max(o.maxMs, orig));
    let end = c.start + want;
    const next = cues[i + 1];
    if (next) {
      const limit = next.start - o.gapMs;
      if (c.end > limit) overlapsFixed++; // חפיפה כבר במקור
      end = Math.min(end, limit);
      end = Math.max(end, Math.min(c.start + 100, next.start)); // לפחות עשירית שנייה
    }
    end = Math.round(end);
    if (end > c.end) extended++;
    c.end = end;
  }

  const durations = (list) => list.map((c) => c.end - c.start);
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  const shortCount = (list) => list.filter((c) => c.end - c.start < 1000).length;
  const overlapsLeft = cues.filter((c, i) => cues[i + 1] && c.end > cues[i + 1].start).length;
  return {
    cues,
    stats: {
      count: cues.length, extended, merged, overlapsFixed, overlapsLeft,
      avgBefore: avg(durations(input)), avgAfter: avg(durations(cues)),
      shortBefore: shortCount(input), shortAfter: shortCount(cues),
    },
  };
}

/** כתובית שמוצגת ברגע t (לתצוגה המקדימה) */
function cueAt(cues, t) {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1; else hi = mid - 1;
  }
  const c = cues[hi];
  return c && t < c.end ? { index: hi, cue: c } : null;
}

/** "Aladdin 2019 UHD TrueHD 7 1-HDH" → "Aladdin.2019.UHD.TrueHD.7.1-HDH" (נקודות במקום רווחים) */
function dotted(name) {
  return String(name).trim().replace(/[\s_]+/g, '.').replace(/\.{2,}/g, '.').replace(/\.?-\.?/g, '-').replace(/^\.|\.$/g, '');
}

/**
 * שם לשמירה. opts.dots – נקודות במקום רווחים ובלי תוספת ".מתוזמן";
 * opts.videoName – שם הסרט (כדי שהנגן יטען את הכתוביות לבד).
 */
function suggestName(name, fmt, opts = {}) {
  const ext = fmt === 'vtt' ? 'vtt' : 'srt';
  const fromVideo = opts.videoName ? String(opts.videoName).replace(/\.[^.]+$/, '') : null;
  const base = fromVideo || String(name || 'כתוביות').replace(/\.[^.]+$/, '');
  if (opts.dots) return `${dotted(base)}.${ext}`;
  return fromVideo ? `${base}.${ext}` : `${base}.מתוזמן.${ext}`;
}

const subsApi = { DEFAULTS, decodeText, parse, format, fmtTime, plain, tightPunctuation, titleCase, retime, cueAt, suggestName, dotted };
if (typeof module !== 'undefined' && module.exports) module.exports = subsApi; else globalThis.Subs = subsApi;
