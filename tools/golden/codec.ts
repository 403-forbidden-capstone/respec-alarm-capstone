// 골든 파일의 값 부호화 — JS 값(Date · NaN · Infinity 포함)을 어느 언어든 읽는 JSON으로 바꾸고 되돌림
//   · Date            → {"$date": "2026-11-16T01:00:00.000Z"}   (UTC ISO, 밀리초 3자리)
//   · NaN · ±Infinity → {"$num": "NaN" | "Infinity" | "-Infinity"}
//   · -0              → 0   (JSON.stringify와 같음 — 앱이 받는 응답에서도 0)
//   · 객체 속성이 undefined → 그 속성이 없음 / 배열 안 undefined → null (JSON.stringify와 같음)
//   · 그 밖의 값(문자 · 숫자 · 불리언 · null · 일반 객체 · 배열)은 그대로
// 지원 안 하는 값(함수 · bigint · Map · Set · 잘못된 Date · `$`로 시작하는 키)은 조용히 넘기지 않고 오류로 멈춤

export function encode(value: unknown, path = '$'): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (Number.isNaN(value)) return { $num: 'NaN' };
      if (value === Infinity) return { $num: 'Infinity' };
      if (value === -Infinity) return { $num: '-Infinity' };
      return Object.is(value, -0) ? 0 : value;
    case 'undefined':
      return null; // 배열 안에서만 여기까지 옴 (객체 속성은 아래에서 건너뜀)
    case 'object':
      break;
    default:
      throw new TypeError(`골든에 못 넣는 값(${typeof value}): ${path}`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RangeError(`잘못된 Date는 골든에 못 넣음: ${path}`);
    return { $date: value.toISOString() };
  }
  if (Array.isArray(value)) return value.map((item, i) => encode(item, `${path}[${i}]`));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`골든에 못 넣는 객체(${proto?.constructor?.name}): ${path}`);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('$')) throw new TypeError(`키가 $로 시작할 수 없음: ${path}.${key}`);
    if (item === undefined) continue;
    out[key] = encode(item, `${path}.${key}`);
  }
  return out;
}

export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === '$date' && typeof obj.$date === 'string') return new Date(obj.$date);
  if (keys.length === 1 && keys[0] === '$num' && typeof obj.$num === 'string') {
    const n = { NaN, Infinity, '-Infinity': -Infinity }[obj.$num];
    if (n === undefined) throw new TypeError(`알 수 없는 $num: ${obj.$num}`);
    return n;
  }
  return Object.fromEntries(keys.map((k) => [k, decode(obj[k])]));
}
