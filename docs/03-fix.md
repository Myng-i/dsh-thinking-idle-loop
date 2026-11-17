# 方案：四层，从止损到兜底

顺序即优先级。前三层都不需要改上游代码。

## L0 止损：上下文重置是唯一可靠手段

一旦进入循环，**讲道理无效**——模式在形式层，不在语义层。在已经被污染的历史里继续追问，只会被续写成下一个 `好。`。

做法：把任务描述重新带进一个干净上下文（compact 或新会话），而不是在原会话里继续劝。

## L1 规则层：把输出纪律写死

在 Agent 的指令文件（`AGENTS.md`）里加一节「输出纪律」，五条：

| # | 约束 |
|---|---|
| O1 | 每轮必须有实质产出：工具调用 / 文件改动 / 新结论 / 一个明确的问题，四选一。禁止「好。」单独成轮，禁止只复述指令当回复 |
| O2 | 单字催促不当新指令：收到「动手」「写」「继续」，不回确认、不复述，直接接着最近一个未闭环的任务做 |
| O3 | 空转刹车：连续两轮没有新动作、或输出高度重复时立刻停住，三行交代「卡在哪 / 试过什么 / 需要什么」，然后停下等人 |
| O4 | 不预告只执行：想改就直接改、直接跑；只有方案互斥、危险操作、动禁令清单时才先问 |
| O5 | 止损只有一条路：真陷进循环时，重置上下文，把任务重新带进去 |

定位是**预防**，不是治疗。它降低进入循环的概率，救不回已经进去的。

## L2 守卫层：先引导、用尽才中止

改动最大也最值钱的一层，完整 diff 见 `patches/attention-health-steer.patch`。

原实现：命中 → 记一笔 → `agent.cancel()`。中止 = 报废一轮，而模型不知道自己错在哪。

改成三分支：

| 情形 | 条件 | 动作 |
|---|---|---|
| A | 本 step 首次命中，且本 turn 引导次数 < `maxSteersPerTurn(3)` | `agent.steer()` 注入提醒 + 重置窗口 |
| B | 同一 step 再次命中（提醒要到 next-step 才可见），且本 step 命中 < `maxHitsPerAttempt(6)` | 只重置窗口，不注入、不中止 |
| C | 本 turn 机会用尽，或单步连命中到上限 | 回到 `agent.cancel()` |

```js
const used = steersByTurn.get(turnKey) ?? 0;
slot.hits += 1;

// A：本 step 还没提醒过，且本 turn 还有机会
if (!slot.steered && used < GUARD_STEER.maxSteersPerTurn) {
  steersByTurn.set(turnKey, used + 1);
  agent.steer(guardSteerMessage(guardSteerText(hit.reason)));
  slot.steered = true;
  slot.guard = createLoopGuard(GUARD_DEFAULTS);   // 必须重置：否则旧碎片立刻再命中
  slot.tail = '';
  recordGuardTrip({ kind: hit.kind, action: 'steer', steerIndex: used + 1, … });
  return;
}

// B：本 step 提醒过，只继续观察；单步超限落到 C
if (slot.steered && slot.hits < GUARD_STEER.maxHitsPerAttempt) {
  slot.guard = createLoopGuard(GUARD_DEFAULTS);
  slot.tail = '';
  return;
}

// C：兜底
agent.cancel({ kind: 'hook', reason: … });
```

### 三个必须踩过才知道的设计判断

**① `steer` 的入参必须是带 `id` 的对象，不能是裸字符串。**

inbox 投影在折叠时按 `message.id` 查重，重复会抛 `message "xxx" is already pending`。插件零 `@deepseek-ai/*` 运行时依赖，所以自己拼等价形状：

```js
{
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'plugin:attention-health', plugin: 'attention-health', form: 'steer', summary: '思考空转引导' },
}
```

上游 `createMessage` 就是 `{ ...input, id: brandString(randomUUID()) }`，`brandString` 是纯 identity，两者运行时等价。

**② `steer` 之后必须重置守卫窗口。**

不重置的话旧碎片还在滑窗里，下一个 delta 立刻再命中，连发 steer 等于没救。

**③ 引导次数必须按 turn 累计，不能按 attempt。**

一个 turn 有几十个 step，每个 step 换一个 `attemptId`。按 attempt 计数等于永不中止。`turn` 只在 `start` 帧出现，要在 `start` 时记进 slot。

### 引导文本本身也有讲究

要短、要具体、要可执行——太长了会被正在复读的模型当成新素材一起复述：

```
（思考守卫提醒）你刚才的思考陷入复读，没有产生新内容。
判定依据：<命中的判据与细节>。
立刻停止复述，直接执行下一步：要么输出一个工具调用，要么给出结论。
不要再写「做。」这类重复短句。
```

## L3 配置与任务粒度

- 推理强度收到 `high`，不再长期挂 `max`。单次响应预算越大，坍缩的跑道越长。
- 各渠道 `maxTokens` 收到 8k–32k。
- 单轮工具调用过多时主动拆 turn，别让一轮里堆出上百个 step。
- 同一操作连续失败两次就停手上报，打断「再试一次」的循环。

## L4 事后：账本要能读

守卫每次触发都追加一条记录，字段：`at / kind / reason / detail / tail / sessionId`，改造后新增 `action: steer | cancel` 与 `steerIndex`。

没有账本，你无法回答「触发几次」「改完有没有用」「误报多少」。它是整个方案的地基。
