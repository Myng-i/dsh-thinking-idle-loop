// 量 DSH 会话 reasoning 块里的「短填充碎片」密度（trim 后 1~4 字符的独立短行，如 做。/ 好。/ 发。/ Go.）。
// 对应上游 #5976 的「第五形态」：碎片太短会被现成护栏的 minReasoningSentenceChars=8 丢弃，故只能按密度看。
// 用法: node scripts/measure-fragment-density.mjs <session目录或zstd文件>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const LIB = process.env.ATTENTION_HEALTH_LIB
  ?? path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-attention-health', 'lib');

const arg = process.argv[2];
if (!arg) {
  console.error('用法: node scripts/measure-fragment-density.mjs <dir|file>');
  process.exit(1);
}
const file = fs.statSync(arg).isDirectory() ? path.join(arg, 'session.v4.jsonl.zstd') : arg;
const raw = fs.readFileSync(file);

const { scanZstdFrames } = await import(pathToFileURL(path.join(LIB, 'zstd-frames.mjs')).href);
const { frames } = scanZstdFrames(raw);
const text = Buffer.concat(frames.map((f) => zlib.zstdDecompressSync(raw.subarray(f.start, f.end)))).toString('utf8');
const events = text
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const reas = [];
let turnNo = 0;
events.forEach((e) => {
  if (e.type === 'turn/start') turnNo += 1;
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj.content)) {
      for (const c of obj.content) {
        if (c && (c.type === 'reasoning' || c.type === 'thinking') && typeof c.text === 'string') {
          reas.push({ text: c.text, turn: turnNo });
        }
      }
    }
    for (const k of Object.keys(obj)) if (obj[k] && typeof obj[k] === 'object') walk(obj[k]);
  };
  walk(e.data);
});

// 短碎片：trim 后 1~4 字符的独立行
const isFrag = (s) => s.length > 0 && s.length <= 4;
const rows = reas.map((r, i) => {
  const lines = r.text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const frags = lines.filter(isFrag);
  return {
    i,
    turn: r.turn,
    len: r.text.length,
    lines: lines.length,
    frags: frags.length,
    density: r.text.length ? (frags.length / r.text.length) * 1000 : 0,
    top: [...new Set(frags)].slice(0, 6),
  };
});

const byTurn = new Map();
for (const x of rows) {
  const a = byTurn.get(x.turn) || { n: 0, len: 0, frag: 0, samples: new Map() };
  a.n += 1;
  a.len += x.len;
  a.frag += x.frags;
  for (const f of x.top) a.samples.set(f, (a.samples.get(f) || 0) + 1);
  byTurn.set(x.turn, a);
}
console.log('turn  块数  总字符  碎片数  密度(‰)  高频碎片');
for (const [t, a] of [...byTurn].sort((p, q) => p[0] - q[0])) {
  const d = a.len ? ((a.frag / a.len) * 1000).toFixed(1) : '0.0';
  const top = [...a.samples]
    .sort((p, q) => q[1] - p[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}×${v}`)
    .join(' ');
  console.log(
    `T${String(t).padStart(2)}  ${String(a.n).padStart(4)} ${String(a.len).padStart(7)} ` +
      `${String(a.frag).padStart(6)} ${d.padStart(8)}  ${top}`,
  );
}

const allLen = rows.reduce((s, x) => s + x.len, 0);
const allFrag = rows.reduce((s, x) => s + x.frags, 0);
console.log(
  `\n整体：${allFrag} 碎片 / ${allLen} 字符 = ${((allFrag / allLen) * 1000).toFixed(1)}‰` +
    '（上游 #5976 第五形态报告 142/2173 ≈ 65.3‰；同会话健康基线 0~3/千）',
);

const worst = [...rows].sort((a, b) => b.density - a.density).slice(0, 6);
console.log('\n密度最高的块：');
for (const x of worst) {
  console.log(
    `  块[${x.i}] T${x.turn} len=${x.len} frag=${x.frags} 密度=${x.density.toFixed(1)}‰ 样本=${x.top.join(' ')}`,
  );
}
