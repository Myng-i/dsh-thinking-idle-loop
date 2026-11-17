/**
 * 探针：验证 attention-health 的「先引导、用尽才中止」分级反应是否按设计工作。
 *
 * 做法：用假 ctx 直接调用插件导出的 apply()，手动喂 agent/assistant-stream 帧，
 * 把 reasoning-delta 造成「同一短行高频」，观察三条分支：
 *   A. 每个新 step 首次命中且本 turn 还有机会 → agent.steer 注入一次、不 cancel；
 *   B. 同一 step 内再次命中（提醒要到下一步才可见）→ 只重置窗口，不注入、不中止；
 *   C. 本 turn 机会用尽，或单个 step 连命中达 maxHitsPerAttempt → agent.cancel 兜底。
 * 落档写到临时 DSH_HOME，不污染真实的 guard-trips.jsonl。
 *
 * 用法：
 *   ATTENTION_HEALTH_PLUGIN=<...>/dsh-attention-health/lib/index.js node scripts/test-guard-steer.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const PLUGIN = process.env.ATTENTION_HEALTH_PLUGIN
  ?? path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-attention-health', 'lib', 'index.js');

const TMP_HOME = path.join(HERE, '.test-dsh-home');
fs.rmSync(TMP_HOME, { recursive: true, force: true });
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.DSH_HOME = TMP_HOME;

if (!fs.existsSync(PLUGIN)) {
  console.error(`✗ 找不到插件入口: ${PLUGIN}\n  用 ATTENTION_HEALTH_PLUGIN 指定 dsh-attention-health/lib/index.js`);
  process.exit(1);
}
const { apply } = await import(pathToFileURL(PLUGIN).href);

// ── 假 ctx ────────────────────────────────────────────────────────────────────
const handlers = new Map();
const ctx = {
  sessionProjections: { register: () => {} },
  get: () => undefined,
  inject: (_deps, cb) => {
    try {
      cb?.(ctx);
    } catch (error) {
      console.error('[probe] inject 回调抛错（预期内，忽略）：', error?.message ?? error);
    }
  },
  on: (event, fn) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(fn);
  },
  remote: undefined,
  sessionQuery: undefined,
  sessions: undefined,
  webServer: undefined,
};

apply(ctx);

const list = handlers.get('agent/assistant-stream') ?? [];
if (list.length === 0) {
  console.error('✗ 插件没有注册 agent/assistant-stream');
  process.exit(1);
}
const onStream = list[0];

// ── 驱动 ──────────────────────────────────────────────────────────────────────
const calls = { steer: [], cancel: [] };
const agent = {
  sessionId: 'probe-session',
  steer: (msg) => calls.steer.push(msg),
  cancel: (cause) => calls.cancel.push(cause),
};
const TURN = 7;

/**
 * 模拟一个 step：先发 start，再喂 n 行「做。」。
 * 命中一次约需 24 行（windowLines 判据），命中后窗口被插件重置。
 */
const feedStep = (attemptId, lines, turn = TURN) => {
  onStream({ agent, frame: { type: 'start', attemptId, turn, step: 1 } });
  for (let i = 0; i < lines; i++) {
    onStream({
      agent,
      frame: { type: 'chunk', attemptId, chunk: { type: 'reasoning-delta', text: '做。\n' } },
    });
  }
  return { steer: calls.steer.length, cancel: calls.cancel.length };
};

// 三个不同 step：每次首次命中都该注入引导（情形 A）
const s1 = feedStep('attempt-1', 40);
const s2 = feedStep('attempt-2', 40);
const s3 = feedStep('attempt-3', 40);
// 第四个 step：本 turn 机会已用尽 → 首次命中即兜底中止（情形 C：机会用尽）
const s4 = feedStep('attempt-4', 40);
// 第五个 step：换一个 turn，单步内反复命中 → 走到 maxHitsPerAttempt 后中止（情形 C：死循环）
const s5 = feedStep('attempt-5', 200, TURN + 1);

// 档位 2（提醒）单独验一次：单行内同一片段连续重复 12 次且累计 ≥96 字
// （guard.js 的 INLINE_WARN_REPEATS / INLINE_WARN_CHARS）⇒ 只该打一行「疑似复读（继续生成）」，不 steer、不 cancel。
const logs = [];
const origError = console.error;
console.error = (...args) => {
  logs.push(args.map(String).join(' '));
  origError(...args);
};
onStream({ agent, frame: { type: 'start', attemptId: 'attempt-warn', turn: TURN + 2, step: 1 } });
onStream({
  agent,
  frame: {
    type: 'chunk',
    attemptId: 'attempt-warn',
    chunk: { type: 'reasoning-delta', text: 'abcdefgh'.repeat(16) + '\n' },
  },
});
console.error = origError;
const s6 = {
  steer: calls.steer.length,
  cancel: calls.cancel.length,
  warned: logs.some((l) => l.includes('疑似复读（继续生成）')),
};

console.log(
  `每步快照: 1=steer${s1.steer}/cancel${s1.cancel} 2=steer${s2.steer}/cancel${s2.cancel} ` +
    `3=steer${s3.steer}/cancel${s3.cancel} 4=steer${s4.steer}/cancel${s4.cancel} 5=steer${s5.steer}/cancel${s5.cancel} ` +
    `warn档=${s6.warned ? '已接出' : '未触发'}`,
);

// ── 断言 ──────────────────────────────────────────────────────────────────────
const fails = [];
const expect = (ok, msg) => {
  if (!ok) fails.push(msg);
};

expect(s1.steer === 1 && s1.cancel === 0, '第 1 个 step 首次命中应只 steer、不 cancel');
expect(s2.steer === 2 && s2.cancel === 0, '第 2 个 step 应继续 steer');
expect(s3.steer === 3 && s3.cancel === 0, '第 3 个 step 应继续 steer');
expect(s4.steer === 3 && s4.cancel === 1, '第 4 个 step（本 turn 机会用尽）应 cancel');
// 第 5 个 step 换了 turn：先注入 1 次引导（本 turn 第 1 次），随后同一步内连命中到上限 → cancel
expect(s5.steer === 4 && s5.cancel === 2, '第 5 个 step（单步反复命中）应兜底 cancel');

const msg = calls.steer[0];
if (msg) {
  expect(typeof msg.id === 'string' && msg.id.length > 10, 'steer 的 message 必须有 id（inbox 按 id 查重）');
  expect(msg.role === 'user', 'steer 的 message.role 必须是 user');
  expect(Array.isArray(msg.content) && msg.content[0]?.type === 'text', 'content 必须是 [{type:"text",text}]');
  expect(typeof msg.content[0]?.text === 'string' && msg.content[0].text.includes('复读'), '引导文本应点明复读');
  expect(JSON.parse(JSON.stringify(msg)).id === msg.id, 'message 必须可 JSON 序列化（要落盘进 session log）');
  const ids = new Set(calls.steer.map((m) => m.id));
  expect(ids.size === calls.steer.length, '每条的 id 必须唯一（否则 inbox 会抛 already pending）');
}

const tripFile = path.join(TMP_HOME, 'attention-health', 'guard-trips.jsonl');
const trips = fs.existsSync(tripFile)
  ? fs
      .readFileSync(tripFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
const steerTrips = trips.filter((t) => t.action === 'steer');
const cancelTrips = trips.filter((t) => t.action === 'cancel');
expect(steerTrips.length === 4, `落档应有 4 条 action=steer（实际 ${steerTrips.length}）`);
expect(cancelTrips.length === 2, `落档应有 2 条 action=cancel（实际 ${cancelTrips.length}）`);

console.log(`落档：steer=${steerTrips.length} cancel=${cancelTrips.length}（${tripFile}）`);
if (fails.length > 0) {
  console.error('\n✗ 失败：');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('\n✓ 分级反应符合设计：每 step 首次命中注入引导，机会用尽或单步死循环才兜底中止');
