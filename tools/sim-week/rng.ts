// 난수 — 시드를 정하면 같은 순서가 나옴 (하루 시뮬레이터가 결정론이도록).
// 호출 순서에 기대지 않게 용도마다 rngFor(시드, 사람, 날, 용도)로 따로 만든다.
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface Rng {
  next(): number; // [0, 1)
  int(lo: number, hi: number): number; // lo ~ hi 정수 (양 끝 포함)
  range(range: readonly [number, number]): number; // [lo, hi] 안 실수
  gauss(mu: number, sd: number): number;
  chance(p: number): boolean;
  pick<T>(list: readonly T[]): T;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0; // mulberry32
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    range: ([lo, hi]) => lo + next() * (hi - lo),
    gauss: (mu, sd) => {
      const u = Math.max(1e-12, next());
      return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)] as never,
  };
  return rng;
}

export const rngFor = (...parts: (string | number)[]): Rng => makeRng(fnv1a(parts.join('|')));
export const hashOf = (...parts: (string | number)[]): number => fnv1a(parts.join('|'));
