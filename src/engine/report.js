// 战报文本渲染：把结构化事件数组渲染成可读文字行（供前端回放/展示）。

const SKILL_NAMES = { cloak: '隐身', teleport: '传送', stun: '眩晕' };

export function renderText(result, names = ['甲', '乙']) {
  const nm = (i) => names[i] ?? `P${i}`;
  const lines = [];
  for (const e of result.events) {
    const t = `t=${String(e.t).padStart(3, '0')}`;
    switch (e.type) {
      case 'start':
        lines.push(`${t} 对战开始 seed=${e.seed} 地图${e.width}x${e.height}`);
        break;
      case 'goal':
        if (e.tag === 'star') lines.push(`${t} ${nm(e.who)} 直奔星星`);
        else if (e.tag === 'enemy') lines.push(`${t} ${nm(e.who)} 扑向敌人`);
        else lines.push(`${t} ${nm(e.who)} 移动到(${e.x},${e.y})`);
        break;
      case 'turn': {
        const arrow = { '1,0': '→', '-1,0': '←', '0,1': '↓', '0,-1': '↑' }[e.dx + ',' + e.dy] ?? '';
        lines.push(`${t} ${nm(e.who)} 转炮口${arrow}`);
        break;
      }
      case 'fire':
        lines.push(`${t} ${nm(e.who)} 开火`);
        break;
      case 'hit':
        lines.push(`${t} ${nm(e.who)} 命中 ${nm(e.target)}（-${e.dmg}，剩${e.hp}）`);
        break;
      case 'bullet_end':
        if (e.cause === 'wall') lines.push(`${t} ${nm(e.who)} 的子弹被墙挡下`);
        else if (e.cause === 'dirt') lines.push(`${t} ${nm(e.who)} 的子弹被土堆挡下`);
        break;
      case 'star':
        lines.push(`${t} ${nm(e.who)} 吃星（${e.total}）`);
        break;
      case 'star_spawn':
        lines.push(`${t} 新星星出现在(${e.x},${e.y})`);
        break;
      case 'skill':
        lines.push(`${t} ${nm(e.who)} 施放${SKILL_NAMES[e.name] ?? e.name}`);
        break;
      case 'stun_hit':
        lines.push(`${t} ${nm(e.target)} 被眩晕${e.duration}拍`);
        break;
      case 'death':
        lines.push(`${t} ${nm(e.who)} 被击毁`);
        break;
      case 'end':
        lines.push(
          e.winner == null
            ? `${t} 平局（星${e.stars[0]}:${e.stars[1]}）`
            : `${t} ${nm(e.winner)} 获胜（${e.reason === 'kill' ? '击杀' : '星数'}，星${e.stars[0]}:${e.stars[1]}）`,
        );
        break;
      default:
        break;
    }
  }
  return lines;
}
