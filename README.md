# DSH 思考空转（thinking idle loop）诊断与熔断改造

> 配套文章：**《AI 开始复读「做。做。做。」》**（B 站专栏，链接见文末）
>
> 本仓库收录这次排查里**能复跑的东西**：会话解码脚本、碎片密度量化脚本、守卫分级反应的补丁与探针、以及脱敏后的账本结构示例。文字叙述在 `docs/`。

## 一句话结论

模型在 thinking 流里反复自我授权（`做。` `执行。` `好。`），但 thinking 流没有执行能力，唯一的出口（tool call / turn 结束）又被坍缩吞掉，于是自回归复读。**它不是「变笨」，是一种可以被量化、也可以在客户端侧熔断的形式层故障。**

## 三个可复用的数字

| 指标 | 值 |
|---|---|
| 碎片密度（trim 后 1–4 字符独立行 / 总字符，‰） | 健康基线 2.1‰ → 恶化峰值 70.2‰（同一会话 11 轮内） |
| 现成插件 thinking-loop-guard 六类判据在 312 个思考块上的命中 | 0 / 312 |
| 分级反应上线后 25 次命中里被 steer 化解的比例 | 21 / 25 = 84% |

## 目录

```
docs/
  01-phenomenon.md     现象实录、守卫账本、样本会话规模
  02-metrics.md        碎片密度怎么定义、为什么现成判据抓不到
  03-fix.md            四层方案：止损 / 规则 / 守卫分级反应 / 配置收敛
  04-results.md        48 条账本的实测效果与局限
patches/
  attention-health-steer.patch   守卫「先引导、用尽才中止」的完整 diff
scripts/
  decode-session.mjs             解压 + 统计 DSH 会话（事件类型、turn 结束原因、思考块）
  measure-fragment-density.mjs   按 turn 统计碎片密度、列峰值块
  test-guard-steer.mjs           假 ctx 验证三分支（A/B/C）与落档
data/
  guard-trips.sample.jsonl       账本结构示例（脱敏，非原始数据）
```

## 复现

前置：Node.js 22+（用到内置 `zlib.zstdDecompressSync` 与 `import.meta.dirname`），以及一个装了 `dsh-attention-health` 的 DSH profile。

```bash
export DSH_HOME=~/.dsh                       # 或你的 profile home
export ATTENTION_HEALTH_LIB="$DSH_HOME/profiles/desktop/node_modules/dsh-attention-health/lib"

# 1) 解码任意会话，看事件类型与思考块概况
node scripts/decode-session.mjs "$DSH_HOME/sessions/<session-id>"

# 2) 按 turn 统计碎片密度（定位「从第几轮开始崩」）
node scripts/measure-fragment-density.mjs "$DSH_HOME/sessions/<session-id>"

# 3) 打过本仓库的补丁后，验三分支行为（不写真实账本，DSH_HOME 会被重定向到临时目录）
node scripts/test-guard-steer.mjs
```

## 边界（别把这里当官方修复）

- 补丁是**客户端侧兜底**，不动上游 `agent-loop`，根因仍在 `packages/core/agent-loop/src/agent.ts` 的 `turn()` 循环。
- 上游 discussion 仍是**零官方回复**状态（截至 2026-11）。
- 21 次 steer 的「有效」只有行为层证据，没有对照实验：账本证明提醒送到了，不能证明模型是靠它回头的。

## License

MIT，见 `LICENSE`。
