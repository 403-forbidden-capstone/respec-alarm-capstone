// 시나리오 작성 도구 — 고정 씨앗 난수(어느 PC에서든 같은 값) · 시각 도우미 · 사례 모음 모양
//   사례 하나 = 모듈 · 함수 이름 · 사람이 읽는 이름 · 인자 목록(앞에서부터 그대로 넘김)
//   난수 사례는 이름에 번호를 붙이고, 씨앗은 파일마다 따로 둠 (한 파일의 사례 수를 바꿔도 다른 파일 사례가 안 바뀜)

export type Add = (module: string, fn: string, name: string, ...args: unknown[]) => void;

export type Rng = {
  next: () => number; // [0, 1)
  int: (lo: number, hi: number) => number; // lo 이상 hi 이하 정수
  pick: <T>(items: readonly T[]) => T;
  chance: (p: number) => boolean;
  shuffle: <T>(items: readonly T[]) => T[];
};

// mulberry32 — 32비트 정수 연산만 써서 엔진 · 플랫폼과 상관없이 같은 수열
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return {
    next,
    int,
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

// 오프셋이 있는 ISO 글자 → Date. 잘못된 글자는 바로 멈춤
export function d(iso: string): Date {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new RangeError(`시나리오의 시각이 잘못됨: ${iso}`);
  return date;
}

export const MINUTE = 60_000;

// base에서 minutes분 뒤 (소수 분 허용: 밀리초로 내림하지 않고 정확히 나눠 떨어지는 값만 씀)
export function after(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * MINUTE);
}

export const RING = ['WAKE', 'PREPARE', 'DEPARTURE'] as const;
export const TRANSPORTS = ['WALK', 'TRANSIT', 'BUS', 'SUBWAY', 'CAR'] as const;
export const IMPORTANCES = ['LOW', 'NORMAL', 'HIGH'] as const;
export const ZONES = ['Asia/Seoul', 'UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kolkata', 'America/Sao_Paulo'] as const;
