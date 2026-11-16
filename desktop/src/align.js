'use strict';
/**
 * סנכרון דיבוב: מוצא איך הזמן בסרט המדובב מתאים לזמן בסרט באנגלית.
 * שני הסרטים חולקים את המוזיקה והאפקטים – אז משווים את "טביעת העוצמה" של הקול (כל 10ms).
 * תוצאה: hebTime = ratio × engTime + offset (+ קטעים, אם יש סצנות שנוספו/חסרות).
 */
const { spawn } = require('node:child_process');

const RATE = 100; // נקודות לשנייה (10ms)
const PCM_RATE = 8000;

/** יחסי מהירות נפוצים בין גרסאות (DVD אירופאי 25fps מול סרט 23.976fps וכו') */
const RATIOS = [1, 23.976 / 25, 25 / 23.976, 24 / 25, 25 / 24, 23.976 / 24, 24 / 23.976];

// ---------- הפקת עוצמה מהקובץ ----------
/** עוצמת הקול (RMS) כל 10ms, בהמשכים, מתוך ערוץ השמע הראשון (או track שנבחר) */
function extractEnergy(ffmpeg, file, { track = 0, onProgress, isCancelled } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-map', `0:a:${track}`, '-vn', '-sn', '-dn',
      '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const block = PCM_RATE / RATE;
    const out = [];
    let sum = 0;
    let n = 0;
    let carry = null;
    let err = '';
    let duration = 0;
    let lastP = -1;
    p.stdout.on('data', (d) => {
      if (isCancelled && isCancelled()) { p.kill(); return; }
      let b = d;
      if (carry) { b = Buffer.concat([carry, d]); carry = null; }
      const usable = b.length - (b.length % 2);
      if (usable < b.length) carry = b.subarray(usable);
      for (let i = 0; i < usable; i += 2) {
        const v = b.readInt16LE(i) / 32768;
        sum += v * v;
        if (++n === block) { out.push(Math.sqrt(sum / block)); sum = 0; n = 0; }
      }
      if (onProgress && duration > 0) {
        const pr = Math.min(1, out.length / RATE / duration);
        if (pr - lastP > 0.01) { lastP = pr; onProgress(pr); }
      }
    });
    p.stderr.on('data', (d) => {
      if (err.length < 300_000) err += d;
      if (!duration) {
        const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
        if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      }
    });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg-missing' : 'unreadable')));
    p.on('close', (code) => {
      if (isCancelled && isCancelled()) { reject(new Error('cancelled')); return; }
      if (!out.length) { reject(new Error(/Stream map|matches no streams/.test(err) ? 'no-audio' : 'unreadable')); return; }
      if (code !== 0 && out.length < RATE) { reject(new Error('unreadable')); return; }
      resolve({ energy: Float32Array.from(out), duration: out.length / RATE, stderr: err });
    });
  });
}

/** "פתיחות" – עליות בעוצמה (בסקאלה לוגריתמית), מנורמל. זה מה שמשווים. */
function onsets(energy) {
  const n = energy.length;
  const out = new Float64Array(n);
  let prev = Math.log(1e-4 + energy[0]);
  for (let i = 1; i < n; i++) {
    const cur = Math.log(1e-4 + energy[i]);
    out[i] = Math.max(0, cur - prev);
    prev = cur;
  }
  return normalize(out);
}

function normalize(a) {
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += a[i];
  mean /= a.length || 1;
  let sd = 0;
  for (let i = 0; i < a.length; i++) { a[i] -= mean; sd += a[i] * a[i]; }
  sd = Math.sqrt(sd / (a.length || 1)) || 1;
  for (let i = 0; i < a.length; i++) a[i] /= sd;
  return a;
}

// ---------- FFT ----------
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j]; const ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * מתאם צולב: c[L] = Σ a[n] · b[n − L]. מחזיר את L הטוב ביותר בטווח [-maxLag, maxLag],
 * עם דיוק של פחות מנקודה (התאמת פרבולה), וציון (0..1) ויחס שיא/רעש.
 */
function bestLag(a, b, maxLag) {
  let size = 1;
  while (size < a.length + b.length) size <<= 1;
  const ar = new Float64Array(size); const ai = new Float64Array(size);
  const br = new Float64Array(size); const bi = new Float64Array(size);
  ar.set(a); br.set(b);
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r; ai[i] = im;
  }
  fft(ar, ai, true);
  const at = (L) => ar[(L + size) % size];
  let best = -Infinity;
  let bestL = 0;
  const lim = Math.min(maxLag, size / 2 - 1);
  for (let L = -lim; L <= lim; L++) { const v = at(L); if (v > best) { best = v; bestL = L; } }
  // שיא שני (רחוק מהראשון) – כדי לדעת כמה ההתאמה בטוחה
  let second = -Infinity;
  for (let L = -lim; L <= lim; L++) if (Math.abs(L - bestL) > 50) second = Math.max(second, at(L));
  const y0 = at(bestL - 1); const y1 = best; const y2 = at(bestL + 1);
  const den = y0 - 2 * y1 + y2;
  const frac = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
  let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) na += a[i] * a[i];
  for (let i = 0; i < b.length; i++) nb += b[i] * b[i];
  // השיאים המובילים (מרוחקים זה מזה) – כדי לבדוק כל אחד ברזולוציה מלאה
  const peaks = [];
  for (let L = -lim + 1; L < lim; L++) {
    const v = at(L);
    if (v > at(L - 1) && v >= at(L + 1)) peaks.push([L, v]);
  }
  peaks.sort((x, y) => y[1] - x[1]);
  const top = [];
  for (const [L] of peaks) { if (top.every((t) => Math.abs(t - L) > 10)) top.push(L); if (top.length >= 6) break; }
  return { lag: bestL + frac, score: best / Math.sqrt(na * nb || 1), peakRatio: second > 0 ? best / second : 99, top };
}

/** מתיחת אות: w[n] = sig[n · ratio] (אינטרפולציה לינארית) – לבדיקת יחס מהירות */
function warp(sig, ratio, length) {
  const out = new Float64Array(length);
  for (let n = 0; n < length; n++) {
    const x = n * ratio;
    const i = Math.floor(x);
    if (i + 1 >= sig.length) break;
    const f = x - i;
    out[n] = sig[i] * (1 - f) + sig[i + 1] * f;
  }
  return out;
}

/**
 * ההתאמה הכללית: לכל יחס מהירות – מותחים את המדובב לציר הזמן של האנגלית ומחפשים היסט.
 * מחזיר { ratio, offset (שניות), score, peakRatio }: hebTime = ratio × engTime + offset
 */
function globalAlign(engOn, hebOn, { maxOffsetSec = 600, ratios = RATIOS } = {}) {
  // לחיפוש הגס מספיקה רזולוציה של 50ms (מהיר פי 5); אחר כך מדייקים
  const dec = 5;
  const down = (s) => { const o = new Float64Array(Math.floor(s.length / dec)); for (let i = 0; i < o.length; i++) { let m = 0; for (let k = 0; k < dec; k++) m = Math.max(m, s[i * dec + k]); o[i] = m; } return normalize(o); };
  const e5 = down(engOn);
  const h5 = down(hebOn);
  const cands = [];
  for (const ratio of ratios) {
    const w = normalize(warp(h5, ratio, Math.ceil(h5.length / ratio)));
    const r = bestLag(e5, w, Math.round((maxOffsetSec * RATE) / dec));
    cands.push({ ratio, ...r });
  }
  // שני היחסים הטובים, ובכל אחד כמה שיאים – כל אחד נבדק ברזולוציה מלאה (10ms + פרבולה)
  cands.sort((x, y) => y.score - x.score);
  let best = null;
  for (const c of cands.slice(0, 2)) {
    const w = normalize(warp(hebOn, c.ratio, Math.ceil(hebOn.length / c.ratio)));
    for (const L5 of c.top.slice(0, 4)) {
      const fine = refineLag(engOn, w, L5 * dec, 8);
      // משווים לפי הסכום הגולמי: ציון מנורמל "מעדיף" היסטים עם חפיפה קצרה (רעש)
      if (!best || fine.raw > best.raw) best = { ratio: c.ratio, lag: fine.lag, score: fine.score, raw: fine.raw };
    }
  }
  // ביטחון: הפרש בין ההתאמה הטובה לשנייה
  const second = cands[1] ? cands[1].score : 0;
  // w[n − L] ≈ eng[n] ⇒ hebTime = ratio × (engTime − L)
  return { ratio: best.ratio, offset: (-best.ratio * best.lag) / RATE, score: best.score, peakRatio: cands[0].peakRatio, ratioMargin: second ? cands[0].score / second : 99 };
}

/** חיפוש ישיר סביב היסט ידוע (מהיר לטווח קטן) */
function refineLag(a, b, center, radius, from = 0, to = a.length) {
  let bestV = -Infinity;
  let bestL = center;
  const vals = new Map();
  for (let L = center - radius - 1; L <= center + radius + 1; L++) {
    let s = 0;
    const lo = Math.max(from, L);
    const hi = Math.min(to, b.length + L);
    for (let n = lo; n < hi; n++) s += a[n] * b[n - L];
    vals.set(L, s);
    if (L >= center - radius && L <= center + radius && s > bestV) { bestV = s; bestL = L; }
  }
  const y0 = vals.get(bestL - 1); const y2 = vals.get(bestL + 1);
  const den = y0 - 2 * bestV + y2;
  const frac = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
  let na = 0; let nb = 0;
  for (let n = Math.max(from, center); n < Math.min(to, b.length + center); n++) { na += a[n] * a[n]; nb += b[n - center] * b[n - center]; }
  return { lag: bestL + frac, score: bestV / Math.sqrt(na * nb || 1), raw: bestV };
}

/**
 * בדיקה לאורך הסרט: כל 30 שניות – מה ההיסט המקומי. ככה מגלים סצנות שנוספו/חסרות.
 * מחזיר חלונות + קטעים (segments) עם היסט קבוע לכל קטע.
 */
function localCheck(engOn, hebOn, ratio, offset, { windowSec = 30, searchSec = 20 } = {}) {
  const w = normalize(warp(hebOn, ratio, Math.ceil(hebOn.length / ratio)));
  const lag0 = Math.round((-offset / ratio) * RATE);
  const win = windowSec * RATE;
  const windows = [];
  for (let s = 0; s + win <= engOn.length; s += win) {
    // חלון "שקט" (בלי מספיק אירועים) – לא אמין
    let energy = 0;
    for (let n = s; n < s + win; n++) energy += engOn[n] > 1 ? 1 : 0;
    const seg = engOn.subarray(s, s + win);
    const from = Math.max(0, s - lag0 - searchSec * RATE);
    const to = Math.min(w.length, s + win - lag0 + searchSec * RATE);
    if (to - from < win / 2 || energy < 20) { windows.push({ start: s / RATE, end: (s + win) / RATE, ok: false, reason: to - from < win / 2 ? 'missing' : 'quiet' }); continue; }
    const part = w.subarray(from, to);
    const r = bestLag(seg, part, searchSec * RATE + Math.abs(s - from - lag0) + 1);
    // מיקום מוחלט: seg[n] ≈ part[n − r.lag] ⇒ eng[s+n] ≈ w[from + n − r.lag]
    const lag = s - from + r.lag;
    windows.push({
      start: s / RATE, end: (s + win) / RATE, lag,
      offset: (-ratio * lag) / RATE, deltaMs: Math.round(((lag - lag0) / RATE) * 1000),
      score: r.score, ok: r.score > 0.25 && r.peakRatio > 1.3,
    });
  }
  // קטעים: חלונות אמינים רצופים עם היסט דומה (עד 60ms)
  const segments = [];
  for (const wd of windows) {
    if (!wd.ok) continue;
    const last = segments[segments.length - 1];
    if (last && Math.abs(wd.offset - last.offset) < 0.06) {
      last.end = wd.end;
      last.offsets.push(wd.offset);
    } else segments.push({ start: wd.start, end: wd.end, offset: wd.offset, offsets: [wd.offset] });
  }
  for (const sg of segments) {
    const o = [...sg.offsets].sort((x, y) => x - y);
    sg.offset = o[Math.floor(o.length / 2)]; // חציון
    delete sg.offsets;
  }
  // מרחיבים כל קטע עד תחילת הבא (החיתוך עצמו קורה איפשהו ביניהם)
  for (let i = 0; i < segments.length; i++) {
    segments[i].start = i === 0 ? 0 : segments[i].start;
    if (segments[i + 1]) segments[i].end = segments[i + 1].start;
    else segments[i].end = engOn.length / RATE;
  }
  const reliable = windows.filter((x) => x.ok);
  const inSync = reliable.filter((x) => Math.abs(x.deltaMs) <= 40).length;
  return { windows, segments, syncedPercent: reliable.length ? Math.round((inSync / reliable.length) * 100) : 0 };
}

/**
 * הארגומנטים ל-ffmpeg: הווידאו מהאנגלית מועתק כמו שהוא (גם 4K/HDR – בלי קידוד מחדש),
 * השמע העברי מסונכרן ומקודד ל-AAC, והאנגלית נשמרת כערוץ שני.
 */
function muxArgs({ english, dubbed, output, ratio, segments, engDuration, hebTrack = 0, keepEnglish = true, keepSubs = true }) {
  const tempo = 1 / ratio; // hebTime = ratio × engTime ⇒ להאט/להאיץ פי 1/ratio … atempo מקבל מהירות
  const parts = [];
  const chains = [];
  const segs = segments.length ? segments : [{ start: 0, end: engDuration, offset: 0 }];
  // הקטעים מוגדרים בזמן של האנגלית. אחרי atempo זמן העברית הוא engTime + offset/ratio
  const base = Math.abs(ratio - 1) > 1e-6 ? `[1:a:${hebTrack}]atempo=${(ratio).toFixed(6)}[heb]` : `[1:a:${hebTrack}]anull[heb]`;
  void tempo;
  chains.push(base);
  chains.push(`[heb]asplit=${segs.length}${segs.map((_, i) => `[h${i}]`).join('')}`);
  segs.forEach((s, i) => {
    const d = s.offset / ratio; // היסט בזמן העברית המותאם
    const from = s.start + d;
    const len = s.end - s.start;
    let chain = `[h${i}]`;
    if (from >= 0) {
      chain += `atrim=start=${from.toFixed(3)}:duration=${len.toFixed(3)},asetpts=PTS-STARTPTS`;
    } else {
      // העברית מתחילה אחרי תחילת הקטע – משלימים שקט בהתחלה
      chain += `atrim=start=0:duration=${Math.max(0, len + from).toFixed(3)},asetpts=PTS-STARTPTS,adelay=delays=${Math.round(-from * 1000)}:all=1`;
    }
    chain += `,apad=whole_dur=${len.toFixed(3)},atrim=duration=${len.toFixed(3)}[s${i}]`;
    chains.push(chain);
    parts.push(`[s${i}]`);
  });
  chains.push(`${parts.join('')}concat=n=${segs.length}:v=0:a=1[dub]`);
  const args = ['-hide_banner', '-nostdin', '-y', '-i', english, '-i', dubbed,
    '-filter_complex', chains.join(';'),
    '-map', '0:v:0', '-map', '[dub]'];
  if (keepEnglish) args.push('-map', '0:a?');
  if (keepSubs) args.push('-map', '0:s?');
  args.push('-c:v', 'copy', '-c:s', 'copy', '-c:a', 'copy',
    '-c:a:0', 'aac', '-b:a:0', '256k',
    '-metadata:s:a:0', 'language=heb', '-metadata:s:a:0', 'title=עברית (מדובב)',
    '-disposition:a:0', 'default');
  if (keepEnglish) args.push('-metadata:s:a:1', 'language=eng', '-disposition:a:1', '0');
  args.push('-max_interleave_delta', '0', '-progress', 'pipe:1', '-nostats', output);
  return args;
}

/** פרטי הקבצים (משך, רזולוציה, ערוצי שמע) מתוך ffmpeg -i */
function parseMedia(stderr) {
  const t = String(stderr);
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
  const v = /Stream #\S+?: Video: (\w+)[^\n]*?, (\d{3,5})x(\d{3,5})/.exec(t);
  const fps = /(\d+(?:\.\d+)?) fps/.exec(t);
  const audio = [...t.matchAll(/Stream #\d+:\d+(?:\[\w+\])?(?:\((\w+)\))?: Audio: (\w+)[^\n]*?(\d+) Hz, ([^,\n]+)/g)]
    .map((m) => ({ lang: m[1] || '', codec: m[2], rate: Number(m[3]), layout: m[4].trim() }));
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    video: v ? { codec: v[1], width: Number(v[2]), height: Number(v[3]), fps: fps ? Number(fps[1]) : null, hdr: /smpte2084|arib-std-b67|bt2020/.test(t) } : null,
    audio,
  };
}

module.exports = { RATE, RATIOS, extractEnergy, onsets, normalize, fft, bestLag, warp, globalAlign, refineLag, localCheck, muxArgs, parseMedia };
