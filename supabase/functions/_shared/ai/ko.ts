// 한국어 정규화 · 검사 — 서버 가드(guards.ts)와 카드 계산(turn-core.ts)이 쓰는 공용 도구 (실험실 lib/ko.ts 이식).
// 같은 뜻의 다른 표기('일곱 시 반' · '7시30분' · '07:30')를 같은 값으로 모은다.
// 순수 TS만 쓴다(Node · Deno 전용 API 없음).
// 이식 때 바꾼 곳(설계 메모 4.1 · 7절): 04:00 하루 경계(DAY_BOUNDARY_MINUTES · recordDateOf)를 뺐다 — 저장은 0시, 대화 기준일은
//   turn-core `dayOf`가 정한다. 상대 날짜('오늘' · '내일') 모호 검사는 현재 시각(nowIso) 대신 달력 오늘(calendarToday) 인자를 받는다.
//   titleSimilarity · normalizeTitle(채점용)은 서버가 안 불러 뺐다.
// 위치(start · end)는 입력을 NFC + 전각 숫자 · 기호 → 반각으로 바꾼 문자열 기준이다(보통 입력과 같음).
import type { Context, LocalDate, LocalTime, Weekday } from "./types.ts";

// ───────── 공개 타입 ─────────

/** 시각 앞에 붙는 때 표시. 정오 · 자정은 그 자체가 시각이다. */
export type PeriodMarker = "오전" | "오후" | "아침" | "저녁" | "밤" | "새벽" | "낮" | "점심" | "정오" | "자정";
/** 시각과 기준의 관계 ('9시 전' · '9시 넘어서' · '9시까지' · '9시부터') */
export type ClockRelation = "before" | "after" | "until" | "from";
/** 길이에 붙는 방향 ('20분 더' · '10분 덜' · '15분 일찍' · '10분 늦게' · '10분 전' · '10분 뒤') */
export type DurationModifier = "more" | "less" | "earlier" | "later" | "before" | "after";
/** last_night = '어젯밤 · 지난밤 · 간밤 · 어제 밤' — 기록 날짜 전날 밤(잠 기록을 가리키는 말) */
export type RelativeDateKey = "today" | "tomorrow" | "day_after" | "yesterday" | "last_night";
/** 요일 앞의 주 표시. 표시가 없으면 this + explicit=false */
export type WeekRef = "last" | "this" | "next" | "after_next";

export type DateValue =
  | { type: "relative"; key: RelativeDateKey }
  | { type: "weekday"; week: WeekRef; weekday: Weekday; explicit: boolean }
  | {
    type: "absolute"; year: number | null; month: number | null; day: number;
    /** '이번 달 N일'(0) · '다음 달 N일'(1) · '다다음 달 N일'(2) — month가 null일 때만 있음 */
    monthOffset?: number;
  };

interface MentionBase {
  raw: string; // 원문 조각
  start: number;
  end: number; // 끝 위치(포함 안 함)
}

export interface ClockMention extends MentionBase {
  kind: "clock";
  value: number; // 자정부터 분. 모호하면 '쓴 그대로'(1~11시 = 오전, 12시 = 낮 12시)
  hour: number; // 말한 시(0~24)
  minute: number;
  period: PeriodMarker | null;
  hour12Ambiguous: boolean; // 때 표시 없이 1~12시
  candidates: number[]; // 가능한 해석(분) — 모호하면 오전 · 오후 2개, '8시 10분 전'이면 7:50 해석도 더함
  approx: boolean; // 쯤 · 정도 · 경 · '한 7시'
  relation: ClockRelation | null;
}

export interface DurationMention extends MentionBase {
  kind: "duration";
  value: number; // 분 (범위면 아래쪽)
  range: [number, number] | null; // '10~15분' · '한두 시간'
  approx: boolean;
  modifier: DurationModifier | null;
}

export interface CountMention extends MentionBase {
  kind: "count";
  value: number; // 범위면 아래쪽
  range: [number, number] | null;
  native: boolean; // 고유어로 씀('한 번' · '두 번' · '이틀')
  /** times = 번 · 회 / days = 날 수('3일 동안' · '3일 연속' · '최근 7일 중 3일' · '이틀') — 날짜가 아님 */
  unit: "times" | "days";
  /** 날짜(그 달 N일)로도 읽히는 날 수 ('발표하는 날이 9일' · '9일 정도') — unsupportedNumbers는 날짜로 맞아도 통과 */
  dateDay?: number;
}

export interface DateMention extends MentionBase {
  kind: "date";
  value: DateValue;
}

/**
 * 시각 · 길이 · 횟수 · 날짜가 아닌 숫자 ('1번 출구' · '2호선' · '3학년' · '첫 번째' · '1단계').
 * 진행 분수 '루틴 1/3단계' · '2/3 완료'는 unit '분수', value = 분자, denominator = 분모 (날짜 아님).
 */
export interface OtherMention extends MentionBase {
  kind: "other";
  value: number | null;
  unit: string;
  denominator?: number;
}

export type TimeMention = ClockMention | DurationMention | CountMention | DateMention | OtherMention;

// ───────── 숫자 읽기 ─────────

const SINO_DIGIT: Record<string, number> = { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9 };
const SINO_UNIT: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
const NATIVE_ONES: Record<string, number> = {
  하나: 1, 한: 1, 둘: 2, 두: 2, 셋: 3, 세: 3, 석: 3, 서: 3, 넷: 4, 네: 4, 넉: 4, 너: 4,
  다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 여덜: 8, 아홉: 9,
};
const NATIVE_TENS: Record<string, number> = { 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60 };

function parseSino(s: string): number | null {
  if (!/^[영공일이삼사오육륙칠팔구십백천]+$/u.test(s)) return null;
  if (s.length === 1 && s in SINO_DIGIT) return SINO_DIGIT[s];
  let total = 0;
  let cur: number | null = null;
  let lastUnit = Infinity;
  for (const ch of s) {
    if (ch in SINO_DIGIT) {
      if (cur !== null) return null; // '이삼' 같은 연속 숫자는 안 받음
      cur = SINO_DIGIT[ch];
    } else {
      const u = SINO_UNIT[ch];
      if (u >= lastUnit) return null; // '십백' · '십십'
      if (cur === 0) return null;
      total += (cur ?? 1) * u;
      cur = null;
      lastUnit = u;
    }
  }
  return total + (cur ?? 0);
}

function parseNative(s: string): number | null {
  if (s in NATIVE_ONES) return NATIVE_ONES[s];
  if (s in NATIVE_TENS) return NATIVE_TENS[s];
  for (const [t, tv] of Object.entries(NATIVE_TENS)) {
    if (t === "스무") continue; // '스무'는 단독으로만 ('스무 살')
    if (s.startsWith(t)) {
      const rest = s.slice(t.length);
      if (rest in NATIVE_ONES) return tv + NATIVE_ONES[rest];
    }
  }
  return null;
}

/**
 * 숫자 낱말 하나를 수로 읽는다. 아라비아 숫자 · 한자어('이십오') · 고유어('열두' · '스물셋').
 * 띄어 쓴 고유어('열 두')도 받는다. 못 읽으면 null.
 */
export function parseKoreanNumber(s: string): number | null {
  const t = toHalfWidth(s.normalize("NFC")).replace(/\s+/gu, "");
  if (t === "") return null;
  if (/^\d+(?:\.\d+)?$/u.test(t)) return Number(t);
  return parseNative(t) ?? parseSino(t);
}

/** 전각 숫자 · 기호를 반각으로 (길이 그대로) */
function toHalfWidth(s: string): string {
  return s.replace(/[０-９：～？！．／]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function prep(text: string): string {
  return toHalfWidth(text.normalize("NFC"));
}

// ───────── 시각 · 날짜 도우미 ─────────

/** 분 → "HH:MM" (하루를 넘으면 접음) */
export function clockToHHMM(minutes: number): LocalTime {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "HH:MM" · "H:MM" → 분. 형식이 틀리면 null. "24:00"은 1440. */
export function hhmmToMinutes(hhmm: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/u.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

const DAY_MS = 86_400_000;

function parseLocalDate(d: LocalDate): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(d);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const t = Date.UTC(y, mo - 1, da);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== da) return null;
  return t;
}

function formatUtcDate(t: number): LocalDate {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function makeDate(y: number, mo: number, da: number): LocalDate | null {
  const s = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
  return parseLocalDate(s) === null ? null : s;
}

/** 날짜 더하기 */
export function addDays(date: LocalDate, days: number): LocalDate {
  const t = parseLocalDate(date);
  if (t === null) throw new Error(`날짜 형식 아님: ${date}`);
  return formatUtcDate(t + days * DAY_MS);
}

/** ISO 시각 → 서울 로컬 {date, minutes}. 시간대 표시가 없으면 이미 서울 로컬로 본다. */
export function seoulLocal(iso: string): { date: LocalDate; minutes: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/u.exec(iso.trim());
  if (!m) throw new Error(`ISO 시각 형식 아님: ${iso}`);
  // Date.parse는 '02-30'을 3/2로 넘겨 버리므로 칸마다 먼저 본다
  if (parseLocalDate(`${m[1]}-${m[2]}-${m[3]}`) === null || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59) {
    throw new Error(`없는 날짜 · 시각: ${iso}`);
  }
  if (!m[7]) return { date: `${m[1]}-${m[2]}-${m[3]}`, minutes: Number(m[4]) * 60 + Number(m[5]) };
  // 시간대를 직접 계산한다 ('+0900'처럼 콜론 없는 표기도 엔진마다 다르게 읽지 않게)
  const tz = m[7].toUpperCase();
  const off = tz === "Z" ? 0 : (tz[0] === "-" ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(-2)));
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - off * 60_000;
  const local = new Date(t + 9 * 3_600_000); // Asia/Seoul = +09:00 (서머타임 없음)
  return {
    date: formatUtcDate(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

// ───────── 시각 · 길이 · 횟수 · 날짜 찾기 ─────────

// 붙여 쓴 한 글자 고유어('두' · '세' · '네' · '한') 바로 앞에 와도 되는 글자 — 조사 · 날짜 · 때 낱말의 끝.
// '모두 시간' · '또한 시간'처럼 낱말 속 글자를 숫자로 읽지 않으려는 장치. 받아쓰기형 '내일오후두시'는 통과.
// 받아쓰기형 이음말 끝 '-는데' · '-면' · '아까'도 넣음 ('준비하는데한시간' · '타면두시간' · '아까한시간')
const PREV_OK = "에은는고서도랑엔쯤일후전침녁밤벽낮심늘낼레욜날터지요제가이을를와과로만나데면까";
const B = String.raw`(?<=^|[^가-힣]|[${PREV_OK}])`;
const NATIVE_HOUR = String.raw`(?:${B}(?:열\s?한|열\s?두|열|한|두|세|네)|다섯|여섯|일곱|여덟|여덜|아홉)`;
const NATIVE_ONE_ALT = "하나|한|둘|두|셋|세|넷|네|다섯|여섯|일곱|여덟|여덜|아홉";
const NATIVE_NUM = String.raw`(?:${B}(?:(?:열|스물|서른|마흔|쉰)\s?(?:${NATIVE_ONE_ALT})|스무|스물|서른|마흔|쉰|열|하나|한|둘|두|셋|세|넷|네)|다섯|여섯|일곱|여덟|여덜|아홉)`;
const NATIVE_NUM_LOOSE = String.raw`(?:(?:열|스물|서른|마흔|쉰)\s?(?:${NATIVE_ONE_ALT})|${NATIVE_ONE_ALT}|스무|스물|서른|마흔|쉰|열)`;
const SINO2 = "(?:[이삼사오육칠팔구]?십[일이삼사오육칠팔구]?)"; // 10~99
const SINO1_ALL = "[일이삼사오육칠팔구]";
const SINO1_SAFE = "[일삼오육칠팔]"; // '이분' · '사분' · '구분'은 낱말이라 홀로 쓰인 분에선 뺌
const PERIOD_RE = "(?<p>오전|오후|아침|저녁|밤|새벽|낮|점심)(?:\\s*때)?(?:\\s*에)?\\s*"; // '점심때 1시' · '아침에 7시'
// 고유어 시 뒤에 붙으면 낱말이 되는 글자 ('두 시험' · '세 시작' · '한시름' …).
// '인 · 대 · 장 · 청'은 뺌 — '7시인데' · '두시인가요' · '8시대' · 받아쓰기형 '7시장소' · '7시청소'를 놓치지 않게.
const NOT_SI = "간|작|험|즌|계|절|켜|킬|켰|키|트|설|합|민|급|각|름|적|바삐";
// 숫자 시 뒤에는 '시간' · '시즌'만 막는다 ('2시험' 같은 낱말은 없음)
const NOT_SI_DIGIT = "간|즌";
const NOT_BUN = "의|기|류|야|석|명|노|해|리|위|홍|식|배|수|들|께|담|량"; // '분의' · '분기' · '분류' · '분담' · '분량' …
// '반' 바로 뒤에 붙으면 낱말이 되는 글자 (반찬 · 반대 · 반납 …) — 받아쓰기형 '7시반알람'은 통과
const AFTER_HALF = "(?!찬|대|드시|납|복|년|영|환|짝|성|려|응|값|팔|바지|죽|항|품|칙|박|숙)";
const BEON_NOUNS = "출구|버스|문제|째|방|칸|게이트|트랙|홀|좌석|자리|줄|승강장|플랫폼|타자|채널|창구|항목|레인|라인|문항|국도|노선|정류장";
// '분' 없이 쓴 두 자리 분('7시 40에' · '7시30')이 다른 단위 숫자가 아님을 보는 뒤 단위
const NOT_MIN_UNIT = "분|초|시|일|월|년|번|회|개|명|층|호|살|원|%|학년|단계|교시|퍼|키로|km|kg|주|달|박|점|기|장|권|쪽|페이지|등|위|강|학기|개월|조|팀|차|동|관|도씨|℃";
const MIN_PART = String.raw`(?:\s*(?<half>반)${AFTER_HALF}|\s*(?<md>\d{1,2})\s*분|\s*(?<ms>${SINO2}|${SINO1_ALL})\s*분|\s*(?<mb>[0-5]\d)(?![\d.:~/-]|\s*(?:${NOT_MIN_UNIT}|[~-]\s*\d)))?`;
// 진행 분수 '1/3단계' · '2/3 완료' · '루틴 1/3' — 날짜(1월 3일)가 아님 (시운전 s-dev-022 · 034)
// 뒤 낱말은 단위 · 완료 말만 ('3/4 개강' · '3/4 진행 예정' · '3/4 끝나요'는 날짜일 수 있어 뺌)
const FRACTION_AFTER = "단계|세트|문항|항목|가지|과목|챕터|회차|개(?![가-힣])|완료|달성|성공";
const FRACTION_BEFORE = "루틴|진행률|진척도|진척|달성률|달성|체크리스트";
// 'N일'이 날 수로만 읽히는 뒤 낱말 — '3일 동안' · '3일 연속' · '3일째' · '3일간' · '7일 중' · '3일 이상'.
// '3일 전 · 후 · 뒤' · '3일만'은 날짜('3일 전에 제출' = 3일 이전)로도 읽혀 여기 넣지 않음 — 지금처럼 구조 숫자(other)
// '2일 있었고' · '3일 남았어요'도 날 수 (날짜면 '9일에 있었던')
// 'N일 정도'는 날짜('9일 정도에')로도 읽혀 CountMention.dateDay를 붙인다
const DAY_COUNT_AFTER = String.raw`(?=째|치|씩|간(?![가-힣])|간[에은는도이을의만]|\s*(?:동안|연속|내내|마다|간격|만에|중(?![가-힣])|중[에엔]|이상|이내|넘게|남짓|가량|정도|째|씩|있었|있어|있고|있는|있던|있으|됐|되었|남았|남은)|\s+간(?![가-힣]))`;
const NATIVE_DAYS: Record<string, number> = { 이틀: 2, 사흘: 3, 나흘: 4, 닷새: 5, 엿새: 6, 열흘: 10 }; // '하루'는 관용어('오늘 하루')라 뺌
const NATIVE_DAY_RANGES: Record<string, [number, number]> = { 하루이틀: [1, 2], 이틀사흘: [2, 3], 사나흘: [3, 4] }; // '하루 이틀' · '사나흘'
const DAY_OFFSET_AFTER = /^\s*(?:전|후|뒤|만(?!\s*에))/u; // '이틀 뒤 · 전 · 후' · '이틀만' (날짜로도 읽힘) — '이틀 만에'는 날 수
// '날이 · 날은 N일' — 앞이 꾸미는 말('늦은 날이 2일' · '짧았던 날은 1일')이면 날 수, 명사('발표 날이 9일' · '그날은 9일')면 날짜
const NAL_BEFORE = /(?:^|[^가-힣])([가-힣]+)\s+날[이은도만]\s*$/u;

const RE = {
  fractionAfter: new RegExp(String.raw`(?<![\d/.:-])(?<n>\d{1,2})\s*\/\s*(?<d>\d{1,2})(?![\d/])(?=\s*(?:${FRACTION_AFTER}))`, "gu"),
  fractionBefore: new RegExp(String.raw`(?<=(?:${FRACTION_BEFORE})\s*(?:은|는|을|를|이|가|도|률|율)?\s*)(?<n>\d{1,2})\s*\/\s*(?<d>\d{1,2})(?![\d/])`, "gu"),
  // '어젯밤 · 지난밤 · 지난 밤 · 어제 밤 · 간밤' — '밤'은 남겨 뒤 시각의 때 표시로 쓴다 ('어젯밤 11시' = 23:00)
  dateNight: new RegExp(String.raw`${B}(?:어젯|어제|지난|간)(?=밤)|${B}(?:어제|지난)(?=\s밤)`, "gu"),
  dayCount: new RegExp(String.raw`(?<![\d.:/~-])(?<!박\s*)(?:(?<rs>\d{1,3})\s*[~-]\s*)?(?<d>\d{1,3})\s*일${DAY_COUNT_AFTER}`, "gu"),
  // '최근 7일' · '요즘 3일' · '7일 중 3일' · '그중 2일'의 '3일'
  dayCountBefore: /(?<=(?:최근|요즘|중|중에|중에서|가운데|일수가|일수는)\s*)(?<![\d.])(?<d>\d{1,3})\s*일(?!\s*차)/gu,
  // '늦은 날이 2일' — 앞 낱말은 NAL_BEFORE로 따로 본다
  dayCountNal: /(?<=날[이은도만]\s*)(?<![\d.])(?<d>\d{1,3})\s*일(?!\s*차)/gu,
  dayNative: new RegExp(String.raw`${B}(?<n>하루\s?이틀|이틀\s?사흘|사나흘|${Object.keys(NATIVE_DAYS).join("|")})`, "gu"),
  dateIso: /(?<!\d)(?<y>\d{4})-(?<m>\d{1,2})-(?<d>\d{1,2})(?!\d)/gu,
  dateMd: new RegExp(String.raw`(?<!\d)(?:(?<y>\d{4})\s*년\s*)?(?<m>\d{1,2})\s*월\s*(?<d>\d{1,2})\s*일(?!차|간|째|동안)`, "gu"),
  // '5/10분' · '1/2번' · '3/2단계'는 날짜가 아님 (길이 목록 · 횟수 · 진행 — 분자 ≤ 분모인 진행은 앞에서 분수로 잡힘)
  dateSlash: /(?<![\d/.:])(?<m>\d{1,2})\/(?<d>\d{1,2})(?![\d/]|\s*(?:분|시간|번|회|개(?![가-힣])|명|초|배|%|퍼센트|등분|조각|씩|단계|세트|문항|항목))/gu,
  dateMonthRel: /(?<mo>다다음\s?달|다음\s?달|담달|이번\s?달)\s*(?<d>\d{1,2})\s*일(?!차|간|째|동안)/gu,
  // '3일 연속' · '3일 내내' · '1박 2일'은 날짜가 아님
  dateDay: /(?<![\d.:/~-])(?<!박\s*)(?<d>\d{1,2})일(?!차|간|째|치|동안|어|할|하|해|했|단|반|정|이상|이내|전|후|뒤|만|씩|\s*(?:연속|내내|마다|간격|짜리)|\s+(?:전|후|뒤|동안|만에|째))/gu,
  dateRel: new RegExp(
    String.raw`(?<k>(?:내일|낼)\s?(?:모레|모래)|모레|오늘|내일|어제|어저께|어젯(?=\s?(?:밤|저녁|새벽|아침))|` +
      String.raw`낼(?=$|[^가-힣\s]|은|도|는|부터|까지|모레|\s*(?:오전|오후|아침|저녁|밤|새벽|낮|점심|몇|\d|열|한|두|세|네|다섯|여섯|일곱|여덟|아홉|일정|약속|수업|스터디|모임|학교|출근|시험|발표|알람|뭐|일찍|늦게|봐|보자|만나)))`,
    "gu",
  ),
  dateWeekday: /(?:(?<w>다다음\s?주|다음\s?다음\s?주|다담주|이번\s?주|금주|담주|다음\s?주|저번\s?주|지난\s?주|다음)\s?)?(?<d>[월화수목금토일])(?:요일|욜)/gu,
  noon: /정오|자정/gu,
  clockColon: new RegExp(String.raw`(?:${PERIOD_RE})?(?<![\d:.])(?<h>\d{1,2}):(?<m>[0-5]\d)(?::[0-5]\d)?(?![\d:])`, "gu"), // 초('08:12:30')는 버림
  clockKo: new RegExp(
    String.raw`(?:${PERIOD_RE})?(?:(?<rs>\d{1,2})\s*[~-]\s*)?(?:(?<![\d.:])(?<hd>\d{1,2})\s*시(?!${NOT_SI_DIGIT})|(?<hn>${NATIVE_HOUR})\s*시(?!${NOT_SI}))${MIN_PART}`,
    "dgu", // d: 범위('7~8시')의 각 시 위치
  ),
  ordinal: new RegExp(String.raw`(?:(?<![\d.])(?<d>\d+)|(?<n>첫|${NATIVE_NUM}))\s*(?:번\s*)?째`, "gu"),
  rangeNative: new RegExp(String.raw`${B}(?<r>한두|두세|서너|너덧|네다섯|대여섯|두어)\s*(?<u>시간|번)`, "gu"),
  durHour: new RegExp(
    String.raw`(?:(?<![\d.])(?<rs>\d+(?:\.\d+)?)\s*[~-]\s*)?(?:(?<![\d.])(?<hd>\d+(?:\.\d+)?)|(?<hn>${NATIVE_NUM})|${B}(?<hs>${SINO2}))\s*시간${MIN_PART}`,
    "gu", // rs: '3~4시간'의 앞쪽
  ),
  durHalfHour: new RegExp(String.raw`${B}반\s?시간`, "gu"),
  durList: new RegExp(String.raw`(?<![\d.])\d+(?:\s*[/,·]\s*\d+)+\s*(?<u>분)(?!${NOT_BUN})`, "gu"),
  durMin: new RegExp(
    String.raw`(?:(?<![\d.])(?<rs>\d+)\s*[~-]\s*)?(?:(?<![\d.])(?<d>\d+)|${B}(?<s>${SINO2}|${SINO1_SAFE}))\s*분(?!${NOT_BUN})`,
    "gu",
  ),
  countDigit: new RegExp(
    String.raw`(?<![\d.])(?<n>\d+)\s*(?<u>번|회)(?!째|지|호|길|방|선|의|차|사|식|장|원|관|역|화|복|전|\s*(?:${BEON_NOUNS}))`,
    "gu",
  ),
  // 횟수는 '번' 뒤를 더 엄하게 보고 앞 글자 제한은 풂 — 받아쓰기형 '알람두번미뤘어' (번갈아 · 번거롭 · 번역 · 번화가는 뺌)
  countNative: new RegExp(
    String.raw`(?<n>${NATIVE_NUM_LOOSE})\s*번(?!째|지|호|길|방|역|갈|거|쩍|뜩|개|복|화|성|식|민|뇌|창|영|져|\s*(?:${BEON_NOUNS}))`,
    "gu",
  ),
  struct: /(?<![\d.])(?<n>\d+(?:\.\d+)?)\s*(?<u>호선|학년|층|단계|교시|호실|호관|호|동|관|차시|주차|차|등|위|강|학기|개월|년|월|일|조|팀|명|개|살|장|권|쪽|페이지|퍼센트|%|번|회|원|km|키로|분|초|주|달|박|점|기)/gu,
  bare: /(?<![\d.])\d+(?:\.\d+)?/gu,
};

const RANGE_NATIVE: Record<string, [number, number]> = {
  한두: [1, 2], 두세: [2, 3], 서너: [3, 4], 너덧: [4, 5], 네다섯: [4, 5], 대여섯: [5, 6], 두어: [2, 2],
};
const WEEKDAY_OF: Record<string, Weekday> = { 월: "MON", 화: "TUE", 수: "WED", 목: "THU", 금: "FRI", 토: "SAT", 일: "SUN" };

/**
 * 때 표시 → 시 (periodHour). 1~12시에만 쓰고, 13시 이상 · 0시 · '07시'는 때 표시와 상관없이 24시간 표기 그대로.
 *   오전 · 새벽 h → h % 12          (오전 12시 = 00:00 · 새벽 12시 = 00:00 · 새벽 5시 = 05:00)
 *   아침 h → h                      (아침 7시 = 07:00)
 *   오후 h → 12면 12, 아니면 h + 12  (오후 12시 30분 = 12:30 · 오후 6시 = 18:00)
 *   낮 h → 12면 12, 1~6이면 h + 12, 7~11이면 h   (낮 12시 20분 = 12:20 · 낮 3시 = 15:00 · 낮 11시 = 11:00)
 *   점심 h → 12면 12, 1~5면 h + 12, 아니면 h     (점심 1시 = 13:00)
 *   저녁 h → 12면 0, 아니면 h + 12   (저녁 6시 = 18:00 · 저녁 12시 = 00:00)
 *   밤 h → 12면 0, 1~4면 h, 아니면 h + 12        (밤 11시 = 23:00 · 밤 12시 30분 = 00:30 · 밤 1시 = 01:00)
 *   정오 = 12:00 · 자정 = 00:00
 * '어젯밤 · 지난밤 · 간밤 · 어제 밤'의 '밤'도 밤으로 읽는다 ('어젯밤 11시' = 23:00, '어젯밤 1시' = 01:00).
 */
function periodHour(h: number, p: PeriodMarker): number {
  switch (p) {
    case "오전":
    case "새벽":
      return h % 12;
    case "아침":
      return h;
    case "오후":
      return h === 12 ? 12 : h + 12;
    case "낮":
      return h === 12 ? 12 : h <= 6 ? h + 12 : h;
    case "점심":
      return h === 12 ? 12 : h <= 5 ? h + 12 : h;
    case "저녁":
      return h === 12 ? 0 : h + 12;
    case "밤":
      return h === 12 ? 0 : h <= 4 ? h : h + 12; // 밤 12시 = 자정, 밤 1시 = 01:00
    default:
      return h;
  }
}

function clockMention(
  base: MentionBase, hour: number, minute: number, period: PeriodMarker | null, zeroPadded: boolean,
): ClockMention | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
  let value: number;
  let candidates: number[];
  let amb = false;
  if (hour === 0 || hour >= 13 || zeroPadded) {
    value = (hour % 24) * 60 + minute;
    candidates = [value];
  } else if (period) {
    value = periodHour(hour, period) * 60 + minute;
    candidates = [value];
  } else {
    amb = true;
    value = hour * 60 + minute; // 쓴 그대로 (12시 = 낮 12시)
    const alt = hour === 12 ? minute : (hour + 12) * 60 + minute;
    candidates = [value, alt];
  }
  return { ...base, kind: "clock", value, hour, minute, period, hour12Ambiguous: amb, candidates, approx: false, relation: null };
}

const SFX_APPROX = /^\s*(?:쯤|즈음|무렵|정도|가량|언저리|남짓|안팎|이상|넘게|이내|내로|안으로|안에|경(?=$|[^가-힣]|[에까부은는이])|께(?=$|[^가-힣]|[에까부]))/u;
const SFX_BEFORE = /^\s*(?:이전|전)(?=$|[^가-힣]|[에까은는도부으엔])/u;
const SFX_AFTER = /^\s*(?:이후|후|뒤|넘어서|넘어|넘|지나서|지나)(?=$|[^가-힣]|[에까은는도부으엔서])/u;
const SFX_UNTIL = /^\s*까지/u;
const SFX_FROM = /^\s*부터/u;
const SFX_PARTICLE = /^\s*(?:만큼|만|이나|이|은|는|도|씩)/u;
const MOD_RES: [DurationModifier, RegExp][] = [
  ["more", /^\s*(?:더(?![라니군욱])|늘려|늘리|늘릴|추가)/u],
  ["less", /^\s*(?:덜|줄여|줄이|줄일|빼)/u],
  ["earlier", /^\s*(?:일찍|빨리|먼저|앞당|당겨|당기)/u],
  ["later", /^\s*(?:늦게|늦춰|늦추|늦어|늦었|늦|미뤄|미루|미룰|뒤로)/u],
  ["before", SFX_BEFORE],
  ["after", /^\s*(?:이후|후|뒤|있다가|있다|이따가|이따)(?=$|[^가-힣]|[에까은는도부으엔서])/u],
];

function scanClockSuffix(
  s: string, pos: number,
): { end: number; approx: boolean; relation: ClockRelation | null; bareJeon: boolean } {
  let end = pos;
  let approx = false;
  let relation: ClockRelation | null = null;
  let bareJeon = false; // '이전'이 아닌 '전' — '8시 10분 전'(= 7:50)으로도 읽힘
  for (let k = 0; k < 3; k++) {
    const rest = s.slice(end);
    let m: RegExpExecArray | null;
    if (!approx && (m = SFX_APPROX.exec(rest))) { approx = true; end += m[0].length; continue; }
    if (relation) break;
    if ((m = SFX_BEFORE.exec(rest))) { relation = "before"; bareJeon = m[0].trim() === "전"; }
    else if ((m = SFX_AFTER.exec(rest))) relation = "after";
    else if ((m = SFX_UNTIL.exec(rest))) relation = "until";
    else if ((m = SFX_FROM.exec(rest))) relation = "from";
    if (!m) break;
    end += m[0].length;
  }
  return { end, approx, relation, bareJeon };
}

function scanDurationSuffix(s: string, pos: number): { end: number; approx: boolean; modifier: DurationModifier | null } {
  let end = pos;
  let approx = false;
  let modifier: DurationModifier | null = null;
  for (let k = 0; k < 3; k++) {
    const rest = s.slice(end);
    let m: RegExpExecArray | null;
    if (!approx && (m = SFX_APPROX.exec(rest))) { approx = true; end += m[0].length; continue; }
    if (modifier) break;
    // 조사는 뒤에 방향 낱말이 올 때만 먹는다 ('20분만 더' · '20분이 더')
    const p = SFX_PARTICLE.exec(rest);
    const off = p ? p[0].length : 0;
    let hit: [DurationModifier, number] | null = null;
    for (const tryOff of p ? [0, off] : [0]) {
      for (const [mod, re] of MOD_RES) {
        const mm = re.exec(rest.slice(tryOff));
        if (mm) { hit = [mod, tryOff + mm[0].length]; break; }
      }
      if (hit) break;
    }
    if (!hit) break;
    modifier = hit[0];
    end += hit[1];
    // '10분 더 일찍' · '10분 더 늦게'는 방향이 먼저 — '더'는 강조일 뿐
    if (modifier === "more") {
      const after = s.slice(end);
      for (const [mod, re] of MOD_RES) {
        if (mod !== "earlier" && mod !== "later") continue;
        const mm = re.exec(after);
        if (mm) { modifier = mod; end += mm[0].length; break; }
      }
    }
  }
  return { end, approx, modifier };
}

function approxPrefix(s: string, start: number): boolean {
  return /(?:^|[^가-힣])(?:한|약|대략|대충|거의)\s*$/u.test(s.slice(Math.max(0, start - 4), start));
}

function numOf(g: string | undefined): number | null {
  return g === undefined ? null : parseKoreanNumber(g);
}

/** MIN_PART가 잡은 분. 없으면 0, 못 읽으면 bad */
function minuteOf(g: Record<string, string | undefined>, bad: number): number {
  if (g.half) return 30;
  if (g.md !== undefined) return Number(g.md);
  if (g.ms !== undefined) return numOf(g.ms) ?? bad;
  if (g.mb !== undefined) return Number(g.mb); // '7시 40에'
  return 0;
}

/** '나두(나도) 시간 없어'의 '두'는 숫자가 아님 */
function isNaduSlang(s: string, st: number, hn: string | undefined): boolean {
  return hn !== undefined && hn.startsWith("두") && /(?:^|[^가-힣])나$/u.test(s.slice(Math.max(0, st - 2), st));
}

// 동사 '두다'의 높임 '두시-' ('시간을 더 두시는 게' · '그대로 두시면' · '켜 두시고') — 2시가 아님 (시운전 s-dev-022)
// 뒤 꼴만으로 동사인 것: '두시는 게 · 거 · 데 · 대로' · '두시길' · '두시려' · '두시도록' … (시각 + 이다로는 안 나오는 꼴)
const DU_VERB_STRONG = /^(?:는\s*(?:게(?!임)|거(?!리|울|의)|걸(?!음)|건(?!강|물|너)|것|데(?!이)|대로|편(?!의|지)|동안|만큼)|는지|길|기(?:로|를|에|만|도|는|가)|려|도록)/u;
// 시각 + 이다 준말로도 읽히는 꼴('두시면 돼요' · '두시니까' · '두시잖아요' · '두시라고 했죠' · '두시던데' · '두시겠네요') —
// 앞이 보조 동사 자리일 때만 동사 (검수 10/9: '약속이 두시니까 한 시에 출발해요'의 2시를 놓쳤음)
const DU_VERB_WEAK = /^(?:는|면|고|죠|지|니|라|잖|던|겠)/u;
// 끝이 ㅏ · ㅓ 모음이어도 '-아/어'가 아니라 조사인 낱말 끝 ('회의가 두시면' · '한시나 두시면' · '친구와 두시' · '학교에서 두시면')
const DU_PARTICLE_END = /[가나와서]$/u;
const DU_ADVERB = /^(?:그대로|그냥|따로|미리|계속|일단|좀|잠깐|넉넉히|넉넉하게|여유있게|조금|더)$/u;
const DU_NOT_AUX = new Set(["이따", "아까", "나", "너", "저", "내가", "제가", "벌써", "아마", "먼저"]); // '벌써 두시겠네요' · '아마 두시죠'
const AUX_SINGLE = new Set(["켜", "꺼", "써", "해", "놔", "둬", "줘", "봐", "떠", "펴", "재", "깨"]);

/** 앞 낱말이 '-아/어'(맞춰 · 적어 · 켜) · 목적어(을/를) · 부사(그대로 · 그냥)라 뒤 '두시-'가 동사 자리인지 */
function auxContext(w: string): boolean {
  if (DU_ADVERB.test(w)) return true;
  if (DU_NOT_AUX.has(w)) return false;
  if (w.length >= 2 && /[을를]$/u.test(w)) return true;
  if (w.length === 1) return AUX_SINGLE.has(w);
  if (DU_PARTICLE_END.test(w)) return false;
  const c = w.charCodeAt(w.length - 1) - 0xac00;
  if (c < 0 || c >= 11172 || c % 28 !== 0) return false; // 받침 없음
  const vowel = Math.floor(c / 28) % 21;
  return [0, 1, 4, 6, 9, 10, 14].includes(vowel); // ㅏ ㅐ ㅓ ㅕ ㅘ ㅙ ㅝ — 맞춰 · 적어 · 해 · 돼 · 놔
}

/** '두시'(분 없이, 때 표시 없이) 뒤가 동사 어미면 true. tail = '시' 바로 뒤부터 */
function duVerb(s: string, hourStart: number, tailStart: number): boolean {
  const tail = s.slice(tailStart, tailStart + 12);
  if (DU_VERB_STRONG.test(tail)) return true;
  if (!DU_VERB_WEAK.test(tail)) return false;
  const m = /([가-힣]+)\s*$/u.exec(s.slice(Math.max(0, hourStart - 12), hourStart));
  return m !== null && auxContext(m[1].replace(/\s/gu, ""));
}

/**
 * 글에서 시각 · 길이 · 횟수 · 날짜를 찾는다. 겹치면 먼저 잡힌 쪽(진행 분수 → 날짜 · 날 수 → 시각 → 서수 → 길이 → 횟수 → 기타)이 이긴다.
 * '1번 출구' · '2호선' · '3학년' · '5층' · '첫 번째' · '1단계' 같은 구조 숫자와 진행 분수 '1/3단계'는 kind 'other'.
 * '3일 동안' · '3일 연속' · '최근 7일 중 3일' · '이틀'은 날 수(count, unit 'days'), '어젯밤 · 지난밤 · 간밤'은 날짜 last_night.
 * '시간을 더 두시는 게' · '그대로 두시면'의 '두시'(동사 두다)는 시각이 아님.
 */
export function findTimeMentions(text: string): TimeMention[] {
  const s = prep(text);
  const taken = new Uint8Array(s.length);
  const out: TimeMention[] = [];
  const free = (a: number, b: number): boolean => {
    for (let i = a; i < b; i++) if (taken[i]) return false;
    return b > a;
  };
  const claim = (m: TimeMention): void => {
    taken.fill(1, m.start, m.end);
    out.push(m);
  };
  const base = (start: number, end: number): MentionBase => ({ raw: s.slice(start, end), start, end });

  // 0) 진행 분수 ('루틴 1/3단계') — 날짜보다 먼저 (분자 ≤ 분모일 때만)
  for (const re of [RE.fractionAfter, RE.fractionBefore]) {
    for (const m of s.matchAll(re)) {
      const st = m.index;
      const en = st + m[0].length;
      const n = Number(m.groups!.n);
      const d = Number(m.groups!.d);
      if (!free(st, en) || d < 1 || n > d) continue;
      claim({ ...base(st, en), kind: "other", value: n, unit: "분수", denominator: d });
    }
  }

  // 1) 날짜
  for (const m of s.matchAll(RE.dateIso)) {
    const g = m.groups!;
    const st = m.index;
    const en = st + m[0].length;
    if (!free(st, en) || makeDate(Number(g.y), Number(g.m), Number(g.d)) === null) continue;
    claim({ ...base(st, en), kind: "date", value: { type: "absolute", year: Number(g.y), month: Number(g.m), day: Number(g.d) } });
  }
  for (const re of [RE.dateMd, RE.dateSlash]) {
    for (const m of s.matchAll(re)) {
      const g = m.groups!;
      const st = m.index;
      const en = st + m[0].length;
      const mo = Number(g.m);
      const da = Number(g.d);
      if (!free(st, en) || mo < 1 || mo > 12 || da < 1 || da > 31) continue;
      claim({ ...base(st, en), kind: "date", value: { type: "absolute", year: g.y ? Number(g.y) : null, month: mo, day: da } });
    }
  }
  for (const m of s.matchAll(RE.dateNight)) {
    const st = m.index;
    const en = st + m[0].length;
    if (!free(st, en)) continue;
    claim({ ...base(st, en), kind: "date", value: { type: "relative", key: "last_night" } });
  }
  for (const m of s.matchAll(RE.dateRel)) {
    const st = m.index;
    const en = st + m[0].length;
    if (!free(st, en)) continue;
    const k = m.groups!.k.replace(/\s/gu, "");
    const key: RelativeDateKey =
      /모레|모래/u.test(k) ? "day_after" : k === "오늘" ? "today" : k === "내일" || k === "낼" ? "tomorrow" : "yesterday";
    claim({ ...base(st, en), kind: "date", value: { type: "relative", key } });
  }
  for (const m of s.matchAll(RE.dateWeekday)) {
    const st = m.index;
    const en = st + m[0].length;
    if (!free(st, en)) continue;
    const w = (m.groups!.w ?? "").replace(/\s/gu, "");
    const week: WeekRef =
      w === "" || w === "이번주" || w === "금주" ? "this"
        : w === "다다음주" || w === "다음다음주" || w === "다담주" ? "after_next"
        : w === "저번주" || w === "지난주" ? "last"
        : "next";
    const explicit = w !== "" && w !== "다음";
    claim({ ...base(st, en), kind: "date", value: { type: "weekday", week, weekday: WEEKDAY_OF[m.groups!.d], explicit } });
  }
  for (const m of s.matchAll(RE.dateMonthRel)) {
    const st = m.index;
    const en = st + m[0].length;
    const da = Number(m.groups!.d);
    if (!free(st, en) || da < 1 || da > 31) continue;
    const mo = m.groups!.mo.replace(/\s/gu, "");
    const monthOffset = mo === "이번달" ? 0 : mo === "다다음달" ? 2 : 1;
    claim({ ...base(st, en), kind: "date", value: { type: "absolute", year: null, month: null, day: da, monthOffset } });
  }
  // 날 수 ('3일 동안' · '3일 연속' · '최근 7일 중 3일' · '이틀') — 월이 붙은 날짜 뒤, 일만 쓴 날짜('9일') 앞.
  // raw는 숫자 + '일'까지만 ('5일 동안' → '5일')
  for (const re of [RE.dayCount, RE.dayCountBefore, RE.dayCountNal]) {
    for (const m of s.matchAll(re)) {
      const g = m.groups!;
      const st = m.index;
      const en = st + m[0].length;
      if (!free(st, en)) continue;
      const v = Number(g.d);
      // '날이 N일'은 앞이 꾸미는 말일 때만 날 수 — '발표 날이 9일' · '그날은 9일'은 날짜로 남김
      let both = false; // 날짜로도 읽힘 ('발표하는 날이 9일' · '9일 정도에')
      if (re === RE.dayCountNal) {
        const w = NAL_BEFORE.exec(s.slice(0, st))?.[1] ?? "";
        const last = w[w.length - 1];
        if (!(last === "던" || jong(last) === J_N || jong(last) === J_L)) continue;
        both = true;
      } else if (/^\s*정도/u.test(s.slice(en))) both = true;
      const lo = g.rs !== undefined ? Number(g.rs) : null;
      const range: [number, number] | null = lo === null ? null : [Math.min(lo, v), Math.max(lo, v)];
      const c: CountMention = { ...base(st, en), kind: "count", value: range ? range[0] : v, range, native: false, unit: "days" };
      if (both && !range && v >= 1 && v <= 31) c.dateDay = v;
      claim(c);
    }
  }
  for (const m of s.matchAll(RE.dayNative)) {
    const st = m.index;
    const en = st + m[0].length;
    if (!free(st, en)) continue;
    const k = m.groups!.n.replace(/\s/gu, "");
    const range = NATIVE_DAY_RANGES[k] ?? null;
    const v = range ? range[0] : NATIVE_DAYS[k];
    // '이틀 뒤 · 전 · 후 · 만'은 '3일 뒤'처럼 날짜로도 읽혀 검사하지 않는 구조 숫자 (검수 10/9 — 숫자로 쓴 '3일 뒤'와 맞춤)
    if (DAY_OFFSET_AFTER.test(s.slice(en))) { claim({ ...base(st, en), kind: "other", value: v, unit: "일" }); continue; }
    claim({ ...base(st, en), kind: "count", value: v, range, native: true, unit: "days" });
  }
  for (const m of s.matchAll(RE.dateDay)) {
    const st = m.index;
    const en = st + m[0].length;
    const da = Number(m.groups!.d);
    if (!free(st, en) || da < 1 || da > 31) continue;
    claim({ ...base(st, en), kind: "date", value: { type: "absolute", year: null, month: null, day: da } });
  }

  // 2) 시각
  for (const m of s.matchAll(RE.noon)) {
    const st = m.index;
    if (!free(st, st + 2)) continue;
    const sfx = scanClockSuffix(s, st + 2);
    const v = m[0] === "정오" ? 720 : 0;
    const c = clockMention(base(st, sfx.end), m[0] === "정오" ? 12 : 0, 0, m[0] as PeriodMarker, false)!;
    claim({ ...c, value: v, candidates: [v], approx: sfx.approx, relation: sfx.relation });
  }
  for (const m of s.matchAll(RE.clockColon)) {
    const g = m.groups!;
    const st = m.index;
    const sfx = scanClockSuffix(s, st + m[0].length);
    if (!free(st, sfx.end)) continue;
    const c = clockMention(base(st, sfx.end), Number(g.h), Number(g.m), (g.p as PeriodMarker) ?? null, g.h.length === 2 && g.h.startsWith("0"));
    if (c) claim({ ...c, approx: sfx.approx || approxPrefix(s, st), relation: sfx.relation });
  }
  for (const m of s.matchAll(RE.clockKo)) {
    const g = m.groups!;
    const st = m.index;
    const sfx = scanClockSuffix(s, st + m[0].length);
    if (!free(st, sfx.end)) continue;
    const hour = g.hd !== undefined ? Number(g.hd) : numOf(g.hn);
    if (hour === null || (g.hn !== undefined && hour > 12)) continue;
    // 관용어 '한 시도 못 쉬었어' · '한시라도 빨리'
    if (g.hn === "한" && /^\s*(?:도\s*(?:\S+\s*){0,2}(?:못|안|않|없)|라도|가\s*급)/u.test(s.slice(st + m[0].length))) continue;
    if (isNaduSlang(s, st, g.hn)) continue;
    const minuteGiven = g.half !== undefined || g.md !== undefined || g.ms !== undefined || g.mb !== undefined;
    if (g.hn === "두" && !g.p && g.rs === undefined && !minuteGiven && duVerb(s, st, st + m[0].length)) continue;
    const minute = minuteOf(g, -1);
    const period = (g.p as PeriodMarker | undefined) ?? null;
    const padded = g.hd !== undefined && g.hd.length === 2 && g.hd.startsWith("0"); // '07시' = 24시간 표기
    const approx = sfx.approx || approxPrefix(s, st);
    if (g.rs !== undefined) {
      // '7~8시' — 앞쪽 시도 같은 때 표시로 따로 낸다
      const ig = m.indices!.groups!;
      const rsSpan = ig.rs!;
      const hourStart = (ig.hd ?? ig.hn)![0];
      const first = clockMention(base(g.p ? st : rsSpan[0], rsSpan[1]), Number(g.rs), 0, period, false);
      const second = clockMention(base(hourStart, sfx.end), hour, minute, period, false);
      if (first && second) {
        claim({ ...first, approx });
        claim({ ...second, approx, relation: sfx.relation });
        taken.fill(1, st, sfx.end);
      }
      continue;
    }
    const c = clockMention(base(st, sfx.end), hour, minute, period, padded);
    if (!c) continue;
    let candidates = c.candidates;
    // '8시 10분 전'은 '8:10보다 앞'과 '7:50' 둘 다로 읽힘 — 분을 '분'까지 말했고 '이전'이 아닌 '전'일 때만
    if (sfx.relation === "before" && sfx.bareJeon && (g.md !== undefined || g.ms !== undefined) && minute >= 1 && minute <= 30) {
      const minus = candidates.map((v) => (((v - 2 * minute) % 1440) + 1440) % 1440);
      candidates = [...candidates, ...minus.filter((v) => !candidates.includes(v))];
    }
    claim({ ...c, candidates, approx, relation: sfx.relation });
  }

  // 3) 서수 ('첫 번째' · '두 번째' · '둘째') — 횟수로 세지 않음
  for (const m of s.matchAll(RE.ordinal)) {
    const st = m.index;
    const en = st + m[0].length;
    if (!free(st, en)) continue;
    const g = m.groups!;
    const v = g.d !== undefined ? Number(g.d) : g.n === "첫" ? 1 : numOf(g.n);
    claim({ ...base(st, en), kind: "other", value: v, unit: "번째" });
  }

  // 4) 길이 · 횟수 범위 ('한두 시간' · '두세 번')
  for (const m of s.matchAll(RE.rangeNative)) {
    const st = m.index;
    const g = m.groups!;
    const [lo, hi] = RANGE_NATIVE[g.r];
    if (g.u === "시간") {
      const sfx = scanDurationSuffix(s, st + m[0].length);
      if (!free(st, sfx.end)) continue;
      claim({ ...base(st, sfx.end), kind: "duration", value: lo * 60, range: lo === hi ? null : [lo * 60, hi * 60], approx: true, modifier: sfx.modifier });
    } else {
      const en = st + m[0].length;
      if (!free(st, en)) continue;
      claim({ ...base(st, en), kind: "count", value: lo, range: lo === hi ? null : [lo, hi], native: true, unit: "times" });
    }
  }

  // 5) 길이
  for (const m of s.matchAll(RE.durHour)) {
    const g = m.groups!;
    const st = m.index;
    const sfx = scanDurationSuffix(s, st + m[0].length);
    if (!free(st, sfx.end)) continue;
    const h = g.hd !== undefined ? Number(g.hd) : numOf(g.hn ?? g.hs);
    if (h === null) continue;
    // 문장 첫 '네 시간 괜찮아요'의 '네'는 대답
    if (g.hn === "네" && /(?:^|[.!?\n]\s*)$/u.test(s.slice(0, st)) && /^\s*시간\s*(?:은|이|도)?\s*(?:괜찮|돼|되|있|없|맞|충분)/u.test(s.slice(st + 1))) continue;
    if (isNaduSlang(s, st, g.hn)) continue;
    const v = Math.round(h * 60 + minuteOf(g, 0));
    // '3~4시간' — 범위 앞쪽은 시간만
    const lo = g.rs !== undefined ? Math.round(Number(g.rs) * 60) : null;
    const range: [number, number] | null = lo === null ? null : [Math.min(lo, v), Math.max(lo, v)];
    claim({
      ...base(st, sfx.end), kind: "duration", value: range ? range[0] : v, range,
      approx: sfx.approx || approxPrefix(s, st) || range !== null, modifier: sfx.modifier,
    });
  }
  for (const m of s.matchAll(RE.durHalfHour)) {
    const st = m.index;
    const sfx = scanDurationSuffix(s, st + m[0].length);
    if (!free(st, sfx.end)) continue;
    claim({ ...base(st, sfx.end), kind: "duration", value: 30, range: null, approx: sfx.approx, modifier: sfx.modifier });
  }
  for (const m of s.matchAll(RE.durList)) {
    // '5/10/15분' · '5, 10, 15분' — 각 숫자를 길이로
    const st = m.index;
    const en = st + m[0].length;
    if (!free(st, en)) continue;
    for (const n of m[0].matchAll(/\d+/gu)) {
      const a = st + n.index;
      const last = a + n[0].length === en - m.groups!.u.length;
      const b = last ? en : a + n[0].length;
      claim({ ...base(a, b), kind: "duration", value: Number(n[0]), range: null, approx: false, modifier: null });
    }
    taken.fill(1, st, en);
  }
  for (const m of s.matchAll(RE.durMin)) {
    const g = m.groups!;
    const st = m.index;
    const sfx = scanDurationSuffix(s, st + m[0].length);
    if (!free(st, sfx.end)) continue;
    const v = g.d !== undefined ? Number(g.d) : numOf(g.s);
    if (v === null) continue;
    const lo = g.rs !== undefined ? Number(g.rs) : null;
    claim({
      ...base(st, sfx.end), kind: "duration", value: lo ?? v, range: lo === null ? null : [lo, v],
      approx: sfx.approx || approxPrefix(s, st) || lo !== null, modifier: sfx.modifier,
    });
  }

  // 6) 횟수
  for (const m of s.matchAll(RE.countDigit)) {
    const st = m.index;
    const en = st + m[0].length;
    if (!free(st, en)) continue;
    claim({ ...base(st, en), kind: "count", value: Number(m.groups!.n), range: null, native: false, unit: "times" });
  }
  for (const m of s.matchAll(RE.countNative)) {
    const st = m.index;
    const en = st + m[0].length;
    const v = numOf(m.groups!.n);
    if (!free(st, en) || v === null) continue;
    claim({ ...base(st, en), kind: "count", value: v, range: null, native: true, unit: "times" });
  }

  // 7) 그 밖의 숫자 (구조 숫자 · 단위 없는 숫자)
  for (const m of s.matchAll(RE.struct)) {
    const st = m.index;
    const en = st + m[0].length;
    if (!free(st, en)) continue;
    claim({ ...base(st, en), kind: "other", value: Number(m.groups!.n), unit: m.groups!.u });
  }
  for (const m of s.matchAll(RE.bare)) {
    const st = m.index;
    const en = st + m[0].length;
    if (!free(st, en)) continue;
    claim({ ...base(st, en), kind: "other", value: Number(m[0]), unit: "" });
  }

  return out.sort((a, b) => a.start - b.start);
}

// ───────── 12시간 모호성 풀기 ─────────

/** 약속 시각에서 흔히 오후로 읽는 시 — 기본값이 아니라 옵션으로만 쓴다 */
export const APPOINTMENT_PM_HOURS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

export interface ResolveClockOptions {
  /** 때 표시 없는 1~12시를 읽는 법. 없으면 쓴 그대로(1~11 = 오전, 12 = 낮 12시). AM이면 12시 = 00:00 */
  defaultPeriod?: "AM" | "PM" | "AUTO";
  /** AUTO일 때 오후로 읽을 시 (기본 APPOINTMENT_PM_HOURS) */
  pmHours?: readonly number[];
  /** 기준 시각(분). 주면 그 뒤로 가장 먼저 오는 해석을 고른다 — defaultPeriod보다 우선 */
  after?: number;
}

export interface ResolvedClock {
  minutes: number;
  hhmm: LocalTime;
  ambiguous: boolean; // 원래 모호했는지 (옵션으로 풀었어도 true)
  by: "explicit" | "after" | "option" | "literal";
}

export function resolveClock(mention: ClockMention, opts: ResolveClockOptions = {}): ResolvedClock {
  const done = (minutes: number, by: ResolvedClock["by"]): ResolvedClock => ({
    minutes, hhmm: clockToHHMM(minutes), ambiguous: mention.hour12Ambiguous, by,
  });
  if (!mention.hour12Ambiguous) return done(mention.value, "explicit");
  const h = mention.hour % 12;
  const am = h * 60 + mention.minute;
  const pm = (h + 12) * 60 + mention.minute;
  if (opts.after !== undefined) {
    const fwd = (c: number): number => (((c - opts.after!) % 1440) + 1440) % 1440;
    return done(fwd(am) <= fwd(pm) ? am : pm, "after");
  }
  if (opts.defaultPeriod === "AM") return done(am, "option");
  if (opts.defaultPeriod === "PM") return done(pm, "option");
  if (opts.defaultPeriod === "AUTO") {
    const pmHours = opts.pmHours ?? APPOINTMENT_PM_HOURS;
    return pmHours.includes(mention.hour) ? done(pm, "option") : done(mention.value, "literal");
  }
  return done(mention.value, "literal");
}

// ───────── 날짜 풀기 ─────────

export interface ResolvedDate {
  date: LocalDate | null; // 못 풀면 null (없는 날짜 등)
  ambiguous: boolean;
  alternative: LocalDate | null; // 모호할 때 다른 해석
  reason?: string;
}

/** 요일 언급 풀기 — today · 이번 주 · 다음 주 표를 받아서 (새벽엔 달력 기준 표로 한 번 더 부른다) */
function weekdayDate(
  v: Extract<DateValue, { type: "weekday" }>, today: LocalDate,
  thisWeek: Record<Weekday, LocalDate>, nextWeek: Record<Weekday, LocalDate>,
): ResolvedDate {
  const thisW = thisWeek[v.weekday];
  const nextW = nextWeek[v.weekday];
  if (v.week === "last") return { date: addDays(thisW, -7), ambiguous: false, alternative: null };
  if (v.week === "after_next") return { date: addDays(nextW, 7), ambiguous: false, alternative: null };
  if (v.week === "this") {
    if (!v.explicit && thisW < today) {
      return { date: nextW, ambiguous: true, alternative: thisW, reason: "요일만 말함 — 이번 주 그 요일은 지나서 다음 주로 봄" };
    }
    return { date: thisW, ambiguous: false, alternative: null };
  }
  if (!v.explicit && thisW > today) {
    return { date: nextW, ambiguous: true, alternative: thisW, reason: "'다음 X요일' — 이번 주 X요일일 수도 있음" };
  }
  return { date: nextW, ambiguous: false, alternative: null };
}

/** 달력 오늘이 대화 기준일보다 며칠 뒤인지 (안 주면 0 · 앞서면 0으로 봄) */
function calendarShift(today: LocalDate, calendarToday: LocalDate | undefined): number {
  if (calendarToday === undefined) return 0;
  const a = parseLocalDate(today);
  const b = parseLocalDate(calendarToday);
  if (a === null || b === null) return 0;
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

/**
 * 날짜 언급을 컨텍스트 날짜표(대화 기준일 = dates.today 기준)로 푼다.
 * 자정이 지났지만 아직 안 잔 대화(달력 오늘 calendarToday ≠ dates.today, 설계 메모 4.1)에서 말한 '오늘' · '내일' · '모레' · '어제'는
 * 달력 날짜로 뜻했을 수 있어 ambiguous (다른 해석 = 달력과 기준일의 차이만큼 뒤). calendarToday를 안 주면 어긋남이 없다고 본다.
 * 요일만 말했는데 이번 주 그 요일이 지났으면 다음 주로 보고 ambiguous. 일만 말했는데 이번 달 그 날이 지났으면 다음 달.
 * 자정 뒤에 말한 요일은 달력 날짜 기준으로도 풀어 다르면 ambiguous (일 → 월 자정의 '이번 주' · '다음 주' 포함).
 * '다음 달 15일'은 그 달로, 월 · 일만 말한 날짜는 반년 넘게 지났으면 내년(2/29는 윤년)으로 본다.
 */
export function resolveRelativeDate(
  mention: DateMention | DateValue, ctxDates: Context["dates"], calendarToday?: LocalDate,
): ResolvedDate {
  const v: DateValue = "kind" in mention ? mention.value : mention;
  const today = ctxDates.today;
  if (v.type === "relative") {
    const date =
      v.key === "today" ? today : v.key === "tomorrow" ? ctxDates.tomorrow : v.key === "day_after" ? ctxDates.day_after : addDays(today, -1);
    const shift = calendarShift(today, calendarToday);
    if (shift !== 0) {
      return {
        date, ambiguous: true, alternative: addDays(date, shift),
        reason: "자정이 지난 뒤 말한 상대 날짜 — 달력 날짜로 뜻했을 수 있음 (대화 기준일 ≠ 달력 오늘)",
      };
    }
    return { date, ambiguous: false, alternative: null };
  }
  if (v.type === "weekday") {
    const r = weekdayDate(v, today, ctxDates.this_week, ctxDates.next_week);
    const shift = calendarShift(today, calendarToday);
    if (shift === 0) return r;
    // 자정 뒤: 달력 날짜(calendarToday) 기준으로도 풀어 보고 다르면 모호. 일 → 월 자정이면 '이번 주'도 바뀜.
    const cal = addDays(today, shift);
    const crosses = cal === ctxDates.next_week.MON;
    const shifted = (w: Record<Weekday, LocalDate>): Record<Weekday, LocalDate> => {
      const o = { ...w };
      for (const k of Object.keys(o) as Weekday[]) o[k] = addDays(o[k], 7);
      return o;
    };
    const c = crosses
      ? weekdayDate(v, cal, ctxDates.next_week, shifted(ctxDates.next_week))
      : weekdayDate(v, cal, ctxDates.this_week, ctxDates.next_week);
    if (c.date === r.date) return r;
    return {
      date: r.date, ambiguous: true, alternative: c.date,
      reason: "자정이 지난 뒤 말한 요일 — 달력 날짜 기준이면 다른 날 (대화 기준일 ≠ 달력 오늘)",
    };
  }
  const ty = Number(today.slice(0, 4));
  const tm = Number(today.slice(5, 7));
  if (v.year !== null && v.month !== null) {
    const d = makeDate(v.year, v.month, v.day);
    return d ? { date: d, ambiguous: false, alternative: null } : { date: null, ambiguous: false, alternative: null, reason: "없는 날짜" };
  }
  if (v.month !== null) {
    // 반년 넘게 지났거나 올해엔 없는 날(2/29)이면 다음 해들에서 찾는다 (12월에 '1월 3일' · 2027년에 '2월 29일')
    const floor = addDays(today, -180);
    for (let y = ty; y <= ty + 4; y++) {
      const d = makeDate(y, v.month, v.day);
      if (d && d >= floor) return { date: d, ambiguous: false, alternative: null };
    }
    return { date: null, ambiguous: false, alternative: null, reason: "없는 날짜" };
  }
  if (v.day < 1 || v.day > 31) return { date: null, ambiguous: false, alternative: null, reason: "없는 날짜" };
  if (v.monthOffset !== undefined) {
    // '다음 달 15일' — 달을 말했으니 지났어도 넘기지 않음
    const k = tm - 1 + v.monthOffset;
    const d = makeDate(ty + Math.floor(k / 12), (k % 12) + 1, v.day);
    return d ? { date: d, ambiguous: false, alternative: null } : { date: null, ambiguous: false, alternative: null, reason: "없는 날짜" };
  }
  const thisMonth = makeDate(ty, tm, v.day);
  if (thisMonth && thisMonth >= today) return { date: thisMonth, ambiguous: false, alternative: null };
  // 지났거나 이번 달엔 없는 날 → 그 날이 있는 다음 달 (1/31에 '30일' → 3/30)
  let next: LocalDate | null = null;
  for (let k = 1; k <= 3 && !next; k++) {
    const mo = ((tm - 1 + k) % 12) + 1;
    next = makeDate(ty + Math.floor((tm - 1 + k) / 12), mo, v.day);
  }
  return {
    date: next, ambiguous: true, alternative: thisMonth,
    reason: thisMonth ? "월 없이 일만 말함 — 이번 달 그 날은 지나서 다음 달로 봄" : "이번 달엔 없는 날 — 그 날이 있는 다음 달로 봄",
  };
}

// ───────── 문장 나누기 · 말투 ─────────

export type SentenceStyle = "haeyo" | "hapsyo" | "banmal" | "unknown";

const TERM = /^[.?!…。~]$/u;
const CONTENT = /[가-힣A-Za-z0-9]/u;
const LAUGH_OR_EMOJI = /^(?:[ㄱ-ㅎㅏ-ㅣ^]|\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|[\u{1F3FB}-\u{1F3FF}])$/u;
const TAIL = /^(?:[ㄱ-ㅎㅏ-ㅣ^;'"”’」』)\]>*]|\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|[\u{1F3FB}-\u{1F3FF}])$/u;
const TRAIL_RE = /(?:[\s.?!…。~,'"”’」』^;:)\]>*\-–—ㄱ-ㅎㅏ-ㅣ]|\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|[\u{1F3FB}-\u{1F3FF}])+$/u;
// 띄어쓰기만 있고 문장부호가 없는 글(받아쓰기형)에서 문장 끝으로 볼 존댓말 어미
const POLITE_FINAL = /(?:[어아에예세네지까나가래데고구걸군게해워봐줘돼와셔여려쳐져니]요|죠)$/u;

const J_N = 4; // ㄴ 받침
const J_L = 8; // ㄹ 받침
const J_B = 17; // ㅂ 받침
function jong(ch: string | undefined): number {
  if (!ch) return -1;
  const c = ch.charCodeAt(0) - 0xac00;
  return c >= 0 && c < 11172 ? c % 28 : -1;
}

/** 문장 끝 낱말(한글 부분만). 끝의 문장부호 · 이모지 · ㅋㅋ · 괄호 묶음은 뺀다. */
/** 문장 끝 토큰(공백 기준). 끝의 문장부호 · 이모지 · ㅋㅋ · 괄호 묶음은 뺀다. */
function lastToken(sentence: string): string {
  let t = prep(sentence).trim();
  for (let k = 0; k < 6; k++) {
    const before = t;
    t = t.replace(/\s*[([][^()[\]]*[)\]]\s*$/u, "").replace(TRAIL_RE, "");
    if (t === before) break;
  }
  const words = t.split(/\s+/u);
  return words[words.length - 1] ?? "";
}

function lastWord(sentence: string): string {
  const m = /[가-힣]+$/u.exec(lastToken(sentence));
  return m ? m[0] : "";
}

function isHapsyoWord(w: string): boolean {
  if (/(?:십시오|시오|읍시다|슴다|슴까|십쇼)$/u.test(w)) return true; // 알겠슴다 · 주십쇼
  const m = /(?:니다|니까|시다|니당|니닷)$/u.exec(w); // 감사합니당
  return m !== null && jong(w[m.index - 1]) === J_B; // 합니다 · 갑니까 · 있습니다 · 합시다
}

/** 받아쓰기형에서 공백 앞 낱말이 문장을 끝내는지 */
function endsWithPoliteFinal(buf: string): boolean {
  const t = buf.slice(-64).trimEnd(); // 끝 낱말만 보면 됨 — 버퍼 전체를 매번 훑으면 긴 받아쓰기 글에서 제곱 시간
  if (t === "" || /[^가-힣]$/u.test(t)) return false;
  const w = lastWord(t);
  return w.length >= 2 && (POLITE_FINAL.test(w) || isHapsyoWord(w)) && !NOUN_YO.some((n) => w.endsWith(n));
}

/**
 * 글을 문장으로 나눈다. 마침표 · 물음표 · 느낌표 · 말줄임 · 물결(뒤가 공백일 때) · 줄바꿈,
 * 공백 앞 ㅋㅋ · 이모지 묶음, 문장부호 없는 존댓말 끝('있어요 내일은')에서 끊는다. '1.5시간' · '7시~8시'는 안 끊는다.
 * 내용 없는 조각('ㅋㅋ' · '?')은 앞 문장에 붙인다.
 */
export function splitSentences(text: string): string[] {
  const raw: string[] = [];
  for (const line of prep(text).split(/\r?\n/u)) {
    const chars = Array.from(line);
    let buf = "";
    const push = (): void => {
      const t = buf.trim();
      if (t) raw.push(t);
      buf = "";
    };
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const prev = chars[i - 1] ?? "";
      const next = chars[i + 1] ?? "";
      if (TERM.test(c)) {
        buf += c;
        if (c === "." && /\d/u.test(prev) && /\d/u.test(next)) continue; // 1.5
        if (c === "." && /[A-Za-z]/u.test(next)) continue; // a.m.
        // 7시~8시 · 월~금은 안 끊고, 존댓말 끝 뒤 물결('좋아요~내일 봐요')은 끊는다
        if (c === "~" && next !== "" && !/\s/u.test(next) && !TERM.test(next) && !TAIL.test(next) && !endsWithPoliteFinal(buf.slice(0, -1))) continue;
        if (c === "." && /^\d{1,2}\.$/u.test(buf.trim()) && /\s/u.test(next)) continue; // 번호 목록 '1. 준비물'

        while (i + 1 < chars.length && (TERM.test(chars[i + 1]) || TAIL.test(chars[i + 1]))) buf += chars[++i];
        push();
      } else if (LAUGH_OR_EMOJI.test(c)) {
        const hadContent = CONTENT.test(buf);
        let j = i;
        while (j < chars.length && (LAUGH_OR_EMOJI.test(chars[j]) || TERM.test(chars[j]) || TAIL.test(chars[j]))) buf += chars[j++];
        i = j - 1;
        if (hadContent && (j >= chars.length || /\s/u.test(chars[j]))) push();
      } else if (/\s/u.test(c)) {
        // 뒤에 ㅋㅋ · 이모지가 오면 그 묶음까지 이 문장에 붙인다 ('봐요 ㅋㅋ 잘자')
        let j = i + 1;
        while (j < chars.length && /\s/u.test(chars[j])) j++;
        if (endsWithPoliteFinal(buf) && !(j < chars.length && LAUGH_OR_EMOJI.test(chars[j]))) push();
        else buf += c;
      } else {
        buf += c;
      }
    }
    push();
  }
  const out: string[] = [];
  for (const t of raw) {
    if (!CONTENT.test(t) && out.length > 0) out[out.length - 1] += ` ${t}`;
    else out.push(t);
  }
  return out;
}

const POLITE_WORDS = new Set(["네", "넵", "넹", "넴", "녜", "예", "옙", "네네", "넵넵", "넹넹", "넴넴", "예예", "옙옙", "네넵", "아니요", "아뇨"]);
const BANMAL_WORDS = new Set(["응", "웅", "엉", "어", "응응", "웅웅", "아니", "그래", "그치", "오키", "오케이", "콜", "굿", "몰라", "그럼", "안녕", "ㅇㅇ"]);
const INTERJECTIONS = new Set(["아", "와", "오", "헐", "대박", "음", "흠", "앗", "아하", "오호", "우와", "와우", "에휴", "아이고", "휴", "흐음"]);
const NOUN_YO = ["필요", "중요", "주요", "소요", "수요", "강요", "요요", "동요", "개요"];
// 반말 어미처럼 끝나는 명사 (조각 문장 '내일 영어'를 반말로 세지 않게)
const NOUN_BLOCK = [
  "영어", "국어", "단어", "언어", "상어", "연어", "오징어", "언니", "어머니", "할머니", "남자", "여자", "글자", "숫자",
  "의자", "과자", "모자", "상자", "혼자", "부자", "피자", "문자", "환자", "기자", "이자", "카메라", "미래", "노래", "거래",
  "가게", "무게", "동네", "가지", "편지", "휴지", "까지", "처지", "의지", "바다", "하나", "누나", "바나나", "시대", "기대",
  "반대", "군대", "침대", "회사", "교사", "의사", "도서", "순서", "주소", "학교", "과제",
  // 앱 · 일상 명사 (10/9 검토 추가) — '알림 메시지' · '다음 주 휴가' · '아침마다' · '학교에서' 같은 조각
  "메시지", "페이지", "강아지", "돼지", "아버지", "금지", "휴가", "평가", "작가", "요가", "물가", "보고서", "문서", "신청서",
  "교과서", "계약서", "독서", "안내", "실내", "올해", "새해", "이해", "오해", "방해", "배려", "고려", "스피커", "스티커",
  "소파", "아빠", "오빠", "사이다", "감자", "분야", "마다", "에서",
  // 문장 중간 '-해,' 검사용 (10/9) — '피해, 손해'는 명사
  "피해", "손해", "견해", "동해", "서해", "남해", "매해",
];
const BANMAL_END = /(?:구나|구만|거든|잖아|더라|든지|든가|다고|라고|냐고|자고|려고|는데|은데|던데|인데|한데|운데|는걸|은걸|던걸|그래|뭐래|이래|저래|했대|었대|았대|겠대|는대|렇대|셈)$/u;

function isHaeyoWord(w: string): boolean {
  if (w === "요" || NOUN_YO.some((n) => w.endsWith(n))) return false;
  if (/(?:요|죠|죵|쵸|욬)$/u.test(w)) return true; // 그쵸 · 알겠어욬(요+ㅋ)
  return /[어아에예세해네까나가지게래데고구걸군워봐줘돼와셔자](?:용|여|염|욤)$/u.test(w); // 했어용 · 했어여 · 좋아염 · 잘자용
}

function isBanmalWord(w: string): boolean {
  if (NOUN_BLOCK.some((n) => w.endsWith(n))) return false;
  if (BANMAL_END.test(w)) return true;
  const last = w[w.length - 1];
  const prev = w[w.length - 2];
  if ("게께래까걸".includes(last) && jong(prev) === J_L) return true; // 할게 · 할래 · 할까 · 할걸
  if (last === "까" && prev === "니") return true; // 그러니까 (합쇼체는 앞에서 걸러짐)
  // 끝 글자 — '꺼 · 켜 · 미뤄 · 바꿔 · 맞춰 · 놔둬 · 슬퍼'처럼 어/아가 줄어든 꼴 포함
  return "어아해돼봐와줘워야지다냐니자라네군가나서내파빠려쳐져펴커써퍼뻐떠꺼켜껴겨혀뎌텨둬놔꿔춰뤄눠숴".includes(last);
}

// 문장 중간(쉼표 · 띄어쓰기 앞)의 반말 끝맺음 — '늦잠이었구나, 많이 아쉬웠겠어요.'(시운전 s-dev-014)처럼 끝만 해요체인 문장.
// 이음말('-는데,' · '-고,' · '-어야,' · '위해,' · 조건 '-거든')과 헷갈리지 않는 꼴만 본다.
const J_SS = 20; // ㅆ 받침 (했 · 잤 · 었 · 겠)
const MID_BANMAL_WORDS = new Set(["좋아", "싫어", "그래", "맞아", "몰라", "괜찮아", "알았어", "알겠어", "됐어", "그치", "있지", "있잖아"]);
// 쉼표 앞 '-해,'는 '고려해, · 감안해, · 참고해,'(= 하여, 이음말)가 흔해 상태 · 기분 낱말만 반말로 본다 (검수 10/9)
const FEEL_HAE = /(?:피곤|미안|불안|답답|심심|우울|속상|행복|다행|궁금|필요|중요|대단|충분|편|불편|당연|이상|급|섭섭|서운|억울|창피|신기|뿌듯|든든|지루)해$/u;
const ADJ_NE = /(?:하|좋|많|없|있|되|늦|맞|싫|같|괜찮|이|르|크|쁘|프|빠)네$/u;
// '-구나'가 아니라 낱말 + 조사 '나'('누구나' · '친구나 가족' · '도구나 앱')이거나 부사 '더구나' (검수 10/9 — sim-v2 s-dev-014 '누구나 늦잠을 잘 수 있어요,'를 반말로 셌음)
const GUNA_NOT_END = /(?:누|더|친|도|가|야|축|농|배|연|요|입|출|기|인|창|탁|문|공|항|완|용|어|경)구나$/u;
// 반말 마디 뒤에 이 말이 오면 남의 말 · 속생각을 옮긴 것 ('고생 많았어, 라고' · '그랬구나 하고 넘어가요' · '잤구나 싶었어요')
const QUOTE_AFTER = /^(?:라고|라며|라는|란\s|하고(?!\s*싶)|싶)/u;

/** 끝말 앞 글자가 과거 · 추측 ('했' · '잤' · '었' · '겠') — '있'은 과거가 아님 ('여유가 있어, 천천히' · '시간이 있거든 들러요') */
function pastBefore(w: string, endLen: number): boolean {
  const ch = w[w.length - endLen - 1];
  return jong(ch) === J_SS && ch !== "있";
}

/**
 * 문장 중간 낱말이 끝맺은 반말인지.
 *  어디서든(띄어쓰기 앞도): '-구나' · '-잖아' · 과거 '-거든'(조건 '-거든'은 과거에 안 붙음)
 *  쉼표 앞에서만: '-구먼 · 구만' · '-군' · '-네'(과거 · 형용사 어간 뒤만 — '친구네 집'은 아님) · '-지'(과거 · 그렇지) ·
 *    '-거야 · 이야' · '-더라' · 과거 '-다' · 과거 '-어/아'(수고했어,) · 상태 낱말 '-해'(피곤해, · 미안해, — '고려해,'는 이음말) · '좋아 · 그래 · 맞아'
 *  빼는 것: '누구나 · 친구나 · 더구나'(낱말 + 조사), 따옴표 안, 뒤에 '라고 · 하고 · 싶'이 오는 옮긴 말 · 속생각
 */
function midBanmalWord(w: string, comma: boolean): boolean {
  if (/(?:구나|잖아)$/u.test(w) && !GUNA_NOT_END.test(w)) return true;
  if (w.endsWith("거든") && pastBefore(w, 2)) return true;
  if (!comma) return false;
  if (MID_BANMAL_WORDS.has(w)) return true;
  if (/(?:구먼|구만|는군|더라|(?:거|이|뭐|건)야)$/u.test(w)) return true;
  const last = w[w.length - 1];
  if ("군네지다어아".includes(last) && pastBefore(w, 1)) return true; // 했군 · 했네 · 했지 · 늦었다 · 수고했어 · 잤어
  if (last === "네" && ADJ_NE.test(w)) return true; // 좋네 · 늦잠이네
  if (/(?:그렇|그러|맞|좋)지$/u.test(w)) return true;
  return FEEL_HAE.test(w); // 피곤해, · 미안해,
}

/** 문장 안에 끝맺은 반말 마디가 있으면 그 낱말 (마지막 낱말은 sentenceStyle이 따로 봄) */
export function midBanmalClause(sentence: string): string | null {
  // 따옴표 안('"수고했어, 오늘도"라고')은 옮긴 말이라 지운다 (길이 그대로)
  const t = prep(sentence).replace(/(["'“‘「『])[^"'”’」』]*["'”’」』]/gu, (q) => " ".repeat(q.length));
  let lastContent = -1; // 마지막 내용 글자 위치 — 그 앞의 마디만 '중간'
  for (let i = t.length - 1; i >= 0; i--) if (CONTENT.test(t[i])) { lastContent = i; break; }
  for (const m of t.matchAll(/([가-힣]+)(\s*,\s*|\s+)/gu)) {
    if (m.index + m[0].length > lastContent) break;
    const w = m[1];
    if (w.length < 2 || NOUN_BLOCK.some((n) => w.endsWith(n))) continue;
    if (QUOTE_AFTER.test(t.slice(m.index + m[0].length))) continue;
    if (midBanmalWord(w, m[2].includes(","))) return w;
  }
  return null;
}

/**
 * 문장 하나의 말투: 해요체 · 합쇼체 · 반말 · 모름(명사 끝 · 감탄사 · ~함/~음 개조식 · 영어).
 * 끝이 해요체여도 중간에 끝맺은 반말 마디('늦잠이었구나, …해요')가 있으면 반말로 센다.
 */
export function sentenceStyle(sentence: string): SentenceStyle {
  const st = finalStyle(sentence);
  if (st !== "banmal" && midBanmalClause(sentence) !== null) return "banmal";
  return st;
}

function finalStyle(sentence: string): SentenceStyle {
  const bare = prep(sentence).replace(/[\s.?!…~,]/gu, "");
  if (/^(?:ㅇㅇ+|ㅇㅋ(?:ㅇㅋ)*|ㄱㄱ+|ㄴㄴ+|ㅇㅈ)$/u.test(bare)) return "banmal";
  const w = lastWord(sentence);
  if (!w) return "unknown";
  if (w === "요" && /[^가-힣]요$/u.test(lastToken(sentence))) return "haeyo"; // '08:12요' · 'OK요'
  if (POLITE_WORDS.has(w)) return "haeyo";
  if (BANMAL_WORDS.has(w) || w === "마") return "banmal"; // '늦지 마' · '걱정 마'(따로 선 '마'만 — '엄마'는 아님)
  if (INTERJECTIONS.has(w)) return "unknown";
  if (isHapsyoWord(w)) return "hapsyo";
  if (isHaeyoWord(w)) return "haeyo";
  if (isBanmalWord(w)) return "banmal";
  return "unknown";
}

export interface StyleReport {
  sentences: number;
  haeyo: number;
  hapsyo: number;
  banmal: number;
  unknown: number;
  detail: { text: string; style: SentenceStyle }[];
}

export function styleReport(text: string): StyleReport {
  const detail = splitSentences(text).map((t) => ({ text: t, style: sentenceStyle(t) }));
  const r: StyleReport = { sentences: detail.length, haeyo: 0, hapsyo: 0, banmal: 0, unknown: 0, detail };
  for (const d of detail) r[d.style]++;
  return r;
}

// ───────── 물음 세기 ─────────

const QUESTION_WORDS = new Set([
  "어때요", "어때", "어땠어요", "어땠어", "어떠세요", "어떠셨어요", "뭐예요", "뭐에요", "뭐야", "뭔데", "뭐지",
  "왜요", "왜", "언제요", "언제야", "어디요", "어디야",
]);

/**
 * 물음 문장인지: '?' 또는 까요 · 나요 · ㄴ가요 · ㅂ니까 · 냐 · 니 · ㄹ까 · 의문사 단독('어때요'). '죠'는 '?'가 있을 때만.
 * '만나요' · '일어나요' · '끝나요'(동사 '-나다'의 해요체)와 '할 테니' · '해 보니'(이음말)는 '?'가 없으면 물음 아님.
 * 문장부호 없는 반말 물음('뭐 했어')과 의문사만 있는 해요체('몇 시에 일어났어요')는 못 잡는다.
 */
// 동사 '-나다'(만나다 · 일어나다 · 끝나다 · 짜증나다 …)의 해요체 — '?' 없이는 물음 아님. '만나나요' · '가지나요'는 물음.
const NA_VERB_YO = new RegExp(
  "(?:^|만|끝|떠|일어|나타|벗어|태어|늘어|헤어|빠져|뛰어|생각|기억|짜증|소리|눈물|냄새|큰일|난리|^지|^신|^화|^겁|^열|^땀|^티|^탈)나(?:요|용|여)$",
  "u",
);

export function isQuestion(sentence: string): boolean {
  const t = prep(sentence);
  if (t.includes("?")) return true;
  const w = lastWord(t);
  if (!w) return false;
  if (NA_VERB_YO.test(w)) return false;
  if (/(?:까요|나요|까용|나용|까여|나여)$/u.test(w)) return true;
  if (w.endsWith("가요") && w.length >= 3 && jong(w[w.length - 3]) === J_N) return true; // 괜찮은가요 · 인가요 · 하는가요
  if (w.endsWith("니까") && jong(w[w.length - 3]) === J_B) return true; // 합니까
  if (QUESTION_WORDS.has(w)) return true;
  if (w === "아니" || NOUN_BLOCK.some((n) => w.endsWith(n))) return false;
  if (/(?:테니|보니)$/u.test(w)) return false; // '할 테니' · '생각해 보니'는 이음말
  if (/(?:냐|냥|니)$/u.test(w)) return true;
  return w.endsWith("까") && jong(w[w.length - 2]) === J_L; // 할까 · 갈까
}

export function questionCount(text: string): number {
  return splitSentences(text).filter(isQuestion).length;
}

// ───────── 지어낸 숫자 찾기 ─────────

export interface AllowedNumbers {
  clocks: number[]; // 자정부터 분
  durations: number[]; // 분
  counts: number[]; // 횟수 (dayCounts를 안 주면 날 수 '3일 연속'도 여기와 비교)
  dates: LocalDate[];
  /** 날 수 허용 목록 ('최근 7일 중 3일' · '3일 연속' · '이틀') — 주면 날 수는 여기와만, 안 주면 counts와 비교 */
  dayCounts?: number[];
  /** 진행 분수 'N/M' ('2/3') — 주면 '루틴 1/3단계'를 이 목록과 비교, 안 주면 분수는 검사 안 함 (fractionsIn으로 모음) */
  fractions?: string[];
  /** 오전/오후가 확실한 시각(분) — unsupportedNumbers는 안 씀, ampmExact의 opts.exact로 넘기는 값 (exactClocksIn으로 모음) */
  exactClocks?: number[];
}

export interface UnsupportedOptions {
  /** 자정이 지난 뒤 상대 날짜의 두 해석을 모두 받기 위한 달력 오늘 (대화 기준일 dates.today와 다를 때) */
  calendarToday?: LocalDate;
  /** 허용 목록 없이도 받는 상대 날짜 (기본: 오늘 · 내일 · 지난밤 — 대화에서 늘 나오는 말이고, 지난밤은 잠 기록을 가리킴) */
  implicitDateKeys?: RelativeDateKey[];
}

/** 진행 분수의 비교 키 'N/M' */
function fractionKey(m: OtherMention): string {
  return `${m.value}/${m.denominator}`;
}

/** 글 속 진행 분수 키 목록 ('루틴 2/3단계 완료' → ['2/3']) — AllowedNumbers.fractions 모으기용 */
export function fractionsIn(text: string): string[] {
  return findTimeMentions(text).flatMap((m) => (m.kind === "other" && m.unit === "분수" ? [fractionKey(m)] : []));
}

/**
 * 허용 목록에 없는 시각 · 길이 · 횟수 · 날짜 언급 = 지어낸 숫자 후보.
 * 시각: 정확히 일치, 때 표시 없는 1~12시는 오전 · 오후 중 하나만 맞아도 통과(틀린 오전/오후 변환은 ampmExact가 따로 봄).
 * 길이 · 횟수 · 날 수: 정확히 일치(범위면 양 끝 모두). 날 수('3일 연속' · '최근 7일 중 3일' · '이틀')는 dayCounts(없으면 counts)와 비교.
 * 날짜로도 읽히는 날 수('발표하는 날이 9일' · '9일 정도', dateDay)는 허용 날짜의 일과 맞아도 통과 (모호하면 두 해석 다 받음 — 시각과 같은 원칙).
 * 날짜: 일만('9일')은 허용 날짜의 일과, 월/일은 허용 날짜의 월 · 일과 비교. 상대 날짜 · 요일은 ctxDates로 풀어 비교(없으면 걸지 않음).
 * '어젯밤 · 지난밤 · 간밤'은 기록 날짜 전날 밤(잠 기록)이라 기본으로 통과.
 * 진행 분수('1/3단계')는 allowed.fractions가 있을 때만 비교. 서수 · 구조 숫자('첫 번째' · '1단계' · '2호선')와 관용어 '한 번(한번)'은 걸지 않는다.
 */
export function unsupportedNumbers(
  text: string, allowed: AllowedNumbers, ctxDates?: Context["dates"], opts: UnsupportedOptions = {},
): TimeMention[] {
  const clocks = new Set(allowed.clocks.map((c) => ((c % 1440) + 1440) % 1440));
  const durations = new Set(allowed.durations);
  const counts = new Set(allowed.counts);
  const dates = new Set(allowed.dates);
  const dayCounts = allowed.dayCounts ? new Set(allowed.dayCounts) : counts;
  const fractions = allowed.fractions ? new Set(allowed.fractions) : null;
  const implicit = new Set<RelativeDateKey>(opts.implicitDateKeys ?? ["today", "tomorrow", "last_night"]);

  const dateOk = (m: DateMention): boolean => {
    const v = m.value;
    if (v.type === "relative" && implicit.has(v.key)) return true;
    if (v.type === "absolute") {
      if (v.month === null && v.monthOffset !== undefined && ctxDates) {
        const d = resolveRelativeDate(v, ctxDates).date;
        return d !== null && dates.has(d);
      }
      if (v.month === null) return allowed.dates.some((d) => Number(d.slice(8, 10)) === v.day);
      if (v.year !== null) return dates.has(makeDate(v.year, v.month, v.day) ?? "");
      return allowed.dates.some((d) => Number(d.slice(5, 7)) === v.month && Number(d.slice(8, 10)) === v.day);
    }
    if (!ctxDates) return true;
    const r = resolveRelativeDate(m, ctxDates, opts.calendarToday);
    return [r.date, r.alternative].some((d) => d !== null && dates.has(d));
  };

  return findTimeMentions(text).filter((m) => {
    switch (m.kind) {
      case "clock":
        return !m.candidates.some((c) => clocks.has(c));
      case "duration":
        return m.range ? !(durations.has(m.range[0]) && durations.has(m.range[1])) : !durations.has(m.value);
      case "count": {
        if (m.unit === "times" && m.native && m.value === 1 && !m.range) return false; // '한 번 더' · '한번 볼게요'
        const ok = m.unit === "days" ? dayCounts : counts;
        if (m.dateDay !== undefined && allowed.dates.some((d) => Number(d.slice(8, 10)) === m.dateDay)) return false;
        return m.range ? !(ok.has(m.range[0]) && ok.has(m.range[1])) : !ok.has(m.value);
      }
      case "date":
        return !dateOk(m);
      case "other":
        return m.unit === "분수" && fractions !== null && !fractions.has(fractionKey(m));
      default:
        return false;
    }
  });
}

// ───────── 시각 표기 형식 · 오전/오후 정확도 (T1 '오전 · 오후로 읽기' 가설용) ─────────

export type ClockForm = "24h" | "12h" | "bare";

export interface ClockFormItem {
  mention: ClockMention;
  form: ClockForm;
  /** '어젯밤 · 지난밤 · 간밤'의 밤 — 날 표시 (13시 이상이 붙어도 섞임이 아님) */
  dayRefNight: boolean;
  /** 한 언급 안에서 섞임 — 때 표시 + 13시 이상 ('오후 18시' · '저녁 19:00') */
  selfMixed: boolean;
}

const DAY_REF_BEFORE_NIGHT = /(?:(?:지난|어젯|어제)\s?|간)$/u;

/**
 * 시각 언급마다 표기 형식.
 *  24h  = 'HH:MM' 꼴(날 표시 '지난밤 01:37' 포함) · 13~24시 · 0시 · 0으로 시작('07시' · '아침 07:30')
 *  12h  = 때 표시(오전 · 오후 · 아침 · 낮 · 점심 · 저녁 · 밤 · 새벽, '어젯밤'의 밤 포함) + 1~12시 ('오후 6시 30분' · '오후 6:30'), 정오 · 자정
 *  bare = 때 표시 없는 1~12시 ('5시' · '6시 30분' · '일곱 시 반') — 듣는 사람이 오전/오후를 모름
 * 검수 10/9: '오후 6:30'(때 표시 + 0 없는 1~12시)은 오전 · 오후로 읽은 것이라 12h로 바꿈 (전엔 24h — checks.ts mixedTimeFormat과 이 경우만 다름, dev 답엔 없음)
 */
export function clockForms(text: string): ClockFormItem[] {
  const s = prep(text);
  const out: ClockFormItem[] = [];
  for (const m of findTimeMentions(text)) {
    if (m.kind !== "clock") continue;
    const dayRefNight = m.period === "밤" && DAY_REF_BEFORE_NIGHT.test(s.slice(Math.max(0, m.start - 3), m.start));
    if (m.period === "정오" || m.period === "자정") { out.push({ mention: m, form: "12h", dayRefNight, selfMixed: false }); continue; }
    const digital = /\d:\d/u.test(m.raw);
    const padded = /^0\d/u.test(m.raw.replace(/^\D+/u, ""));
    const marker = m.period !== null;
    const markedDigital12 = digital && marker && !dayRefNight && !padded && m.hour >= 1 && m.hour <= 12;
    if (!markedDigital12 && (digital || m.hour >= 13 || m.hour === 0 || padded)) {
      out.push({ mention: m, form: "24h", dayRefNight, selfMixed: marker && !dayRefNight && (m.hour >= 13 || m.hour === 0) });
    } else {
      out.push({ mention: m, form: marker ? "12h" : "bare", dayRefNight, selfMixed: false });
    }
  }
  return out;
}

export interface TimeFormatReport {
  has24h: boolean;
  has12h: boolean;
  /** 때 표시 없는 1~12시 (원문 조각, 나온 순서) */
  bare: string[];
  /** 24시간 표기와 때 표시 표기가 한 글에 같이 있음, 또는 한 언급 안에서 섞임 ('오후 18시'). bare는 따로 셈 */
  mixed: boolean;
  /** 한 언급 안에서 섞인 조각 ('오후 18시' · '저녁 19:00') */
  selfMixed: string[];
}

export function timeFormatReport(text: string): TimeFormatReport {
  const items = clockForms(text);
  const has24h = items.some((i) => i.form === "24h");
  const has12h = items.some((i) => i.form === "12h");
  const selfMixed = items.filter((i) => i.selfMixed).map((i) => i.mention.raw);
  return {
    has24h, has12h,
    bare: items.filter((i) => i.form === "bare").map((i) => i.mention.raw),
    mixed: (has24h && has12h) || selfMixed.length > 0,
    selfMixed,
  };
}

export interface AmPmMismatch {
  raw: string;
  start: number;
  end: number;
  /** 글이 뜻하는 시각(분) — periodHour 표대로 읽은 값 */
  minutes: number;
  hhmm: LocalTime;
  period: PeriodMarker;
  /** 같은 시 · 분의 반대쪽(오전 ↔ 오후, 낮 12시 ↔ 밤 12시)은 허용 — 지어낸 숫자가 아니라 오전/오후를 잘못 바꾼 것 */
  flipped: boolean;
}

export interface AmPmOptions {
  /**
   * 오전/오후가 확실한 시각(분) — 컨텍스트 · 알람 · 처리 결과의 'HH:MM', 글 속 때 표시 · 24시간 표기 시각(exactClocksIn).
   * 주면: 이 목록에 없고 반대쪽(±12시간)이 이 목록에 있으면 허용 시각에 있어도 뒤집힘으로 건다.
   * 허용 시각은 사용자가 말한 '7시'처럼 모호한 말의 두 후보를 다 담아서, 그것만으로는 틀린 변환을 못 거른다
   * (실패 분석 harness (d) · 검수 10/9). 반대쪽도 확실하지 않으면(모호한 말에서만 나온 시각) 걸지 않는다.
   */
  exact?: number[];
}

/** 글 속 시각 중 오전/오후가 확실한 것(때 표시 · 24시간 표기 · 13시 이상)의 분 — AmPmOptions.exact 모으기용 */
export function exactClocksIn(text: string): number[] {
  return findTimeMentions(text).flatMap((m) => (m.kind === "clock" && !m.hour12Ambiguous ? m.candidates : []));
}

/**
 * 때 표시가 있는 시각('오후 6시 30분' · '밤 12시 반' · '정오')을 허용 시각과 정확히 비교한다.
 * unsupportedNumbers는 때 표시 없는 시각의 오전 · 오후를 둘 다 받아 틀린 변환을 못 잡으므로 따로 둔다.
 * opts.exact 없이 허용 시각만 주면 unsupportedNumbers가 때 표시 시각에 거는 것과 같다(뒤집힘 표시만 더함) —
 * 사용자가 '7시'라고 했는데 AI가 '오후 7시'로 바꾼 것까지 보려면 opts.exact를 준다.
 * 때 표시 없는 시각은 보지 않는다 (timeFormatReport.bare로 셈). 읽는 법은 periodHour 위 표.
 */
export function ampmExact(text: string, allowedClockMinutes: number[], opts: AmPmOptions = {}): AmPmMismatch[] {
  const norm = (c: number): number => ((Math.round(c) % 1440) + 1440) % 1440;
  const allowed = new Set(allowedClockMinutes.map(norm));
  const exact = opts.exact ? new Set(opts.exact.map(norm)) : null;
  const out: AmPmMismatch[] = [];
  for (const m of findTimeMentions(text)) {
    if (m.kind !== "clock" || m.period === null) continue;
    if (exact && m.candidates.some((c) => exact.has(norm(c)))) continue;
    const flipExact = exact !== null && m.candidates.some((c) => exact.has(norm(c + 720)));
    if (!flipExact && m.candidates.some((c) => allowed.has(norm(c)))) continue;
    out.push({
      raw: m.raw, start: m.start, end: m.end, minutes: m.value, hhmm: clockToHHMM(m.value), period: m.period,
      flipped: flipExact || m.candidates.some((c) => allowed.has(norm(c + 720))),
    });
  }
  return out;
}
