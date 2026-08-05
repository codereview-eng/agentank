// 隐身偷袭流：先开隐身摸过去，进射程立刻开火（开火破隐），残血传送跑路。
export default function stealth(api) {
  const me = api.me();
  const foe = api.enemy();
  const R = api.rules();
  const d = api.distTo(foe);
  if (me.hp < 30 && api.ready('teleport')) {
    const c = api.safestCorner();
    if (c) return api.teleport(c);
  }
  if (api.enemyVisible() && api.canFire() && d <= R.fireRange) return api.fireAt(foe);
  if (!me.cloaked && api.ready('cloak') && d > 2) return api.cloak();
  if (d === 0) return api.patrol();
  return api.moveTo(foe);
}
