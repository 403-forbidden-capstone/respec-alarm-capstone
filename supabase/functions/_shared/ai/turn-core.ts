// 턴 처리 순수부 — 사용자 말마다 빠른 추출(T2F) 결과를 받아 "카드 재료 · 기록 정정 · 처리 결과 줄"로 바꾼다 (실험실 lib/stub.ts + run/e2-lib.ts 이식, 설계 메모 7절).
// 순수 TS, DB · 모델 · 현재 시각을 안 부른다(시각은 ctx.session.now). 같은 입력 → 같은 결과. 입력 state는 바꾸지 않고 새 state를 돌려준다.
//
// 실험실 스텁과 다른 점 (설계 메모 5절 · 7절):
//   · 저장하지 않는다. 새 약속 · 알람 고침 · 알람 추가 · 약속 변경은 "카드"(APPT_NEW · ALARM_EDIT · ALARM_NEW · APPT_OPEN)로 만들고, 말 "응"(CONFIRMED)은 카드 강조(highlight)만 —
//     저장은 카드 [저장] · [바꾸기]로만 (applyCardAction). L6 안건후보: 글로 응 저장 기본안.
//   · 알람 시각 · 강도를 서버가 계산하지 않는다. 앱이 L1 함수(estimateAppointment · previewAlarms)로 계산해 요약(digest)을 돌려주면(applyTaskResults) 그 숫자를 처리 결과 줄에 담는다.
//     planAlarms · timesFor · wakeAnchor 계산부 · learnedExtra · intensityOf · 겹침 검사 · StubParams · overrides는 뺐다.
//   · 기록 정정(출발 · 도착)은 앱이 L2 함수로 반영한다 — fixes로 내보내고 결과(ok)가 오면 "저장됨: …정정" 줄. 기상 정정은 함수가 없어 '대상 없음' 거절(설계 메모 13절 L1-3).
//   · 위기 안내는 서버가 늘 정한다(crisis_by_server 켬). 위기 턴은 앱 일을 다음 턴으로 미룬다.
//   · 다른 사람 알람 권한 길은 v0에서 늘 NO_PERMISSION. 준비시간 범위는 day(내일 기상 기준 일정) 고정.
//   · 할 일 · 준비물 · 이유 태그 · 하루 기록은 T2F가 안 뽑는다 — 대화 끝 추출(applyFinal, PR 5) 몫. itemKey만 미리 옮겨 둠.
import type {
  AlarmPlan, AlarmType, ApptDraft, Appointment, Basis, Card, CardAction, CardEdit, CardGroup, CardKind, Context, Digest, Extract, FactKind, FastExtract, Fix, Importance, Intensity, PreTask,
  GroupRef, LocalDate, LocalTime, PendingItem, QuestionKind, RejectReason, ServerEvent, ServerQuestion, TaskResults, Weekday,
} from "./types.ts";
import { IMPORTANCE_LABEL } from "./types.ts";
import { FACT_KIND_KO, FIXABLE_FACT_KINDS, addDays, spokenTime, weekdayOf } from "./view.ts";
import { isQuestion, seoulLocal, splitSentences } from "./ko.ts";
import { GROUP_ASK_HEAD, PLACE_PICK, toMinutes } from "./guards.ts";
import { RING_KINDS } from "../calc/types.ts";

/** HH:MM (24시간) — 기상 답 시각 검사 */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type XAppt = Extract["appointments"][number];
type XAlarm = Extract["alarm_changes"][number];
type XPrep = NonNullable<Extract["prep_adjustment"]>;

// ───────── 날짜 · 시각 도우미 (실험실 truth.ts에서 필요한 것만) ─────────

export interface LocalDateTime {
  date: LocalDate;
  time: LocalTime;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 분 → "HH:MM" (하루 안으로 감음) */
function fromMinutes(m: number): LocalTime {
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(x / 60))}:${pad2(x % 60)}`;
}

/** 1970-01-01부터 며칠째 (UTC 달력 계산 — 시간대와 무관) */
function dayNumber(date: LocalDate): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** 날짜 + 시각에 분을 더함 (자정 넘김 처리) */
function addMinutes(date: LocalDate, time: LocalTime, delta: number): LocalDateTime {
  const total = toMinutes(time) + Math.round(delta);
  const shift = Math.floor(total / 1440);
  return { date: addDays(date, shift), time: fromMinutes(total - shift * 1440) };
}

/** to − from (분). 음수면 to가 더 이름 */
function minutesBetween(from: LocalDateTime, to: LocalDateTime): number {
  return (dayNumber(to.date) - dayNumber(from.date)) * 1440 + toMinutes(to.time) - toMinutes(from.time);
}

const WEEKDAY_SHORT: Record<Weekday, string> = { MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토", SUN: "일" };

/** "10/9(금)" */
export function dateKo(date: LocalDate): string {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${m}/${d}(${WEEKDAY_SHORT[weekdayOf(date)]})`;
}

/** ISO 시각 → 서울 로컬 날짜 · 시각(초 버림). 시간대 표기가 없으면 이미 서울 로컬로 봄. 형식이 틀리면 에러 */
export function isoToLocal(iso: string): LocalDateTime {
  const r = seoulLocal(iso);
  return { date: r.date, time: fromMinutes(r.minutes) };
}

/** 로컬 날짜 · 시각 → 서울 ISO ("2026-10-30T07:40:00+09:00") */
export function localToIso(date: LocalDate, time: LocalTime): string {
  return `${date}T${time}:00+09:00`;
}

/** 별칭 번호 비교 (a2 < a10) */
function cmpRef(a: string, b: string): number {
  const na = /(\d+)$/.exec(a);
  const nb = /(\d+)$/.exec(b);
  const pa = na ? a.slice(0, na.index) : a;
  const pb = nb ? b.slice(0, nb.index) : b;
  return (pa < pb ? -1 : pa > pb ? 1 : 0) || (na && nb ? Number(na[1]) - Number(nb[1]) : a < b ? -1 : a > b ? 1 : 0);
}

/** 서버 키워드 사전 (7장 v4 M2) — 못 정하면 null. 질문 대상 판단(PREP_CHECK)에도 같은 사전을 쓴다 */
export function keywordImportance(title: string): Importance | null {
  if (/(시험|중간고사|기말|면접|발표|시연)/.test(title)) return "HIGH";
  if (/(수업|강의|실습|팀플|회의)/.test(title)) return "NORMAL";
  return null;
}

// ───────── 대화 기준일 (설계 메모 4.1, 헤드 H1) ─────────

export interface ConversationDays {
  /** 돌아볼 날 = '오늘' (사실 · 정정이 속한 날) */
  review: LocalDate;
  /** 다가올 아침 = '내일' (일정 · 알람 · 준비물을 보여 줄 날) */
  morning: LocalDate;
  tz: string;
  /** false면 서울이 아닌 시간대인데 서울로 계산함 — 경고 플래그(v0 Asia/Seoul만, 설계 메모 11절) */
  tzSupported: boolean;
}

/** 하루 경계 — KST 새벽 4시. 00:00~03:59는 전날 (대화방 · 기록 기준일 · 날짜 해석 · 자동 정리가 모두 이 값을 씀) */
export const DAY_START_HOUR = 4;

/** 지금(ISO)의 생활 날짜 — 새벽 4시 전이면 달력 전날 */
export function lifeDate(now: string): LocalDate {
  const cal = seoulLocal(now);
  return cal.minutes < DAY_START_HOUR * 60 ? addDays(cal.date, -1) : cal.date;
}

/** 생활 날짜 date가 시작하는 때 ("2026-11-11" → "2026-11-11T04:00:00+09:00") */
export const dayStartIso = (date: LocalDate): string => `${date}T0${DAY_START_HOUR}:00:00+09:00`;

/**
 * 대화 기준일 — KST 새벽 4시 경계 (11/13). 기상 알람 · 기상 확인 여부와 상관없음.
 *   돌아볼 날 review = 생활 날짜(lifeDate) = '오늘', 다가올 아침 morning = review + 1 = '내일'
 *   예: 11/12 01:00 → review 11/11 · morning 11/12, 11/12 04:00 → review 11/12 · morning 11/13
 */
export function dayOf(now: string, tz: string): ConversationDays {
  const review = lifeDate(now);
  return { review, morning: addDays(review, 1), tz, tzSupported: tz === "Asia/Seoul" };
}

// ───────── 글 도우미 (실험실 stub.ts 그대로) ─────────

/** 제목 비교용 — NFKC(조합형 한글 · 전각 문자 맞춤) · 소문자 · 공백 · 문장부호 제거 */
export function normTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 같은 일정으로 볼 제목인지 (같거나 한쪽이 다른 쪽을 품음, 2자 이상) */
export function titleMatch(a: string, b: string): boolean {
  const x = normTitle(a);
  const y = normTitle(b);
  if (x === y) return x.length > 0;
  return Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x));
}

/**
 * 같은 일정 이름으로 볼지 — titleMatch이거나, 정규화한 제목이 한 글자 안팎만 다름(둘 다 2자 이상).
 * 받아쓰기 · 모델 출력의 글자 흔들림('스터디' ~ '스터더', 11/9 웹 시험)을 같은 일정으로 — 날짜 · 시각이 같을 때만 씀
 */
export function nearTitle(a: string, b: string): boolean {
  if (titleMatch(a, b)) return true;
  const x = normTitle(a);
  const y = normTitle(b);
  if (Math.min(x.length, y.length) < 2 || Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return Math.max(x.length, y.length) - i - j <= 1;
}

/** 준비물 · 할 일 같은 것 판별 키 — 정규화한 제목 끝의 '챙기기 · 가져가기' 류를 뗌 ('우산 챙기기' = '우산', 059 · 060). 대화 끝 추출(PR 5)이 씀 */
export function itemKey(title: string): string {
  const t = normTitle(title);
  const core = t.replace(/(을|를)?(챙기기|챙겨가기|챙겨오기|가져가기|가져오기|가지고가기|들고가기)$/u, "");
  return core === "" ? t : core;
}

/** "10/9(금) 14:00 스터디 · 학교 도서관" */
export function appointmentSummary(a: { date: LocalDate; time: LocalTime; title: string; place: string | null }): string {
  return `${dateKo(a.date)} ${a.time} ${a.title}${a.place ? ` · ${a.place}` : ""}`;
}

const TYPE_KO: Record<AlarmType, string> = { WAKE: "기상", PREPARE: "준비", DEPARTURE: "출발", ARRIVE: "도착" };
const INTENSITY_KO: Record<Intensity, string> = { SOFT: "약하게", NORMAL: "보통", STRONG: "강하게" };
const FACT_TIME_LABEL: Partial<Record<FactKind, string>> = { SLEEP: "취침", WAKE: "기상", DEPART: "출발", ARRIVE: "도착" };
// ───────── 고칠 대상 찾기 — 이번 사용자 말(최신 요청)로 만들기 · 고치기 · 바로잡기를 가르고, 말에 나온 일정 · 그룹 이름으로 대상을 좁힘 ─────────
//   T2F 추출에는 '고침/새로'를 가르는 칸이 없어(프롬프트 판은 덮어쓰지 않음) 서버가 말에서 직접 봄. 말이 없으면(userText 없음) 예전 동작 그대로

export interface Intent {
  text: string;
  /** 바꿔 · 변경 · 수정 · 옮겨 · 미뤄 · 당겨 … — 있는 것을 고침 */
  edit: boolean;
  /** 추가 · 새로 · 등록 … — 새로 만듦 (고침 말과 같이 오면 새로 만듦이 이김) */
  add: boolean;
  /** 아니 · 말고 · 잘못 — 앞 요청을 바로잡음 */
  correct: boolean;
  /** 알람 · 깨워 — 알람 얘기 */
  alarm: boolean;
  /** 기상 · 준비 · 출발 · 도착 중 하나를 말함 */
  typeNamed: boolean;
}

export function intentOf(text: string): Intent {
  return {
    text,
    edit: /(바꿔|바꾸|바꿀|변경|수정|고쳐|고치|옮겨|옮기|미뤄|늦춰|당겨|앞당)/u.test(text),
    add: /(추가|새로|새\s|등록|만들어|잡아\s*줘)/u.test(text), // '새벽'은 아님
    correct: /(아니|말고|잘못)/u.test(text),
    alarm: /(알람|깨워|깨우)/u.test(text),
    typeNamed: /(기상|일어나|깨워|깨우|준비|출발|나가는|도착)/u.test(text),
  };
}

/** 상대 시간 변경 말 — "10분 당겨" · "십 분만 늦춰" · "한 시간 뒤로" (분 · 시간 + 방향) */
export function shiftSaid(text: string): boolean {
  return /(분|시간)/u.test(text) && /(당겨|당기|앞당|일찍|빨리|늦춰|늦추|늦게|미뤄|미루|뒤로)/u.test(text);
}
const TYPE_WORDS: Record<AlarmType, RegExp> = { WAKE: /(기상|일어나|깨워|깨우)/u, PREPARE: /준비/u, DEPARTURE: /(출발|나가는)/u, ARRIVE: /도착/u };

/** 이름 비교에서 빼는 흔한 낱말 — '동아리 회의'가 '캡스톤 회의'로 잡히지 않게 */
const GENERIC_WORDS = new Set(["회의", "미팅", "약속", "일정", "모임", "수업", "강의", "그룹", "알람"]);
/** 일정 · 그룹 이름의 낱말 (2자 이상, 흔한 낱말 뺌) */
export function nameWords(s: string): string[] {
  return s.split(/\s+/u).map(normTitle).filter((w) => w.length >= 2 && !GENERIC_WORDS.has(w));
}

/**
 * 말에 나온 일정 — 일정 이름 · 그룹 이름의 낱말(nameWords)이 말에 들어 있는 수 + '그룹'(그룹 약속) · '개인'(개인 일정) 말.
 * all = 하나라도 걸린 약속, best = 가장 많이 걸린 약속들. 아무것도 안 걸리면 null (좁히지 않음)
 */
export function mentionedAppts(appts: Appointment[], text: string): { all: Set<string>; best: Set<string> } | null {
  const said = normTitle(text);
  const scored = appts.map((a) => {
    let n = [...new Set(nameWords(`${a.title} ${a.group ?? ""}`))].filter((w) => said.includes(w)).length;
    if (a.group !== undefined && /그룹/u.test(text)) n++;
    if (a.group === undefined && /개인/u.test(text)) n++;
    return { ref: a.ref, n };
  });
  const top = Math.max(0, ...scored.map((x) => x.n));
  if (top === 0) return null;
  return { all: new Set(scored.filter((x) => x.n > 0).map((x) => x.ref)), best: new Set(scored.filter((x) => x.n === top).map((x) => x.ref)) };
}

/** "'캡스톤 회의'(그룹 캡스톤) " — 카드 · 되물음에서 어느 일정의 알람인지 (개인 일정은 이름만) */
export function apptName(a: Appointment | undefined): string {
  if (a === undefined) return "";
  const group = a.group === undefined ? "" : a.group === "" ? "(그룹)" : `(그룹 ${a.group})`;
  return `'${a.title}'${group} `;
}

const REJECT_WORD: Record<RejectReason, string> ={ NO_PERMISSION: "권한 없음", AMBIGUOUS: "모호함", PAST_TIME: "이미 지난 시각", NOT_FOUND: "대상 없음" };

/** '좀 더'처럼 분이 없을 때 서버 기본 가감 폭 */
export const PREP_ADJUST_DEFAULT = 10;
/** 대화 한 번으로 바꿀 수 있는 준비시간 상한 (설계 가정) */
export const PREP_ADJUST_MAX = 60;

const PREP_TOPIC = /(준비|여유|시간)/u;
const PREP_CHANGE = /(늘려|늘리|줄여|줄이|바꿔|바꾸|변경|당겨|늦춰|원래대로|줘|주세요|주라|줄래|달라|걸릴)/u;
const PREP_QUESTION = /준비[^?]*(\?|까요)/u;

/**
 * 사용자가 준비시간 변경을 실제로 청했는지 — 준비 · 여유 · 시간 이야기에 바꾸는 말 · 부탁 · 앞으로의 예상('더 걸릴 듯')이 있거나, 코치가 준비시간을 물은 바로 다음 말.
 * 모델(T2F · T2)이 지난 일 · 목표를 변경 요청으로 읽어도 서버가 거름 (11/8 음성 '준비하는데 15분 더 걸렸고 … 일찍 일어나고 싶어' → '+10분' 카드)
 */
export function prepAsked(turns: readonly { role: string; text: string }[]): boolean {
  return turns.some((t, i) => t.role === "user" && ((PREP_TOPIC.test(t.text) && PREP_CHANGE.test(t.text) && !/알람/u.test(t.text)) || (turns[i - 1]?.role === "ai" && PREP_QUESTION.test(turns[i - 1].text))));
}

/** 준비시간 가감 분 (부호 포함): '좀 더'(분 없음) 10, 상한 60, 원래대로 0 */
function prepDeltaOf(pa: XPrep): number {
  const size = Math.min(PREP_ADJUST_MAX, Math.max(1, pa.minutes ?? PREP_ADJUST_DEFAULT));
  return pa.direction === "OK" ? 0 : pa.direction === "MORE" ? size : -size;
}

const refNum = (ref: string, prefix: string): number => {
  const m = new RegExp(`^${prefix}(\\d+)$`).exec(ref);
  return m ? Number(m[1]) : 0;
};
const signed = (n: number): string => `${n > 0 ? "+" : "-"}${Math.abs(n)}분`;
const levelKo = (level: number | null): string => (level === 2 ? "강하게" : level === 0 ? "약하게" : "보통");
const intensityOfLevel = (level: number | null): Intensity => (level === 2 ? "STRONG" : level === 0 ? "SOFT" : "NORMAL");
const levelOfIntensity = (i: Intensity): number | null => (i === "STRONG" ? 2 : i === "SOFT" ? 0 : null);

// ───────── 상태 ─────────

export interface PendingEntry {
  kind: PendingItem["kind"];
  key: string; // 같은 항목 판별 키
  item: XAppt | XAlarm | XPrep; // 원본 추출 항목
  summary: string; // 처리 결과 줄 앞부분(꼬리 '카드의 [저장]으로 …' 빼고)
  target_ref: string | null; // 고치는 기존 약속 a# (새 약속 · 알람이면 null)
}

export type FixStatus = "PENDING" | "SENT" | "DONE" | "FAILED";
export interface FixRecord extends Fix {
  status: FixStatus;
  /** 처리 결과 글에 쓸 이름 ("도착") */
  label: string;
  approx: boolean;
}

/**
 * 턴 처리 상태 — 설계 메모 3절 server_state의 core · events · cards · fixes · awaiting를 한 덩어리로 (PR 4가 칸별로 저장).
 * pending = 열린 카드 c# (SAVED · REJECTED면 지움). 카드가 NEEDS_ESTIMATE인 동안에도 들어 있어 같은 항목은 같은 c#을 이어 쓴다.
 */
export interface TurnState {
  v: 1;
  pendingSeq: number;
  pending: Record<string, PendingEntry>;
  applied: string[];
  appointments: Appointment[]; // 오늘 + 내일 + 이후(ctx.later, 고칠 대상 찾기용) (카드로 저장된 것 포함)
  alarms: AlarmPlan[];
  apptSeq: number;
  alarmSeq: number;
  seen: Record<string, string>; // 처리한 항목 키 → 서명
  createdKeys: Record<string, string>; // 이 대화에서 카드로 저장한 약속 a# → 만들 때 키
  /** 앱이 알려 준 DB id (저장한 약속 a# · 알람 al# → id) — 서버가 refs에 옮겨 적음 */
  bound: Record<string, string>;
  factFeedback: Extract["fact_feedback"];
  safetyFlag: boolean;
  crisisNotified: boolean;
  events: ServerEvent[];
  cards: Card[];
  fixes: FixRecord[];
  fixSeq: number;
  /** 앱 일(카드 계산 · 기록 정정) 결과를 기다리는 중 — 없으면 null */
  awaiting: { after_turn: number; cards: string[]; fixes: string[] } | null;
}

export function initTurnState(ctx: Context): TurnState {
  const uniq = <T extends { ref: string }>(xs: T[]): T[] => {
    const seen = new Set<string>();
    return xs.filter((x) => (seen.has(x.ref) ? false : (seen.add(x.ref), true)));
  };
  // 이후 약속 · 알람(ctx.later)도 넣음 — 고칠 대상 찾기 · 같은 일정 되풀이 판별용 (준비시간 계산은 내일만 봄)
  const appointments = uniq([...ctx.today.appointments, ...ctx.tomorrow.appointments, ...(ctx.later?.appointments ?? [])]).map((a) => ({ ...a }));
  const alarms = uniq([...ctx.today.alarms, ...ctx.tomorrow.alarms, ...(ctx.later?.alarms ?? [])]).map((a) => ({ ...a }));
  return {
    v: 1,
    pendingSeq: 0,
    pending: {},
    applied: [],
    appointments,
    alarms,
    apptSeq: appointments.reduce((m, a) => Math.max(m, refNum(a.ref, "a")), 0),
    alarmSeq: alarms.reduce((m, a) => Math.max(m, refNum(a.ref, "al")), 0),
    seen: {},
    createdKeys: {},
    bound: {},
    factFeedback: [],
    safetyFlag: false,
    crisisNotified: false,
    events: [],
    cards: [],
    fixes: [],
    fixSeq: 0,
    awaiting: null,
  };
}

const newEvent = (afterTurn: number): ServerEvent => ({ after_turn: afterTurn, applied: [], pending: [], rejected: [], clarify: [], alarms: [] });

/** after_turn이 같은 처리 결과가 있으면 그것을, 없으면 새로 만들어 state.events에 넣는다 */
function eventFor(s: TurnState, afterTurn: number): ServerEvent {
  const found = s.events.find((e) => e.after_turn === afterTurn);
  if (found) return found;
  const e = newEvent(afterTurn);
  s.events.push(e);
  return e;
}

// ───────── 빠른 추출(T2F) 펼치기 · 처리 결과 분류 (실험실 run/e2-lib.ts) ─────────

/** T2F 출력을 전체 Extract 모양으로 (안 맡은 칸은 비움) */
export function expandFast(f: FastExtract): Extract {
  return {
    schema_version: "2.0-lab.0",
    appointments: f.appointments,
    todos: [],
    importance_updates: [],
    alarm_changes: f.alarm_changes,
    fact_feedback: f.fact_feedback,
    reason_tags: [],
    prep_adjustment: f.prep_adjustment,
    daily_record: { sleep_time: null, sleep_satisfaction: null, condition_note: null },
    safety_flag: f.safety_flag,
  };
}

export type NeedKind = "saved" | "pending" | "clarify" | "rejected" | "alarm" | "conflict" | "crisis";

export const NEED_LABEL: Record<NeedKind, string> = {
  saved: "저장됨 줄", pending: "확인 필요(저장할까요)", clarify: "되물을 것", rejected: "거절", alarm: "바뀐 알람", conflict: "겹침", crisis: "위기 안내",
};

/** 한 처리 결과(사용자 말 하나 뒤)에서 T1이 바로 알아야 하는 것의 종류 — 비면 "처리할 게 없음"(미리 부른 T1 답을 씀, 06-서버지침.md 28 · 29번) */
export function needKinds(e: ServerEvent | undefined): NeedKind[] {
  if (!e) return [];
  const out: NeedKind[] = [];
  if (e.applied.length > 0) out.push("saved");
  if (e.pending.length > 0) out.push("pending");
  if (e.clarify.length > 0) out.push("clarify");
  if (e.rejected.length > 0) out.push("rejected");
  if (e.alarms.length > 0) out.push("alarm");
  if ((e.conflicts ?? []).length > 0) out.push("conflict");
  if (e.crisis === true) out.push("crisis");
  return out;
}

/** 처리 결과 목록에서 사용자 말 j 뒤 결과 */
export const eventAt = (events: ServerEvent[], j: number): ServerEvent | undefined => events.find((e) => e.after_turn === j);

// ───────── 카드 도우미 ─────────

const OPEN_STATUS: readonly Card["status"][] = ["NEEDS_ESTIMATE", "READY", "NEEDS_PLACE", "FAILED"];
const pendingKindOf = (k: CardKind): PendingItem["kind"] => (k === "APPT_NEW" || k === "APPT_OPEN" ? "APPOINTMENT" : "ALARM_CHANGE");

function emptyCard(id: string, kind: CardKind): Card {
  return { id, kind, status: "NEEDS_ESTIMATE", first_of_day: false, highlight: false, summary: "", draft: null, edit: null, digest: null, items: [], appointment_id: null, error: null };
}

/** 앱이 계산해야 하는 카드인지 — 새 약속 · 시각이나 준비를 바꾸는 알람 고침 · 장소를 바꾸는 약속 변경(앱이 장소를 확인, 모호하면 [장소 고르기]). 그 밖은 서버가 바로 READY */
function needsEstimate(c: Card): boolean {
  if (c.kind === "APPT_NEW") return true;
  if (c.kind === "APPT_OPEN") return typeof c.edit?.changes?.place === "string";
  if (c.kind === "ALARM_EDIT") return c.edit?.times !== undefined || c.edit?.prepare_delta !== undefined;
  return false;
}

/** 그날 첫 일정인지 — 이미 있는 그날 일정 · 다른 열린 새 약속 카드보다 이른 것 (D36: 첫 일정만 알람을 자세히 말함) */
function isFirstOfDay(s: TurnState, c: Card): boolean {
  const d = c.draft;
  if (d === null) return false;
  const mine = toMinutes(d.time);
  const others = [
    ...s.appointments.filter((a) => a.date === d.date).map((a) => a.time),
    ...s.cards.filter((o) => o.id !== c.id && o.kind === "APPT_NEW" && OPEN_STATUS.includes(o.status) && o.draft?.date === d.date).map((o) => (o.draft as { time: string }).time),
  ];
  return others.every((t) => toMinutes(t) > mine);
}

/** 계산 요약(digest)에서 기상 알람의 로컬 시각 */
function wakeOf(digest: Digest | null): LocalDateTime | null {
  const w = digest?.alarms.find((a) => a.kind === "WAKE" && a.enabled);
  return w ? isoToLocal(w.at) : null;
}

/** 처리 결과 '확인 필요' 줄의 글 (설계 메모 5.1) */
export function pendingText(c: Card, s: TurnState): string {
  switch (c.kind) {
    case "APPT_NEW": {
      const d = c.draft as NonNullable<Card["draft"]>;
      const parts = [appointmentSummary(d)];
      if (d.importance !== null) parts.push(`중요도 ${IMPORTANCE_LABEL[d.importance]}`);
      const w = wakeOf(c.digest);
      parts.push(c.first_of_day && w !== null ? `알람 기상 ${w.time} ${levelKo(c.digest?.level ?? null)}` : "알람: 출발 알림");
      // 알람 근거 — 앱이 준 값을 검사해 통과한 것만 (checkBasis). 기상 알람을 말할 때만 붙임
      if (c.first_of_day && w !== null && c.digest?.basis) parts.push(basisText(c.digest.basis, w, { date: d.date, time: d.time }));
      if (c.edit?.prepare_delta !== undefined) parts.push(c.edit.prepare_delta === 0 ? "내일만 준비시간 원래대로" : `내일만 준비시간 ${signed(c.edit.prepare_delta)}`);
      if (c.pre_task !== undefined) parts.push(`나가기 전 할 일: ${c.pre_task.title} · ${c.pre_task.wake === "SET" ? "기상은 사용자가 정한 시각, 준비 · 출발은 그대로" : "계산된 기상 그대로"}`);
      if (c.group !== undefined && c.group.choice !== "ASK") parts.push(c.group.choice === "GROUP" ? `${groupName(c.group)} 그룹 일정 (알람은 본인 것만)` : "개인 일정");
      parts.push("카드의 [저장]으로 저장");
      return parts.join(" · ");
    }
    case "ALARM_EDIT": {
      const parts = [c.summary];
      if (c.edit?.prepare_delta !== undefined) {
        // 기상 07:55 → 07:40 (지금 기상 알람 → 앱이 미리 계산한 기상)
        const to = wakeOf(c.digest);
        const from = s.alarms.find((a) => a.owner === "u0" && a.type === "WAKE" && a.enabled && a.appointment_ref === (c.edit as CardEdit).appointment_id);
        if (to !== null && from !== undefined && (from.date !== to.date || from.time !== to.time)) parts.push(`기상 ${from.time} → ${to.time}`);
      } else if (c.edit?.times !== undefined && c.digest !== null) {
        // 요청하지 않은 알람이 앱 미리 보기에서 움직이면 저장 전에 알림 — 몰래 바뀌지 않게
        for (const d of c.digest.alarms) {
          if (d.kind === "ARRIVE" || c.edit.times[d.kind] !== undefined) continue;
          const to = isoToLocal(d.at);
          const from = s.alarms.find((a) => a.owner === "u0" && a.type === d.kind && a.appointment_ref === (c.edit as CardEdit).appointment_id);
          if (from !== undefined && (from.date !== to.date || from.time !== to.time)) parts.push(`${TYPE_KO[d.kind]} ${from.time} → ${to.time}도 같이 바뀜`);
        }
      }
      parts.push("카드의 [바꾸기]로");
      return parts.join(" · ");
    }
    case "ALARM_NEW":
      return `${c.summary} · 카드의 [저장]으로`;
    case "APPT_OPEN":
      return `${c.summary} · 카드의 [변경하기]로`;
  }
}

// ───────── 그룹 일정 고르기 ─────────

// 음성 인식 문자열에 섞인 WORD JOINER(\u2060) · 제로폭 문자는 사람이 보는 그룹명을 바꾸지 않지만 문자열 비교를 깨뜨린다.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/gu;
const squash = (t: string): string => t.replace(INVISIBLE, "").replace(/\s+/gu, "").toLowerCase();
// '개인 과제'처럼 일정 종류가 아닌 '개인'은 고른 말로 보지 않음
const PERSONAL_RE = /개인(일정|으로|약속)|혼자|나만/u;

/** 말에 나온 그룹 이름(더 긴 이름에 들어 있는 짧은 이름은 뺌)과 이름을 지운 나머지 말 — 그룹 이름 안의 '그룹'을 '그룹이라고 말함'으로 치지 않게 */
function readGroups(groups: GroupRef[], text: string): { named: GroupRef[]; rest: string } {
  const said = squash(text);
  const hit = groups.filter((g) => squash(g.name) !== "" && said.includes(squash(g.name)));
  const named = hit.filter((g) => !hit.some((o) => squash(o.name) !== squash(g.name) && squash(o.name).includes(squash(g.name))));
  const rest = named.reduce((t, g) => t.split(squash(g.name)).join(" "), said);
  return { named, rest };
}

// 그룹 이름 끝의 묶음 말 — '캡스톤팀'의 핵심은 '캡스톤'
const GROUP_TAIL = /(팀|조|그룹|모임|소모임|동아리|반)$/u;
// 낱말 끝 조사 — '캡스톤이랑' → '캡스톤'
const PARTICLE = /(으로|에서|이랑|하고|까지|부터|랑|은|는|이|가|을|를|에|의|로|과|와|도|만)$/u;
// 일정 · 날짜 · 요청 말처럼 흔한 낱말은 그룹 이름 일부와 같아도 후보로 안 봄 ('알고리즘 스터디' 그룹 ↔ "스터디 잡아줘")
const COMMON_WORDS = new Set([
  "회의", "미팅", "모임", "스터디", "수업", "강의", "과제", "프로젝트", "발표", "시험", "면접", "약속", "일정", "그룹", "팀", "동아리", "개인",
  "내일", "오늘", "모레", "글피", "이번", "다음", "주말", "오전", "오후", "아침", "점심", "저녁", "새벽", "밤",
  "학교", "회사", "알람", "잡아줘", "잡아", "해줘", "넣어줘", "추가", "등록", "만들어줘", "있어", "있어요",
]);

// 'X 그룹'의 X가 그룹 이름이 아닌 말 ('우리 그룹' · '어느 그룹')
const NOT_GROUP_NAME = new Set(["우리", "내", "제", "저", "이", "그", "어느", "무슨", "다른", "같은", "새", "새로운", "전체", "단체", "반", "시", "분"]);

/** 말에서 'X 그룹'의 X가 가입한 그룹(정확히 · 이름 앞부분)이 아니면 X — 없는 그룹을 말함. 그런 말이 없으면 null ('그룹 알람'처럼 이름 없이 '그룹'만이면 null) */
export function missingGroup(groups: GroupRef[], text: string): string | null {
  // '모바일 앱팀' · '403팀'처럼 띄어쓰기나 숫자가 있는 가입 그룹도 먼저 확인한다.
  // 정규식으로 끝 낱말('앱팀' · '팀')만 잡아 존재하지 않는 그룹으로 오인하지 않도록 한다.
  if (readGroups(groups, text).named.length > 0) return null;
  for (const m of text.replace(INVISIBLE, "").matchAll(/([가-힣A-Za-z0-9]+?)\s*그룹/gu)) {
    const w = m[1] as string;
    // "내일 3시 그룹 회의" / "10시 반 그룹"의 시각 표현은 그룹명이 아니다.
    if (NOT_GROUP_NAME.has(w) || COMMON_WORDS.has(w) || /^\d+(?:시|분)$/u.test(w)) continue;
    if (readGroups(groups, w).named.length > 0 || partialGroups(groups, w).length > 0) continue;
    return w;
  }
  return null;
}

/** 일정 제목에 섞인 없는 그룹 이름을 뺌 — '가족 그룹 약속' · '가족 약속' → '약속' (그룹 이름을 제목으로 쓰지 않음) */
export function stripGroupName(title: string, name: string): string {
  const t = title.replace(new RegExp(`${name}\\s*그룹\\s*`, "gu"), "").trim();
  return t.startsWith(`${name} `) ? t.slice(name.length).trim() : t;
}

/**
 * 이름을 정확히 말하지 않았을 때의 후보 — 말의 낱말(조사를 떼고 2글자 이상, 숫자 · 흔한 말 제외)이 그룹 이름 앞부분과 같고,
 * 그 낱말이 이름 핵심(끝의 팀 · 조 · 그룹 … 뺀 것)의 절반 이상일 때만 ('캡스톤' → '캡스톤팀' O, '캡' · '디자인' → '캡스톤디자인팀' X)
 * 부분 일치는 후보를 찾는 데만 씀 — 이걸로 그룹을 확정하지 않음
 */
function partialGroups(groups: GroupRef[], text: string): GroupRef[] {
  const words = text
    .split(/[\s,.!?·~]+/u)
    .map((w) => squash(w).replace(PARTICLE, ""))
    .filter((w) => [...w].length >= 2 && !/\d/u.test(w) && !COMMON_WORDS.has(w));
  return groups.filter((g) => {
    const name = squash(g.name);
    const core = name.replace(GROUP_TAIL, "") || name;
    return words.some((w) => core.startsWith(w) && [...w].length * 2 >= [...core].length);
  });
}

/**
 * 새 일정의 그룹 선택 — 말 · 제목에 가입한 그룹 이름(일부)이나 '그룹'이 나올 때만 (없으면 undefined = 개인 일정, 묻지 않음).
 * '개인'이라고 말함 → PERSONAL · 이름을 정확히(띄어쓰기 무시) 말하고 '그룹'이라고 함, 또는 이름 없이 '그룹'이라고 했는데 가입 그룹이 하나 → GROUP
 * 그 밖(이름 일부만 · 이름만 · 후보 여럿) → ASK. 후보는 정확히 맞은 그룹 → 없으면 부분 일치 그룹 → 없으면 가입한 그룹 모두
 * 가입한(JOINED) 그룹 밖에서 고르거나 새 그룹을 만들지 않음
 */
export function groupOf(groups: GroupRef[] | undefined, text: string): CardGroup | undefined {
  if (groups === undefined) return undefined;
  const { named, rest } = readGroups(groups, text);
  const partial = named.length === 0 ? partialGroups(groups, text) : [];
  // 가입하지 않은 그룹 이름('가족 그룹') — 다른 그룹이나 개인 일정으로 정하지 않고 묻기만 ('개인'이라고 같이 말했으면 개인)
  const missing = named.length === 0 && partial.length === 0 ? missingGroup(groups, text) : null;
  if (missing !== null) return { choice: PERSONAL_RE.test(rest) ? "PERSONAL" : "ASK", id: null, candidates: [], missing };
  if (groups.length === 0) return undefined;
  const saidGroup = rest.includes("그룹");
  if (named.length === 0 && partial.length === 0 && !saidGroup) return undefined;
  const candidates = named.length > 0 ? named : partial.length > 0 ? partial : groups;
  if (PERSONAL_RE.test(rest)) return { choice: "PERSONAL", id: null, candidates };
  if (saidGroup && candidates.length === 1 && partial.length === 0) return { choice: "GROUP", id: (candidates[0] as GroupRef).id, candidates };
  return { choice: "ASK", id: null, candidates };
}

/** 그룹 질문(ASK)에 대한 사용자 답 — 후보 이름 하나 · '개인' · (후보가 하나면) '그룹'. 둘 다 말했거나 못 알아들으면 null (다시 물음) */
export function groupAnswer(g: CardGroup, text: string): CardGroup | null {
  const { rest } = readGroups(g.candidates, text);
  // 이름 뒤에 고르는 말이 붙어야 답 — '캡스톤 회의 11시로 바꿔줘'의 '캡스톤'은 고른 것이 아님
  //   이미 물은 후보 안에서 고르는 답이라 이름 핵심('캡스톤팀' → '캡스톤')으로 답해도 받음
  const said = squash(text);
  const keys = (c: GroupRef): string[] => {
    const name = squash(c.name);
    const core = name.replace(GROUP_TAIL, "");
    return [...core].length >= 2 ? [name, core] : [name];
  };
  const named = g.candidates.filter((c) => keys(c).some((k) => ["그룹", "으로", "로", "일정"].some((x) => said.includes(k + x))));
  const personal = PERSONAL_RE.test(rest);
  if (personal && named.length === 0) return { ...g, choice: "PERSONAL", id: null };
  if (personal) return null;
  const pick = named.length === 1 ? named[0] : named.length === 0 && rest.includes("그룹") && g.candidates.length === 1 ? g.candidates[0] : undefined;
  return pick === undefined ? null : { ...g, choice: "GROUP", id: pick.id };
}

const groupName = (g: CardGroup): string => g.candidates.find((x) => x.id === g.id)?.name ?? "";

/** 받침에 맞는 조사 — '약속'을 · '회의'를 */
const josa = (word: string, withFinal: string, without: string): string => {
  const code = (word.trim().at(-1) ?? "").charCodeAt(0) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0 ? withFinal : without;
};

/** 그룹 질문을 사용자에게 할 말 (T1이 물음을 안 냈을 때 서버가 그대로 씀) */
export function groupSay(c: Card): string | null {
  if (c.group?.choice !== "ASK" || c.draft === null) return null;
  const t = c.draft.title;
  const names = c.group.candidates.map((g) => g.name);
  if (names.length === 0) return `${c.group.missing ?? ""} 그룹을 찾을 수 없어요. 그룹을 만들거나 '${t}'${josa(t, "을", "를")} 개인 일정으로 등록할까요?`;
  return names.length === 1
    ? `'${t}'${josa(t, "을", "를")} ${names[0]} 그룹 일정으로 등록할까요, 개인 일정으로 등록할까요?`
    : `'${t}'${josa(t, "은", "는")} ${names.join(", ")} 중 어느 그룹 일정인가요, 아니면 개인 일정인가요?`;
}

/** 되물을 것 줄과 사용자에게 할 말을 같이 넣음 (같은 줄은 한 번) */
function ask(ev: ServerEvent, line: string, say: string | null): void {
  if (!ev.clarify.includes(line)) ev.clarify.push(line);
  if (say !== null) ev.say = { ...(ev.say ?? {}), [line]: say };
}

/** 그룹 질문 (서버 문구) — 그룹 · 개인 일정을 아직 안 고른(ASK) 새 일정 카드. T1이 이 줄로 묻고, 답 전엔 저장을 권하지 않음 */
export function groupQuestion(c: Card): string | null {
  if (c.group?.choice !== "ASK" || c.draft === null) return null;
  const names = c.group.candidates.map((g) => g.name);
  if (names.length === 0) {
    return `${GROUP_ASK_HEAD} '${c.group.missing ?? ""}' 그룹을 찾을 수 없음(가입한 그룹이 아님) — 그룹을 먼저 만들지, '${c.draft.title}'을 개인 일정으로 등록할지 (AI는 그룹을 만들지 않음 · 다른 그룹으로 정하지 않음 · 카드의 개인 일정 칩으로 골라도 됨)`;
  }
  // '그룹 선택'으로 시작 — 장소 고르기 줄과 섞이지 않게 (이 줄에는 '장소'라는 말을 쓰지 않음: T1은 '장소'가 든 되물을 것에 [장소 고르기]를 안내함)
  return names.length === 1
    ? `${GROUP_ASK_HEAD} 가입한 '${names[0]}' 그룹이 있음 — '${c.draft.title}'을 ${names[0]} 그룹 일정으로 등록할지, 개인 일정으로 등록할지 (카드의 그룹 · 개인 일정 칩으로 골라도 됨)`
    : `${GROUP_ASK_HEAD} 가입한 그룹 중 '${c.draft.title}'이 어느 그룹(${names.join(" · ")}) 일정인지 먼저 고르기 — 그룹 일정이 아니면 개인 일정 (카드의 그룹 · 개인 일정 칩으로 골라도 됨)`;
}

/** 장소 고르기 줄 — 장소를 정해야 하는(NEEDS_PLACE) 새 일정 카드만 냄 */
export const placeAskLine = (title: string): string => `'${title}' 장소 (카드의 ${PLACE_PICK})`;

/** 이번 말(j)에 장소 고르기 줄이 남은 카드마다 왜 못 정했는지 + 고르라는 서버 문장 — 없으면 null (단순히 버튼만 누르라고 하지 않게) */
export function placeSayOf(s: TurnState, j: number): string | null {
  const e = eventAt(s.events, j);
  const says = s.cards.flatMap((c) => {
    if (c.status !== "NEEDS_PLACE" || c.draft === null || !e?.clarify.includes(placeAskLine(c.draft.title))) return [];
    const { title } = c.draft;
    const heard = c.draft.place?.trim() ?? "";
    const what = heard ? `'${heard}'${josa(heard, "이", "가")}` : `'${title}' 장소가`;
    return [`${what} 정확히 어디인지 확인하기 어려워요. 카드의 '장소 고르기'를 눌러 ${title} 장소를 직접 선택해 주세요.`];
  });
  return says.length === 0 ? null : says.join(" ");
}

/** 카드가 낸 되물을 것 줄 (그룹 선택 · 장소 고르기 · 알람 계산 · 계산 실패 문구 · 기상 확인) — 저장 · 거절한 카드의 질문을 다시 쓰지 않게 지울 때 */
function cardAskLines(c: Card): string[] {
  const title = c.draft?.title ?? c.edit?.before?.title ?? c.summary;
  const group = c.group ? groupQuestion({ ...c, group: { ...c.group, choice: "ASK" } }) : null;
  const lines = [group, placeAskLine(title), `'${title}' 알람 계산`, c.error, wakeQuestion(c), `'${title}' 날 몇 시에 일어날지 (정확한 시각)`];
  return lines.filter((l): l is string => typeof l === "string" && l !== "");
}

/** 지난 처리 결과의 되물을 것에서 풀린 줄을 지움 — 남겨 두면 T1이 이미 끝난 질문 · 안내를 되풀이함 */
function forgetLines(s: TurnState, lines: readonly (string | null)[]): void {
  const gone = new Set(lines.filter((l): l is string => l !== null));
  if (gone.size === 0) return;
  for (const e of s.events) e.clarify = e.clarify.filter((l) => !gone.has(l));
}

/** 저장 안내에 붙일 그룹 결과 — 그룹 말이 있던 카드만 */
function groupSavedText(c: Card): string | null {
  if (c.group?.choice === "GROUP") return `${groupName(c.group)} 그룹 일정으로 저장 (알람은 내 것만)`;
  if (c.group?.choice === "PERSONAL") return "개인 일정으로 저장";
  return null;
}

/** 이번 말(j)의 되물을 것 중 아직 남은 줄의 서버 문장 (첫 줄) — 없으면 null */
export function serverAskOf(s: TurnState, j: number): string | null {
  const e = eventAt(s.events, j);
  const line = e?.clarify.find((l) => e.say?.[l] !== undefined);
  return line === undefined ? null : (e?.say?.[line] as string);
}

/** 기상 확인 질문 (서버 문구) — 할 일이 있는 새 일정 카드가 계산된 뒤 (T1 · Live가 이 줄로 물음) */
export function wakeQuestion(c: Card): string | null {
  const w = wakeOf(c.digest);
  if (c.pre_task === undefined || c.draft === null || w === null) return null;
  return `'${c.draft.title}' 기상 알람이 ${w.time}으로 계산됨 — 나가기 전 할 일(${c.pre_task.title})이 있다고 했으니 이 시각에 일어날지, 몇 시에 일어날지`;
}

/**
 * 사용자 말 j 뒤 처리 결과에 기상 질문(wakeQuestion)이 있으면 그 기상 시각(말 표기)과 서버가 직접 물을 문장 — 없으면 null.
 * T1이 이 질문 대신 준비물 같은 선택 질문을 하면(11/20 "나가기 전에 뭐 좀 해야 돼" → 준비물 질문) turn.ts가 이 문장으로 바꿈
 */
export function wakeAskOf(s: TurnState, j: number): { spoken: string; sentence: string } | null {
  const clarify = eventAt(s.events, j)?.clarify ?? [];
  for (const c of s.cards) {
    const q = c.pre_task?.wake === "ASK" ? wakeQuestion(c) : null;
    const w = wakeOf(c.digest);
    if (q === null || w === null || !clarify.includes(q)) continue;
    const [h, m] = w.time.split(":").map(Number) as [number, number];
    const spoken = spokenTime(h, m);
    return { spoken, sentence: `${(c.draft as ApptDraft).title} 전에 할 일이 있으시군요. 추천 기상 시각은 ${spoken}인데, 그대로 일어나실 건가요, 더 일찍 일어나실 건가요?` };
  }
  return null;
}

/**
 * T1 답이 기상 확인을 제대로 물었는지 — 물음 문장 하나 안에 정확한 기상 시각(앞말 포함, 뒤에 다른 분이 붙지 않음)과 일어나는 말이 있고, 출발 · 준비물을 묻지 않을 때만.
 * 애매하면 false (서버 문장으로 보완). "오전 1시"는 "오전 11시" · "오전 1시 30분"과 맞지 않음
 */
export function asksWake(reply: string, spoken: string): boolean {
  const at = new RegExp(`${spoken}(?!\\s*\\d+분)`, "u");
  return splitSentences(reply).some((s) => isQuestion(s) && at.test(s) && /일어나|일어날|깨/u.test(s) && !/출발|준비물|챙기|챙길|준비 시작/u.test(s));
}

/** 카드가 READY일 때 처리 결과에 '확인 필요' 줄을 (다시) 넣는다 — 같은 c#은 한 줄로
 *   나가기 전 할 일이 있고 기상 답을 아직 못 받았으면(ASK) 저장을 권하지 않고 기상 질문만 (답 전엔 저장 안 함) */
function pushPending(ev: ServerEvent, c: Card, s: TurnState): void {
  // 그룹 · 개인 일정을 아직 안 골랐으면 저장을 권하지 않고 그 질문만 (답 전엔 저장 안 함)
  const gq = groupQuestion(c);
  if (gq !== null) {
    ask(ev, gq, groupSay(c));
    ev.pending = ev.pending.filter((p) => p.id !== c.id);
    return;
  }
  if (c.pre_task?.wake === "ASK") {
    const q = wakeQuestion(c);
    if (q !== null) {
      if (!ev.clarify.includes(q)) ev.clarify.push(q);
      ev.pending = ev.pending.filter((p) => p.id !== c.id);
      return;
    }
    // 계산된 사슬에 기상 알람이 없음(기존 규칙 — 그날 앞 일정의 기상이 있음 등): 물을 기상 시각이 없으니 새 기상을 만들지 않고 그대로 진행
    if (c.digest !== null) c.pre_task = { ...c.pre_task, wake: "KEEP", time: null };
  }
  const item: PendingItem = { id: c.id, kind: pendingKindOf(c.kind), summary: pendingText(c, s) };
  const at = ev.pending.findIndex((p) => p.id === c.id);
  if (at >= 0) ev.pending[at] = item;
  else ev.pending.push(item);
}

// ───────── 앱이 보낸 요약 검사 (설계 메모 5절 "앱이 보낸 요약도 믿지 않음") ─────────

export interface RawDigest {
  alarms: { kind: AlarmType; at: string; enabled: boolean; level?: number | null }[];
  level?: number | null;
  with_wake?: boolean;
  basis?: unknown; // 앱이 L1 결과에서 준 기상 근거(분) — 믿지 않고 checkBasis로 검사
}

/** 근거 분 값 하나의 범위 */
export const BASIS_MAX_MINUTES = 600;
/** 기상 시각과 (약속 − 이동 − 준비 − 여유)가 이만큼(분)까지 어긋나도 반올림으로 보고 맞는 것으로 침 */
export const BASIS_TOLERANCE_MINUTES = 1;

/**
 * 앱이 보낸 기상 알람 근거를 검사한다 — 정수 · 0~600 · 기상 시각 = 약속 − 이동 − 준비 − 여유 (±1분)일 때만 그 값을 돌려주고, 아니면(빠짐 · 모양 이상 · 합이 안 맞음) null.
 * 서버가 값을 계산해 만들지 않는다: 앱이 준 값을 맞는지 보고 그대로 쓸 뿐. null이면 근거 줄을 만들지 않아 AI는 "근거는 모른다"고 한다.
 */
export function checkBasis(raw: unknown, wake: LocalDateTime | null, apptAt: LocalDateTime | null): Basis | null {
  if (!isObj(raw) || wake === null || apptAt === null) return null;
  const f = (k: string): number | null => {
    const v = raw[k];
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= BASIS_MAX_MINUTES ? v : null;
  };
  const travel = f("travel_minutes");
  const prepare = f("prepare_minutes");
  const buffer = f("buffer_minutes");
  if (travel === null || prepare === null || buffer === null) return null;
  const gap = minutesBetween(wake, apptAt); // 기상 → 약속
  if (Math.abs(gap - (travel + prepare + buffer)) > BASIS_TOLERANCE_MINUTES) return null;
  return { travel_minutes: travel, prepare_minutes: prepare, buffer_minutes: buffer };
}

/** '기상 = 약속 09:00 − 이동 41분 − 준비 45분 − 여유 14분' — 처리 결과 알람 줄에 덧붙이는 근거 (검사를 통과한 값만) */
export function basisText(b: Basis, wake: LocalDateTime, apptAt: LocalDateTime): string {
  return `근거 기상 ${wake.time} = 약속 ${apptAt.time} − 이동 ${b.travel_minutes}분 − 준비 ${b.prepare_minutes}분 − 여유 ${b.buffer_minutes}분`;
}

/** 약속이 없는 카드(ALARM_NEW 등)의 알람은 지금부터 이 시간(분) 안이어야 함 (리뷰 #261) */
export const NO_APPT_MAX_AHEAD_MINUTES = 48 * 60;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 앱이 보낸 알람 요약이 받을 만한지 — 모양(객체 · 배열) · 종류 ∈ RING_KINDS · 시각이 지금 뒤 · 약속 앞 · 약속 24시간 안 · 강도 0~2(또는 null).
 * 약속이 없으면(apptAt null) 약속 기준 검사 대신 지금부터 48시간 상한. 받을 수 있으면 null, 아니면 이유 글. 예외를 던지지 않는다.
 */
export function checkDigest(d: RawDigest | null | undefined, now: LocalDateTime, apptAt: LocalDateTime | null): string | null {
  if (!isObj(d) || !Array.isArray(d.alarms)) return "계산 요약이 없음";
  const okLevel = (v: unknown): boolean => v === null || v === undefined || v === 0 || v === 1 || v === 2;
  if (!okLevel(d.level)) return "강도가 0~2 밖";
  for (const a of d.alarms as unknown[]) {
    if (!isObj(a)) return "알람 요약 원소가 객체가 아님";
    if (!(RING_KINDS as readonly string[]).includes(a["kind"] as string)) return `알람 종류 ${String(a["kind"])}는 울리는 알람이 아님`;
    if (typeof a["enabled"] !== "boolean") return "켜짐 값이 이상함";
    if (!okLevel(a["level"])) return "강도가 0~2 밖";
    let at: LocalDateTime;
    try {
      at = isoToLocal(a["at"] as string);
    } catch {
      return "시각 형식이 이상함";
    }
    if (minutesBetween(now, at) <= 0) return "이미 지난 시각";
    if (apptAt !== null) {
      if (minutesBetween(at, apptAt) <= 0) return "약속 뒤 시각";
      if (minutesBetween(at, apptAt) > 24 * 60) return "약속 24시간 밖";
    } else if (minutesBetween(now, at) > NO_APPT_MAX_AHEAD_MINUTES) {
      return "지금부터 48시간 밖";
    }
  }
  return null;
}

/** 앱이 보낸 알람 시각이 카드가 요청한 시각(edit.times · edit.at)과 같은지 — 다르면 처리 결과로 쓰지 않음. 같거나 요청이 없으면 null */
function checkAgainstCard(c: Card, alarms: unknown): string | null {
  if (!Array.isArray(alarms)) return null;
  const same = (x: string, y: string): boolean => {
    try {
      const a = isoToLocal(x);
      const b = isoToLocal(y);
      return a.date === b.date && a.time === b.time;
    } catch {
      return false;
    }
  };
  if (c.kind === "ALARM_NEW" && c.edit?.at !== undefined) {
    for (const a of alarms) {
      if (!isObj(a)) continue;
      if (a["kind"] !== "WAKE") return "요청과 다른 알람 종류";
      if (!same(a["at"] as string, c.edit.at)) return "요청한 시각과 다름";
    }
  }
  if (c.kind === "ALARM_EDIT" && c.edit?.times !== undefined) {
    for (const a of alarms) {
      if (!isObj(a)) continue;
      const want = c.edit.times[a["kind"] as AlarmType];
      if (want !== undefined && !same(a["at"] as string, want)) return "요청한 시각과 다름";
    }
  }
  return null;
}

/** 순수 함수가 받은 입력 모양이 이상할 때 던지지 않고 돌려주는 거절 (voice-turn이 VALIDATION_FAILED로 바꿈) */
export interface Rejected {
  ok: false;
  reason: string;
}

function resultsShapeProblem(results: unknown): string | null {
  if (!isObj(results)) return "results가 객체가 아님";
  for (const k of ["cards", "fixes"]) {
    const v = results[k];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return `results.${k}가 배열이 아님`;
    for (let i = 0; i < v.length; i++) {
      const e: unknown = v[i];
      if (!isObj(e) || typeof e["id"] !== "string") return `results.${k}[${i}]가 id 있는 객체가 아님`;
    }
  }
  return null;
}

function actionShapeProblem(action: unknown): string | null {
  if (!isObj(action) || typeof action["id"] !== "string") return "card_action이 id 있는 객체가 아님";
  if (action["action"] !== "SAVED" && action["action"] !== "REJECTED" && action["action"] !== "GROUP") return "card_action.action이 SAVED · REJECTED · GROUP이 아님";
  if (action["group_id"] !== undefined && action["group_id"] !== null && typeof action["group_id"] !== "string") return "card_action.group_id가 글자가 아님";
  if (action["alarms"] !== undefined && !Array.isArray(action["alarms"])) return "card_action.alarms가 배열이 아님";
  return null;
}

/** 앱이 준 오류 문구 — 한 줄, 80자까지 (DB · 네트워크 원문이 그대로 화면에 가지 않게) */
export const APP_ERROR_MAX_CHARS = 80;
function cleanAppError(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\r\n\v\f\u0085\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
  return t === "" ? null : [...t].slice(0, APP_ERROR_MAX_CHARS).join("");
}

// ───────── 빠른 추출 처리 ─────────

export interface FastResult {
  state: TurnState;
  /** 이번 사용자 말 뒤 처리 결과 (앱 일이 있으면 아직 반쪽 — applyTaskResults가 이어서 채움) */
  event: ServerEvent;
  /** 이번에 만들었거나 바뀐 카드 + 앱이 계산해야 할 카드 */
  cards: Card[];
  /** 앱이 반영해야 할 기록 정정 */
  fixes: Fix[];
  /** true면 next = APP_TASKS (앱이 cards의 NEEDS_ESTIMATE · fixes를 하고 results로 돌려줌, 이 턴은 T1 미리 답을 버림) */
  tasks: boolean;
  /** 위기 턴이라 앱 일을 다음 턴으로 미룸 */
  deferred: boolean;
}

const toFix = (f: FixRecord): Fix => ({ id: f.id, fact: f.fact, kind: f.kind, participant_id: f.participant_id, action: f.action, to: f.to });

/**
 * T2F 추출(현재 상태) 하나를 처리한다. state는 바꾸지 않고 새 state를 돌려준다.
 * event에는 이번에 새로 생긴 것 · 바뀐 것만 담긴다 (pending · rejected · clarify · applied · 위기 안내 …). 같은 항목은 한 번만 처리하고 c# 번호는 턴이 지나도 그대로.
 * afterTurn(j) = 몇 번째 사용자 말인지(1부터). userText = 이번 사용자 말 — 주면 고칠 대상 찾기(intentOf · mentionedAppts)를 켬.
 */
export function applyFast(state: TurnState, fast: FastExtract, ctx: Context, afterTurn: number, userText?: string): FastResult {
  const s: TurnState = structuredClone(state);
  // T2F 결과는 다음 턴 · 시험에서 재사용될 수 있으므로 입력 객체를 변경하지 않는다.
  const extract = expandFast(structuredClone(fast));
  const intent = userText === undefined ? null : intentOf(userText);
  // 말에 나온 일정 (최신 말이 앞 대화 · 추출의 약속 번호보다 우선)
  const hits = intent === null ? null : mentionedAppts(s.appointments, intent.text);
  const ev = newEvent(afterTurn);
  // 이번 말이 알람 상대 변경("준비 알람 10분 당겨줘" · 이어서 "5분 더") — 일정 시각 · 준비시간 변경으로 처리하지 않음
  const alarmShiftTurn = intent !== null && shiftSaid(intent.text) &&
    (intent.alarm || intent.typeNamed || extract.alarm_changes.some((c) => (c.shift ?? 0) !== 0));
  const seen0 = { ...s.seen }; // 이번 말 전 처리 기록 — 거절한 일정을 다시 청했는지(저장해 달라는 말이 새로 생김) 볼 때
  // 새로 가입한 그룹은 현재 턴의 ctx.groups에 반영된다.
  // 이전 카드의 "없는 그룹" 판정과 seen 중복 기록 때문에 동일한 요청을 영원히 막지 않도록 한다.
  const mentionedGroup = userText === undefined ? undefined : groupOf(ctx.groups, userText);
  const missingNow = mentionedGroup?.missing ?? null;
  const knownNamed = userText === undefined ? undefined : ctx.groups?.find((g) =>
    squash(userText).includes(`${squash(g.name)}그룹`));
  const latestMissing = [...s.cards].reverse().find((c) =>
    c.kind === "APPT_NEW" && c.status === "REJECTED" && c.draft !== null && c.group?.missing !== undefined &&
    knownNamed !== undefined && squash(knownNamed.name) === squash(c.group.missing as string));
  // 아직 열려 있는 카드도 그룹 탭에서 새로 만든 그룹을 적용할 수 있도록 같은 카드를 재사용한다.
  const openMissing = [...s.cards].reverse().find((c) =>
    c.kind === "APPT_NEW" && OPEN_STATUS.includes(c.status) && c.draft !== null &&
    c.group?.choice === "ASK" && c.group.missing !== undefined && knownNamed !== undefined &&
    squash(c.group.missing) === squash(knownNamed.name));
  for (const x of extract.appointments) {
    if (x.ref !== null) continue;
    if (openMissing?.draft && knownNamed && x.date === openMissing.draft.date && x.time === openMissing.draft.time &&
      squash(x.title).startsWith(`${squash(knownNamed.name)}그룹`)) {
      x.title = openMissing.draft.title;
      continue;
    }
    const original = x.title;
    const oldKey = `appt:${normTitle(original)}|${x.date ?? "?"}|${x.time ?? "?"}`;
    const rememberedKey = `group-missing-title:${normTitle(original)}|${x.date ?? "?"}|${x.time ?? "?"}`;
    const finalTitleKey = `group-missing-final:${normTitle(original)}|${x.date ?? "?"}|${x.time ?? "?"}`;
    const sameRetry = latestMissing?.draft?.date === x.date && latestMissing?.draft?.time === x.time;
    // T2F는 앞 대화까지 다시 뽑는다. 이미 처리한 과거 일정은 이번 말의 재요청이 아니면 손대지 않는다.
    if (seen0[oldKey] !== undefined && !sameRetry) continue;
    const name = s.seen[rememberedKey] ?? missingNow ?? knownNamed?.name;
    if (name === undefined || name === null) continue;
    const prefix = `${squash(name)}그룹`;
    const explicit = squash(original).startsWith(prefix);
    const cleaned = stripGroupName(original.replace(INVISIBLE, ""), name);
    // T2F가 "가족 그룹 약속" 대신 "가족 약속"으로 뽑아도 사용자 말에 '약속'이 있으면 정상 제목으로 바꾼다.
    // 하지만 지난 대화에서 나온 '가족 여행'처럼 전혀 다른 제목은 손대지 않는다.
    const implied = cleaned !== original && cleaned !== "" && userText !== undefined &&
      squash(userText).includes(squash(cleaned)) &&
      (missingNow !== null || (sameRetry && latestMissing?.draft && nearTitle(latestMissing.draft.title, cleaned)));
    if (!explicit && !implied) continue;
    // 가입한 정상 그룹의 '모바일 앱팀 그룹 회의'처럼 제목이 붙은 경우는 기존 제목을 유지한다.
    // 그룹 이름만 제목이 됐거나, 과거 '없는 그룹'을 같은 일정으로 다시 청한 경우만 정정한다.
    if (missingNow === null && !sameRetry && squash(original) !== prefix && s.seen[rememberedKey] === undefined) continue;
    // 최초 요청에서 정한 제목을 다음 턴에도 재사용한다. "고마워"에는 "약속"이 없더라도 제목을 비우지 않는다.
    // 그룹을 이미 가입한 상태에서 일정 제목을 말하지 않았다면 원래 제목을 유지한다.
    const title = cleaned || s.seen[finalTitleKey] ||
      (userText !== undefined && /약속/u.test(squash(userText)) ? "약속" :
      missingNow !== null || s.seen[rememberedKey] !== undefined ? "" : original);
    if (title === original) continue;
    x.title = title;
    // 그룹이 이미 가입돼 있더라도 원래 T2F 제목을 바꿨다면 대응 관계를 기억해야 한다.
    // 안 그러면 다음 턴 "고마워"에서 옛 제목이 새 일정으로 재생성된다.
    // 변경 전 T2F 제목과 날짜·시각으로만 기억해 무관한 "가족 여행"에 전파하지 않는다.
    // 제목을 몰라 빈 값으로 처리했어도 원문을 기억한다. 다음 턴에 과거 그룹명을 새 카드로 재생성하지 않기 위함.
    s.seen[rememberedKey] = name;
    if (title !== "") s.seen[finalTitleKey] = title;
    if (sameRetry && title !== "" && latestMissing?.draft && nearTitle(latestMissing.draft.title, title)) {
      delete s.seen[`appt:${normTitle(title)}|${x.date ?? "?"}|${x.time ?? "?"}`];
    }
  }
  const touched = new Set<string>();
  if (openMissing !== undefined && knownNamed !== undefined) {
    forgetLines(s, [groupQuestion(openMissing)]); // 이미 풀린 '없는 그룹' 질문을 다시 꺼내지 않는다
    openMissing.group = { choice: "GROUP", id: knownNamed.id, candidates: [knownNamed] };
    touched.add(openMissing.id);
    if (openMissing.status === "READY") pushPending(ev, openMissing, s);
  }
  const now = isoToLocal(ctx.session.now);
  const isPast = (at: LocalDateTime): boolean => minutesBetween(now, at) < 0;

  // ── 공통 도우미 ──
  const once = (key: string, sig: string): boolean => {
    if (s.seen[key] === sig) return false;
    s.seen[key] = sig;
    return true;
  };
  const reject = (target: string, reason: RejectReason): void => {
    ev.rejected.push({ target, reason });
  };
  const pendingIdByKey = (key: string): string | undefined => Object.keys(s.pending).find((id) => s.pending[id]?.key === key);
  const cardById = (id: string): Card | undefined => s.cards.find((c) => c.id === id);
  /** 열린 카드를 거절 상태로 (말로 "저장하지 마" · 되돌림) — 되돌릴 게 없는 쪽이라 말로도 됨(설계 판단) */
  const dropPending = (key: string, id?: string): void => {
    const pid = id ?? pendingIdByKey(key);
    if (pid === undefined) return;
    delete s.pending[pid];
    const c = cardById(pid);
    if (c !== undefined && OPEN_STATUS.includes(c.status)) {
      c.status = "REJECTED";
      c.highlight = false;
      touched.add(pid);
    }
  };
  const apptByRef = (ref: string): Appointment | undefined => s.appointments.find((a) => a.ref === ref);
  const apptDateOf = (ref: string | null): LocalDate | null => (ref === null ? null : apptByRef(ref)?.date ?? null);

  /**
   * 열린 카드를 만들거나 이어 쓴다 (같은 키 · 지정한 c#). 재료가 바뀌면 다시 계산(NEEDS_ESTIMATE), 안 바뀌면 상태 유지.
   * 말 "응"(CONFIRMED)은 highlight만 켜고, 이미 READY인 카드면 같은 c# '확인 필요' 줄을 이번 말 뒤에 다시 낸다.
   */
  const upsertCard = (entry: PendingEntry, kind: CardKind, fill: (c: Card) => void, save: XAppt["save"], reuseId?: string): Card => {
    const pid = reuseId ?? pendingIdByKey(entry.key) ?? `c${++s.pendingSeq}`;
    let c = cardById(pid);
    const isNew = c === undefined;
    if (c === undefined) {
      c = { ...emptyCard(pid, kind), at: ctx.session.now, turn: afterTurn };
      s.cards.push(c);
    }
    const before = JSON.stringify([c.draft, c.edit, c.summary]);
    c.kind = kind;
    fill(c);
    c.first_of_day = kind === "APPT_NEW" ? isFirstOfDay(s, c) : false;
    c.highlight = save === "CONFIRMED";
    const changed = isNew || before !== JSON.stringify([c.draft, c.edit, c.summary]) || !OPEN_STATUS.includes(c.status);
    if (changed) {
      c.status = needsEstimate(c) ? "NEEDS_ESTIMATE" : "READY";
      c.digest = null;
      c.error = null;
    }
    s.pending[pid] = entry;
    touched.add(pid);
    if (c.status === "READY") pushPending(ev, c, s);
    return c;
  };

  // ── 약속 ──
  const apptKey = (x: XAppt): string => (x.ref ? `appt:ref:${x.ref}` : `appt:${normTitle(x.title)}|${x.date ?? "?"}|${x.time ?? "?"}`);
  const presentKeys = new Set(extract.appointments.map(apptKey));

  /** 되물을 것 — T2 unclear 원문(내부 메모 · '오후 18:30' 같은 말)은 넘기지 않고 빈 칸으로 서버 문구를 만든다 */
  /** 되물을 것을 사용자에게 할 말 */
  const apptSay = (x: XAppt): string => {
    if (normTitle(x.title) === "") return "어떤 일정인지 이름을 알려 주시겠어요?";
    const miss = x.date === null && x.time === null ? "날짜와 시각을" : x.date === null ? "날짜를" : "시각을";
    return `'${x.title}' 일정의 ${miss} 알려 주시겠어요?`;
  };
  const clarifyAppt = (x: XAppt): string => {
    if (normTitle(x.title) === "") return `${x.date ? `${dateKo(x.date)} ` : ""}${x.time ? `${x.time} ` : ""}일정의 이름`;
    const miss = [x.date === null ? "날짜" : null, x.time === null ? "시각" : null].filter((v): v is string => v !== null);
    return `'${x.title}'의 정확한 ${miss.join("·")}${x.place === null ? " · 장소" : ""}`;
  };

  /** 기존 약속(targetRef)을 x 값으로 고치는 카드(APPT_OPEN) — [변경하기]면 앱이 appointment-edit로 그 약속을 고치고 알람을 다시 맞춤 (새 약속을 만들지 않음) */
  const changeAppt = (x: XAppt, key: string, targetRef: string, reuseId?: string): void => {
    const cur = apptByRef(targetRef);
    if (!cur) {
      reject(`${x.title} (${targetRef})`, "NOT_FOUND");
      return;
    }
    // 바뀐 날짜 · 시각을 모름(null + 모호 메모, 예: '점심 먹고로 미뤄짐') — 옛 값으로 채우지 않고 빈 칸을 되물음
    if (x.unclear !== null && (x.date === null || x.time === null)) {
      const miss = [x.date === null ? "날짜" : null, x.time === null ? "시각" : null].filter((v): v is string => v !== null);
      ev.clarify.push(`'${normTitle(x.title) === "" ? cur.title : x.title}'의 바뀐 ${miss.join("·")}`);
      return;
    }
    const next: Appointment = {
      ...cur,
      date: x.date ?? cur.date,
      time: x.time ?? cur.time,
      place: x.place ?? cur.place,
      importance: x.importance ?? cur.importance,
      importance_confirmed: x.importance !== null ? true : cur.importance_confirmed,
      transport: x.transport ?? cur.transport,
      repeat: x.repeat ?? cur.repeat,
    };
    const fields = ["date", "time", "place", "importance", "transport", "repeat"] as const;
    if (fields.every((f) => next[f] === cur[f])) {
      // 바뀌는 칸이 없음 — 모호 메모가 붙어 있어도(알람 얘기 등) 되물을 일정 변경이 아님
      dropPending(key, reuseId);
      // 원래 값으로 되돌림 — 이번 추출에서 사라진 이 약속의 '변경' 카드도 거둠 (옛 값 · 새 값이 같이 오면 남김)
      for (const id of Object.keys(s.pending)) {
        const e = s.pending[id] as PendingEntry;
        if (e.kind === "APPOINTMENT" && e.target_ref === targetRef && !presentKeys.has(e.key)) {
          dropPending(e.key, id);
          delete s.seen[e.key]; // 같은 변경(B)이 나중에 다시 오면 새로 처리 (A → B → A → B)
        }
      }
      return;
    }
    const timeMoved = next.date !== cur.date || next.time !== cur.time;
    if (timeMoved && isPast(next)) {
      dropPending(key, reuseId);
      if (x.save !== "DECLINED") reject(appointmentSummary(next), "PAST_TIME");
      return;
    }
    if (x.save === "DECLINED") {
      dropPending(key, reuseId);
      return;
    }
    // 요약에 안 보이는 칸이 바뀌면 덧붙임 (중요도만 바꾸는 확인이 빈 말이 되지 않게)
    const extra = [
      next.importance !== cur.importance && next.importance !== null ? `중요도 ${IMPORTANCE_LABEL[next.importance]}` : null,
      next.repeat !== cur.repeat ? (next.repeat === "WEEKLY" ? "매주" : "이번만") : null,
    ].filter((v): v is string => v !== null);
    // 지금 일정 → 바뀌는 칸만 ("10/9(금) 10:00 캡스톤 발표 · 강남역 → 10/9(금) 11:00")
    const moved = [
      timeMoved ? `${dateKo(next.date)} ${next.time}` : null,
      next.place !== cur.place ? `장소 ${next.place ?? "미정"}` : null,
      next.transport !== cur.transport ? "이동 방법 바꿈" : null,
      ...extra,
    ].filter((v): v is string => v !== null);
    const group = cur.group === undefined ? "" : cur.group === "" ? " (그룹)" : ` (그룹 ${cur.group})`;
    const line = `${appointmentSummary(cur)}${group} → ${moved.join(" · ")}`;
    const changes: NonNullable<CardEdit["changes"]> = {};
    const before: NonNullable<CardEdit["before"]> = { title: cur.title };
    for (const f of ["date", "time", "place", "importance", "transport"] as const) {
      if (next[f] === cur[f]) continue;
      (changes as Record<string, unknown>)[f] = next[f];
      (before as Record<string, unknown>)[f] = cur[f];
    }
    upsertCard(
      { kind: "APPOINTMENT", key, item: x, summary: `변경: ${line}`, target_ref: cur.ref },
      "APPT_OPEN",
      (c) => {
        c.summary = `변경: ${line}`;
        c.draft = null;
        c.edit = { appointment_id: cur.ref, changes, before };
      },
      x.save,
      reuseId,
    );
  };

  /** 새 약속 카드(APPT_NEW) — 앱이 estimateAppointment로 계산하고 [저장]으로 createAppointment */
  const newAppt = (x: XAppt & { date: LocalDate; time: LocalTime }, key: string, reuseId?: string): void => {
    if (x.save === "DECLINED") {
      dropPending(key, reuseId);
      return;
    }
    // 이번 요청에서 새 일정 카드는 하나만 — 날짜 · 시각이 가장 이른 일정 (2026-11-19 팀 결정). 이어 쓰는 카드(같은 c#)는 그대로
    //   일정은 시각순으로 처리하므로 먼저 만든 카드가 가장 이른 일정. 나머지는 이번에 만들지 않고 알림 — 같은 말이 다음 말에서 다시 뽑혀도
    //   once()가 걸러서 사용자가 그 일정을 저장해 달라고(CONFIRMED) 하기 전엔 만들지 않음. 수동 일정 등록 · 다른 화면은 이 규칙과 상관없음
    if (reuseId === undefined && pendingIdByKey(key) === undefined) {
      if (tieKeys.has(key)) {
        const names = extract.appointments.filter((y) => tieKeys.has(apptKey(y))).map((y) => `'${y.title}'`).join(" · ");
        const line = `같은 시각(${dateKo(x.date)} ${x.time})의 일정 ${names} 중 어느 일정부터 등록할지`;
        if (!ev.clarify.includes(line)) ev.clarify.push(line);
        return;
      }
      if (madeNew !== null) {
        ev.conflicts = [...(ev.conflicts ?? []), `우선 ${dateKo(madeNew.date)} ${madeNew.time} '${madeNew.title}' 일정부터 등록 — ${dateKo(x.date)} ${x.time} '${x.title}'은 이번에 만들지 않음`];
        return;
      }
      madeNew = x;
    }
    const summary = appointmentSummary(x);
    const card = upsertCard(
      { kind: "APPOINTMENT", key, item: x, summary, target_ref: null },
      "APPT_NEW",
      (c) => {
        c.summary = summary;
        c.draft = {
          title: x.title, date: x.date, time: x.time, place: x.place,
          importance: x.importance ?? keywordImportance(x.title),
          transport: x.transport, repeat: x.repeat === "WEEKLY" ? [weekdayOf(x.date)] : [],
          items: c.draft?.items ?? [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true },
        };
        // 앞서 붙은 준비시간 가감(prepare_delta)은 새 약속 재료가 바뀌어도 유지
        c.edit = c.edit?.prepare_delta !== undefined ? { prepare_delta: c.edit.prepare_delta } : null;
        // 그룹 선택은 카드를 처음 만든 말 · 제목으로 한 번만 — 재료가 바뀌어도 고른 값 유지
        if (c.group === undefined) {
          // 날짜 없는 그룹 요청의 제목이 '약속' → '점심 약속'으로 구체화되어도
          // 같은 요청의 그룹 후보를 이어받되, 다른 일정('수업')으로 흘리지 않는다.
          const normalized = normTitle(x.title);
          const carried = Object.entries(s.seen).find(([k]) => {
            if (!k.startsWith("group-text:")) return false;
            const prior = k.slice("group-text:".length);
            const priorTime = s.seen[`group-time:${prior}`];
            return prior.length >= 2 && (priorTime === undefined || priorTime === x.time) &&
              (normalized === prior || normalized.includes(prior) || prior.includes(normalized));
          });
          const g = groupOf(ctx.groups, `${userText ?? ""} ${carried?.[1] ?? ""} ${x.title}`);
          if (g !== undefined) c.group = g;
          if (carried !== undefined) {
            const priorTitle = carried[0].slice("group-text:".length);
            // 카드가 없는 시점의 오래된 질문은 이제 새 제목의 카드가 대신한다.
            forgetLines(s, s.events.flatMap((e) => e.clarify.filter((line) =>
              line.startsWith(GROUP_ASK_HEAD) && line.includes(`'${priorTitle}'`))));
            delete s.seen[carried[0]];
            delete s.seen[`group-time:${priorTitle}`];
          }
        }
      },
      x.save,
      reuseId,
    );
    // 계산(장소)을 기다리는 카드라도 그룹 질문은 바로
    const gq = groupQuestion(card);
    if (gq !== null) ask(ev, gq, groupSay(card));
  };

  const handleNewAppt = (x: XAppt, key: string): void => {
    // 이름 · 날짜 · 시각이 비면 되묻기 (모호 메모만 있고 다 채워진 일정은 아래에서 카드로)
    if (normTitle(x.title) === "" || x.date === null || x.time === null) {
      // 그룹을 말했으면(없는 그룹 포함) 카드가 생길 때 쓰려고 이 말을 기억하고, 부족한 정보와 같이 그룹도 알림 — 카드는 만들지 않음
      const g = groupOf(ctx.groups, `${userText ?? ""} ${x.title}`);
      let note = "";
      if (g !== undefined && userText !== undefined) {
        const title = normTitle(x.title) === "" ? "이 일정" : x.title;
        if (normTitle(x.title) !== "") {
          s.seen[`group-text:${normTitle(x.title)}`] = userText;
          s.seen[`group-time:${normTitle(x.title)}`] = x.time ?? "";
        }
        const names = g.candidates.map((c) => c.name);
        const gq = groupQuestion({ draft: { title }, group: g } as unknown as Card);
        if (gq !== null) ask(ev, gq, null);
        note = names.length === 0
          ? `${g.missing ?? ""} 그룹을 찾을 수 없어요. 그룹을 만들거나 개인 일정으로 등록할 수 있어요. `
          : g.choice === "GROUP"
          ? `${names[0]} 그룹 일정으로 만들고, 카드에서 개인 일정으로 바꿀 수 있어요. `
          : `가입한 그룹은 ${names.join(", ")}${josa(names.at(-1) as string, "이에요", "예요")}. 일정이 정해지면 카드에서 그룹 일정인지 개인 일정인지 골라 주세요. `;
      }
      ask(ev, clarifyAppt(x), `${note}${apptSay(x)}`);
      return;
    }
    const xx = { ...x, date: x.date, time: x.time };
    // 1) 이미 열린 같은 항목
    const pid = pendingIdByKey(key);
    if (pid !== undefined) {
      const e = s.pending[pid] as PendingEntry;
      if (e.target_ref) changeAppt(x, key, e.target_ref, pid);
      else newAppt(xx, key, pid);
      return;
    }
    // 2) 이미 있는 약속과 제목 · 날짜 · 시각이 같음 → 그 약속의 장소 · 중요도 등 고침
    //    (지난 시각 검사보다 먼저 — 컨텍스트의 오늘 약속을 ref 없이 되풀이한 것은 거절할 일이 아님)
    const same = s.appointments.find((a) => normTitle(a.title) === normTitle(x.title) && a.date === x.date && a.time === x.time);
    if (same) {
      changeAppt({ ...x, ref: same.ref }, key, same.ref);
      return;
    }
    // 2b) 날짜 · 시각이 같고 제목이 한 글자 안팎만 다른 약속(저장한 카드 포함) · 열린 카드 → 같은 일정을 다시 말했거나 T2F가 앞 말을 다시 뽑으며
    //     글자를 틀리게 낸 것 — 새 카드를 만들지 않고, 틀린 글자로 고치지도 않음 (11/9 웹 시험: 저장한 '스터디 · 도서관' 뒤 상관없는 말에 '스터더 · 도서간' 카드).
    //     [저장 안 함]한 카드도 글자만 다르면 같은 일정 — 되살리지 않음 (정확히 같은 제목으로 다시 청하면 아래에서 새 카드: 거절 뒤 '그래도 저장해줘').
    //     제목이 다른 일정(같은 시각의 '치과')은 그대로 새 카드
    const near = (t: string, d: string | null, h: string | null): boolean => d === x.date && h === x.time && nearTitle(t, x.title);
    if (
      s.appointments.some((a) => near(a.title, a.date, a.time)) ||
      Object.values(s.pending).some((e) => e.kind === "APPOINTMENT" && near((e.item as XAppt).title, (e.item as XAppt).date, (e.item as XAppt).time)) ||
      (rejectedTwin(x) && !askedAgain(x, key))
    ) return;
    // 3) 지난 시각 — 모호 메모보다 먼저. 거절(DECLINED)이면 알릴 것 없음. 같은 일정을 이미 거절했으면 T2 흔들림으로
    //    다시 내지 않고, 사용자가 '그래도 저장해줘'로 확인(CONFIRMED)했을 때만 한 번 더 알림
    if (isPast(xx)) {
      dropPending(key);
      const summary = appointmentSummary(xx);
      const told = s.seen[`past:${summary}`];
      if (x.save !== "DECLINED" && (told === undefined || (told !== "CONFIRMED" && x.save === "CONFIRMED"))) {
        s.seen[`past:${summary}`] = x.save;
        reject(summary, "PAST_TIME");
      }
      return;
    }
    // 앞 모양의 처리 기록을 지움 — A → B → A로 되돌리면 A를 새로 처리해야 함 (안 지우면 '이미 처리함'으로 묻힘)
    const forget = (oldKey: string | undefined): void => {
      if (oldKey !== undefined && oldKey !== key) delete s.seen[oldKey];
    };
    // 4) 대화 중 바뀐 일정: 같은 제목의 열린 카드가 이번 추출에서 사라졌으면 그 c#을 이어 씀
    const superseded = Object.keys(s.pending).find((id) => {
      const e = s.pending[id] as PendingEntry;
      return e.kind === "APPOINTMENT" && !presentKeys.has(e.key) && titleMatch((e.item as XAppt).title, x.title);
    });
    if (superseded !== undefined) {
      const e = s.pending[superseded] as PendingEntry;
      forget(e.key);
      if (e.target_ref) changeAppt(x, key, e.target_ref, superseded);
      else newAppt(xx, key, superseded);
      return;
    }
    // 5) 이 대화에서 카드로 저장한 약속을 고친 것
    const created = Object.keys(s.createdKeys).find((ref) => {
      const a = apptByRef(ref);
      return a !== undefined && !presentKeys.has(s.createdKeys[ref] as string) && titleMatch(a.title, x.title);
    });
    if (created !== undefined) {
      forget(s.createdKeys[created]);
      changeAppt(x, key, created);
      return;
    }
    newAppt(xx, key);
  };

  /**
   * [저장 안 함]한 새 일정 카드와 같은 일정(같은 날짜 · 시각, 제목이 같거나 한 글자 안팎) — T2F가 대화 전체를 다시 뽑으며 낸 것이라 새 일정이 아님.
   * 날짜 · 시각이 같아도 제목이 다른 일정('수업' 거절 뒤 같은 시각 '약속')은 다른 일정
   */
  const rejectedTwin = (x: XAppt): boolean =>
    s.cards.some((c) => c.kind === "APPT_NEW" && c.status === "REJECTED" && c.draft !== null && c.draft.date === x.date && c.draft.time === x.time && nearTitle(c.draft.title, x.title));
  /** 거절한 일정을 다시 청함. 새 일정이 함께 나오면 '수업 말고 치과'의 '수업'은 취소 대상이지 재등록이 아니다. */
  const askedAgain = (x: XAppt, key: string): boolean => {
    const brandNew = extract.appointments.some((y) => y !== x && y.ref === null && seen0[apptKey(y)] === undefined && !rejectedTwin(y));
    if (brandNew) return false;
    if (userText !== undefined && normTitle(x.title) !== "" && squash(userText).includes(squash(x.title))) {
      // 부정/대체 말에 등장한 옛 제목은 재등록 요청으로 취급하지 않는다.
      const afterTitle = squash(userText).split(squash(x.title))[1] ?? "";
      // "수업은 취소야"처럼 조사 뒤에 취소 의사를 밝힌 말은 재등록이 아니다.
      if (/^(?:은|는|이|가|을|를|도|만)?(말고|대신|빼고|취소|안|하지마)/u.test(afterTitle)) return false;
      return true;
    }
    const before = seen0[key];
    return x.save === "CONFIRMED" && before !== undefined && (JSON.parse(before) as unknown[])[0] !== "CONFIRMED";
  };

  // 이번 말에서 새로 카드를 만들 수 있는 일정 중 가장 이른 시각에 둘 이상이면(같은 시각) 어느 것부터인지 되물음 — 이미 있는 약속 · 열린 카드는 빼고 셈
  const freshCandidate = (x: XAppt): boolean =>
    x.ref === null && normTitle(x.title) !== "" && x.date !== null && x.time !== null && x.save !== "DECLINED" && pendingIdByKey(apptKey(x)) === undefined &&
    !s.appointments.some((a) => a.date === x.date && a.time === x.time && nearTitle(a.title, x.title)) &&
    !(rejectedTwin(x) && !askedAgain(x, apptKey(x))) &&
    minutesBetween(now, { date: x.date, time: x.time }) >= 0;
  const atOf = (x: XAppt): number => (x.date === null || x.time === null ? Number.MAX_SAFE_INTEGER : dayNumber(x.date) * 1440 + toMinutes(x.time));
  const fresh = extract.appointments.filter(freshCandidate);
  const earliest = fresh.length > 0 ? Math.min(...fresh.map(atOf)) : null;
  const tieGroup = fresh.filter((x) => atOf(x) === earliest);
  const tieKeys = new Set(tieGroup.length > 1 ? tieGroup.map(apptKey) : []);
  let madeNew: (XAppt & { date: LocalDate; time: LocalTime }) | null = null;

  /** 있는 일정 중 x가 가리키는 것 — 이름이 맞는 일정(없으면 이름 · 그룹 낱말이 겹치는 일정), 같은 날이 있으면 그날 것, 말에 그룹 · 이름이 나왔으면 그것만 */
  const existingFor = (x: XAppt): Appointment[] => {
    let pool = s.appointments.filter((a) => nearTitle(a.title, x.title));
    if (pool.length === 0) {
      const mine = nameWords(x.title);
      pool = s.appointments.filter((a) => nameWords(`${a.title} ${a.group ?? ""}`).some((w) => mine.includes(w)));
    }
    const sameDay = pool.filter((a) => a.date === x.date);
    if (sameDay.length > 0) pool = sameDay;
    const named = hits === null ? [] : pool.filter((a) => hits.best.has(a.ref));
    return named.length > 0 ? named : pool;
  };
  /** 고치라는 말("바꿔 · 옮겨 …")인데 추출이 새 일정(ref 없음)으로 낸 것 — 있는 일정을 찾아 변경 카드로, 못 찾으면 새로 만들지 않음 */
  const editExisting = (x: XAppt, key: string): void => {
    const found = existingFor(x);
    if (found.length === 1) {
      const ref = (found[0] as Appointment).ref;
      changeAppt({ ...x, ref }, key, ref);
      return;
    }
    delete s.seen[key]; // 다음 말("새로 추가해줘" · "24일 거")에서 다시 봄
    if (found.length > 1) ev.clarify.push(`바꿀 일정이 어느 것인지 — ${found.slice(0, 5).map((a) => `${dateKo(a.date)} ${a.time} ${apptName(a).trim()}`).join(" · ")}`);
    else reject(`'${x.title}' 일정 (바꿀 일정 없음)`, "NOT_FOUND");
  };
  /** 알람 시각을 일정 시각으로 잘못 뽑은 것 — "캡스톤 회의 기상 알람 8시로"에서 '캡스톤 회의 08:00' 일정 (같은 시각 알람 변경이 같이 옴) */
  const alarmEcho = (x: XAppt): boolean =>
    intent !== null && intent.alarm && x.time !== null &&
    extract.alarm_changes.some((c) => c.time === x.time) &&
    (x.ref !== null || s.appointments.some((a) => nearTitle(a.title, x.title)));

  // ── 그룹 · 개인 일정 답 ── 앞 말에서 물은(ASK) 가장 최근 새 일정 카드에 이번 말이 그룹 이름 · '개인'으로 답하면 고름
  let groupAnswered = false;
  const asking = userText === undefined ? undefined : s.cards.filter((c) => c.kind === "APPT_NEW" && OPEN_STATUS.includes(c.status) && c.group?.choice === "ASK" && c.turn !== afterTurn).at(-1);
  if (asking !== undefined) {
    const g = groupAnswer(asking.group as CardGroup, userText as string);
    if (g !== null) {
      forgetLines(s, [groupQuestion(asking)]); // 고른 뒤엔 그룹 질문을 다시 쓰지 않음
      asking.group = g;
      groupAnswered = true;
      touched.add(asking.id);
      if (asking.status === "READY") pushPending(ev, asking, s);
    }
  }

  /** 같은 일정 추출의 처리 기록 서명 — 같으면 이미 처리함(once) */
  const apptSig = (x: XAppt): string => JSON.stringify([x.save, x.date, x.time, x.place, x.importance, x.transport, x.repeat, x.unclear !== null]);
  for (const x of [...extract.appointments].sort((a, b) => atOf(a) - atOf(b))) {
    // "캡스톤 그룹으로"라는 답을 T2F가 날짜 · 시각 없는 새 일정으로 뽑은 것 — 되묻지 않음
    if (groupAnswered && x.ref === null && (x.date === null || x.time === null)) continue;
    const key = apptKey(x);
    if (!once(key, apptSig(x))) continue;
    if (alarmEcho(x)) continue;
    if (alarmShiftTurn && (x.ref !== null || (intent as Intent).edit)) continue; // 알람을 당기는 말을 일정 변경으로 잘못 뽑은 것
    if (x.ref) changeAppt(x, key, x.ref);
    else if (intent !== null && intent.edit && !intent.add && normTitle(x.title) !== "") editExisting(x, key);
    else handleNewAppt(x, key);
  }

  // ── 나가기 전 할 일 · 기상 확인 (2026-11-19 팀 결정) ──
  //   할 일은 일정 카드를 만들지 않고, 할 일 시각으로 기상을 계산하지도 않음. 이번 대화의 열린 새 일정 카드(가장 이른 것)에 붙여
  //   앱이 계산한 기상 시각을 사용자에게 묻고(ASK), 답이 오기 전엔 저장하지 않음. 답: 그대로(KEEP) · 시각(SET — 기상만 옮김, 준비 · 출발은 그대로)
  //   "좀 일찍"처럼 시각이 없으면 다시 물음 — 임의로 당기지 않음
  const openNew = s.cards
    .filter((c) => c.kind === "APPT_NEW" && OPEN_STATUS.includes(c.status) && c.draft !== null)
    .sort((a, b) => dayNumber((a.draft as ApptDraft).date) * 1440 + toMinutes((a.draft as ApptDraft).time) - (dayNumber((b.draft as ApptDraft).date) * 1440 + toMinutes((b.draft as ApptDraft).time)))[0];
  const taskTitles = [...new Set((fast.pre_tasks ?? []).map((t) => t.title.trim()).filter((t) => t !== ""))];
  if (openNew !== undefined && taskTitles.length > 0 && openNew.pre_task === undefined) {
    openNew.pre_task = { title: taskTitles.join(" · "), wake: "ASK", time: null };
    touched.add(openNew.id);
    if (openNew.status === "READY") pushPending(ev, openNew, s); // 이미 계산된 카드면 바로 기상 질문
  }
  let wakeReply = fast.wake_reply && fast.wake_reply.choice !== "NONE" ? fast.wake_reply : null;
  // T2F가 기상 답을 알람 변경으로 적은 경우(새 일정의 기상, 약속 번호 없음)도 이 카드의 기상 답으로 — 따로 기상 알람 카드를 만들지 않음
  const redirected = openNew?.pre_task !== undefined
    ? extract.alarm_changes.find((c) => c.target === "u0" && c.type === "WAKE" && c.appointment_ref === null && c.time !== null && c.enabled !== false && (c.date === null || c.date === openNew.draft?.date))
    : undefined;
  if (redirected !== undefined) {
    extract.alarm_changes = extract.alarm_changes.filter((c) => c !== redirected);
    wakeReply ??= { choice: "TIME", time: redirected.time as string };
  }
  if (openNew?.pre_task !== undefined && wakeReply !== null && once(`wake:${openNew.id}`, JSON.stringify(wakeReply))) {
    const card = openNew;
    const pt = card.pre_task as PreTask;
    const d = card.draft as ApptDraft;
    const wakeLine = `'${d.title}' 날 몇 시에 일어날지 (정확한 시각)`;
    const setEdit = (times: CardEdit["times"] | undefined): void => {
      const rest = { ...(card.edit ?? {}) };
      delete rest.times;
      card.edit = times ? { ...rest, times } : Object.keys(rest).length > 0 ? rest : null;
      card.status = "NEEDS_ESTIMATE";
      card.digest = null;
      card.error = null;
    };
    if (wakeReply.choice === "KEEP") {
      const wasSet = pt.wake === "SET";
      card.pre_task = { ...pt, wake: "KEEP", time: null };
      if (wasSet) setEdit(undefined); // 앞서 정한 시각을 거두고 계산된 기상으로
      else if (card.status === "READY") pushPending(ev, card, s);
    } else if (wakeReply.choice === "TIME" && TIME_RE.test(wakeReply.time)) {
      // 약속 시각보다 늦은 시각이면 전날 (새벽 약속의 밤 기상)
      const date = toMinutes(wakeReply.time) <= toMinutes(d.time) ? d.date : addMinutes(d.date, "00:00", -1).date;
      const prep = card.digest?.alarms.find((a) => a.kind === "PREPARE" && a.enabled);
      const prepAt = prep ? isoToLocal(prep.at) : null;
      if (prepAt !== null && minutesBetween({ date, time: wakeReply.time }, prepAt) <= 0) {
        // 준비 알람보다 늦거나 같은 기상 — 저장하지 않고 다시 물음
        card.pre_task = { ...pt, wake: "ASK", time: null };
        ev.clarify.push(`기상 ${wakeReply.time}이 준비 알람 ${prepAt.time}보다 늦어요 — ${prepAt.time} 전에 일어날 시각`);
      } else {
        card.pre_task = { ...pt, wake: "SET", time: wakeReply.time };
        setEdit({ WAKE: localToIso(date, wakeReply.time) });
      }
    } else {
      // VAGUE(또는 시각을 못 읽음) — 정확한 시각을 다시 물음
      card.pre_task = { ...pt, wake: "ASK", time: null };
      if (!ev.clarify.includes(wakeLine)) ev.clarify.push(wakeLine);
    }
    touched.add(card.id);
  }

  // ── 알람 변경 (본인 알람만) ──
  const alarmDay = (a: AlarmPlan): LocalDate => apptDateOf(a.appointment_ref) ?? a.date;
  /** 같은 분에 이미 울리는 본인 알람 (켜진 것) */
  const sameMinuteAlarm = (at: LocalDateTime): AlarmPlan | undefined =>
    s.alarms.find((a) => a.owner === "u0" && a.enabled && a.date === at.date && a.time === at.time);
  /** 알람 변경이 가리키는 날 · 후보 알람 (주인 · 종류 · 약속 또는 날짜가 같은 것) */
  const changeDay = (c: XAlarm): LocalDate =>
    c.date ?? apptDateOf(c.appointment_ref) ?? (ctx.session.type === "AFTER_WAKE" ? ctx.dates.today : ctx.dates.tomorrow);
  const candsOf = (c: XAlarm, day: LocalDate): AlarmPlan[] =>
    s.alarms.filter((a) => a.owner === c.target && a.type === c.type && (c.appointment_ref !== null ? a.appointment_ref === c.appointment_ref : alarmDay(a) === day));

  // 내일 기상 기준 일정의 기상 알람 (준비시간 가감의 대상) · 이번 말의 준비 가감 분
  const prepAnchorWake = (): AlarmPlan | undefined =>
    s.alarms
      .filter((a) => a.owner === "u0" && a.type === "WAKE" && a.enabled && a.appointment_ref !== null && apptDateOf(a.appointment_ref) === ctx.dates.tomorrow)
      .sort((x, y) => dayNumber(x.date) - dayNumber(y.date) || toMinutes(x.time) - toMinutes(y.time) || cmpRef(x.ref, y.ref))[0];
  const prepDelta = (() => {
    const p = extract.prep_adjustment;
    return p && p.save !== "DECLINED" ? prepDeltaOf(p) : null;
  })();
  const impliedByPrep = (cur: AlarmPlan, to: LocalDateTime): boolean => {
    if (prepDelta === null || prepDelta === 0) return false;
    if (cur.type !== "WAKE" && cur.type !== "PREPARE") return false;
    if (prepAnchorWake()?.appointment_ref !== cur.appointment_ref) return false;
    const want = addMinutes(cur.date, cur.time, -prepDelta);
    return want.date === to.date && want.time === to.time;
  };

  /**
   * 알람 변경이 가리키는 본인 알람 후보 — 말에 일정 · 그룹 이름이 나왔고 추출의 약속 번호가 그 일정이 아니면 말을 따름("아니 그거 말고 캡스톤 그룹 알람").
   * 종류를 말하지 않고 바꿀 값도 없으면("25일 알람 수정해줘") 그날 모든 종류가 후보. ask = 말한 날짜에 그 일정이 없어 되물어야 함
   */
  const resolveAlarm = (c: XAlarm, day: LocalDate): { cands: AlarmPlan[]; ask: boolean } => {
    const anyType = intent !== null && !intent.typeNamed && c.time === null && c.intensity === null && c.enabled === null && !c.shift;
    const mine = s.alarms.filter((a) => a.owner === c.target && (anyType || a.type === c.type));
    if (hits !== null && !(c.appointment_ref !== null && hits.all.has(c.appointment_ref))) {
      const pool = mine.filter((a) => a.appointment_ref !== null && hits.best.has(a.appointment_ref));
      if (pool.length > 0) {
        const dated = c.date === null ? pool : pool.filter((a) => apptDateOf(a.appointment_ref) === c.date || a.date === c.date);
        return dated.length > 0 ? { cands: dated, ask: false } : { cands: pool, ask: true };
      }
    }
    return { cands: mine.filter((a) => (c.appointment_ref !== null ? a.appointment_ref === c.appointment_ref : alarmDay(a) === day)), ask: false };
  };
  /** "11/25(수) '캡스톤 회의'(그룹 캡스톤) 기상 07:00" */
  const alarmText = (a: AlarmPlan): string => `${dateKo(a.date)} ${apptName(a.appointment_ref === null ? undefined : apptByRef(a.appointment_ref))}${TYPE_KO[a.type]} ${a.time}`;
  const alarmKeys = new Set<string>();
  /** 합친 알람 고침 카드 줄 — "11/24(화) '캡스톤 회의' 기상 알람 07:00 → 08:30 · 준비 알람 08:00 → 09:10" (기상 · 준비 · 출발 순) */
  const timesLabel = (cur: AlarmPlan, times: NonNullable<CardEdit["times"]>): string => {
    const parts = (["WAKE", "PREPARE", "DEPARTURE", "ARRIVE"] as const).flatMap((t) => {
      const to = times[t];
      if (to === undefined) return [];
      const now = s.alarms.find((a) => a.owner === "u0" && a.type === t && a.appointment_ref === cur.appointment_ref);
      return [`${TYPE_KO[t]} 알람 ${now ? `${now.time} → ` : ""}${isoToLocal(to).time}`];
    });
    return `${dateKo(cur.date)} ${apptName(cur.appointment_ref === null ? undefined : apptByRef(cur.appointment_ref))}${parts.join(" · ")}`;
  };

  // 이어진 상대 변경("5분 더 당겨줘")이 일정을 말하지 않으면 이 대화에서 마지막으로 시각을 고친 알람 카드의 일정
  const lastTimedAppt = s.cards.filter((k) => k.kind === "ALARM_EDIT" && k.edit?.times !== undefined && k.edit.appointment_id).at(-1)?.edit?.appointment_id ?? null;
  for (const c0 of extract.alarm_changes) {
    const shift = Math.round(c0.shift ?? 0);
    const c: XAlarm = shift !== 0 && c0.appointment_ref === null && hits === null && lastTimedAppt !== null ? { ...c0, appointment_ref: lastTimedAppt } : c0;
    const key = `alarm:${c.target}|${c.type}|${c.appointment_ref ?? ""}|${c.date ?? ""}`;
    alarmKeys.add(key); // 바로잡는 말 정리(아래)가 이번 추출에 있는 요청으로 봄 — 건너뛰는 같은 요청도
    // 상대 변경은 이번 말이 청한 것만 — T2F는 대화 전체의 현재 상태를 내서 앞 말의 "10분 당겨"를 다시 적음(이미 처리함).
    //   종류를 말했으면 그 종류만 ("출발 알람도 5분 늦춰"에 다시 적힌 준비 −10은 건너뜀)
    if (shift !== 0 && intent !== null && !(shiftSaid(intent.text) && (!intent.typeNamed || TYPE_WORDS[c.type].test(intent.text)))) continue;
    const day = changeDay(c);
    const { cands, ask } = resolveAlarm(c, day);
    // 후보가 바뀌면(정정한 말로 대상을 좁힘) 같은 추출이어도 다시 처리. 상대 변경은 말마다 새 요청(거절 뒤 같은 말 · 연속 "5분 더")
    if (!once(key, JSON.stringify([c.time, c.intensity, c.enabled, c.save, cands.map((a) => a.ref), ...(shift !== 0 ? [shift, afterTurn] : [])]))) continue;
    const self = c.target === "u0";
    const eu = self ? null : ctx.editable_users.find((u) => u.alias === c.target) ?? null;
    const who = self ? "" : `${eu ? `${eu.name}(${c.target})` : c.target} `;
    const cur = cands.length === 1 && !ask ? (cands[0] as AlarmPlan) : null;
    // 상대 변경 — 마지막 저장 알람 시각(대화 중 바꾼 값 포함)에서 서버가 계산. 자정을 넘으면 날짜도 바뀜
    const shiftAt = shift !== 0 && cur !== null ? addMinutes(cur.date, cur.time, shift) : null;
    // 카드 키 = 추출 키 + 고를 알람 — 바로잡아 다른 알람을 가리키면 앞 카드를 다시 쓰지 않고 거둔 뒤 새 카드
    const pkey = cur ? `${key}#${cur.ref}` : key;
    /** 이 요청의 열린 알람 카드를 거둠 (keep = 남길 카드 키) */
    const dropAlarmCards = (keep?: string): void => {
      for (const id of Object.keys(s.pending)) {
        const k = (s.pending[id] as PendingEntry).key;
        if (k !== keep && (k === key || k.startsWith(`${key}#`))) dropPending(k, id);
      }
    };
    // 지금 값과 같은 칸은 바꿀 것이 아님 — AI가 전한 결과를 T2가 되받아 적은 것(019)이 '변경'으로 다시 적용되지 않게
    const sameTime = cur !== null && c.time !== null && c.time === cur.time && (c.date === null || c.date === cur.date);
    const wantTime = shiftAt !== null ? shiftAt.time : sameTime ? null : c.time;
    const wantIntensity = cur !== null && c.intensity === cur.intensity ? null : c.intensity;
    const wantEnabled = cur !== null && c.enabled === cur.enabled ? null : c.enabled;
    // 일정에 딸린 알람은 날짜를 말해도 그 알람의 날(전날 밤 기상 등)을 지킴 — 말한 날짜는 일정 날짜일 수 있음
    const newAt: LocalDateTime | null = shiftAt ?? (wantTime === null ? null : { date: cur?.appointment_ref ? cur.date : c.date ?? cur?.date ?? day, time: wantTime });
    // 카드 · 확인 줄: 있는 알람이면 지금 값 → 바꿀 값
    const changes = [
      wantTime !== null && newAt !== null ? (cur ? `${cur.time} → ${newAt.date !== cur.date ? `${dateKo(newAt.date)} ` : ""}${wantTime}` : `${wantTime}으로`) : null,
      wantIntensity !== null ? (cur ? `강도 ${INTENSITY_KO[cur.intensity]} → ${INTENSITY_KO[wantIntensity]}` : `강도 ${INTENSITY_KO[wantIntensity]}`) : null,
      wantEnabled === false ? "끄기" : wantEnabled === true ? "켜기" : null,
    ].filter(Boolean).join(" · ");
    const label = cur
      ? `${who}${dateKo(cur.date)} ${apptName(cur.appointment_ref === null ? undefined : apptByRef(cur.appointment_ref))}${TYPE_KO[cur.type]} 알람 ${changes}`.trim()
      : newAt === null
        ? `${who}${dateKo(day)} ${TYPE_KO[c.type]} 알람 ${changes}`.trim()
        : `${who}${dateKo(newAt.date)} ${newAt.time} ${TYPE_KO[c.type]} 알람 추가`;

    // 다른 사람 알람은 v0에서 늘 거절 — 친구 알람은 범위 밖 (설계 메모 4절 '알람 바꿀 수 있는 사람' 늘 빈 목록)
    if (!self) {
      reject(label, "NO_PERMISSION");
      continue;
    }
    // 본인 알람이 없는 약속을 가리키면 고아 알람을 만들지 않음
    if (cands.length === 0 && c.appointment_ref !== null && !apptByRef(c.appointment_ref)) {
      reject(`${c.appointment_ref} ${TYPE_KO[c.type]} 알람`, "NOT_FOUND");
      continue;
    }
    // 후보가 여럿이어도 그중 하나가 이미 요청 값 그대로면 AI가 전한 알람을 되받아 적은 것 — 되묻지 않음
    const already = (a: AlarmPlan): boolean =>
      c.time !== null && a.time === c.time && (c.date === null || a.date === c.date)
      && (c.intensity === null || a.intensity === c.intensity) && (c.enabled === null || a.enabled === c.enabled);
    if (cands.length > 1 && cands.some(already)) {
      dropAlarmCards();
      continue;
    }
    // 후보가 여럿 · 말한 날짜에 그 일정이 없음 → 어느 알람인지 되물음 (임의로 하나를 고르거나 새로 만들지 않음)
    if (cands.length > 1 || ask) {
      dropAlarmCards();
      delete s.seen[key]; // 답("24일 거")이 같은 추출로 와도 다시 처리
      ev.clarify.push(`바꿀 알람이 어느 것인지 — ${cands.slice(0, 5).map(alarmText).join(" · ")}`);
      continue;
    }
    // 상대 변경인데 기준이 될 본인 알람이 없음 — 새 알람을 만들지 않음 (꺼진 알람도 시각은 있어 기준이 됨)
    if (shift !== 0 && cur === null) {
      reject(`${who}${dateKo(day)} ${TYPE_KO[c.type]} 알람 (바꿀 알람 없음)`, "NOT_FOUND");
      continue;
    }
    if (shiftAt === null && c.time === null && c.intensity === null && c.enabled === null) {
      if (cur) ev.clarify.push(`${who}${dateKo(cur.date)} ${apptName(cur.appointment_ref === null ? undefined : apptByRef(cur.appointment_ref))}${TYPE_KO[cur.type]} 알람(지금 ${cur.time})을 어떻게 바꿀지`);
      else if (intent !== null && (c.date !== null || c.appointment_ref !== null)) reject(`${dateKo(day)} 알람 (바꿀 알람 없음)`, "NOT_FOUND");
      else ev.clarify.push(`${who}${TYPE_KO[c.type]} 알람을 어떻게 바꿀지`);
      continue;
    }
    if (cur && wantTime === null && wantIntensity === null && wantEnabled === null) {
      dropAlarmCards(); // 이미 그 값 — 할 일 없음
      continue;
    }
    if (newAt && isPast(newAt)) {
      reject(label, "PAST_TIME");
      continue;
    }
    if (!cur && !newAt) {
      reject(label, "NOT_FOUND");
      continue;
    }
    // 사용자가 거절한 것은 알릴 것 없음 — 약속 없는 비기상 알람의 NOT_FOUND 거절보다 먼저 봄 (실험실과 같은 순서, 리뷰 #261)
    if (c.save === "DECLINED") {
      dropAlarmCards();
      continue;
    }
    // 고치라는 말인데 바꿀 알람이 없음 — 새 알람(ALARM_NEW)으로 만들지 않음 ("새로 · 추가"라고 하면 만듦)
    if (!cur && intent !== null && intent.edit && !intent.add) {
      reject(`${who}${dateKo(newAt?.date ?? day)} ${TYPE_KO[c.type]} 알람 (바꿀 알람 없음)`, "NOT_FOUND");
      continue;
    }
    // 약속 없이 새로 만드는 알람은 기상만 — 약속에 딸린 알람이 없는 약속을 가리키면 그 약속의 알람 계산은 L1 몫 (카드 [수정])
    if (!cur && (c.type !== "WAKE" || c.appointment_ref !== null)) {
      reject(label, "NOT_FOUND");
      continue;
    }
    // 같은 턴의 준비시간 가감으로 이미 그 시각이 되는 본인 알람 시각 변경은 카드로 만들지 않음 — T2가 서버 계산 결과를 알람 변경으로 함께 적은 것
    //   (실험실 test-015: '+15분'과 '기상 07:45으로'가 같이 나옴). 기상 · 준비 알람은 같이 일러지므로 둘 다 지금 시각 − 가감이면 같은 말
    if (cur && newAt && wantIntensity === null && wantEnabled === null && impliedByPrep(cur, newAt)) {
      dropAlarmCards();
      continue;
    }
    if (cur) {
      // 있는 약속의 알람 고침 — 시각을 바꾸면 앱이 previewAlarms로 계산, 강도 · 켜고 끄기만이면 바로 READY
      const edit: CardEdit = { appointment_id: cur.appointment_ref };
      if (newAt) edit.times = { [c.type]: localToIso(newAt.date, newAt.time) };
      if (wantIntensity !== null) {
        const lv = levelOfIntensity(wantIntensity);
        edit.levels = { sound: lv, voice: lv, vibration: lv };
      }
      if (wantEnabled !== null) edit.enabled = { [c.type]: wantEnabled };
      dropAlarmCards(pkey);
      // 같은 일정의 다른 알람 시각을 고치는 열린 카드가 있으면 한 카드로 합침 — "기상 8시 반" 뒤 "준비도 9시 10분에 맞춰줘"(앱이 낸 조정안 확인)가
      //   두 카드로 나뉘면 각 카드가 따로 계산돼 순서 충돌로 막히고, 하나만 저장돼 다른 하나가 빠짐. 합친 카드는 한 번의 [바꾸기]로 둘 다 저장
      const pkeyOf = (id: string): string | undefined => s.pending[id]?.key;
      const sib = newAt === null || cur.appointment_ref === null ? undefined : s.cards.find((x) =>
        x.kind === "ALARM_EDIT" && OPEN_STATUS.includes(x.status) && x.edit?.appointment_id === cur.appointment_ref &&
        x.edit.times !== undefined && x.edit.prepare_delta === undefined && pkeyOf(x.id) !== undefined && pkeyOf(x.id) !== pkey && !(pkeyOf(x.id) as string).startsWith(key));
      let summary = label;
      if (sib?.edit) {
        edit.times = { ...sib.edit.times, ...edit.times };
        if (edit.levels === undefined && sib.edit.levels !== undefined) edit.levels = sib.edit.levels;
        if (sib.edit.enabled !== undefined) edit.enabled = { ...sib.edit.enabled, ...edit.enabled };
        summary = timesLabel(cur, edit.times);
      }
      upsertCard({ kind: "ALARM_CHANGE", key: pkey, item: c, summary, target_ref: null }, "ALARM_EDIT", (card) => {
        card.summary = summary;
        card.draft = null;
        card.edit = edit;
      }, c.save, sib?.id);
    } else if (newAt) {
      // 본인 알람을 새로 만드는데 같은 분에 이미 켜진 본인 알람이 있으면 두 번 울리지 않게 만들지 않음 (072)
      const twin = sameMinuteAlarm(newAt);
      if (twin) {
        dropAlarmCards();
        ev.conflicts = [...(ev.conflicts ?? []), `${dateKo(twin.date)} ${twin.time} ${TYPE_KO[c.type]} 알람 안 만듦 — 같은 시각 ${TYPE_KO[twin.type]} 알람이 이미 있음`];
        continue;
      }
      const edit: CardEdit = { at: localToIso(newAt.date, newAt.time), level: c.intensity === null ? null : levelOfIntensity(c.intensity) };
      dropAlarmCards(key);
      upsertCard({ kind: "ALARM_CHANGE", key, item: c, summary: label, target_ref: null }, "ALARM_NEW", (card) => {
        card.summary = label;
        card.draft = null;
        card.edit = edit;
      }, c.save);
    }
  }

  // ── 바로잡는 말("아니 그거 말고 …") ── 이번 추출에 없는 앞 요청의 열린 카드(일정 · 알람)는 거둠 — 잘못 짚은 카드를 그대로 두거나 다시 쓰지 않게.
  //   바로잡는 말일 때만 (추출이 흔들려 한 항목을 빠뜨린 것만으로는 안 거둠). 준비시간 카드는 따로 (아래)
  if (intent?.correct) {
    for (const id of Object.keys(s.pending)) {
      const e = s.pending[id] as PendingEntry;
      if (e.key === "prep" || touched.has(id) || presentKeys.has(e.key) || alarmKeys.has(e.key.replace(/#.*$/u, ""))) continue;
      dropPending(e.key, id);
      delete s.seen[e.key]; // 같은 요청을 나중에 다시 하면 새로 처리
    }
  }

  // ── 내일만 준비시간 가감 ── (준비시간 범위는 day 고정: 내일 기상 기준 일정 — 그날 가장 이른 켜진 기상 알람의 약속)
  const pa = extract.prep_adjustment;
  // 알람 상대 변경 말에서 뽑힌 준비시간 가감은 처리 기록만 남기고 건너뜀 ("준비 알람 10분 당겨" ≠ 준비시간 10분 줄임)
  if (pa && once("prep", JSON.stringify([pa.direction, pa.minutes, pa.save ?? null])) && !alarmShiftTurn) {
    const delta = prepDeltaOf(pa);
    const tomorrowWake = prepAnchorWake();
    // 저장 전 카드가 내일 첫 일정이면 그 카드에 붙인다 (저장 뒤 앱이 saveAlarmSettings로 한 번 더, 설계 메모 5절)
    const firstCard = s.cards.find((c) => c.kind === "APPT_NEW" && OPEN_STATUS.includes(c.status) && c.draft?.date === ctx.dates.tomorrow && c.first_of_day);
    if (pa.save === "DECLINED") {
      if (firstCard?.edit?.prepare_delta !== undefined) {
        firstCard.edit = null;
        touched.add(firstCard.id);
      }
      dropPending("prep");
    } else if (firstCard !== undefined) {
      firstCard.edit = { prepare_delta: delta };
      firstCard.highlight = pa.save === "CONFIRMED";
      touched.add(firstCard.id);
      if (firstCard.status === "READY") pushPending(ev, firstCard, s);
    } else if (tomorrowWake !== undefined) {
      const anchor = tomorrowWake.appointment_ref as string;
      const text = delta === 0 ? "내일만 준비시간 원래대로" : `내일만 준비시간 ${signed(delta)}`;
      upsertCard({ kind: "ALARM_CHANGE", key: "prep", item: { ...pa }, summary: text, target_ref: anchor }, "ALARM_EDIT", (card) => {
        card.summary = text;
        card.draft = null;
        card.edit = { appointment_id: anchor, prepare_delta: delta };
      }, pa.save ?? "UNCONFIRMED");
    } else {
      reject("내일 준비시간", "NOT_FOUND"); // 준비시간을 바꿀 내일 일정이 없음
    }
  }

  // ── 사실 확인 · 정정 — 출발 · 도착 시각 정정은 앱이 L2 함수로, 기상은 함수가 없어 대상 없음 ──
  const fixLabel = (kind: FactKind): string => FACT_TIME_LABEL[kind] ?? FACT_KIND_KO[kind];
  for (const f of extract.fact_feedback) {
    if (!once(`fact:${f.fact_id}`, JSON.stringify([f.status, f.value_time, f.approx]))) continue;
    const fact = ctx.today.facts.find((x) => x.id === f.fact_id);
    if (!fact) {
      reject(`기록 ${f.fact_id}`, "NOT_FOUND");
      continue;
    }
    // 기록과 같은 값으로 '정정' = 확인 (030: '도착 16:44으로 정정'이 같은 값으로 나감)
    const same = f.status === "CORRECTED" && f.value_time !== null && fact.time !== null && f.value_time === fact.time;
    const g: Extract["fact_feedback"][number] = same ? { ...f, status: "CONFIRMED" } : { ...f };
    s.factFeedback = [...s.factFeedback.filter((x) => x.fact_id !== f.fact_id), g];
    const label = fixLabel(fact.kind);
    const fixable = (FIXABLE_FACT_KINDS as readonly FactKind[]).includes(fact.kind);
    const addFix = (action: Fix["action"], to: string | null, approx: boolean): void => {
      s.fixes.push({ id: `x${++s.fixSeq}`, fact: fact.id, kind: fact.kind, participant_id: null, action, to, status: "PENDING", label, approx });
    };
    if (g.status === "CORRECTED" && g.value_time !== null) {
      if (fixable) addFix("CORRECT", localToIso(ctx.dates.today, g.value_time), g.approx);
      else reject(`${label} 기록 정정`, "NOT_FOUND");
    }
    // 그런 일 없다고 한(DENIED) 기록도 처리 결과 줄을 줌 — 줄이 없으면 T1이 "빼 둘게요"를 약속함 (E1 s3-dev-030, E2 단계 0)
    if (g.status === "DENIED") {
      const line = `기록 정정: ${FACT_KIND_KO[fact.kind]}${fact.time !== null ? ` ${fact.time}` : ""} → 아님`;
      if (fact.earlier === true) {
        // 앞 출발은 이미 진짜 출발이 아니라 바꿀 값이 없음 — 줄만 (설계 메모 4.5)
        ev.applied.push(line);
      } else if (fixable) addFix("DENY", null, false);
      else reject(`${label} 기록 정정`, "NOT_FOUND");
    }
  }

  // ── 안전 — 위기 안내 판단은 서버가: 이 턴 사용자 말에서 위험 표시(T2F safety_flag)가 켜진 턴마다 `위기 안내 필요` 줄을 넘김 (헤드 10/30 B안).
  //   예전엔 대화당 1번만 넘겨서, 위기 말이 이어지는 둘째 턴의 109 문장을 가드가 '되풀이'로 지웠음. 새 위험 말에 다시 안내하는 건 되풀이가 아님.
  //   가드가 109를 지우는 건 이 턴 위험 판단이 꺼져 있고 이미 안내한 대화일 때뿐 (guards.ts hotline_repeat · hotline_without_risk)
  //   T2F가 실패 · 시간 초과로 이 턴 판단이 아예 없으면 '모름'(turn.ts가 이벤트에 risk_unknown) — 가드는 모델의 109를 지우지 않음
  //   crisisNotified는 '한 번이라도 안내했는지'로 남김(상태 기록 · 시험용). 안내 줄 자체는 이 턴 위험 표시만 따른다
  s.safetyFlag = s.safetyFlag || extract.safety_flag;
  const crisis = extract.safety_flag;
  if (crisis) {
    s.crisisNotified = true;
    ev.crisis = true;
  }

  // ── 일정을 바꿔 달라는 말인데 이번 말로 바뀐 게 없음 (2026-11-25) ──
  //   T2F가 변경을 못 뽑았거나 지금 값 · 이미 처리한 값을 되풀이하면 처리 결과가 비어 "네, 알겠어요."로 끝났음.
  //   열린 변경 카드가 있으면 그 카드를 다시 안내, 이미 그 값이면 지금 설정을 알림(note), 그 밖은 바꿀 일정 · 값을 되물음.
  //   알람 · 준비시간 말(intent.alarm · typeNamed)은 알람 쪽이 맡음. 위기 턴은 위기 안내가 먼저라 건너뜀
  const quiet = touched.size === 0 && s.fixes.length === state.fixes.length && ev.applied.length + ev.pending.length + ev.clarify.length + ev.rejected.length + ev.alarms.length + (ev.conflicts ?? []).length === 0;
  // 알람을 몇 분 당기 · 늦추라는 말("5분 더 당겨줘" 포함)인데 바꿀 알람을 못 뽑음 — 일정 변경으로 되묻지 않고 알람을 되물음
  const shiftAsk = quiet && intent !== null && shiftSaid(intent.text) && (intent.alarm || intent.typeNamed || lastTimedAppt !== null) && !extract.safety_flag;
  if (shiftAsk) ask(ev, "바꿀 알람이 어느 일정의 어떤 알람(기상 · 준비 · 출발)인지와 몇 분 바꿀지", "어느 일정의 어떤 알람을 몇 분 바꿀까요?");
  if (!shiftAsk && quiet && intent !== null && intent.edit && !intent.add && !intent.alarm && !intent.typeNamed && extract.prep_adjustment === null && !extract.safety_flag) {
    const targetOf = (x: XAppt): Appointment | undefined => {
      if (x.ref) return apptByRef(x.ref);
      const found = normTitle(x.title) === "" ? [] : existingFor(x);
      return found.length === 1 ? found[0] : undefined;
    };
    const named = hits === null ? [] : s.appointments.filter((a) => hits.best.has(a.ref));
    const said = extract.appointments.map((x) => ({ x, a: targetOf(x) })).find((p) => p.a !== undefined);
    const target = said?.a ?? (named.length === 1 ? named[0] : undefined);
    const when = (a: Appointment): string => `${dateKo(a.date)} ${spokenTime(Math.floor(toMinutes(a.time) / 60), toMinutes(a.time) % 60)}`;
    const open = target === undefined ? undefined : s.cards.find((c) => c.kind === "APPT_OPEN" && OPEN_STATUS.includes(c.status) && c.edit?.appointment_id === target.ref);
    const unchanged = said !== undefined && target !== undefined && said.x.unclear === null &&
      (["date", "time", "place", "importance", "transport", "repeat"] as const).every((f) => (said.x[f] ?? target[f]) === target[f]);
    if (open !== undefined) {
      // 같은 변경을 다시 청함 — 아직 [변경하기] 전인 그 카드로 (저장한 카드는 열린 카드가 아니라 여기 안 옴)
      touched.add(open.id);
      if (open.status === "READY") pushPending(ev, open, s);
    } else if (said !== undefined && target !== undefined && !unchanged) {
      // 지금 값과 다른 변경인데 처리 기록(seen)이 걸러 냄 — [변경 안 함]한 카드를 같은 말로 다시 청함. 되묻지 않고 이번 말로 다시 처리
      const key = apptKey(said.x);
      s.seen[key] = apptSig(said.x);
      changeAppt({ ...said.x, ref: target.ref }, key, target.ref);
    } else if (unchanged && target !== undefined) {
      const w = when(target);
      const place = said?.x.place && target.place ? `, 장소는 ${target.place}` : "";
      ev.note = `'${target.title}' 일정은 이미 ${w}${place}${josa(place === "" ? w : target.place as string, "으로", "로")} 되어 있어요.`;
    } else if (target !== undefined) {
      const w = when(target);
      ask(ev, `'${target.title}'(지금 ${dateKo(target.date)} ${target.time}) 일정을 무엇으로 바꿀지 — 바뀔 날짜 · 시각 · 장소`, `지금 '${target.title}' 일정은 ${w}${josa(w, "이에요", "예요")}. 언제로 바꿀까요?`);
    } else {
      ask(ev, "바꿀 일정이 어느 것인지와 바뀔 날짜 · 시각", "어떤 일정을 언제로 바꿀지 알려 주시겠어요?");
    }
  }

  // ── 앱 일 ── (위기 턴은 앱 일을 다음 턴으로 미룸 — 위기 안내가 먼저, 지침 12)
  const openCards = s.cards.filter((c) => c.status === "NEEDS_ESTIMATE");
  const openFixes = s.fixes.filter((x) => x.status === "PENDING" || x.status === "SENT");
  const deferred = crisis && openCards.length + openFixes.length > 0;
  let tasks = false;
  if (!crisis && openCards.length + openFixes.length > 0) {
    for (const x of openFixes) x.status = "SENT";
    for (const c of openCards) touched.add(c.id);
    s.awaiting = { after_turn: afterTurn, cards: openCards.map((c) => c.id), fixes: openFixes.map((x) => x.id) };
    tasks = true;
  } else {
    s.awaiting = null;
  }

  s.events = [...s.events.filter((e) => e.after_turn !== afterTurn), ev];
  s.applied.push(...ev.applied);
  const sent = tasks ? s.fixes.filter((x) => x.status === "SENT").map(toFix) : [];
  return { state: s, event: ev, cards: s.cards.filter((c) => touched.has(c.id)), fixes: sent, tasks, deferred };
}

// ───────── 앱 일 결과 ─────────

export interface TaskOutcome {
  ok: true;
  state: TurnState;
  event: ServerEvent;
  cards: Card[];
  fixes: Fix[];
  /** 모르는 카드 · 정정 번호 (voice-turn이 NOT_FOUND로 돌려줌) */
  unknown: string[];
  /** 앱이 보낸 요약이 범위 밖이라 안 쓴 카드 (id → 이유) */
  invalid: Record<string, string>;
  /** 기다리던 앱 일이 모두 끝났는지 */
  done: boolean;
}

/** 카드가 가리키는 약속 시각 (새 약속은 초안, 알람 고침은 있는 약속) */
function apptAtOf(c: Card, s: TurnState): LocalDateTime | null {
  if (c.kind === "APPT_NEW" && c.draft) return { date: c.draft.date, time: c.draft.time };
  const ref = c.edit?.appointment_id;
  const a = ref ? s.appointments.find((x) => x.ref === ref) : undefined;
  if (!a) return null;
  // 약속 변경 카드의 알람은 바뀐 날짜 · 시각 기준
  const ch = c.kind === "APPT_OPEN" ? c.edit?.changes : undefined;
  return { date: ch?.date ?? a.date, time: ch?.time ?? a.time };
}

/**
 * 앱이 계산한 카드 상태 · 기록 정정 결과를 반영한다 (voice-turn `results`). 같은 사용자 말 j 뒤 처리 결과에 이어서 채운다:
 *   READY → '확인 필요 [c#]' 줄 · NEEDS_PLACE → '되물을 것: … (카드의 [장소 고르기])' · FAILED → '되물을 것: {앱 문구}'
 *   정정 ok → '저장됨: 도착 시각 10:20으로 정정' / '저장됨: 기록 정정: 출발 09:33 → 아님' · 실패 → '거절: 도착 기록 정정 (대상 없음)'
 * 앱이 보낸 요약은 믿지 않고 범위를 검사한다(checkDigest) — 범위 밖이면 그 카드는 FAILED로 두고 '되물을 것'만 낸다.
 */
export function applyTaskResults(state: TurnState, results: TaskResults, ctx: Context, afterTurn: number): TaskOutcome | Rejected {
  const problem = resultsShapeProblem(results);
  if (problem !== null) return { ok: false, reason: problem };
  const s: TurnState = structuredClone(state);
  const ev = eventFor(s, afterTurn);
  const now = isoToLocal(ctx.session.now);
  const unknown: string[] = [];
  const invalid: Record<string, string> = {};
  const touchedCards: Card[] = [];
  const touchedFixes: FixRecord[] = [];

  for (const r of results.cards ?? []) {
    const c = s.cards.find((x) => x.id === r.id);
    if (c === undefined) {
      unknown.push(r.id);
      continue;
    }
    if (!OPEN_STATUS.includes(c.status)) continue; // 이미 저장 · 거절한 카드
    touchedCards.push(c);
    c.first_of_day = c.kind === "APPT_NEW" ? isFirstOfDay(s, c) : c.first_of_day;
    const title = c.draft?.title ?? c.edit?.before?.title ?? c.summary;
    // 이 카드가 앞서 낸 "되물을 것"(장소 · 계산 실패)은 새 결과로 풀렸거나 바뀌었으므로 지움 — 안 지우면 장소를 고른 뒤에도 T1이 장소를 또 물음 (L8 버그 1)
    const stale = new Set([placeAskLine(title), `'${title}' 알람 계산`, ...(typeof c.error === "string" ? [c.error] : [])]);
    for (const e of s.events) e.clarify = e.clarify.filter((l) => !stale.has(l));
    if (r.status === "READY") {
      const reason = checkDigest(r.estimate as RawDigest | null | undefined, now, apptAtOf(c, s)) ?? checkAgainstCard(c, (r.estimate as RawDigest).alarms);
      if (reason !== null) {
        invalid[c.id] = reason;
        c.status = "FAILED";
        c.error = `계산 결과를 쓸 수 없음 (${reason})`;
        c.digest = null;
        ev.clarify.push(`'${title}' 알람 계산`);
        continue;
      }
      const est = r.estimate as NonNullable<TaskResults["cards"][number]["estimate"]>;
      c.digest = { alarms: est.alarms.map((a) => ({ kind: a.kind, at: a.at, enabled: a.enabled })), level: est.level ?? null, with_wake: est.with_wake === true };
      const basis = checkBasis((est as RawDigest).basis, wakeOf(c.digest), apptAtOf(c, s));
      if (basis !== null) c.digest.basis = basis;
      c.status = "READY";
      c.error = null;
      pushPending(ev, c, s);
    } else if (r.status === "NEEDS_PLACE") {
      c.status = "NEEDS_PLACE";
      c.error = null;
      ev.clarify.push(placeAskLine(title));
    } else if (r.status === "FAILED") {
      c.status = "FAILED";
      const msg = cleanAppError(r.error) ?? `'${title}' 알람 계산`;
      c.error = msg;
      ev.clarify.push(msg);
    } else {
      unknown.push(r.id);
    }
  }

  for (const r of results.fixes ?? []) {
    const x = s.fixes.find((f) => f.id === r.id);
    if (x === undefined) {
      unknown.push(r.id);
      continue;
    }
    if (x.status === "DONE" || x.status === "FAILED") continue;
    touchedFixes.push(x);
    if (r.ok === true) {
      x.status = "DONE";
      ev.applied.push(
        x.action === "CORRECT"
          ? `${x.label} 시각 ${x.approx ? "약 " : ""}${isoToLocal(x.to as string).time}으로 정정`
          : `기록 정정: ${FACT_KIND_KO[x.kind]}${factTime(ctx, x.fact)} → 아님`,
      );
    } else {
      x.status = "FAILED";
      ev.rejected.push({ target: `${x.label} 기록 정정`, reason: "NOT_FOUND" });
    }
  }

  const stillCards = s.cards.filter((c) => c.status === "NEEDS_ESTIMATE").map((c) => c.id);
  const stillFixes = s.fixes.filter((x) => x.status === "SENT").map((x) => x.id);
  s.awaiting = stillCards.length + stillFixes.length > 0 ? { after_turn: afterTurn, cards: stillCards, fixes: stillFixes } : null;
  s.applied.push(...ev.applied.filter((l) => !s.applied.includes(l)));
  return { ok: true, state: s, event: ev, cards: touchedCards, fixes: touchedFixes.map(toFix), unknown, invalid, done: s.awaiting === null };
}

function factTime(ctx: Context, factId: string): string {
  const f = ctx.today.facts.find((x) => x.id === factId);
  return f?.time ? ` ${f.time}` : "";
}

// ───────── 카드 버튼 ─────────

export interface CardOutcome {
  ok: true;
  state: TurnState;
  event: ServerEvent;
  card: Card | null;
  /** true면 T1을 불러 결과를 말하게 함(저장됨). 거절 버튼은 상태만(reply: null) */
  needsReply: boolean;
  /** 'NOT_FOUND' 모르는 카드 · 'NOOP' 이미 끝난 카드나 저장 없는 카드 · 'OK' */
  status: "OK" | "NOT_FOUND" | "NOOP";
  /** 앱이 보낸 알람 요약 중 범위 밖이라 안 쓴 것 이유 */
  invalid: string | null;
}

/** 'al9'처럼 알람 별칭 고르기 */
const nextAlarmRef = (s: TurnState): string => `al${++s.alarmSeq}`;

/**
 * 카드 버튼(voice-turn `card_action`)을 반영한다. 저장은 여기서만 일어난다 — 말 "응"은 강조뿐.
 *   REJECTED: 카드 상태만 바꿈(되돌릴 게 없음), needsReply false.
 *   SAVED: 앱이 이미 저장한 값(action.alarms)을 믿되 범위를 검사해 받고(checkDigest), 처리 결과에 '저장됨: 일정 저장: …'과 새 알람(기상만 — 그 밖은 '그 밖의 알람(준비 · 출발)도 같이 맞춤')을 담는다.
 * 같은 사용자 말 j 뒤 처리 결과에 이어 쓴다(없으면 새로 만듦).
 */
export function applyCardAction(state: TurnState, action: CardAction, ctx: Context, afterTurn: number): CardOutcome | Rejected {
  const problem = actionShapeProblem(action);
  if (problem !== null) return { ok: false, reason: problem };
  const s: TurnState = structuredClone(state);
  const c = s.cards.find((x) => x.id === action.id) ?? null;
  const none = (status: CardOutcome["status"]): CardOutcome => ({ ok: true, state: s, event: eventFor(s, afterTurn), card: c, needsReply: false, status, invalid: null });
  if (c === null) return none("NOT_FOUND");
  if (!OPEN_STATUS.includes(c.status)) return none("NOOP");

  if (action.action === "REJECTED") {
    forgetLines(s, cardAskLines(c)); // 거절한 카드의 질문은 다시 묻지 않음
    c.status = "REJECTED";
    c.highlight = false;
    delete s.pending[c.id];
    // 같은 말(T2F가 현재 상태를 되풀이)이 다시 와도 카드를 또 만들지 않음 — seen 서명이 같으면 건너뛰고, 재료가 바뀌면 새 카드
    return { ok: true, state: s, event: eventFor(s, afterTurn), card: c, needsReply: false, status: "OK", invalid: null };
  }
  if (action.action === "GROUP") {
    // 그룹 · 개인 일정 칩 — 고를 수 있는 그룹(가입한 그룹 중 카드 후보)만. 저장은 여전히 [저장]으로
    if (c.kind !== "APPT_NEW" || c.group === undefined) return none("NOOP");
    const id = action.group_id ?? null;
    const pick = id === null ? undefined : c.group.candidates.find((g) => g.id === id);
    if (id !== null && pick === undefined) return { ok: false, reason: "card_action.group_id가 고를 수 있는 그룹이 아님" };
    forgetLines(s, [groupQuestion(c)]); // 고른 뒤엔 그룹 질문을 다시 쓰지 않음
    c.group = { ...c.group, choice: pick ? "GROUP" : "PERSONAL", id: pick?.id ?? null };
    const ev = eventFor(s, afterTurn);
    if (c.status === "READY") pushPending(ev, c, s);
    return { ok: true, state: s, event: ev, card: c, needsReply: false, status: "OK", invalid: null };
  }

  const ev = eventFor(s, afterTurn);
  const now = isoToLocal(ctx.session.now);
  const rawAlarms = action.alarms ?? [];
  const reason = checkDigest({ alarms: rawAlarms }, now, apptAtOf(c, s)) ?? checkAgainstCard(c, rawAlarms);
  const alarms = reason === null ? rawAlarms : [];
  const entry = s.pending[c.id];
  const base = entry?.summary ?? c.summary;
  const addAlarm = (a: { kind: AlarmType; at: string; enabled: boolean; level: number | null }, apptRef: string | null): AlarmPlan => {
    const at = isoToLocal(a.at);
    const plan: AlarmPlan = {
      ref: nextAlarmRef(s), owner: "u0", type: a.kind, date: at.date, time: at.time, intensity: intensityOfLevel(a.level ?? null),
      appointment_ref: apptRef, enabled: a.enabled, change: "NEW",
    };
    s.alarms.push(plan);
    return plan;
  };
  const OTHER_LABEL: Partial<Record<AlarmType, string>> = { PREPARE: "준비", DEPARTURE: "출발", ARRIVE: "도착" };

  if (c.kind === "APPT_NEW") {
    const d = c.draft as NonNullable<Card["draft"]>;
    const ref = `a${++s.apptSeq}`;
    // 장소를 고르기 전에 저장함([장소 없이 저장], alarm-commit PLACE_PENDING) — 들은 장소('한실')는 저장되지 않았으니 장소 미정으로 적고 알람 없음을 알림
    const placePending = c.status === "NEEDS_PLACE";
    // 저장한 카드의 질문(그룹 선택 · 장소 고르기 · 기상 확인 …)은 모두 풀림 — 장소 없이 저장했어도 장소를 더 묻지 않음
    forgetLines(s, cardAskLines(c));
    s.appointments.push({
      ref, title: d.title, date: d.date, time: d.time, place: placePending ? null : d.place, importance: d.importance,
      importance_confirmed: d.importance !== null, transport: d.transport, travel_minutes: null, repeat: d.repeat.length > 0 ? "WEEKLY" : "NONE",
      ...(c.group?.choice === "GROUP" ? { group: groupName(c.group) } : {}),
    });
    s.createdKeys[ref] = entry?.key ?? `appt:${normTitle(d.title)}|${d.date}|${d.time}`;
    if (action.appointment_id) s.bound[ref] = action.appointment_id;
    c.appointment_id = action.appointment_id ?? null;
    const grouped = groupSavedText(c);
    ev.applied.push(
      (placePending ? `일정 저장: ${appointmentSummary({ ...d, place: null })} · 장소 미정이라 알람은 아직 없음 (장소를 정한 뒤 알람 설정에서)` : `일정 저장: ${base}`) + (grouped ? ` · ${grouped}` : ""),
    );
    const others: string[] = [];
    for (const a of alarms) {
      const plan = addAlarm({ ...a, level: a.level ?? null }, ref);
      if (a.kind === "WAKE" && c.first_of_day) ev.alarms.push(plan);
      else if (OTHER_LABEL[a.kind] !== undefined && !others.includes(OTHER_LABEL[a.kind] as string)) others.push(OTHER_LABEL[a.kind] as string);
    }
    if (others.length > 0) ev.applied.push(`그 밖의 알람(${others.join(" · ")})도 같이 맞춤`);
    if (c.edit?.prepare_delta !== undefined) ev.applied.push(c.edit.prepare_delta === 0 ? "내일만 준비시간 원래대로" : `내일만 준비시간 원래보다 ${signed(c.edit.prepare_delta)}`);
  } else if (c.kind === "ALARM_EDIT" || c.kind === "APPT_OPEN") {
    const apptRef = c.edit?.appointment_id ?? null;
    if (c.kind === "APPT_OPEN") {
      // 앱이 appointment-edit로 이미 고침 — 대화 상태의 그 약속도 바뀐 값으로 (같은 약속을 새로 만들지 않음)
      const a = s.appointments.find((x) => x.ref === apptRef);
      const ch = c.edit?.changes ?? {};
      if (a) {
        for (const [k, v] of Object.entries(ch)) if (v !== undefined) (a as unknown as Record<string, unknown>)[k] = v;
        if (ch.importance !== undefined) a.importance_confirmed = true;
      }
      forgetLines(s, cardAskLines(c));
    }
    const asked = new Set<AlarmType>([...(Object.keys(c.edit?.times ?? {}) as AlarmType[]), ...(Object.keys(c.edit?.enabled ?? {}) as AlarmType[])]);
    const others: string[] = [];
    for (const a of alarms) {
      const at = isoToLocal(a.at);
      const cur = s.alarms.find((x) => x.owner === "u0" && x.type === a.kind && x.appointment_ref === apptRef);
      let plan: AlarmPlan;
      if (cur) {
        Object.assign(cur, { date: at.date, time: at.time, enabled: a.enabled, intensity: a.level === undefined || a.level === null ? cur.intensity : intensityOfLevel(a.level), change: "CHANGED" });
        plan = cur;
      } else {
        plan = addAlarm({ ...a, level: a.level ?? null }, apptRef);
      }
      if (a.kind === "WAKE" || asked.has(a.kind)) ev.alarms.push({ ...plan });
      else if (OTHER_LABEL[a.kind] !== undefined && !others.includes(OTHER_LABEL[a.kind] as string)) others.push(OTHER_LABEL[a.kind] as string);
    }
    ev.applied.push(c.kind === "APPT_OPEN" ? `일정 변경: ${base.replace(/^변경: /u, "")}` : `알람 변경: ${base}`);
    if (others.length > 0) ev.applied.push(`그 밖의 알람(${others.join(" · ")})도 같이 맞춤`);
  } else if (c.kind === "ALARM_NEW") {
    const first = alarms[0];
    const plan = first
      ? addAlarm({ ...first, kind: "WAKE", level: first.level ?? null }, null)
      : addAlarm({ kind: "WAKE", at: c.edit?.at as string, enabled: true, level: c.edit?.level ?? null }, null);
    if (action.appointment_id) s.bound[plan.ref] = action.appointment_id;
    ev.alarms.push({ ...plan });
    ev.applied.push(`알람 변경: ${base}`);
  }

  c.status = "SAVED";
  c.highlight = false;
  delete s.pending[c.id];
  s.applied.push(...ev.applied.filter((l) => !s.applied.includes(l)));
  return { ok: true, state: s, event: ev, card: c, needsReply: true, status: "OK", invalid: reason };
}

// ───────── 서버 질문 고르기 (설계 메모 4.3) ─────────

/** user_questions 한 줄 (PR 2 새 표, 헤드 H2 A 공용) — DB는 PR 4가 읽어 이 모양으로 넘김 */
export interface AskedQuestion {
  kind: QuestionKind;
  subject_key: string;
  asked_at: string; // ISO
}

export interface QuestionHistory {
  /** 이번 대화에서 서버 질문을 이미 했는지 */
  askedInConversation: boolean;
  /** 최근 질문 기록 (모든 채널 — 원탭 칩 · 카드 · 대화) */
  recent: AskedQuestion[];
}

export const QUESTION_PER_DAY = 1;
export const QUESTION_PER_WEEK = 3;
/** 같은 대상(subject_key)을 다시 묻지 않는 시간 */
export const QUESTION_SAME_KEY_HOURS = 24;

/** 질문 대상 키 — 별칭(a#)이 아니라 일정 날짜 · 제목으로 (대화가 달라도 같은 일정이면 같은 키) */
export function questionSubjectKey(kind: QuestionKind, a: { date: LocalDate; title: string }): string {
  return `${kind}:${a.date}|${normTitle(a.title)}`;
}

/** 로컬 분 단위 절대 시각 (일 수 * 1440 + 분) — 서울 기준 */
const absMinutes = (iso: string): number => {
  const l = isoToLocal(iso);
  return dayNumber(l.date) * 1440 + toMinutes(l.time);
};

export interface PickedQuestion {
  question: ServerQuestion;
  subject_key: string;
}

/**
 * 서버 질문 고르기 — PREP_CHECK 하나 (설계 메모 4.3). 답에 따라 내일 기상이 10분 바뀔 때만 묻는다:
 *   ① 내일 사유는 자동 수집이 없음 ② 대상 = 내일 기상 기준 일정(그날 가장 이른 켜진 기상 알람의 약속)의 중요도 HIGH 또는 제목 키워드(HIGH) ∧
 *   그 기상이 자동 시각(time_source AUTO — 직접 고른 기상은 준비를 늘려도 안 바뀜) ∧ 기상 − 10분이 지금보다 뒤
 *   ③ 예산: 이번 대화 0개 · 하루 1개 · 7일 3개 미만 · 같은 일정 24시간 안에 안 물음
 * 해당 없으면 null. now = ISO.
 */
export function pickServerQuestion(ctx: Context, history: QuestionHistory, now: string): PickedQuestion | null {
  if (history.askedInConversation) return null;
  const nowAbs = absMinutes(now);
  const recent = history.recent ?? [];
  // '하루' = 대화 기준일(돌아볼 날 ctx.dates.today)의 새벽 4시부터 지금까지 — 23:50에 물은 뒤 00:20 같은 밤 대화에서도 오늘 몫을 이미 쓴 것
  const dayStart = dayNumber(ctx.dates.today) * 1440 + DAY_START_HOUR * 60;
  if (recent.filter((q) => absMinutes(q.asked_at) >= dayStart).length >= QUESTION_PER_DAY) return null;
  if (recent.filter((q) => nowAbs - absMinutes(q.asked_at) < 7 * 1440).length >= QUESTION_PER_WEEK) return null;

  const tomorrowAppts = ctx.tomorrow.appointments;
  const wakes = ctx.tomorrow.alarms
    .filter((a) => a.owner === "u0" && a.type === "WAKE" && a.enabled && a.appointment_ref !== null && tomorrowAppts.some((p) => p.ref === a.appointment_ref))
    .sort((x, y) => dayNumber(x.date) - dayNumber(y.date) || toMinutes(x.time) - toMinutes(y.time) || cmpRef(x.ref, y.ref));
  const wake = wakes[0];
  if (wake === undefined) return null;
  const appt = tomorrowAppts.find((p) => p.ref === wake.appointment_ref) as Appointment;
  if (!(appt.importance === "HIGH" || keywordImportance(appt.title) === "HIGH")) return null;
  if ((wake.time_source ?? "AUTO") !== "AUTO") return null;
  if (dayNumber(wake.date) * 1440 + toMinutes(wake.time) - PREP_ADJUST_DEFAULT <= nowAbs) return null;

  const key = questionSubjectKey("PREP_CHECK", appt);
  if (recent.some((q) => q.subject_key === key && nowAbs - absMinutes(q.asked_at) < QUESTION_SAME_KEY_HOURS * 60)) return null;
  return {
    subject_key: key,
    question: {
      id: "q1",
      kind: "PREP_CHECK",
      text: `내일 ${appt.time} ${appt.title} 준비가 평소보다 더 걸릴 것 같아요?`,
      target_ref: appt.ref,
      options: [],
    },
  };
}
