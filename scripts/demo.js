// 示例：跑一局 抢星流 vs 蹲草流，打印文本战报与确定性校验。
import { runMatch, renderText } from '../src/engine/index.js';
import { bots } from '../bots/index.js';

const opts = { seed: 7, botA: bots.starGrabber, botB: bots.camper };
const r1 = runMatch(opts);
const r2 = runMatch(opts);
const names = ['抢星流', '蹲草流'];

console.log('=== 文本战报（前 10 行）===');
console.log(renderText(r1, names).slice(0, 10).join('\n'));
console.log('...');
console.log(renderText(r1, names).at(-1));
console.log(`事件数=${r1.events.length} 胜者=${r1.winner === null ? '平局' : names[r1.winner]} 原因=${r1.reason} 星=${r1.stars.join(':')} 拍数=${r1.ticks}`);
console.log(`确定性校验（两次运行战报逐字节相同）：${JSON.stringify(r1.events) === JSON.stringify(r2.events) ? 'PASS' : 'FAIL'}`);
