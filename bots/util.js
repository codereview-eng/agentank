// bot 公共小工具：炸弹威胁应对。
// 判定自己是否站在任一炸弹（含自己放的）的十字爆区内且引信将尽；是则走向最近的爆区外落点。
export function bombEvade(api) {
  const me = api.me();
  const bombs = api.bombs();
  if (!bombs.length) return null;
  const danger = (x, y) => bombs.some((b) =>
    b.fuse <= 6 && ((b.x === x && Math.abs(b.y - y) <= 2) || (b.y === y && Math.abs(b.x - x) <= 2)));
  if (!danger(me.x, me.y)) return null;
  for (let d = 1; d <= 3; d++) {
    for (let dy = -d; dy <= d; dy++) {
      const rem = d - Math.abs(dy);
      for (const dx of rem === 0 ? [0] : [-rem, rem]) {
        const p = { x: me.x + dx, y: me.y + dy };
        if (api.walkable(p) && !danger(p.x, p.y)) return api.moveTo(p);
      }
    }
  }
  return null;
}
