// ---------- 无 eval 沙箱：宿主 CSP 禁 eval 时，把整局对战搬进 blob Worker 跑 ----------
// 为什么这条路走得通（2026-08-19 在 play-agentank.run.ceo 实测）：
//   线上 CSP = script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:
//   → new Function 必抛（"Evaluating a string as JavaScript violates ... 'unsafe-eval'"）；
//   → 但 Worker 的顶层脚本来自 blob URL，属于「脚本加载」受 worker-src 管辖，实测可跑任意用户代码。
// 因此：玩家脚本不再当字符串去 eval，而是作为 Worker 的源码之一被加载执行；
// 引擎同样以源码文本随行（单文件产物里由 __ENGINE_START__/__ENGINE_END__ 标记切出），
// 整局在 Worker 内 runMatch 后把纯数据结果 postMessage 回主线程 —— 主线程只负责渲染。
//
// 边界：Worker 继承文档 CSP，所以 Worker 内部同样禁 eval —— 这正是我们要的沙箱语义
//（玩家脚本能跑，但拿不到 eval / DOM / 网络，见 checkGeneratedCode 的禁用清单）。

// 拆写标记：产物里绝不能出现第二处完整标记，否则切割会截错位置（构建期 check-dist 会断言只出现一次）
const MARK_START = '/*__ENGINE' + '_START__*/';
const MARK_END = '/*__ENGINE' + '_END__*/';

// 从单文件产物的内联脚本文本里切出引擎源码段；拿不到就返回空串（上层据此 fail-closed，绝不静默降级）
export function extractEngineSource(bundleText) {
  const s = String(bundleText || '');
  const i = s.indexOf(MARK_START);
  if (i < 0) return '';
  const j = s.indexOf(MARK_END, i + MARK_START.length);
  if (j < 0) return '';
  return s.slice(i + MARK_START.length, j);
}

// 解析脚本入口名：`export default function xxx` → xxx；否则按约定的 decide
export function decideEntryName(code) {
  const m = String(code || '').match(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
  return m ? m[1] : 'decide';
}

// 把一段玩家脚本包成「命名 IIFE 求值」——纯文本拼接，不执行、不 eval。
// 用 IIFE 隔离作用域：用户脚本与对手脚本的顶层声明互不污染，也污染不到引擎。
export function wrapDecide(code, varName) {
  const entry = decideEntryName(code);
  const body = String(code || '').replace(/export\s+default\s+/g, '');
  return [
    `const ${varName} = (function () {`,
    '"use strict";',
    body,
    `;if (typeof ${entry} === 'function') return ${entry};`,
    ";if (typeof decide === 'function') return decide;",
    'return null;',
    '})();',
  ].join('\n');
}

// Worker 内的调度器：收一份作业，跑 runMatch，回纯数据。
// 支持两类作业：single（开战一局，回完整 result）、ladder（一批循环赛，只回胜负，供主线程算 ELO）。
const HARNESS = `
function __guard(fn, box) {
  return function (api) {
    try { return fn(api); } catch (e) { box.count++; box.last = String((e && e.message) || e); return null; }
  };
}
function __pick(spec, box) {
  if (!spec) return null;
  if (spec.kind === 'user') {
    if (typeof __userDecide !== 'function') throw new Error('user script has no decide(api) entry');
    var g = __guard(__userDecide, box); g.skill = spec.skill; return g;
  }
  if (spec.kind === 'code') {
    if (typeof __oppDecide !== 'function') throw new Error('opponent script has no decide(api) entry');
    var o = __guard(__oppDecide, { count: 0, last: '' }); o.skill = spec.skill; return o;
  }
  var b = bots[spec.key];
  if (typeof b !== 'function') throw new Error('unknown builtin bot: ' + spec.key);
  return b;
}
self.onmessage = function (e) {
  var m = e.data || {};
  var box = { count: 0, last: '' };
  try {
    if (m.type === 'batch') {
      // 批量试跑（同关卡同对手同技能、只换 seed）：Worker 内跑完直接出「一局一行摘要」，
      // 不把全量事件回传主线程（12 局的事件有几 MB，回传既慢又没人看）。
      // 摘要口径与主线程共用 summarizeGame，两条路胜率必须一致。
      var games = [];
      for (var bi = 0; bi < m.jobs.length; bi++) {
        var bj = m.jobs[bi];
        if (!bj.map) throw new Error('batch job requires map (摘要判定需要地形与出生点)');
        var br = runMatch({ seed: bj.seed, botA: __pick(bj.a, box), botB: __pick(bj.b, box), map: bj.map, content: m.content || null });
        games.push(summarizeGame({
          map: bj.map, result: br, who: bj.who || 0,
          seed: bj.seedStr || bj.seed, strategy: m.strategy || '',
        }));
        // 逐局进度上报：整批 12 局在 Worker 里要跑好几秒，主线程若一条消息都收不到，
        // 界面就只能显示一个不动的「打 12 局评分」——与「卡死」无法区分（progress 消息不带 ok，主线程据此不收尾）。
        self.postMessage({ id: m.id, progress: bi + 1, total: m.jobs.length });
      }
      self.postMessage({ id: m.id, ok: true, games: games, errCount: box.count, errLast: box.last });
      return;
    }
    if (m.type === 'ladder') {
      var out = [];
      for (var i = 0; i < m.jobs.length; i++) {
        var j = m.jobs[i];
        var r = runMatch({ seed: j.seed, botA: __pick(j.a, box), botB: __pick(j.b, box), map: j.map || null, content: m.content || null });
        out.push({ winner: r.winner });
      }
      self.postMessage({ id: m.id, ok: true, results: out, errCount: box.count, errLast: box.last });
      return;
    }
    var res = runMatch({ seed: m.seed, botA: __pick(m.a, box), botB: __pick(m.b, box), map: m.map || null, content: m.content || null });
    self.postMessage({ id: m.id, ok: true, result: res, errCount: box.count, errLast: box.last });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};
`;

// 组装完整 Worker 源：引擎源码 + 玩家脚本 + 对手脚本 + 调度器。全程字符串拼接，零 eval。
export function buildWorkerSource(opts) {
  const o = opts || {};
  const engineSrc = String(o.engineSrc || '');
  if (!engineSrc.trim()) throw new Error('engine source unavailable (sandbox cannot start)');
  const parts = ['"use strict";', engineSrc];
  if (o.userCode) parts.push(wrapDecide(o.userCode, '__userDecide'));
  if (o.oppCode) parts.push(wrapDecide(o.oppCode, '__oppDecide'));
  parts.push(HARNESS);
  return parts.join('\n');
}
