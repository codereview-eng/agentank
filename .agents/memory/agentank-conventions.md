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

## v13 i18n 双语（2026-08-08）
- web/i18n.js：LOCALES zh/en 键位同构（tests/i18n.test.js 锁死：en 无中文、占位符对齐、技能8/道具6/判定链6/地图13 全覆盖、zh 地图词条与引擎逐字同源）。
- 语言解析 ?lang= > localStorage(agentank-lang) > navigator.language > zh；切换器在顶栏，切换=存偏好+带参刷新。
- 引擎 report.js（battle.log）保持中文不动（确定性口径）；网页战报由 buildLog 按字典渲染。
- check-dist ③ 默认脚本改从字典 script.default 提取（兼容旧字面量）；新增⑥ i18n 产物体检。

## v14 UGC 内容架构（2026-08-08）
- src/engine/content.js：四类内容（map/skill/item/bot）纯 JSON 声明式定义；技能/道具只能对效果原语参数化（SKILL_EFFECTS 8 种 / ITEM_EFFECTS 6 种，数值有界），bot 为 decide 源码字符串走 new Function 沙箱（引擎本体零 eval）。
- 三阶段：stage private→shared→official（promoteStage 逐级）；分享串 atpack1.<base64 JSON>；官方收录 = OFFICIAL_CONTENT 列表追加条目。
- runMatch({content: pack})：skillDefs/itemDefs = 内置 + 内容包（castSkill/pickupItem 按 effect.kind 分发）；战报 result.content 嵌整包 → 同 seed+同 pack 逐字节重现。
- web：创作工坊 details 面板（localStorage agentank-workshop）；下拉三来源合并带 [私有]/[已分享]/[官方] 徽标；深链 ?pack=/&script=/&skill=/&opp=（分享本局=串全嵌）。
- 坑：build-web 剥 import 是单行正则，app.js import 必须写单行；check-dist ⑦ 工坊体检 + makeEngine 暴露面记得加新符号。

## play 公网部署通道勘误（2026-08-10）
- 旧结论作废：play.run.ceo 的 /g/<publicId>（project-service 匿名快照托管）是旧通道，不用于游戏部署。
- 新通道 = gamesrvd（run-solo-company services/gamesrvd）：单进程零依赖 + node:sqlite，每游戏一个目录契约（schema.json + game.sqlite + files/ + web/），per-slug 子域 https://play-<slug>.run.ceo/（通配 vhost 具名捕获 rewrite，旧路径 301）。
- 能力面（对齐 base44）：entities（REST CRUD/行级权限/append-only schema）与 files（HMAC 签名直链）已落地；auth=gateway game token 售票口+逐游戏匿名门槛（schema.json auth.required，缺省匿名可玩）；llm/connectors 仍 501 显式空壳。
- 游戏内容部署走服务器侧 deploy.mjs（版本目录+原子 symlink+部署期 brotli/gzip 预压缩，rollback 一条命令），新 slug 免重启即生效；agent 只做「本地彩排+交接包+精确手工命令」，服务器状态改动一律用户手工执行。
- 此面 nginx 只注 frame-ancestors CSP，不禁 eval —— AgenTank 在线版自定义脚本可直接编辑（v13 的 CSP 降级模式不会触发）。
