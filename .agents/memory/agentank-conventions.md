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
- 浏览器（用户裁定 2026-08-07，作废旧口径）：tankgame 一切浏览器类工作（实机截图、网页验证、CU 调试）**专门使用 chrome-cu-3**（CDP 19303）——不再起临时 headless Chrome / 独立临时 `--user-data-dir` profile；借用共享实例只 detach 自己的 CDP/Playwright 连接，不杀进程、不 `browser.close()`、不 pkill，禁止 `bring_to_front` 抢前台。

## v5 事件 schema 关键改名（下游消费注意）
- `bullet_end.cause` → `reason`，取值 `hit/wall/mound/out`（原 `dirt`→`mound`，`range` 移除）；
- 新事件：`turn`、`bullet_end`、`bomb_place`、`bomb_explode`、`mound_hit`、`mound_destroyed`、`star_spawn`、`teleport_reveal`、`freeze_hit`/`stun_hit`（语义分离：freeze=禁止行动、stun=操作随机化）。

## 评审模式
- 重活 spawn_agent 分身；judge 用 clean-context + RUBRIC + 严格 JSON，阈值 ≥8.5 直接过 / 7-8.4 可过带改进点 / <7 返工。

## 地形 v10（冰面 + 水域）
- 图例新增：'='=冰面（TILE.ICE）、'~'=水域（TILE.WATER）；预置图 13 张（新增 frozenLake 冰湖 / riverCrossing 冰河渡口 / tundra 冻原）。
- 冰面：踏上后沿原方向续滑至离冰/撞墙/撞敌，滑行途中吃星；新事件 `slide {t,who,x,y}`（web timeline 与 move 同口径消费）。
- 水域：isWalkable=false（挡车），子弹/炸弹冲击波照常飞越（不挡弹）；teleport 落点非法集新增水域。

## v11 缩圈与终局判定链（2026-08-08）
- RULES.zone：start 240 / every 30 / dmg 5 / dmgStep 1；安全区 [1+ring, w-2-ring]，收到中心 1 格封顶；毒圈伤害无视护盾。
- 新事件：zone_shrink {ring,x0,y0,x1,y1}、zone_hit {target,dmg,hp}、star_gone {x,y}；星星/传送/safestCorner 全部避圈。
- 平局已根治：end.reason 新增 hp/damage/center/coin（击杀→星数→HP→输出→圈心→种子掷签），winner 永不为 null；旧战报 draw 仅回放兼容。

## v12 场上道具（2026-08-08）
- RULES.items：start 40 / every 45 / max 2；kinds 六件套 medkit(+30HP)/rapid(3 次双发)/pierce(3 发 +10 伤且一击毁土堆)/helmet(挡一次伤害，同护盾槽)/clock(冻敌 6 拍)/boots(10 拍每拍 2 格)。
- 新事件：item_spawn {kind,x,y}、item_pick {who,kind,x,y(,hp)}、item_gone {x,y,kind}；clock 复用 freeze_hit 加 source:"clock"；hit.dmg 随穿甲弹可变。
- api：items()/nearestItem(kind?)，me() 增 rapidShots/pierceShots；压过即拾取（move/slide/patrol 同口径），随机落点走 randomFreeCell（避星/避道具/避圈），rules.items.forceAt 定点投放供测试。
