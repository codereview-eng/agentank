// 贴脸流：死咬最后目击位置贴上去，近身眩晕接射击。
export default function brawler(api) {
  const foe = api.enemy();
  const R = api.rules();
  const d = api.distTo(foe);
  if (api.enemyVisible()) {
    if (d <= R.stunRange && api.ready('stun')) return api.stun();
    if (api.canFire() && d <= R.fireRange) return api.fireAt(foe);
  }
  if (d === 0) return api.patrol(); // 已到最后目击点仍没人：就地搜索
  return api.moveTo(foe);
}
