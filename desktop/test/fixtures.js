'use strict';
// קבצים לבדיקות: "סרט" באנגלית ו"סרט" מדובב עם אותה מוזיקה/אפקטים
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(FF, args) {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
}

function bedWav(file, dur) {
  const sr = 22050; const n = dur * sr;
  const pcm = Buffer.alloc(n * 2);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let level = 0.1; let left = 0; let tone = 0; let ph = 0;
  for (let i = 0; i < n; i++) {
    if (left-- <= 0) { level = rnd() < 0.35 ? 0.02 : 0.1 + rnd() * 0.6; left = Math.floor(sr * (0.05 + rnd() * 0.7)); tone = rnd() < 0.5 ? 0 : 80 + rnd() * 800; }
    ph += (2 * Math.PI * tone) / sr;
    const v = level * (tone ? 0.6 * Math.sin(ph) + 0.4 * (rnd() * 2 - 1) : rnd() * 2 - 1);
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 20000))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
  return file;
}

const speech = (f, k, dur) => `sine=f=${f}:d=${dur},volume='0.25*gt(sin(${k}*t)+sin(${k * 2.3}*t),1.1)':eval=frame`;

/** english.mp4 (וידאו h264 + אנגלית), dubbed.mkv (עברית: PAL + היסט 3.25 שנ׳) */
function movies(FF, dir, dur = 90) {
  const bed = bedWav(path.join(dir, 'bed.wav'), dur);
  const english = path.join(dir, 'Movie.2024.English.mp4');
  const dubbed = path.join(dir, 'הסרט.מדובב.mkv');
  run(FF, ['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=24000/1001:d=${dur}`, '-i', bed, '-f', 'lavfi', '-i', speech(300, 1.7, dur),
    '-filter_complex', '[1][2]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', '-shortest', english]);
  run(FF, ['-f', 'lavfi', '-i', `testsrc=s=320x240:r=25:d=${dur}`, '-i', bed, '-f', 'lavfi', '-i', speech(520, 2.3, dur),
    '-filter_complex', `[1][2]amix=inputs=2:normalize=0,adelay=delays=${Math.round(3250 * 25 / 23.976)}:all=1,atempo=${25 / 23.976}[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-metadata:s:a:0', 'language=heb', '-t', String(dur), dubbed]);
  return { english, dubbed, bed };
}

module.exports = { run, bedWav, speech, movies };
