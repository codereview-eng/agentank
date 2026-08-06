# AgenTank 发布与工程约定（跨会话复用）

## 发布（最易踩坑）
- 发布走 `publish_artifact`，id 必须是完整 `artifact-nh7pdd65pbb4c`（含 `artifact-` 前缀、**全小写**）：
  - 裸 id（不带前缀）→ HTTP 404；
  - 曾因大写 `C` 误发成新 artifact，勿再犯；
  - 引用链接时整行复制发布回执里的 markdown 链接行，禁止凭记忆手写 slug/URL。
- 发布物 = `dist/agentank.html`（自包含单文件，`node scripts/build-web.mjs` 打包）。同 id 重发即同链接刷新（v1→v5 均如此）。

## 交付纪律（用户裁定，已多轮生效）
- 确定性引擎（种子 RNG、禁 Math.random）；`node --test` 严格先红后绿、最终全绿；
- 改动链：引擎/规则 → eval/score.mjs 重跑评分 → web 端适配 → `scripts/check-dist.mjs` 冒烟 → headless Chrome 实机截图判分过线 → 本地 git 提交 → 同 URL 发新版；
- 脚本契约固定为 `decide(api)`（保留 fireAt 语法糖），**不改成**官方 onIdle/HTTP API；
- 截图：headless Chrome 独立临时 `--user-data-dir` profile，pkill 只匹配自己的 profile 名，绝不动 chrome-cu-1/2/3 及其 Profile。

## v5 事件 schema 关键改名（下游消费注意）
- `bullet_end.cause` → `reason`，取值 `hit/wall/mound/out`（原 `dirt`→`mound`，`range` 移除）；
- 新事件：`turn`、`bullet_end`、`bomb_place`、`bomb_explode`、`mound_hit`、`mound_destroyed`、`star_spawn`、`teleport_reveal`、`freeze_hit`/`stun_hit`（语义分离：freeze=禁止行动、stun=操作随机化）。

## 评审模式
- 重活 spawn_agent 分身；judge 用 clean-context + RUBRIC + 严格 JSON，阈值 ≥8.5 直接过 / 7-8.4 可过带改进点 / <7 返工。
