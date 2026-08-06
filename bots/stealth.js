// 隐身偷袭流（技能：隐身）：先开隐身摸过去，进射程立刻开火（开火破隐），残血撤向远角；躲炸弹。
import { bombEvade } from './util.js';

export default function stealth(api) {
  const evade = bombEvade(api);
  if (evade) return evade;
  const me = api.me();
  const foe = api.enemy();
  const R = api.rules();
  const d = api.distTo(foe);
  if (me.hp < 30 && d <= 4) {
    const c = api.safestCorner();
    if (c) return api.moveTo(c);
  }
  if (api.enemyVisible() && api.canFire() && d <= R.fireRange) return api.fireAt(foe);
  if (!me.cloaked && api.ready() && d > 2) return api.useSkill();
  if (d === 0) return api.patrol();
  return api.moveTo(foe);
}
stealth.skill = 'cloak';
