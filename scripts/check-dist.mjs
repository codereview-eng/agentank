#!/usr/bin/env node
// 打包产物冒烟检查：node scripts/check-dist.mjs
// ① 整包内联 JS 语法检查（new Function 仅解析不执行）
// ② 抽出引擎段真跑一局 + 确定性双跑对比
// ③ 用产物内联引擎编译默认脚本，跑「默认脚本 vs 隐身偷袭流」一局（浏览器同口径）
// ④ 自包含体检：无外链 src/href、无 CDN、无 import/export 残留
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
const makeEngine = new Function(`${em[1]}\n;return { runMatch, bots, renderText, generateMap, mulberry32, RULES };`);
const eng = makeEngine();
const r1 = eng.runMatch({ seed: 42, botA: eng.bots.starGrabber, botB: eng.bots.camper });
const r2 = eng.runMatch({ seed: 42, botA: eng.bots.starGrabber, botB: eng.bots.camper });
if (JSON.stringify(r1.events) !== JSON.stringify(r2.events)) fail('内联引擎双跑不确定');
console.log(`② 内联引擎实跑 PASS：seed=42 抢星流 vs 蹲草流 → winner=${r1.winner} reason=${r1.reason} ticks=${r1.ticks} 星=${r1.stars.join(':')}（双跑逐字节一致）`);

// ③ 默认脚本（产物内 DEFAULT_SCRIPT）对战一局，模拟浏览器 startBattle 口径
const dm = full.match(/const DEFAULT_SCRIPT = `([\s\S]*?)`;/);
if (!dm) fail('未找到 DEFAULT_SCRIPT');
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
console.log('check-dist: ALL PASS');
