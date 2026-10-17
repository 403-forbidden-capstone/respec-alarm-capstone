// 시간대 도우미 — 사용자 시간대(profiles.timezone, 기본 Asia/Seoul)로 "그날"과 화면 시각 글자를 계산
// 하루 경계는 0시 (전체작업계획 8.1 F7 "0시 유지"). 순수 TS(Intl만) — node --test로 시험

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsIn(d: Date, timeZone: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const get: Record<string, number> = {};
  for (const p of f.formatToParts(d)) if (p.type !== 'literal') get[p.type] = Number(p.value);
  return { year: get.year, month: get.month, day: get.day, hour: get.hour, minute: get.minute, second: get.second };
}

// 그 시각에 시간대가 UTC보다 몇 분 앞서는지 (서울 = +540)
export function offsetMinutes(d: Date, timeZone: string): number {
  const p = partsIn(d, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

// 그 시간대의 y년 m월 d일 0시 (일광절약시간이 있는 시간대도 두 번 보정해서 맞춤)
function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day);
  const first = naive - offsetMinutes(new Date(naive), timeZone) * 60_000;
  return new Date(naive - offsetMinutes(new Date(first), timeZone) * 60_000);
}

// d가 속한 날의 시작(0시)과 다음 날 시작 — [start, end)
export function localDayRange(d: Date, timeZone: string): { start: Date; end: Date } {
  const p = partsIn(d, timeZone);
  return { start: zonedMidnight(p.year, p.month, p.day, timeZone), end: zonedMidnight(p.year, p.month, p.day + 1, timeZone) };
}

// "오전 10:00" — 앱 lib/format의 시각 글자와 같은 모양 (RingPackage.subtitle에 씀)
export function formatKoTime(d: Date, timeZone: string): string {
  const p = partsIn(d, timeZone);
  const period = p.hour < 12 ? '오전' : '오후';
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${period} ${hour12}:${String(p.minute).padStart(2, '0')}`;
}

// 모르는 시간대 이름이면 기본값 (profiles.timezone은 DB 트리거가 검사하지만 방어)
export function safeTimeZone(timeZone: string | null | undefined): string {
  const tz = timeZone || 'Asia/Seoul';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'Asia/Seoul';
  }
}
