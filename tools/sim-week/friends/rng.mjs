// 씨앗 고정 난수 (같은 글자 씨앗이면 같은 일주일)
export function makeRng(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^ (h >>> 16)) >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => (arr.length ? arr[Math.floor(next() * arr.length)] : undefined),
    chance: (p) => next() < p,
    // 가중치 [{w, ...}] 중 하나
    weighted(items) {
      const total = items.reduce((s, i) => s + i.w, 0);
      let x = next() * total;
      for (const i of items) {
        x -= i.w;
        if (x < 0) return i;
      }
      return items[items.length - 1];
    },
  };
}
