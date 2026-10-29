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

// d가 그 시간대에서 몇 월 며칠인지 — 'YYYY-MM-DD' (DB date 칸 appointments.occurrence_on과 같은 글자)
export function localDateKey(d: Date, timeZone: string): string {
  const p = partsIn(d, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// d가 그 시간대의 0시부터 몇 분째인지 (자정 0 · 오전 7:30은 450)
export function localMinuteOfDay(d: Date, timeZone: string): number {
  const p = partsIn(d, timeZone);
  return p.hour * 60 + p.minute;
}

const DAY_MS = 86_400_000;

// 그 시간대의 날짜('YYYY-MM-DD') + 0시부터 분 → 시각. localMinuteOfDay의 반대 (같은 벽시계 시:분을 다른 날짜에 놓을 때)
//   분이 1440 이상이면 다음 날로 넘어감 (자정을 넘는 루틴 단계처럼)
//   일광절약시간이 있는 시간대: 두 번 있는 시각(가을에 시계가 되돌아가는 때)은 먼저 오는 쪽, 없는 시각(봄에 시계가 건너뛰는 때)은 건너뛴 만큼 뒤로 밂
//   (작성자 판단 — 한국은 일광절약시간이 없어 영향 없음)
export function zonedTime(dateKey: string, minuteOfDay: number, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) throw new RangeError(`날짜는 YYYY-MM-DD 모양이어야 해요: ${dateKey}`);
  // 벽시계 글자를 UTC로 읽은 값. 실제 시각은 여기서 그 시간대의 UTC 오프셋만큼 앞으로 당긴 값
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, minuteOfDay);
  // 오프셋이 바뀌는 날(일광절약시간)에도 맞게 — 하루 전 · 하루 뒤의 오프셋을 둘 다 써 보고 벽시계가 맞아떨어지는 쪽을 고름
  const offsets = [...new Set([offsetMinutes(new Date(naive - DAY_MS), timeZone), offsetMinutes(new Date(naive + DAY_MS), timeZone)])];
  const fits = offsets.map((o) => naive - o * 60_000).filter((t) => t + offsetMinutes(new Date(t), timeZone) * 60_000 === naive);
  if (fits.length) return new Date(Math.min(...fits));
  return new Date(naive - offsets[0] * 60_000); // 건너뛴 시각 — 바뀌기 전 오프셋으로 읽어 건너뛴 만큼 뒤로 밂
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
