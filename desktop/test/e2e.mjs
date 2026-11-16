// בדיקה אמיתית של התוכנה: טאב כתוביות + טאב דיבוב
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../src/subs.js');
const A = require('../src/align.js');
const F = require('./fixtures.js');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FF = process.env.SC_FFMPEG || 'ffmpeg';
const shots = process.env.MS_SHOTS || path.join(os.tmpdir(), 'ms-shots');
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-e2e-'));
const saveDir = path.join(work, 'שמורים');
fs.mkdirSync(saveDir);
const step = async (name, fn) => { await fn(); process.stdout.write(`  ✓ ${name}\n`); };

// כתוביות בעברית בקידוד ישן (Windows-1255): קצרות, חופפות, פיסוק מרווח
const srt = `1\r\n00:00:01,000 --> 00:00:01,500\r\nאבא ?\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,500\r\nמה קרה , למה אתה צועק ?\r\n\r\n3\r\n00:00:04,300 --> 00:00:04,900\r\nכלום .\r\n\r\n4\r\n00:00:06,000 --> 00:00:06,400\r\nבוא !\r\n\r\n5\r\n00:00:20,000 --> 00:00:21,000\r\nלהתראות\r\n`;
const enc = new Map([...'אבגדהוזחטיךכלםמןנסעףפץצקרשת'].map((c, i) => [c, 0xe0 + i]));
const subsFile = path.join(work, 'Movie.heb.srt');
fs.writeFileSync(subsFile, Buffer.from([...srt].map((c) => enc.get(c) ?? c.charCodeAt(0))));
// עונה: עוד שני פרקים (UTF-8)
const ep2 = path.join(work, 'Show.S01E02.srt');
const ep10 = path.join(work, 'Show.S01E10.srt');
fs.writeFileSync(ep2, '1\n00:00:01,000 --> 00:00:01,300\nשלום\n\n2\n00:00:01,400 --> 00:00:02,000\nלהתראות\n');
fs.writeFileSync(ep10, '1\n00:00:05,000 --> 00:00:05,500\nפרק עשר\n');
const { english, dubbed } = F.movies(FF, work, 90);

const app = await electron.launch({
  args: ['--no-sandbox', root],
  env: { ...process.env, MS_USER_DATA: path.join(work, 'data'), MS_TEST_SUBS: [ep10, subsFile, ep2].join(path.delimiter), MS_TEST_VIDEO: english, MS_TEST_DUBBED: dubbed, MS_TEST_SAVE_DIR: saveDir },
});
const win = await app.firstWindow();
await win.setViewportSize({ width: 1320, height: 860 });
const shot = (n) => win.screenshot({ path: path.join(shots, `${n}.png`) });

await step('Hebrew UI, credit, open old-encoding Hebrew subtitles', async () => {
  assert.equal(await win.getAttribute('html', 'dir'), 'rtl');
  assert.match(await win.textContent('.credit'), /king400/);
  await shot('1-start');
  await win.click('#subs-pick-files');
  await win.waitForSelector('#subs-editor:not([hidden])');
  // 3 קבצים, ממוינים: Movie, Show E02, Show E10
  assert.equal(await win.locator('#file-select option').count(), 3);
  assert.match(await win.textContent('#subs-meta'), /קובץ 1 מתוך 3 · 5 כתוביות · SRT · קידוד Windows-1255/);
  assert.match(await win.textContent('.cue >> nth=1'), /מה קרה , למה אתה צועק \?/);
});

await step('longer on screen, no overlaps (stats)', async () => {
  const stats = await win.textContent('#subs-stats');
  assert.match(stats, /חפיפות \(תוקנו 1 מהמקור\)/);
  assert.match(stats, /2 ← 0\s*קצרות משנייה|קצרות משנייה/);
  assert.equal(await win.locator('.stat >> nth=3 >> b').textContent(), '0');
});

await step('tight punctuation option', async () => {
  await win.check('#o-tight');
  assert.match(await win.textContent('.cue >> nth=1'), /מה קרה, למה אתה צועק\?/);
});

await step('preview plays, key 0 returns to the start', async () => {
  await win.click('#p-play');
  await win.waitForTimeout(1600);
  await win.waitForFunction(() => document.getElementById('sub-line').textContent.includes('אבא'));
  await shot('2-subs-preview');
  await win.click('#p-play');
  await win.locator('#cue-list .cue >> nth=4').click(); // קפיצה ל-20 שניות
  assert.match(await win.textContent('#p-time'), /00:00:20/);
  await win.keyboard.press('0');
  assert.match(await win.textContent('#p-time'), /00:00:00/);
});

await step('preview on the movie itself', async () => {
  await win.click('#p-video');
  await win.waitForFunction(() => document.getElementById('video').readyState >= 2, null, { timeout: 15000 });
  await win.click('#p-play');
  await win.waitForTimeout(1500);
  assert.ok(await win.evaluate(() => document.getElementById('video').currentTime > 0.5));
  await shot('3-subs-on-video');
  await win.click('#p-play');
});

await step('save → UTF-8 SRT, no overlaps, short lines longer', async () => {
  await win.fill('#o-min', '1.5');
  await win.click('#subs-save');
  await win.waitForSelector('#snackbar:not([hidden])');
  const f = path.join(saveDir, 'Movie.heb.מתוזמן.srt');
  const raw = fs.readFileSync(f);
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const cues = S.parse(raw.toString('utf8')).cues;
  assert.equal(cues.length, 5);
  assert.equal(cues[0].text, 'אבא?');
  for (let i = 0; i + 1 < cues.length; i++) assert.ok(cues[i].end <= cues[i + 1].start, `overlap ${i}`);
  assert.ok(cues[0].end - cues[0].start > 500);
  assert.ok(cues[4].end - cues[4].start >= 1500);
  await shot('4-subs-saved');
});

await step('several files: switch between them, save all to one folder', async () => {
  await win.click('#file-next');
  assert.equal(await win.textContent('#subs-name'), 'Show.S01E02.srt');
  await win.selectOption('#file-select', '2');
  assert.equal(await win.textContent('#subs-name'), 'Show.S01E10.srt');
  await shot('4b-many-files');
  await win.click('#subs-save-all');
  await win.waitForFunction(() => /נשמרו 3 קבצים/.test(document.getElementById('snack-text').textContent));
  for (const n of ['Movie.heb.מתוזמן.srt', 'Show.S01E02.מתוזמן.srt', 'Show.S01E10.מתוזמן.srt']) assert.ok(fs.existsSync(path.join(saveDir, n)), n);
  const c = S.parse(fs.readFileSync(path.join(saveDir, 'Show.S01E02.מתוזמן.srt'), 'utf8')).cues;
  assert.ok(c[0].end <= c[1].start, 'no overlap');
  assert.equal(c[1].end - c[1].start >= 1500, true);
  await win.selectOption('#file-select', '0');
});

await step('dubbing: load English + dubbed, analyze → PAL speed and +3.25 s', async () => {
  await win.click('#tab-dub');
  await win.click('#pick-english');
  await win.waitForSelector('#eng-body .badges');
  await win.click('#pick-dubbed');
  await win.waitForSelector('#heb-body .badges');
  await shot('5-dub-files');
  await win.click('#dub-analyze');
  await win.waitForSelector('#dub-result:not([hidden])', { timeout: 120000 });
  const off = Number((await win.textContent('#r-offset')).replace(/[^\d.+-]/g, ''));
  assert.ok(Math.abs(off - 3.25) < 0.03, `offset ${off}`);
  assert.match(await win.textContent('#r-speed'), /4\.3%.*PAL/);
  assert.match(await win.textContent('#dub-title'), /נמצאה התאמה/);
  await shot('6-dub-result');
});

await step('dubbing: create MKV – English video as is, Hebrew track synced', async () => {
  await win.click('#dub-export');
  await win.waitForFunction(() => /נוצר/.test(document.getElementById('snack-text').textContent), null, { timeout: 120000 });
  const out = path.join(saveDir, 'Movie.2024.English.עברית.mkv');
  const info = A.parseMedia(spawnSync(FF, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr);
  assert.equal(info.video.width, 640);
  assert.deepEqual(info.audio.map((a) => a.lang), ['heb', 'eng']);
  const E = await A.extractEnergy(FF, english);
  const D = await A.extractEnergy(FF, out, { track: 0 });
  const chk = A.globalAlign(A.onsets(E.energy), A.onsets(D.energy));
  assert.equal(chk.ratio, 1);
  assert.ok(Math.abs(chk.offset) < 0.03, `residual ${chk.offset}`);
  await shot('7-dub-done');
});

await app.close();
process.stdout.write('\nall studio checks passed\n');
