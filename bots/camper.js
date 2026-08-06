// 蹲草流（技能：冰冻）：看得见敌人就先冰冻再交火；看不见就找草丛蹲着装死；躲炸弹。
import { bombEvade } from './util.js';

export default function camper(api) {
  const evade = bombEvade(api);
  if (evade) return evade;
  const foe = api.enemy();
  const me = api.me();
  const R = api.rules();
  const d = api.distTo(foe);
  if (api.enemyVisible()) {
    if (api.ready() && d <= R.fireRange) return api.useSkill(); // 冰冻定身
    if (api.canFire() && d <= R.fireRange && (foe.x === me.x || foe.y === me.y)) return api.fireAt(foe);
    if (d > R.fireRange) return api.moveTo(foe); // 追到射程内
    if (api.canFire()) return api.fireAt(foe); // 未对齐：先借 fireAt 转向压制
    return null; // 装填/在飞：原地不动
  }
  if (!api.inGrass()) {
    const g = api.nearestGrass();
    if (g) return api.moveTo(g);
    const s = api.nearestStar();
    return s ? api.moveTo(s) : api.patrol();
  }
  return null; // 已在草丛：蹲住
}
camper.skill = 'freeze';
