#!/usr/bin/env node
// 打包产物冒烟检查：node scripts/check-dist.mjs
// ① 整包内联 JS 语法检查（new Function 仅解析不执行）
// ② 抽出引擎段真跑一局 + 确定性双跑对比
// ③ 用产物内联引擎编译默认脚本，跑「默认脚本 vs 隐身偷袭流」一局（浏览器同口径）
// ④ 自包含体检：无外链 src/href、无 CDN、无 import/export 残留
// ⑤ 内置 bot 全员体检：产物引擎里逐个实跑，必须零异常且有实际动作（防内联漏文件导致对手静默瘫痪）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'dist/agentank.html'), 'utf8');

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

// ---- 抽出内联 JS ----
const m = html.match(/<script>\n\(function \(\) \{\n([\s\S]*?)\n\}\)\(\);\n<\/script>/);
if (!m) fail('未找到内联 <script> 包');
const full = m[1];

// ① 语法检查
new Function(full); // eslint-disable-line no-new-func
console.log(`① 语法检查 PASS（内联 JS ${(full.length / 1024).toFixed(1)} KiB 可解析）`);

// ② 引擎段真跑一局
const em = full.match(/\/\*__ENGINE_START__\*\/([\s\S]*?)\/\*__ENGINE_END__\*\//);
if (!em) fail('未找到 __ENGINE_START__ 标记');
const makeEngine = new Function(`${em[1]}\n;return { runMatch, bots, renderText, generateMap, mapFromAscii, mulberry32, RULES };`);
const eng = makeEngine();
const r1 = eng.runMatch({ seed: 42, botA: eng.bots.starGrabber, botB: eng.bots.camper });
const r2 = eng.runMatch({ seed: 42, botA: eng.bots.starGrabber, botB: eng.bots.camper });
if (JSON.stringify(r1.events) !== JSON.stringify(r2.events)) fail('内联引擎双跑不确定');
console.log(`② 内联引擎实跑 PASS：seed=42 抢星流 vs 蹲草流 → winner=${r1.winner} reason=${r1.reason} ticks=${r1.ticks} 星=${r1.stars.join(':')}（双跑逐字节一致）`);

// ③ 默认脚本（产物内 DEFAULT_SCRIPT）对战一局，模拟浏览器 startBattle 口径
// i18n 后默认脚本住进语言字典（web/i18n.js script.default，zh 在前）；兼容旧字面量写法
const dm = full.match(/const DEFAULT_SCRIPT = `([\s\S]*?)`;/) || full.match(/default: `([\s\S]*?)`,/);
if (!dm) fail('未找到 DEFAULT_SCRIPT（字面量与字典 script.default 均未命中）');
const userCode = dm[1].replace(/export\s+default\s+/g, '');
const userFn = new Function(`"use strict";\n${userCode}\n;return decide;`)();
function seedFromString(s) {
  s = String(s).trim();
  if (/^\d+$/.test(s) && s.length <= 10) return Number(s) >>> 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const seed = seedFromString('20260805-42');
const map = eng.generateMap(eng.mulberry32(seed));
const r3 = eng.runMatch({ seed, botA: userFn, botB: eng.bots.stealth, map });
const names = ['我的坦克 v1', '隐身偷袭流'];
const lines = eng.renderText(r3, names);
console.log(`③ 默认脚本一局 PASS：seed=20260805-42(hash=${seed}) vs 隐身偷袭流 → 胜方=${r3.winner === null ? '平局' : names[r3.winner]} reason=${r3.reason} ticks=${r3.ticks} 星=${r3.stars.join(':')} 战报${lines.length}行`);

// ④ 自包含体检
if (/\s(src|href)\s*=\s*["'](https?:|\/\/)/i.test(html)) fail('含外部 URL 引用');
if (/<script[^>]*\ssrc=/i.test(html)) fail('存在外链 script');
if (/<link\s/i.test(html)) fail('存在 <link> 外部资源');
console.log('④ 自包含体检 PASS：无外链 script/link/href/src，零外部请求');

// ⑤ 内置 bot 全员体检：引擎对脚本异常容错（本拍待机），所以必须用探针显式抓异常 + 断言有动作
{
  const idle = () => null;
  const summary = [];
  for (const [key, fn] of Object.entries(eng.bots)) {
    let threw = null;
    const probe = (api) => { try { return fn(api); } catch (e) { threw = threw || e; return null; } };
    const map5 = eng.generateMap(eng.mulberry32(7));
    const r = eng.runMatch({ seed: 7, map: map5, botA: idle, botB: probe, maxTicks: 80 });
    if (threw) fail(`⑤ 内置 bot「${key}」在产物引擎中抛异常：${threw.message}`);
    const acts = r.events.filter((e) => e.who === 1 && (e.type === 'move' || e.type === 'turn' || e.type === 'fire' || e.type === 'skill')).length;
    if (acts === 0) fail(`⑤ 内置 bot「${key}」在产物引擎中 80 拍零动作（疑似静默瘫痪）`);
    summary.push(`${key}:${acts}`);
  }
  console.log(`⑤ 内置 bot 全员体检 PASS：零异常、80 拍动作数 ${summary.join(' ')}`);
}
// ⑥ i18n 体检：单文件产物必须内联双语字典与语言切换器（防打包漏 i18n.js 导致英文态静默缺失）
{
  const must = [
    ['langSel', '语言切换器 select'],
    ['>English<', '英文语言选项'],
    ['data-i18n', '静态文案 i18n 标注'],
    ['agentank-lang', '语言偏好 localStorage 键'],
    ['Frozen Lake', 'en 地图词条（字典内联证据）'],
    ['冰湖', 'zh 地图词条（字典内联证据）'],
  ];
  for (const [needle, why] of must) {
    if (!html.includes(needle)) fail(`⑥ i18n 体检：产物缺少「${needle}」（${why}）`);
  }
  console.log('⑥ i18n 体检 PASS：zh/en 字典内联、语言切换器与 data-i18n 标注齐全');
}
// ⑦ 创作工坊体检：UGC 三阶段链路必须整链内联（面板/分享串前缀/本机存储键/官方收录证据）
{
  const must = [
    ['wsEditor', '工坊编辑器节点'],
    ['创作工坊', 'zh 工坊标题词条'],
    ['Workshop', 'en 工坊标题词条'],
    ['atpack1.', '内容包分享串前缀（阶段2）'],
    ['agentank-workshop', '私有内容 localStorage 键（阶段1）'],
    ['OFFICIAL_CONTENT', '官方收录列表（阶段3）'],
  ];
  for (const [needle, why] of must) {
    if (!html.includes(needle)) fail(`⑦ 工坊体检：产物缺少「${needle}」（${why}）`);
  }
  // 产物内引擎实跑一局 UGC：自定义技能经内容包注册应可用且事件带自定义 id
  const packRun = eng.runMatch({
    seed: 5,
    map: eng.mapFromAscii(['######', '#A.B.#', '######']),
    botA: (api) => (api.ready() ? api.useSkill() : null),
    botB: () => null,
    skillA: 'zap',
    content: { formatVersion: 1, author: null, entries: [{ type: 'skill', id: 'zap', name: '测试电击', stage: 'shared', cd: 40, effect: { kind: 'stun', dur: 4 } }] },
    maxTicks: 10,
  });
  if (!packRun.events.some((e) => e.type === 'skill' && e.name === 'zap')) fail('⑦ 工坊体检：产物引擎未按内容包注册自定义技能');
  if (!packRun.content) fail('⑦ 工坊体检：战报未嵌内容包（阶段2 重现凭据缺失）');
  console.log('⑦ 工坊体检 PASS：三阶段链路内联齐全，产物引擎可跑 UGC 技能且战报嵌 pack');
}
// ⑧ 无 eval 沙箱体检：线上 CSP 禁 eval，自定义脚本只能靠 blob Worker 跑。
// 这里用产物自身的沙箱代码组装 Worker 源，在假 self 环境里跑完整一局，
// 与③主线程同种子同地图逐字节对拍 —— 保证「禁 eval 路径」与「主线程路径」结果一致。
{
  const startMark = '/*__ENGINE' + '_START__*/';
  const endMark = '/*__ENGINE' + '_END__*/';
  // 标记必须各只出现一次，否则运行时切割会截错位置（沙箱拿到半截引擎 → 静默瘫痪）
  const nStart = full.split(startMark).length - 1;
  const nEnd = full.split(endMark).length - 1;
  if (nStart !== 1 || nEnd !== 1) fail(`⑧ 沙箱体检：引擎标记出现次数异常（start=${nStart} end=${nEnd}，应各为 1）`);

  const sb = new Function(`${em[1]}\n;return { buildWorkerSource, extractEngineSource };`)();
  if (sb.extractEngineSource(full) !== em[1]) fail('⑧ 沙箱体检：产物内 extractEngineSource 切出的引擎段与实际不符');

  const workerSrc = sb.buildWorkerSource({ engineSrc: em[1], userCode: dm[1] });
  if (/\bnew\s+Function\s*\(/.test(workerSrc.replace(em[1], ''))) fail('⑧ 沙箱体检：Worker 调度层里出现 new Function（禁 eval 环境会直接抛）');
  const out = [];
  const fakeSelf = { postMessage: (msg) => out.push(msg) };
  new Function('self', workerSrc)(fakeSelf); // 模拟 Worker 全局；线上由 blob URL 加载，不经 eval
  if (typeof fakeSelf.onmessage !== 'function') fail('⑧ 沙箱体检：Worker 源未注册 onmessage 调度器');
  fakeSelf.onmessage({ data: { id: 1, type: 'match', seed, map, a: { kind: 'user' }, b: { kind: 'builtin', key: 'stealth' } } });
  const r8 = out[0];
  if (!r8 || !r8.ok) fail(`⑧ 沙箱体检：沙箱跑局失败 ${(r8 && r8.error) || '(无返回)'}`);
  if (r8.errCount) fail(`⑧ 沙箱体检：默认脚本在沙箱内报错 ${r8.errCount} 次（${r8.errLast}）`);
  if (JSON.stringify(r8.result.events) !== JSON.stringify(r3.events)) fail('⑧ 沙箱体检：沙箱与主线程同种子结果不一致（确定性被破坏）');
  // 结果必须是纯数据，否则 postMessage 结构化克隆会在真浏览器里抛（本地跑不出来的坑）
  try { structuredClone(r8.result); } catch (e) { fail(`⑧ 沙箱体检：对局结果无法结构化克隆（${e.message}）`); }
  console.log(`⑧ 无 eval 沙箱体检 PASS：Worker 内默认脚本 vs 隐身偷袭流 → 胜方=${r8.result.winner === null ? '平局' : names[r8.result.winner]} ticks=${r8.result.ticks}（与主线程逐字节一致，结果可结构化克隆）`);
}
console.log('check-dist: ALL PASS');
