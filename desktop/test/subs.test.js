'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/subs');

const SRT = `1
00:00:01,000 --> 00:00:01,600
אבא?

2
00:00:02,000 --> 00:00:04,500
מה קרה , למה אתה צועק ?

3
00:00:04,300 --> 00:00:05,000
<i>hello there, old friend</i>

4
00:00:05,100 --> 00:00:05,400
Two

5
00:00:30,000 --> 00:00:31,000
A very long line that needs a lot of time to read on the screen ok
`;

test('decode: UTF-8, BOM and old Hebrew (Windows-1255)', () => {
  const he = Buffer.from([0xf9, 0xec, 0xe5, 0xed]); // "שלום" ב-1255
  assert.deepEqual(S.decodeText(he), { text: 'שלום', encoding: 'Windows-1255' });
  assert.equal(S.decodeText(Buffer.from('﻿שלום', 'utf8')).text, 'שלום');
  assert.equal(S.decodeText(Buffer.from('שלום', 'utf8')).encoding, 'UTF-8');
});

test('parse SRT and VTT, write back', () => {
  const p = S.parse(SRT.replace(/\n/g, '\r\n'));
  assert.equal(p.format, 'srt');
  assert.equal(p.cues.length, 5);
  assert.deepEqual(p.cues[1], { start: 2000, end: 4500, text: 'מה קרה , למה אתה צועק ?' });
  const back = S.parse(S.format(p.cues));
  assert.deepEqual(back.cues, p.cues);
  const v = S.parse('WEBVTT\n\nNOTE x\n\n00:01.500 --> 00:03.000 align:start\nHi\n\nid2\n01:00:00.000 --> 01:00:01.250\nBye\n');
  assert.equal(v.format, 'vtt');
  assert.deepEqual(v.cues, [{ start: 1500, end: 3000, text: 'Hi' }, { start: 3600000, end: 3601250, text: 'Bye' }]);
  assert.match(S.format(v.cues, 'vtt'), /^WEBVTT\n\n00:00:01\.500 --> 00:00:03\.000\nHi/);
});

test('retime: longer on screen, minimum duration, never overlapping', () => {
  const { cues, stats } = S.retime(S.parse(SRT).cues, { extendMs: 700, minMs: 1500, cps: 15, maxMs: 7000, gapMs: 80, mergeMs: 0 });
  // "אבא?" – 0.6 שנייה במקור → לפחות 1.5 שניות, אבל לא עד הכתובית הבאה
  assert.equal(cues[0].end, 1920);
  // חפיפה במקור (4.5 > 4.3) – תוקנה
  assert.equal(cues[1].end, 4220);
  assert.equal(stats.overlapsFixed, 1);
  assert.equal(stats.overlapsLeft, 0);
  // שורה ארוכה: לפי מהירות קריאה, עד המקסימום
  assert.equal(cues[4].end, 30000 + Math.round((S.plain(cues[4].text).length / 15) * 1000));
  for (let i = 0; i + 1 < cues.length; i++) assert.ok(cues[i].end <= cues[i + 1].start - 80, `gap ${i}`);
  assert.ok(stats.avgAfter > stats.avgBefore);
  assert.ok(stats.shortAfter < stats.shortBefore);
});

test('retime: never shorter than the original (unless it overlaps), max cap, shift', () => {
  const long = [{ start: 0, end: 9000, text: 'x' }, { start: 20000, end: 20500, text: 'y' }];
  const r = S.retime(long, { maxMs: 4000, extendMs: 500 });
  assert.equal(r.cues[0].end, 9000);
  assert.equal(r.cues[1].end, 21500); // min 1.5s
  const s = S.retime([{ start: 1000, end: 2000, text: 'a' }, { start: 500, end: 900, text: 'gone' }], { shiftMs: -950, extendMs: 0, minMs: 0, cps: 0 });
  assert.deepEqual(s.cues.map((c) => [c.start, c.end, c.text]), [[50, 1050, 'a']]); // מה שנגמר לפני 0 – נמחק
});

test('retime: near-simultaneous cues are merged', () => {
  const r = S.retime([{ start: 1000, end: 2000, text: '- Hi' }, { start: 1100, end: 2100, text: '- Hello' }], {});
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].text, '- Hi\n- Hello');
  assert.equal(r.stats.merged, 1);
});

test('tight punctuation and title case', () => {
  assert.equal(S.tightPunctuation('מה קרה , למה אתה צועק ?'), 'מה קרה, למה אתה צועק?');
  assert.equal(S.tightPunctuation('wait ... what ?!\n( hi )  there'), 'wait... what?!\n(hi) there');
  assert.equal(S.tightPunctuation('3.5 , 1,000'), '3.5, 1,000');
  assert.equal(S.titleCase('<i>hello there, old friend</i>\n-yes sir'), '<i>Hello There, Old Friend</i>\n-Yes Sir');
  assert.equal(S.titleCase('שלום world'), 'שלום World');
  assert.equal(S.titleCase('{\\an8}up here'), '{\\an8}Up Here');
});

test('cue at time (preview) and file name', () => {
  const cues = [{ start: 0, end: 1000, text: 'a' }, { start: 2000, end: 3000, text: 'b' }];
  assert.equal(S.cueAt(cues, 500).index, 0);
  assert.equal(S.cueAt(cues, 1500), null);
  assert.equal(S.cueAt(cues, 2999).cue.text, 'b');
  assert.equal(S.suggestName('Movie.2020.heb.srt', 'srt'), 'Movie.2020.heb.מתוזמן.srt');
});

test('file name with dots instead of spaces', () => {
  assert.equal(S.dotted('Aladdin 2019 UHD BluRay 2160p x265 HDR 10bit Atmos TrueHD 7 1-HDH'), 'Aladdin.2019.UHD.BluRay.2160p.x265.HDR.10bit.Atmos.TrueHD.7.1-HDH');
  assert.equal(S.dotted('  a  b_c - d '), 'a.b.c-d');
  assert.equal(S.suggestName('Aladdin 2019 heb.srt', 'srt', { dots: true }), 'Aladdin.2019.heb.srt');
  assert.equal(S.suggestName('x.srt', 'srt', { videoName: 'Aladdin 2019 2160p.mkv', dots: true }), 'Aladdin.2019.2160p.srt');
  assert.equal(S.suggestName('x.srt', 'srt', { videoName: 'Movie.mkv' }), 'Movie.srt');
});
