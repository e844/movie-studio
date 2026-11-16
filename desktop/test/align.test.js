'use strict';
// סנכרון דיבוב על "סרטים" סינתטיים: אותה מוזיקה/אפקטים, דיבור שונה, היסט + מהירות PAL
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../src/align');

const FF = process.env.SC_FFMPEG || 'ffmpeg';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));
const run = (args) => { const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status !== 0) throw new Error(String(r.stderr)); };
const DUR = 150;
// "מוזיקה ואפקטים" משותפים: אירועים אקראיים (כמו אפקטים בסרט) – לא מחזוריים
const bedFile = require('./fixtures').bedWav(path.join(dir, 'bed.wav'), DUR);
const speech = (f, k) => `sine=f=${f}:d=${DUR},volume='0.25*gt(sin(${k}*t)+sin(${k * 2.3}*t),1.1)':eval=frame`;
const eng = path.join(dir, 'english.mkv');
const heb = path.join(dir, 'מדובב.mkv');
const hebCut = path.join(dir, 'cut.mkv');
const hebEarly = path.join(dir, 'early.mka');

test.before(() => {
  run(['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=24000/1001:d=${DUR}`, '-i', bedFile, '-f', 'lavfi', '-i', speech(300, 1.7),
    '-filter_complex', '[1][2]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac', '-shortest', eng]);
  // גרסה מדובבת: אותו רקע, דיבור אחר, מואץ ל-25fps (פי 1.0427) ומתחילה 3.25 שניות מאוחר יותר
  run(['-f', 'lavfi', '-i', `testsrc=s=320x240:r=25:d=${DUR}`, '-i', bedFile, '-f', 'lavfi', '-i', speech(520, 2.3),
    '-filter_complex', `[1][2]amix=inputs=2:normalize=0,adelay=delays=${Math.round(3250 * 25 / 23.976)}:all=1,atempo=${25 / 23.976}[a]`, '-map', '0:v', '-map', '[a]',
    '-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac', '-t', String(DUR), heb]);
  // גרסה עם סצנה חסרה: 4 שניות (בזמן האנגלית 60–64) הוסרו
  run(['-i', bedFile, '-f', 'lavfi', '-i', speech(520, 2.3),
    '-filter_complex', '[0][1]amix=inputs=2:normalize=0,asplit[x][y];[x]atrim=0:60,asetpts=PTS-STARTPTS[p];[y]atrim=64,asetpts=PTS-STARTPTS[q];[p][q]concat=n=2:v=0:a=1,adelay=delays=1500:all=1[a]',
    '-map', '[a]', '-c:a', 'aac', hebCut]);
  // גרסה שמתחילה 2 שניות *לפני* האנגלית (חסרות לה 2 השניות הראשונות)
  run(['-i', bedFile, '-f', 'lavfi', '-i', speech(520, 2.3),
    '-filter_complex', '[0][1]amix=inputs=2:normalize=0,atrim=start=2,asetpts=PTS-STARTPTS[a]', '-map', '[a]', '-c:a', 'aac', hebEarly]);
});

let E; let H;
test('energy + global alignment finds PAL speed and offset', async () => {
  E = await A.extractEnergy(FF, eng);
  H = await A.extractEnergy(FF, heb);
  assert.ok(Math.abs(E.duration - DUR) < 0.1, `eng ${E.duration}`);
  const r = A.globalAlign(A.onsets(E.energy), A.onsets(H.energy));
  assert.ok(Math.abs(r.ratio - 23.976 / 25) < 1e-9, `ratio ${r.ratio}`);
  assert.ok(Math.abs(r.offset - 3.25) < 0.02, `offset ${r.offset}`);
  assert.ok(r.score > 0.3, `score ${r.score}`);
});

test('local check: whole movie in sync', () => {
  const eo = A.onsets(E.energy); const ho = A.onsets(H.energy);
  const g = A.globalAlign(eo, ho);
  const lc = A.localCheck(eo, ho, g.ratio, g.offset);
  assert.ok(lc.syncedPercent >= 90, `synced ${lc.syncedPercent}% ${JSON.stringify(lc.windows.map((w) => w.deltaMs))}`);
  assert.equal(lc.segments.length, 1);
});

test('missing scene → two segments with the right offsets', async () => {
  const C = await A.extractEnergy(FF, hebCut);
  const eo = A.onsets(E.energy); const co = A.onsets(C.energy);
  const g = A.globalAlign(eo, co);
  assert.equal(g.ratio, 1);
  const lc = A.localCheck(eo, co, g.ratio, g.offset);
  assert.equal(lc.segments.length, 2, JSON.stringify(lc.segments));
  assert.ok(Math.abs(lc.segments[0].offset - 1.5) < 0.03, JSON.stringify(lc.segments));
  assert.ok(Math.abs(lc.segments[1].offset - (1.5 - 4)) < 0.03, JSON.stringify(lc.segments));
  assert.ok(lc.segments[0].end >= 55 && lc.segments[0].end <= 95, JSON.stringify(lc.segments));
});

test('mux: video copied, Hebrew track synced to the English movie', async () => {
  const eo = A.onsets(E.energy); const ho = A.onsets(H.energy);
  const g = A.globalAlign(eo, ho);
  const lc = A.localCheck(eo, ho, g.ratio, g.offset);
  const out = path.join(dir, 'english.heb.mkv');
  const args = A.muxArgs({ english: eng, dubbed: heb, output: out, ratio: g.ratio, segments: lc.segments, engDuration: E.duration });
  const r = spawnSync(FF, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const info = A.parseMedia(spawnSync(FF, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr);
  assert.equal(info.video.width, 640); // הווידאו של האנגלית, כמו שהוא
  assert.equal(info.audio.length, 2);
  assert.equal(info.audio[0].lang, 'heb');
  assert.ok(Math.abs(info.duration - DUR) < 0.5, `${info.duration}`);
  // הערוץ העברי בקובץ החדש מסונכרן לאנגלית: היסט ~0 ומהירות 1
  const D = await A.extractEnergy(FF, out, { track: 0 });
  const chk = A.globalAlign(eo, A.onsets(D.energy));
  assert.equal(chk.ratio, 1);
  assert.ok(Math.abs(chk.offset) < 0.03, `residual ${chk.offset}`);
});

test('mux with a missing scene: both parts in sync', async () => {
  const C = await A.extractEnergy(FF, hebCut);
  const eo = A.onsets(E.energy); const co = A.onsets(C.energy);
  const g = A.globalAlign(eo, co);
  const lc = A.localCheck(eo, co, g.ratio, g.offset);
  const out = path.join(dir, 'english.cut.mkv');
  const r = spawnSync(FF, A.muxArgs({ english: eng, dubbed: hebCut, output: out, ratio: g.ratio, segments: lc.segments, engDuration: E.duration, hebTrack: 0 }).map((x) => x), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const D = await A.extractEnergy(FF, out, { track: 0 });
  const lc2 = A.localCheck(eo, A.onsets(D.energy), 1, 0);
  const bad = lc2.windows.filter((w) => w.ok && Math.abs(w.deltaMs) > 40);
  assert.ok(bad.length <= 1, JSON.stringify(lc2.windows.map((w) => [w.start, w.deltaMs, w.ok])));
});

test('media info: 4K HDR', () => {
  const i = A.parseMedia(`Duration: 02:01:03.50, start: 0\n  Stream #0:0(eng): Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 23.98 fps\n  Stream #0:1(heb): Audio: ac3, 48000 Hz, 5.1(side), fltp, 448 kb/s\n  Stream #0:2(eng): Audio: truehd, 48000 Hz, 7.1, s32\n`);
  assert.equal(i.duration, 7263.5);
  assert.deepEqual(i.video, { codec: 'hevc', width: 3840, height: 2160, fps: 23.98, hdr: true });
  assert.deepEqual(i.audio.map((a) => a.lang), ['heb', 'eng']);
});

test('dub starts earlier than the English (negative offset) → padded with silence, in sync', async () => {
  const X = await A.extractEnergy(FF, hebEarly);
  const eo = A.onsets(E.energy); const xo = A.onsets(X.energy);
  const g = A.globalAlign(eo, xo);
  assert.equal(g.ratio, 1);
  assert.ok(Math.abs(g.offset + 2) < 0.02, `offset ${g.offset}`);
  const lc = A.localCheck(eo, xo, g.ratio, g.offset);
  const out = path.join(dir, 'english.early.mkv');
  const r = spawnSync(FF, A.muxArgs({ english: eng, dubbed: hebEarly, output: out, ratio: g.ratio, segments: lc.segments, engDuration: E.duration }), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const D = await A.extractEnergy(FF, out, { track: 0 });
  const chk = A.globalAlign(eo, A.onsets(D.energy));
  assert.ok(Math.abs(chk.offset) < 0.03, `residual ${chk.offset}`);
  assert.ok(Math.abs(D.duration - E.duration) < 0.3, `${D.duration}`);
});
