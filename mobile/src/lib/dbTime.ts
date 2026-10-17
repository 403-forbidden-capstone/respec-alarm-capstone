// DB(PostgREST)가 준 시각 글자를 Date로 읽기 — DB 시각을 읽는 곳은 `new Date(글자)` 대신 여기 함수를 씀
//   Postgres는 timestamptz를 `2026-10-16T05:12:45.123456+00:00`처럼 마이크로초까지(끝의 0은 빼서 1~6자리) 주는데,
//   ECMAScript 날짜 글자가 정한 소수는 3자리(밀리초)까지라 엔진(Hermes)에 따라 6자리를 못 읽고 Invalid Date가 될 수 있음
//   → 소수를 3자리로 맞춰서(길면 자르고 짧으면 0으로 채움) 읽음. 앱이 DB에 넣는 시각은 toISOString()이라 밀리초지만,
//   서버가 now()로 채운 칸(created_at · 놓침 기록의 event_at 등)은 마이크로초로 옴
//   시차는 `Z` · `+09:00` · `+09`(분 없음) · `+0900`을 모두 읽고, 날짜만 있는 글자(2026-10-16) 같은 다른 모양은 그대로 둠

// 날짜 [T 또는 공백] 시각 [.소수] [Z 또는 ±시[:분]]
const DB_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:(Z)|([+-])(\d{2})(?::?(\d{2}))?)?$/;

// DB 시각 글자를 ECMAScript가 확실히 읽는 모양(소수 3자리 · 시차 Z 또는 ±HH:mm)으로. 모르는 모양은 그대로
export function normalizeDbTime(value: string): string {
  const match = DB_TIME.exec(value.trim());
  if (!match) return value;
  const [, date, time, fraction, utc, sign, hours, minutes] = match;
  const millis = fraction ? `.${fraction.slice(0, 3).padEnd(3, '0')}` : '';
  const zone = utc ?? (sign ? `${sign}${hours}:${minutes ?? '00'}` : '');
  return `${date}T${time}${millis}${zone}`;
}

// DB 시각 글자 → Date (읽을 수 없는 글자면 Invalid Date, new Date와 같음)
export function parseDbTime(value: string): Date {
  return new Date(normalizeDbTime(value));
}

// DB 시각 글자 → 밀리초 (읽을 수 없으면 NaN, Date.parse와 같음)
export function dbTimeMs(value: string): number {
  return Date.parse(normalizeDbTime(value));
}
