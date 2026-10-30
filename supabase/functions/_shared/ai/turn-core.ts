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
  AlarmPlan, AlarmType, Appointment, Card, CardAction, CardEdit, CardKind, Context, Digest, Extract, FactKind, FastExtract, Fix, Importance, Intensity,
  LocalDate, LocalTime, PendingItem, QuestionKind, RejectReason, ServerEvent, ServerQuestion, TaskResults, Weekday,
} from "./types.ts";
import { IMPORTANCE_LABEL } from "./types.ts";
import { FACT_KIND_KO, FIXABLE_FACT_KINDS, addDays, weekdayOf } from "./view.ts";
import { seoulLocal } from "./ko.ts";
import { toMinutes } from "./guards.ts";
import { RING_KINDS } from "../calc/types.ts";

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

/**
 * 대화 기준일. 저장은 0시 경계이지만(문서보완_목록 #14) 대화의 '오늘 · 내일'은 아직 안 잔 밤이면 같은 밤으로 본다 (헤드 H1, 7장 7.13.1:
 * 밤은 다가올 기상에 붙음). 04:00 상수 없음.
 *   다가올 아침 morning = (지금 < 12시 ∧ 달력 오늘 기상 기록 없음) ? 달력 오늘 : 달력 내일, 돌아볼 날 review = morning − 1
 * wokeToday = 달력 오늘의 기상 기록(daily_records.wake_confirmed_at)이 이미 있는지.
 */
export function dayOf(now: string, tz: string, wokeToday: boolean): ConversationDays {
  const cal = seoulLocal(now);
  const morning = cal.minutes < 12 * 60 && !wokeToday ? cal.date : addDays(cal.date, 1);
  return { review: addDays(morning, -1), morning, tz, tzSupported: tz === "Asia/Seoul" };
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
const REJECT_WORD: Record<RejectReason, string> = { NO_PERMISSION: "권한 없음", AMBIGUOUS: "모호함", PAST_TIME: "이미 지난 시각", NOT_FOUND: "대상 없음" };

/** '좀 더'처럼 분이 없을 때 서버 기본 가감 폭 */
export const PREP_ADJUST_DEFAULT = 10;
/** 대화 한 번으로 바꿀 수 있는 준비시간 상한 (설계 가정) */
export const PREP_ADJUST_MAX = 60;

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
  appointments: Appointment[]; // 오늘 + 내일 (카드로 저장된 것 포함)
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
  const appointments = uniq([...ctx.today.appointments, ...ctx.tomorrow.appointments]).map((a) => ({ ...a }));
  const alarms = uniq([...ctx.today.alarms, ...ctx.tomorrow.alarms]).map((a) => ({ ...a }));
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

/** 앱이 계산해야 하는 카드인지 — 새 약속 · 시각이나 준비를 바꾸는 알람 고침. 강도 · 켜고 끄기만이거나 약속 열기 · 알람 추가는 서버가 바로 READY */
function needsEstimate(c: Card): boolean {
  if (c.kind === "APPT_NEW") return true;
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
      if (c.edit?.prepare_delta !== undefined) parts.push(c.edit.prepare_delta === 0 ? "내일만 준비시간 원래대로" : `내일만 준비시간 ${signed(c.edit.prepare_delta)}`);
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
      }
      parts.push("카드의 [바꾸기]로");
      return parts.join(" · ");
    }
    case "ALARM_NEW":
      return `${c.summary} · 카드의 [저장]으로`;
    case "APPT_OPEN":
      return `${c.summary} · 카드의 [일정 열기]로`;
  }
}

/** 카드가 READY일 때 처리 결과에 '확인 필요' 줄을 (다시) 넣는다 — 같은 c#은 한 줄로 */
function pushPending(ev: ServerEvent, c: Card, s: TurnState): void {
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
  if (action["action"] !== "SAVED" && action["action"] !== "REJECTED") return "card_action.action이 SAVED · REJECTED가 아님";
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
 * afterTurn(j) = 몇 번째 사용자 말인지(1부터).
 */
export function applyFast(state: TurnState, fast: FastExtract, ctx: Context, afterTurn: number): FastResult {
  const s: TurnState = structuredClone(state);
  const extract = expandFast(fast);
  const ev = newEvent(afterTurn);
  const touched = new Set<string>();
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
      c = emptyCard(pid, kind);
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
  const clarifyAppt = (x: XAppt): string => {
    if (normTitle(x.title) === "") return `${x.date ? `${dateKo(x.date)} ` : ""}${x.time ? `${x.time} ` : ""}일정의 이름`;
    const miss = [x.date === null ? "날짜" : null, x.time === null ? "시각" : null].filter((v): v is string => v !== null);
    return `'${x.title}'의 정확한 ${miss.join("·")}${x.place === null ? " · 장소" : ""}`;
  };

  /** 기존 약속(targetRef)을 x 값으로 고치는 카드(APPT_OPEN) — 저장 없이 [일정 열기]만 (D41: 알람 저장은 약속 칸을 안 고침) */
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
    const line = `${appointmentSummary(next)}${extra.map((v) => ` · ${v}`).join("")}`;
    const changes: NonNullable<CardEdit["changes"]> = {};
    if (next.date !== cur.date) changes.date = next.date;
    if (next.time !== cur.time) changes.time = next.time;
    if (next.place !== cur.place) changes.place = next.place;
    if (next.importance !== cur.importance) changes.importance = next.importance;
    if (next.transport !== cur.transport) changes.transport = next.transport;
    upsertCard(
      { kind: "APPOINTMENT", key, item: x, summary: `변경: ${line}`, target_ref: cur.ref },
      "APPT_OPEN",
      (c) => {
        c.summary = `변경: ${line}`;
        c.draft = null;
        c.edit = { appointment_id: cur.ref, changes };
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
    const summary = appointmentSummary(x);
    upsertCard(
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
      },
      x.save,
      reuseId,
    );
  };

  const handleNewAppt = (x: XAppt, key: string): void => {
    // 이름 · 날짜 · 시각이 비면 되묻기 (모호 메모만 있고 다 채워진 일정은 아래에서 카드로)
    if (normTitle(x.title) === "" || x.date === null || x.time === null) {
      ev.clarify.push(clarifyAppt(x));
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

  for (const x of extract.appointments) {
    const key = apptKey(x);
    const sig = JSON.stringify([x.save, x.date, x.time, x.place, x.importance, x.transport, x.repeat, x.unclear !== null]);
    if (!once(key, sig)) continue;
    if (x.ref) changeAppt(x, key, x.ref);
    else handleNewAppt(x, key);
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

  for (const c of extract.alarm_changes) {
    const key = `alarm:${c.target}|${c.type}|${c.appointment_ref ?? ""}|${c.date ?? ""}`;
    if (!once(key, JSON.stringify([c.time, c.intensity, c.enabled, c.save]))) continue;
    const self = c.target === "u0";
    const eu = self ? null : ctx.editable_users.find((u) => u.alias === c.target) ?? null;
    const who = self ? "" : `${eu ? `${eu.name}(${c.target})` : c.target} `;
    const day = changeDay(c);
    const cands = candsOf(c, day);
    const cur = cands.length === 1 ? (cands[0] as AlarmPlan) : null;
    // 지금 값과 같은 칸은 바꿀 것이 아님 — AI가 전한 결과를 T2가 되받아 적은 것(019)이 '변경'으로 다시 적용되지 않게
    const sameTime = cur !== null && c.time !== null && c.time === cur.time && (c.date === null || c.date === cur.date);
    const wantTime = sameTime ? null : c.time;
    const wantIntensity = cur !== null && c.intensity === cur.intensity ? null : c.intensity;
    const wantEnabled = cur !== null && c.enabled === cur.enabled ? null : c.enabled;
    const newAt: LocalDateTime | null = wantTime === null ? null : { date: c.date ?? cur?.date ?? day, time: wantTime };
    const changes = [
      wantTime !== null ? `${wantTime}으로` : null,
      wantIntensity !== null ? `강도 ${INTENSITY_KO[wantIntensity]}` : null,
      wantEnabled === false ? "끄기" : wantEnabled === true ? "켜기" : null,
    ].filter(Boolean).join(" · ");
    const label = cur || newAt === null
      ? `${who}${dateKo(cur?.date ?? day)} ${TYPE_KO[c.type]} 알람 ${changes}`.trim()
      : `${who}${dateKo(newAt.date)} ${newAt.time} ${TYPE_KO[c.type]} 알람 추가`;

    // 다른 사람 알람은 v0에서 늘 거절 — 친구 알람은 범위 밖 (설계 메모 4절 '알람 바꿀 수 있는 사람' 늘 빈 목록)
    if (!self) {
      reject(label, "NO_PERMISSION");
      continue;
    }
    // 본인 알람이 없는 약속을 가리키면 고아 알람을 만들지 않음
    if (c.appointment_ref !== null && !apptByRef(c.appointment_ref)) {
      reject(`${c.appointment_ref} ${TYPE_KO[c.type]} 알람`, "NOT_FOUND");
      continue;
    }
    // 후보가 여럿이어도 그중 하나가 이미 요청 값 그대로면 AI가 전한 알람을 되받아 적은 것 — '모호함'으로 거절하지 않음
    const already = (a: AlarmPlan): boolean =>
      c.time !== null && a.time === c.time && (c.date === null || a.date === c.date)
      && (c.intensity === null || a.intensity === c.intensity) && (c.enabled === null || a.enabled === c.enabled);
    if (cands.length > 1 && cands.some(already)) {
      dropPending(key);
      continue;
    }
    if (cands.length > 1) {
      reject(label, "AMBIGUOUS");
      continue;
    }
    if (c.time === null && c.intensity === null && c.enabled === null) {
      ev.clarify.push(`${who}${TYPE_KO[c.type]} 알람을 어떻게 바꿀지`);
      continue;
    }
    if (cur && wantTime === null && wantIntensity === null && wantEnabled === null) {
      dropPending(key); // 이미 그 값 — 할 일 없음
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
      dropPending(key);
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
      dropPending(key);
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
      upsertCard({ kind: "ALARM_CHANGE", key, item: c, summary: label, target_ref: null }, "ALARM_EDIT", (card) => {
        card.summary = label;
        card.draft = null;
        card.edit = edit;
      }, c.save);
    } else if (newAt) {
      // 본인 알람을 새로 만드는데 같은 분에 이미 켜진 본인 알람이 있으면 두 번 울리지 않게 만들지 않음 (072)
      const twin = sameMinuteAlarm(newAt);
      if (twin) {
        dropPending(key);
        ev.conflicts = [...(ev.conflicts ?? []), `${dateKo(twin.date)} ${twin.time} ${TYPE_KO[c.type]} 알람 안 만듦 — 같은 시각 ${TYPE_KO[twin.type]} 알람이 이미 있음`];
        continue;
      }
      const edit: CardEdit = { at: localToIso(newAt.date, newAt.time), level: c.intensity === null ? null : levelOfIntensity(c.intensity) };
      upsertCard({ kind: "ALARM_CHANGE", key, item: c, summary: label, target_ref: null }, "ALARM_NEW", (card) => {
        card.summary = label;
        card.draft = null;
        card.edit = edit;
      }, c.save);
    }
  }

  // ── 내일만 준비시간 가감 ── (준비시간 범위는 day 고정: 내일 기상 기준 일정 — 그날 가장 이른 켜진 기상 알람의 약속)
  const pa = extract.prep_adjustment;
  if (pa && once("prep", JSON.stringify([pa.direction, pa.minutes, pa.save ?? null]))) {
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
  //   crisisNotified는 '한 번이라도 안내했는지'로 남김(상태 기록 · 시험용). 안내 줄 자체는 이 턴 위험 표시만 따른다
  s.safetyFlag = s.safetyFlag || extract.safety_flag;
  const crisis = extract.safety_flag;
  if (crisis) {
    s.crisisNotified = true;
    ev.crisis = true;
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
  return a ? { date: a.date, time: a.time } : null;
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
    const title = c.draft?.title ?? c.summary;
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
      c.status = "READY";
      c.error = null;
      pushPending(ev, c, s);
    } else if (r.status === "NEEDS_PLACE") {
      c.status = "NEEDS_PLACE";
      c.error = null;
      ev.clarify.push(`'${title}' 장소 (카드의 [장소 고르기])`);
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
    c.status = "REJECTED";
    c.highlight = false;
    delete s.pending[c.id];
    // 같은 말(T2F가 현재 상태를 되풀이)이 다시 와도 카드를 또 만들지 않음 — seen 서명이 같으면 건너뛰고, 재료가 바뀌면 새 카드
    return { ok: true, state: s, event: eventFor(s, afterTurn), card: c, needsReply: false, status: "OK", invalid: null };
  }
  if (c.kind === "APPT_OPEN") return none("NOOP"); // 저장 없는 카드 — [일정 열기]만

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
    s.appointments.push({
      ref, title: d.title, date: d.date, time: d.time, place: d.place, importance: d.importance,
      importance_confirmed: d.importance !== null, transport: d.transport, travel_minutes: null, repeat: d.repeat.length > 0 ? "WEEKLY" : "NONE",
    });
    s.createdKeys[ref] = entry?.key ?? `appt:${normTitle(d.title)}|${d.date}|${d.time}`;
    if (action.appointment_id) s.bound[ref] = action.appointment_id;
    c.appointment_id = action.appointment_id ?? null;
    ev.applied.push(`일정 저장: ${base}`);
    const others: string[] = [];
    for (const a of alarms) {
      const plan = addAlarm({ ...a, level: a.level ?? null }, ref);
      if (a.kind === "WAKE" && c.first_of_day) ev.alarms.push(plan);
      else if (OTHER_LABEL[a.kind] !== undefined && !others.includes(OTHER_LABEL[a.kind] as string)) others.push(OTHER_LABEL[a.kind] as string);
    }
    if (others.length > 0) ev.applied.push(`그 밖의 알람(${others.join(" · ")})도 같이 맞춤`);
    if (c.edit?.prepare_delta !== undefined) ev.applied.push(c.edit.prepare_delta === 0 ? "내일만 준비시간 원래대로" : `내일만 준비시간 원래보다 ${signed(c.edit.prepare_delta)}`);
  } else if (c.kind === "ALARM_EDIT") {
    const apptRef = c.edit?.appointment_id ?? null;
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
    ev.applied.push(`알람 변경: ${base}`);
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
  // '하루' = 대화 기준일(같은 밤, 헤드 H1 · 10/30) — 달력 날짜가 아님. 기준일 = 돌아볼 날(ctx.dates.today)의 0시부터 지금까지.
  //   23:50에 물은 뒤 00:20 같은 밤 대화(기준일 아직 어제)에서도 오늘 몫을 이미 쓴 것이고, 다음 기준일(돌아볼 날이 바뀐 대화)에는 새로 물을 수 있음.
  //   (자정 뒤에 물은 질문은 그 밤의 기준일에 묶이지 못하고 달력 날짜로 셈 — 다음 날 저녁에 한 번 덜 묻는 쪽으로 틀림, 안전한 쪽)
  const dayStart = dayNumber(ctx.dates.today) * 1440;
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
