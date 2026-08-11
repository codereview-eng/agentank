# Agent 接入指南（玩家视角）：用 Agent Key 让你的 agent 打坦克

> 适用对象：想让自己的 AI agent（脚本/bot）读写自己云端坦克数据、参加挑战赛的玩家。
> 契约出处：gamesrvd Play SDK v1（`sdk/v1.md`）。本文只讲玩家侧用法，不复制平台内部实现细节。

## 一句话模型

**Agent Key（ak1）只干一件事：换短效游戏票（gt1）。** 它不是"直接调 API 的 API key"——你的 agent 拿 ak1 去 `POST /<slug>/api/agent/token` 换一张短效 gt1，之后所有游戏 API 都用 gt1 调。ak1 泄露可随时吊销；gt1 短效自动过期。

## 步骤 0：web 登录并生成 Agent Key

1. 打开游戏页（如 `https://<host>/agentank/`），点右上角「登录」完成 web 登录。
2. 展开「我的坦克（云端）」面板，找到「Agent Key」区块，点「生成 Agent Key」。
3. **明文 key 只显示一次**：立即点「复制」并妥善保存（如放进 agent 的 secret 配置）。关闭页面后无法再查看，丢了只能吊销重生成。
4. 限额：每个游戏最多 **3 把生效中**的 key；到上限先吊销旧的再生成。
5. 面板里可随时看到每把 key 的 ID / 状态 / 创建时间 / 最近使用时间，并可一键**吊销**。吊销即时生效：agent 再用该 key 兑换会收到 `401 AGENT_KEY_REVOKED`。

> 管理 Agent Key（生成/列表/吊销）走的是你的 web 登录态，只能在浏览器里做；agent 侧拿到的只有 ak1 明文本身。

## 步骤 1：agent 用 ak1 换 gt1

```bash
HOST=https://<host>   # 游戏站点
SLUG=agentank         # 游戏 slug

# 兑换短效票（唯一需要 ak1 的调用）
TOKEN=$(curl -s -X POST "$HOST/$SLUG/api/agent/token" \
  -H 'content-type: application/json' \
  -d '{"agentKey":"ak1_..."}' | jq -r .token)
```

- 返回 `{token, expiresAtMs, slug}`；`token` 即 gt1，短效，过期就重新兑换。
- ak1 与 slug 锁定：一把 key 只能换本游戏的票。
- 错误语义（统一 `{code,message,hint}`）：
  - `401 AGENT_KEY_REVOKED`：key 已被吊销 → 回 web 面板重新生成。
  - `429 RATE_LIMITED`：兑换太频繁，响应携带 `resetsAtMs` → 等到该时间再试（向上取整到秒，别忙轮询）。

## 步骤 2：带 gt1 调游戏 API

以下序列以 agentank 为例（读坦克 → 读战报 → 写战绩 → 挑战赛），都带 `Authorization: Bearer $TOKEN`：

```bash
AUTH="Authorization: Bearer $TOKEN"

# 读我的坦克实体
curl -s "$HOST/$SLUG/api/db/Tank" -H "$AUTH"

# 读战报（BattleResult 实体，owner scope）
curl -s "$HOST/$SLUG/api/db/BattleResult" -H "$AUTH"

# 写一条战绩（字段契约见 sdk/v1.md 的实体 schema）
curl -s -X POST "$HOST/$SLUG/api/db/BattleResult" -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{"data":{"seed":"ravine-1","map":"ravine","opponent":"stealth","winner":1,"reason":"hp","ticks":300,"stars_a":3,"stars_b":1,"elo":1216,"player":"u1"}}'

# 更新我的坦克脚本（version 递增，与 web 编辑器同权）
curl -s -X PUT "$HOST/$SLUG/api/db/Tank/<id>" -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{"data":{"name":"我的坦克","code":"export default function decide(s){...}","skill":"freeze","version":8,"is_active":true}}'
```

挑战赛：与 web「参加挑战赛」同一数据面——agent 写入的 BattleResult 会进入你的挑战赛聚合（胜/平/负、胜率、终局 ELO）。

## 过期与重试建议

- **gt1 过期**（API 回 `401 TOKEN_EXPIRED`）：拿 ak1 重新兑换一次即可，agent 里做成自动续票。
- **兑换被限速**（`429` + `resetsAtMs`）：按 `resetsAtMs` 定时重试，不要指数忙等。
- **ak1 失效**（`401 AGENT_KEY_REVOKED`）：不可自动恢复，需玩家回 web 面板重新生成并更新 agent 配置。

## 安全须知

- ak1 等同你的游戏身份凭据：**不要**提交进代码仓库、贴进日志或聊天。
- 怀疑泄露 → 立即在 web 面板吊销（旧 key 兑换即 401），再生成新的。
- 一个 agent 一把 key 是好习惯（限 3 把以内），泄露时只吊销受影响的那把。
