// 解压 DSH 会话（session.v4.jsonl.zstd）并统计事件类型、turn 结束原因、思考块概况。
// 用法: node scripts/decode-session.mjs <session目录或zstd文件> [--dump <块序号>]
//
// DSH 会话日志是多帧 zstd 拼接，内置 API 只解第一帧；这里复用 dsh-attention-health
// 移植的帧扫描器逐帧解压。位置可用 ATTENTION_HEALTH_LIB 覆盖。
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
  console.error('用法: node scripts/decode-session.mjs <dir|file> [--dump N]');
  process.exit(1);
}
const file = fs.statSync(arg).isDirectory() ? path.join(arg, 'session.v4.jsonl.zstd') : arg;
const raw = fs.readFileSync(file);

const { scanZstdFrames } = await import(pathToFileURL(path.join(LIB, 'zstd-frames.mjs')).href);
const { frames } = scanZstdFrames(raw);
const text = Buffer.concat(frames.map((f) => zlib.zstdDecompressSync(raw.subarray(f.start, f.end)))).toString('utf8');
const lines = text.split('\n').filter(Boolean);
console.log(`文件: ${file}`);
console.log(`压缩 ${raw.length} B → 原始 ${text.length} B，事件行 ${lines.length}，帧数 ${frames.length}`);

const events = [];
let bad = 0;
for (const l of lines) {
  try {
    events.push(JSON.parse(l));
  } catch {
    bad += 1;
  }
}
console.log(`可解析 ${events.length}，坏行 ${bad}`);

const types = new Map();
for (const e of events) types.set(e.type, (types.get(e.type) || 0) + 1);
console.log('\n-- 事件类型 --');
for (const [k, v] of [...types].sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(6)}  ${k}`);

console.log('\n-- turn 结束原因 --');
const ends = events.filter((e) => e.type === 'turn/end');
console.log(`turn/end 共 ${ends.length}`);
const reasonCount = new Map();
for (const e of ends) {
  const r = JSON.stringify(e.data?.reason ?? e.reason ?? null);
  reasonCount.set(r, (reasonCount.get(r) || 0) + 1);
}
for (const [k, v] of [...reasonCount].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`${String(v).padStart(4)}  ${k.slice(0, 200)}`);
}

const reas = [];
let turnNo = 0;
events.forEach((e, i) => {
  if (e.type === 'turn/start') turnNo += 1;
  const d = e.data || {};
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj.content)) {
      for (const c of obj.content) {
        if (c && (c.type === 'reasoning' || c.type === 'thinking') && typeof c.text === 'string') {
          reas.push({ text: c.text, turn: turnNo, evt: i });
        }
      }
    }
    for (const k of Object.keys(obj)) if (obj[k] && typeof obj[k] === 'object') walk(obj[k]);
  };
  walk(d);
});
console.log(`\n-- reasoning 块: 共 ${reas.length} 个 --`);

reas.forEach((r, i) => {
  const nl = r.text.split('\n');
  const short = nl.filter((x) => x.trim() && x.trim().length <= 11);
  const cnt = new Map();
  for (const s of short.map((s) => s.trim())) cnt.set(s, (cnt.get(s) || 0) + 1);
  const top = [...cnt].sort((a, b) => b[1] - a[1])[0];
  console.log(
    `[${i}] T${String(r.turn).padStart(2)} len=${String(r.text.length).padStart(7)} ` +
      `行=${String(nl.length).padStart(4)} 短行=${String(short.length).padStart(4)} ` +
      `最高频=${top ? JSON.stringify(top[0]) + '×' + top[1] : '-'}`,
  );
});

const dumpIdx = process.argv.includes('--dump')
  ? Number(process.argv[process.argv.indexOf('--dump') + 1])
  : -1;
if (dumpIdx >= 0 && reas[dumpIdx]) {
  console.log(`\n===== reasoning[${dumpIdx}] 全文 =====`);
  console.log(reas[dumpIdx].text);
}

// 填充词排行：定位退化最重的块
const fill = reas
  .map((r, i) => ({
    i,
    turn: r.turn,
    len: r.text.length,
    zuo: (r.text.match(/做[。.]/g) || []).length,
    go: (r.text.match(/(?:^|\n)\s*Go[.。]\s*(?:\n|$)/g) || []).length,
    hao: (r.text.match(/(?:^|\n)\s*好[。.]\s*(?:\n|$)/g) || []).length,
  }))
  .filter((x) => x.zuo + x.go + x.hao > 0)
  .sort((a, b) => b.zuo + b.go + b.hao - (a.zuo + a.go + a.hao))
  .slice(0, 12);
console.log('\n-- 填充词密度 Top12（块 / 轮 / 长度 / 做。 / Go. / 好。） --');
for (const f of fill) {
  console.log(
    `[${String(f.i).padStart(3)}] T${String(f.turn).padStart(2)} len=${String(f.len).padStart(6)} ` +
      `做。=${String(f.zuo).padStart(3)} Go.=${String(f.go).padStart(3)} 好。=${String(f.hao).padStart(3)}`,
  );
}

console.log('\n-- 最早出现「做。」的 5 个块 --');
reas
  .map((r, i) => ({ i, turn: r.turn, n: (r.text.match(/做[。.]/g) || []).length }))
  .filter((x) => x.n > 0)
  .slice(0, 5)
  .forEach((f) => console.log(`[${f.i}] T${f.turn} 做。=${f.n} 行数=${reas[f.i].text.split('\n').length}`));
