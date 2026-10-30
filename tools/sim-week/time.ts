// 시각 도우미 — 한국 시간(+09:00) 고정. 하네스 안의 시각은 전부 Date, 글자로 쓸 때만 여기 함수를 씀
export const MIN = 60_000;
const KST = 9 * 60 * MIN;

export const addMin = (d: Date, m: number): Date => new Date(d.getTime() + m * MIN);
export const diffMin = (a: Date, b: Date): number => (b.getTime() - a.getTime()) / MIN; // b - a (분, 소수)

// 'YYYY-MM-DD' + 'HH:MM' (한국 시간) → Date
export function kstDate(date: string, time = '00:00'): Date {
  return new Date(`${date}T${time}:00+09:00`);
}

function parts(d: Date) {
  const t = new Date(d.getTime() + KST);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), wd: t.getUTCDay() };
}
const p2 = (n: number) => String(n).padStart(2, '0');

export function ymd(d: Date): string {
  const p = parts(d);
  return `${p.y}-${p2(p.mo)}-${p2(p.d)}`;
}
export function hm(d: Date): string {
  const p = parts(d);
  return `${p2(p.h)}:${p2(p.mi)}`;
}
// 분 단위로 자른 시각 (초는 버리지 않고 반올림 — 앱 화면이 분까지만 보여서)
export const roundMin = (d: Date): Date => new Date(Math.round(d.getTime() / MIN) * MIN);

export const addDaysKey = (date: string, n: number): string => ymd(addMin(kstDate(date), n * 24 * 60));

const WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export const weekdayOf = (date: string): (typeof WD)[number] => WD[parts(kstDate(date)).wd];
const WD_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;
export const weekdayKo = (date: string): string => WD_KO[parts(kstDate(date)).wd];

// "오전 7시 40분" · "낮 12시" · "밤 12시 30분" — 코치가 읽어 주는 말 (T1 프롬프트의 시각 말씨)
export function spokenTime(d: Date): string {
  const { h, mi } = parts(d);
  let label: string;
  let hour = h % 12;
  if (h === 0) {
    label = '밤';
    hour = 12;
  } else if (h < 12) label = '오전';
  else if (h === 12) {
    label = '낮';
    hour = 12;
  } else label = '오후';
  return mi === 0 ? `${label} ${hour}시` : `${label} ${hour}시 ${mi}분`;
}

// "10월 8일(목)"
export function shortDate(date: string): string {
  const p = parts(kstDate(date));
  return `${p.mo}월 ${p.d}일(${weekdayKo(date)})`;
}

export const isoKst = (d: Date): string => {
  const t = new Date(d.getTime() + KST);
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}T${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())}+09:00`;
};
