#!/usr/bin/env node
// AgenTank 单文件打包：node scripts/build-web.mjs
// 纯 Node、零依赖。把 src/engine + bots + web/app.js 按依赖序内联（去 import/export），
// 注入 web/index.html 生成 dist/agentank.html —— 零外部请求、打开即玩。
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 依赖序（被依赖者在前）；各 index.js 桶文件跳过，bots 聚合由下方 shim 提供。
const ORDER = [
  'src/engine/rng.js',
  'src/engine/map.js',
  'src/engine/content.js',
  'src/engine/maps.js',
  'src/engine/engine.js',
  'src/engine/report.js',
  'bots/util.js',
  'bots/camper.js',
  'bots/starGrabber.js',
  'bots/brawler.js',
  'bots/stealth.js',
  'bots/baseline.js',
  'web/i18n.js',
  'web/play.js',
];

// 内联覆盖检查：被剥掉的相对 import 必须指向 ORDER 内文件（或被跳过的 index.js 桶），
// 否则内联后引用会变成运行期 ReferenceError（引擎对脚本容错 → 静默瘫痪），必须在构建期炸出来。
function assertImportsCovered(src, file) {
  const dir = dirname(join(ROOT, file));
  for (const im of src.matchAll(/^import\s[^\n]*?from\s*['"]([^'"]+)['"]/gm)) {
    const spec = im[1];
    if (!spec.startsWith('.')) throw new Error(`${file}: 非相对依赖 ${spec}，单文件包无法内联`);
    const abs = join(dir, spec).replace(`${ROOT}/`, '');
    if (abs.endsWith('/index.js') || abs === 'index.js') continue; // 桶文件由 shim 覆盖
    if (!ORDER.includes(abs)) throw new Error(`${file}: import 了 ${abs}，但它不在 build-web ORDER 内联清单里`);
  }
}

function stripModule(src, file, { appMode = false } = {}) {
  assertImportsCovered(src, file);
  let out = src.replace(/^import\s[^\n]*$/gm, '');
  if (appMode) {
    // app.js 的模板字符串里合法地含有 "export default ..."（默认脚本文本），
    // 只剥它顶部的 import 行，不做 export 变换，避免误改字符串内容。
    return out.trim();
  }
  out = out.replace(/^export\s+default\s+function/gm, 'function');
  if (/^export\s+default\s/m.test(out)) throw new Error(`${file}: 存在未处理的 export default 形态`);
  out = out.replace(/^export\s+\{[^}]*\}\s*(from\s*[^\n]*)?;?\s*$/gm, '');
  out = out.replace(/^export\s+/gm, '');
  if (/^(import|export)\s/m.test(out)) {
    throw new Error(`${file}: 内联后仍残留 import/export`);
  }
  return out.trim();
}

const parts = [];
for (const rel of ORDER) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  parts.push(`// ===== ${rel} =====\n${stripModule(src, rel)}`);
}
parts.push('// ===== bots barrel shim =====\nconst bots = { camper, starGrabber, brawler, stealth, baseline };');
const engineBundle = parts.join('\n\n');

const appSrc = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
const appBundle = `// ===== web/app.js =====\n${stripModule(appSrc, 'web/app.js', { appMode: true })}`;

const bundle = [
  '"use strict";',
  '/*__ENGINE_START__*/',
  engineBundle,
  '/*__ENGINE_END__*/',
  appBundle,
].join('\n');

if (bundle.includes('</script')) throw new Error('bundle 含 </script>，会截断内联 <script> 标签');
// 语法检查（仅解析不执行）
new Function(bundle); // eslint-disable-line no-new-func

const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
const tag = '<script type="module" src="./app.js"></script>';
if (!html.includes(tag)) throw new Error('web/index.html 中找不到模块 script 占位标签');
const out = html
  .replace('<title>AgenTank — AI 脚本坦克对战</title>', '<title>AgenTank — AI 脚本坦克对战（单文件版）</title>')
  .replace(tag, `<script>\n(function () {\n${bundle}\n})();\n</script>`);

if (/\s(src|href)\s*=\s*["'](https?:|\/\/)/i.test(out)) throw new Error('产物含外部 URL 引用');
if (/<script[^>]*\ssrc=/i.test(out)) throw new Error('产物仍有外链 script');

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const target = join(ROOT, 'dist/agentank.html');
writeFileSync(target, out);
console.log(`built dist/agentank.html — ${(statSync(target).size / 1024).toFixed(1)} KiB`);
