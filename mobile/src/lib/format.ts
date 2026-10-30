// 시각 · 날짜를 화면 말투로 바꿈 (오전 7:55 · 5월 22일 목요일 · 5분 뒤) — 한국 시간 기준
// 기기 시간대와 상관없이 같은 글자가 나오게 UTC에 9시간을 더해서 읽음. 시간대 설정(profiles.timezone)이 붙으면 여기만 바꿈

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

function kst(date: Date) {
  const t = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    weekday: WEEKDAYS[t.getUTCDay()],
    weekdayIndex: t.getUTCDay(), // 0 = 일요일
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date: Date, days: number) {
  return addMinutes(date, days * 24 * 60);
}

// to − from (분, 반올림)
export function minutesBetween(from: Date, to: Date) {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

// 그날 0시 (한국 시간)
export function startOfDay(date: Date) {
  const p = kst(date);
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - KST_OFFSET_MS);
}

// 0시부터 몇 분째인지 (한국 시간)
export function minuteOfDay(date: Date) {
  const p = kst(date);
  return p.hour * 60 + p.minute;
}

// 날짜만 비교할 때 쓰는 키 (2025-05-22)
export function dayKey(date: Date) {
  const p = kst(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function isSameDay(a: Date, b: Date) {
  return dayKey(a) === dayKey(b);
}

export function dateParts(date: Date) {
  const { year, month, day, weekday, weekdayIndex } = kst(date);
  return { year, month, day, weekday, weekdayIndex };
}

// 큰 시각 표시용으로 오전/오후와 숫자를 나눔 ({ ampm: '오전', hm: '7:55' })
export function timeParts(date: Date) {
  const { hour, minute } = kst(date);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return { ampm: hour < 12 ? '오전' : '오후', hm: `${h12}:${pad(minute)}` };
}

// 오전 7:55
export function formatTime(date: Date) {
  const { ampm, hm } = timeParts(date);
  return `${ampm} ${hm}`;
}

// 21:30
export function formatTime24(date: Date) {
  const { hour, minute } = kst(date);
  return `${pad(hour)}:${pad(minute)}`;
}

// 음성 안내용 (오전 10시 · 오후 2시 30분)
export function spokenTime(date: Date) {
  const { hour, minute } = kst(date);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour < 12 ? '오전' : '오후'} ${h12}시${minute ? ` ${minute}분` : ''}`;
}

// 5월 22일 목요일
export function formatDate(date: Date) {
  const { month, day, weekday } = kst(date);
  return `${month}월 ${day}일 ${weekday}요일`;
}

// 5월 22일 (목) — 화면 어디서나 짧은 날짜는 이 모양
export function formatDateShort(date: Date) {
  const { month, day, weekday } = kst(date);
  return `${month}월 ${day}일 (${weekday})`;
}

// formatDateShort와 같음 (옛 이름)
export const formatDateParen = formatDateShort;

// 지금 · 5분 뒤 · 1시간 5분 뒤 — 지난 시각도 '지금' (다음 알람처럼 앞으로 올 시각에만 씀)
export function formatRelative(from: Date, to: Date) {
  const diff = minutesBetween(from, to);
  if (diff <= 0) return '지금';
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return `${[h ? `${h}시간` : '', m ? `${m}분` : ''].filter(Boolean).join(' ')} 뒤`;
}

// 시간 길이 글자 — 30분 · 1시간 · 1시간 10분 (분은 반올림). 서버 알림 문구(_shared/tz.ts formatKoDuration)와 같은 모양 — mocks/__tests__/shared.test.ts가 같은 값인지 봄
export function formatDuration(minutes: number) {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return [h ? `${h}시간` : '', m || !h ? `${m}분` : ''].filter(Boolean).join(' ');
}

// 받침에 맞는 조사 (josa('수연', '이', '가') → '수연이')
export function josa(word: string, withBatchim: string, withoutBatchim: string) {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return word + withoutBatchim;
  return word + ((code - 0xac00) % 28 ? withBatchim : withoutBatchim);
}

// 수연님, 지형님과 준성님
export function joinKo(words: string[]) {
  if (words.length < 2) return words.join('');
  const head = words.slice(0, -1).map((w, i) => (i === words.length - 2 ? `${josa(w, '과', '와')} ` : `${w}, `));
  return head.join('') + words[words.length - 1];
}

// 좁은 칸에서 단어 사이에서만 줄이 바뀌게 — Android · 웹은 한글 음절 사이에서도 줄을 바꿔 "기 / 상"이 됨
// 음절 사이는 단어 잇기(U+2060), "오후 12:28" · "· 지남"은 줄 안 바뀌는 공백(U+00A0)으로 묶음. 보이는 글자는 그대로
export function keepWords(text: string) {
  return text
    .replace(/(오전|오후) /g, '$1\u00A0')
    .replace(/· /g, '·\u00A0')
    .replace(/([가-힣])(?=[가-힣])/g, '$1\u2060');
}

// 0시부터 분 → '21:30' (루틴 시작 시각 등). 하루를 넘으면 다음 날 시각으로 (목업 h24)
export function formatMinuteOfDay(minutes: number) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
