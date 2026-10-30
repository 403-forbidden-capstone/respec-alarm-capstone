// 컨텍스트 → 한국어 글 블록 (실험실 lib/view.ts 이식). 프롬프트 입력 모양이 되므로 순수 · 결정적이어야 한다(같은 입력 → 같은 바이트).
// 현재 시각 · Intl · toLocaleString을 쓰지 않는다(Node/Deno ICU 차이 · 프롬프트 캐시 깨짐 방지).
// 글 모양을 바꾸면 프롬프트 입력이 바뀌므로 VIEW_VERSION을 올린다. 프롬프트가 부르는 머리말 이름(### 날짜 · ### 오늘 기록 · '확인할 기록(서버가 고름)' ·
//   ### 서버 처리 결과 …)은 바꾸지 않는다(03-대화답.md:229).
// 엄격함: 형식이 틀린 날짜 · 시각 · 모르는 열거값은 에러(가짜 데이터 · 서버 버그를 조용히 넘기지 않게).
//         날짜표(dates)가 record_date와 어긋나거나 record_date가 달력 오늘 · 어제 밖이어도 에러.
//
// 이식 때 바꾼 곳(설계 메모 7절):
//   · 날짜(4.1): 04:00 하루 경계(DAY_BOUNDARY_HOUR)를 뺐다. 저장은 0시이고, 대화 기준일(record_date = 돌아볼 날)은 헤드 H1 규칙으로 turn-core `dayOf`가 정한다.
//     record_date는 달력 오늘이거나 달력 어제여야 하고, 어제면(자정 뒤 아직 안 잔 대화) 날짜 블록 둘째 줄에 자정 줄이 붙는다.
//   · 확인할 기록(4.2): pickConfirmFacts에 fill · kinds 옵션 — 서버는 SERVER_CONFIRM_OPTS(자동 감지 값만, 채우기 없음, 기상 1 + 출발 · 도착 2).
//   · diaryVars(일기 PR 몫)는 뺐다.
// 자유 글(제목 · 장소 · 사용자 말 등)은 한 줄로 접는다 — 사용자 말이 '### …' 같은 줄을 새로 만들지 못하게.

import type {
  AlarmPlan,
  AlarmType,
  Appointment,
  Context,
  EditableUser,
  Fact,
  FactKind,
  Importance,
  Intensity,
  LocalDate,
  LocalTime,
  Opening,
  PendingItem,
  QuestionKind,
  RejectReason,
  ServerEvent,
  SessionType,
  Transport,
  Turn,
  Weekday,
} from "./types.ts";
import { IMPORTANCE_LABEL, WEEKDAYS, WEEKDAY_KO } from "./types.ts";

// v2(10/9 검토): 날짜 블록 끝에 '대화 여는 방식' 줄 · 사실의 단위(도착 = 지각 분, 루틴 = 단계) · 날짜표 일관성 검사
// v3(10/9 시운전): 취침 사실을 "지난밤 취침"으로 — 전날 밤 일인데 "오늘 22시에 주무셨고"로 읽힘
// v4(10/9 실패 분석): "어젯밤 취침"(v3도 4건 '오늘'로 읽힘) · "준비가 예상보다 N분 더 걸림"('N분 넘게 걸림' 오독) ·
//   지금보다 이른 일정에 '지남' · 처리 결과에 '새 알람'과 '바뀐 알람' 구분 · '겹침' 줄 · 위기 안내 줄 · 확인할 기록 줄(선택)
// (E1 10/10: 선택 옵션 spokenTimes 추가 — 기본 끔이라 기본 글은 v4와 바이트까지 같음 → 버전은 그대로. 켠 실행은 대화 파일 harness.view_opts에 남음)
// v5(L4 10/29, 설계 메모 4.1): 날짜 블록의 새벽(04:00) 줄 → 자정 줄('자정이 지났지만 잠들기 전이라 …'). 기록 날짜가 달력 어제일 때만 붙음. 나머지 글은 v4와 같음.
export const VIEW_VERSION = "view.v5";

// ───────── 열거값 → 한국어 ─────────

export const INTENSITY_KO: Record<Intensity, string> = { SOFT: "약하게", NORMAL: "보통", STRONG: "강하게" };
export const ALARM_TYPE_KO: Record<AlarmType, string> = { WAKE: "기상", PREPARE: "준비 시작", DEPARTURE: "출발", ARRIVE: "도착 확인" };
export const REJECT_KO: Record<RejectReason, string> = {
  NO_PERMISSION: "권한 없음",
  AMBIGUOUS: "모호함",
  PAST_TIME: "이미 지난 시각",
  NOT_FOUND: "대상 없음",
};
export const TRANSPORT_KO: Record<Transport, string> = { WALK: "도보", TRANSIT: "대중교통", BUS: "버스", SUBWAY: "지하철", CAR: "자동차" };
export const FACT_KIND_KO: Record<FactKind, string> = {
  SLEEP: "어젯밤 취침",
  WAKE: "기상",
  SNOOZE: "미루기",
  DEPART: "출발",
  ARRIVE: "도착",
  LATE: "지각",
  PREP_OVER: "준비 초과",
  ROUTINE_DONE: "루틴 완료",
};
export const FACT_SOURCE_KO: Record<Fact["source"], string> = { AUTO: "자동", ONE_TAP: "원탭", MANUAL: "직접 입력" };
export const QUESTION_KIND_KO: Record<QuestionKind, string> = {
  CAUSE: "원인 질문",
  IMPORTANCE: "중요도 확인",
  TOMORROW_REASON: "내일 사유 확인",
  PREP_CHECK: "내일 준비시간 확인",
  ITEMS: "준비물 확인",
};
export const RELATION_KO: Record<EditableUser["relation"], string> = { FRIEND: "친구", GROUP: "그룹", FAMILY: "가족" };
export const PENDING_KIND_KO: Record<PendingItem["kind"], string> = { APPOINTMENT: "일정", IMPORTANCE: "중요도", ALARM_CHANGE: "알람 변경" };
export const SESSION_KO: Record<SessionType, string> = { BEFORE_SLEEP: "자기 전 대화", AFTER_WAKE: "기상 후 대화" };
export const OPENING_KO: Record<Opening, string> = { SUMMARY_FIRST: "요약 먼저", QUESTION_FIRST: "질문 먼저" };

/** 열거값 → 라벨. 모르는 값이면 에러. */
function pick<K extends string>(map: Record<K, string>, key: K, what: string): string {
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(map, key)) {
    throw new Error(`view: 모르는 ${what} 값 '${String(key)}'`);
  }
  return map[key];
}

// ───────── 날짜 · 시각 ─────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const SEOUL_OFFSET_MIN = 540;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymd(d: LocalDate, what = "날짜"): [number, number, number] {
  const m = typeof d === "string" ? DATE_RE.exec(d) : null;
  if (!m) throw new Error(`view: ${what} 형식이 아님 '${String(d)}' (YYYY-MM-DD)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  // 0~99년은 Date.UTC가 1900~1999년으로 바꿔 버린다 — 1000년 전은 받지 않음
  if (y < 1000) throw new Error(`view: 없는 ${what} '${d}' (1000년 이후만)`);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || da < 1 || da > last) throw new Error(`view: 없는 ${what} '${d}'`);
  return [y, mo, da];
}

/** 날짜의 요일 (달력 계산만, 현재 시각과 무관) */
export function weekdayOf(d: LocalDate): Weekday {
  const [y, mo, da] = ymd(d);
  const js = new Date(Date.UTC(y, mo - 1, da)).getUTCDay(); // 0 = 일
  return WEEKDAYS[(js + 6) % 7] as Weekday;
}

/** 날짜 더하기 (n은 음수 가능) */
export function addDays(d: LocalDate, n: number): LocalDate {
  if (!Number.isInteger(n)) throw new Error(`view: addDays 일수는 정수여야 함 '${String(n)}'`);
  const [y, mo, da] = ymd(d);
  const t = new Date(Date.UTC(y, mo - 1, da + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** "10-09(금)" — 블록 안에서 쓰는 짧은 날짜 */
export function shortDate(d: LocalDate): string {
  ymd(d);
  return `${d.slice(5)}(${WEEKDAY_KO[weekdayOf(d)]})`;
}

/** "2026-10-09(금)" — 모델이 그대로 베껴 쓸 수 있는 날짜 */
export function fullDate(d: LocalDate): string {
  ymd(d);
  return `${d}(${WEEKDAY_KO[weekdayOf(d)]})`;
}

/** "07:40" — 초가 붙어 와도 잘라 낸다 */
export function hhmm(t: LocalTime, what = "시각"): string {
  const m = typeof t === "string" ? TIME_RE.exec(t) : null;
  if (!m) throw new Error(`view: ${what} 형식이 아님 '${String(t)}' (HH:MM)`);
  return `${m[1]}:${m[2]}`;
}

/**
 * 시각 → 말로 하는 한국어 (E1, 10/10 — 라운드 1 h4: 프롬프트가 24시간을 오전/오후로 바꾸게 하면 변환 실수가 났음 → 서버가 미리 바꿔 넘김).
 *   00시대 = 밤 12시 · 01~05시 = 새벽 · 06~11시 = 오전 · 12시대 = 낮 12시 · 13~23시 = 오후. 분이 0이면 '분'을 생략, 30분도 '반'이 아니라 '30분'.
 *   예: 18:30 → 오후 6시 30분 · 09:00 → 오전 9시 · 12:20 → 낮 12시 20분 · 00:30 → 밤 12시 30분 · 05:10 → 새벽 5시 10분
 *   ko.ts의 때 표시 읽기(오전·새벽 = h%12, 낮 12시 = 12, 오후 h+12, 밤 12시 = 0)와 같은 뜻이 되게 맞춘 것.
 */
export function spokenTime(hour: number, minute: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`view: 없는 시각 ${String(hour)}:${String(minute)}`);
  }
  const part = hour === 0 ? "밤" : hour < 6 ? "새벽" : hour < 12 ? "오전" : hour === 12 ? "낮" : "오후";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${part} ${h12}시${minute === 0 ? "" : ` ${minute}분`}`;
}

/** 글 속 'HH:MM'(초 없는 24시간 표기)을 모두 spokenTime으로. 앞뒤가 숫자 · 콜론이면 시각이 아니라고 보고 둠 ('10:30:15' · '3:1') */
export function spokenizeTimes(text: string): string {
  return text.replace(/(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/gu, (_m, h: string, mi: string) => spokenTime(Number(h), Number(mi)));
}

export interface SeoulTime {
  date: LocalDate; // 달력 날짜 (04:00 경계 적용 전)
  time: LocalTime;
  hour: number;
  month: number;
  day: number;
}

/** ISO 시각 → 서울 로컬 날짜 · 시각(분 단위, 초 버림). 시간대 표기가 없으면 이미 서울 로컬로 본다. */
export function toSeoul(iso: string): SeoulTime {
  const m = typeof iso === "string" ? ISO_RE.exec(iso) : null;
  if (!m) throw new Error(`view: ISO 시각 형식이 아님 '${String(iso)}'`);
  const [y, mo, da] = ymd(`${m[1]}-${m[2]}-${m[3]}`, "now 날짜");
  const h = Number(m[4]);
  const mi = Number(m[5]);
  if (h > 23 || mi > 59 || (m[6] !== undefined && Number(m[6]) > 59)) throw new Error(`view: 없는 시각 '${iso}'`);
  const zone = m[7];
  let offset = SEOUL_OFFSET_MIN;
  if (zone === "Z") offset = 0;
  else if (zone) {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    // 실제 시간대는 −12:00 ~ +14:00, 분은 59까지
    if (!z || Number(z[2]) > 14 || Number(z[3]) > 59) throw new Error(`view: 시간대 형식이 아님 '${zone}'`);
    offset = (z[1] === "-" ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3]));
  }
  const t = new Date(Date.UTC(y, mo - 1, da, h, mi) + (SEOUL_OFFSET_MIN - offset) * 60000);
  const date = `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  return { date, time: `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`, hour: t.getUTCHours(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** "10월 8일(목) 22:30" */
export function nowLabel(iso: string): string {
  const n = toSeoul(iso);
  return `${n.month}월 ${n.day}일(${WEEKDAY_KO[weekdayOf(n.date)]}) ${n.time}`;
}

// ───────── 자유 글 ─────────

/**
 * 줄마다 앞뒤 공백을 걷고 빈 줄은 버린 뒤 ' / '로 잇는다. 빈 글이면 대체 문구.
 * 줄바꿈으로 치는 글자: CR · LF · 세로 탭 · 폼 피드 · 정보 구분자(1C~1E) · NEL(85) · 줄/문단 구분자(2028 · 2029)
 * — 어느 렌더러 · 토크나이저가 새 줄로 보든 사용자 말이 '### …' 줄을 만들지 못하게.
 */
const LINE_BREAK_RE = /\r\n|[\n\r\x0b\x0c\x1c-\x1e\x85\u2028\u2029]/;
export function oneLine(s: string, empty = "(빈 글)"): string {
  if (typeof s !== "string") throw new Error(`view: 글이 문자열이 아님 '${String(s)}'`);
  const t = s
    .split(LINE_BREAK_RE)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .join(" / ");
  return t === "" ? empty : t;
}

function count(n: number | null, what: string): number | null {
  if (n === null) return null;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`view: ${what} 값이 수가 아님 '${String(n)}'`);
  return n;
}

/** 날짜 · 시각 순 정렬 (같으면 들어온 순서 유지) */
function byWhen<T extends { date: LocalDate; time: LocalTime }>(list: T[]): T[] {
  return list
    .map((x, i) => ({ x, i, k: `${x.date} ${x.time}` }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
    .map((e) => e.x);
}

// ───────── 날짜 블록 ─────────

/** 세션의 지금(서울). 이 보기는 context.v1 · Asia/Seoul(+09:00 고정 계산)만 다룬다. */
function sessionNow(ctx: Context): SeoulTime {
  if (ctx.context_version !== "context.v1") throw new Error(`view: 모르는 context_version '${String(ctx.context_version)}' (context.v1만)`);
  if (ctx.session.timezone !== "Asia/Seoul") {
    throw new Error(`view: session.timezone '${String(ctx.session.timezone)}' — Asia/Seoul만 (+09:00 고정 계산)`);
  }
  return toSeoul(ctx.session.now);
}

/** 날짜표가 record_date로 만든 값과 같은지 — 모델이 그대로 베끼는 값이라 하나라도 어긋나면 에러 */
function checkDates(d: Context["dates"], rec: LocalDate): void {
  const eq = (label: string, got: LocalDate | undefined, want: LocalDate): void => {
    ymd(got as LocalDate, label);
    if (got !== want) throw new Error(`view: ${label} '${got}'가 record_date ${rec} 기준 값 '${want}'와 다름`);
  };
  eq("dates.today", d.today, rec);
  eq("dates.tomorrow", d.tomorrow, addDays(rec, 1));
  eq("dates.day_after", d.day_after, addDays(rec, 2));
  const wd = weekdayOf(rec);
  if (d.weekday_today !== wd) throw new Error(`view: dates.weekday_today '${String(d.weekday_today)}'가 record_date ${rec}의 요일 ${wd}와 다름`);
  // 주는 월~일, this_week = record_date가 든 주
  const monday = addDays(rec, -WEEKDAYS.indexOf(wd));
  WEEKDAYS.forEach((k, i) => {
    eq(`dates.this_week ${k}`, d.this_week?.[k], addDays(monday, i));
    eq(`dates.next_week ${k}`, d.next_week?.[k], addDays(monday, 7 + i));
  });
}

/**
 * 지금: 10월 8일(목) 22:30 · 기록 날짜 2026-10-08 · 자기 전 대화
 * 오늘 2026-10-08(목) · 내일 2026-10-09(금) · 모레 2026-10-10(토)
 * 이번 주: 월 2026-10-05 · … · 일 2026-10-11
 * 다음 주: 월 2026-10-12 · … · 일 2026-10-18
 * 기록 날짜(= 대화 기준일, 돌아볼 날)는 달력 오늘이거나 달력 어제여야 한다(설계 메모 4.1 — 어제면 '자정이 지났지만 아직 안 잔' 대화).
 * 어제일 때는 둘째 줄에 자정 줄이 붙는다(일요일 밤이면 '이번 주'도 확인 필요). 그 밖이면 에러.
 */
export function viewDates(ctx: Context): string {
  const now = sessionNow(ctx);
  const rec = ctx.session.record_date;
  ymd(rec, "record_date");
  const midnightPassed = rec !== now.date;
  if (midnightPassed && rec !== addDays(now.date, -1)) {
    throw new Error(`view: record_date ${rec}가 지금(${now.date} ${now.time})의 달력 오늘 · 어제가 아님 — 대화 기준일(dayOf)을 확인`);
  }
  const d = ctx.dates;
  checkDates(d, rec);
  const lines = [`지금: ${nowLabel(ctx.session.now)} · 기록 날짜 ${rec} · ${pick(SESSION_KO, ctx.session.type, "세션 종류")}`];
  if (midnightPassed) {
    let night = `자정이 지났지만 잠들기 전이라 '오늘'은 ${fullDate(rec)} · '내일'은 ${fullDate(d.tomorrow)}로 셈 · 이때 말하는 '오늘'이 ${fullDate(rec)}인지 ${fullDate(now.date)}인지는 확인 필요`;
    // 일요일 밤 → 월요일 자정 뒤: 기록상 '이번 주'는 끝난 주라 '이번 주 수요일'도 어느 주인지 모호
    if (weekdayOf(rec) === "SUN") night += " · 달력으로는 이미 월요일이라 '이번 주'·'다음 주'가 어느 주인지도 확인 필요";
    lines.push(night);
  }
  lines.push(`오늘 ${fullDate(d.today)} · 내일 ${fullDate(d.tomorrow)} · 모레 ${fullDate(d.day_after)}`);
  const week = (w: Record<Weekday, LocalDate>): string => WEEKDAYS.map((k) => `${WEEKDAY_KO[k]} ${w[k]}`).join(" · ");
  lines.push(`이번 주: ${week(d.this_week)}`);
  lines.push(`다음 주: ${week(d.next_week)}`);
  return lines.join("\n");
}

// ───────── 오늘 사실 ─────────

/**
 * 사실 본문 ("지각 20분", "기상 08:37") — 출처 · 약속 표시는 뺀 것.
 * minutes의 뜻은 종류마다 다르다(truth.factsFor 기준): 미루기 = 횟수 · 지각/준비 초과 = 분 · 도착 = 지각 분 · 루틴 = 완료 단계 수.
 * 뜻을 모르는 숫자에 '분'을 붙이면 모델이 없는 사실을 말하게 되므로 종류별로 단위를 고정한다.
 */
function factMain(f: Fact): string {
  const label = pick(FACT_KIND_KO, f.kind, "사실 종류");
  const t = f.time === null ? null : hhmm(f.time, `사실 ${f.id} 시각`);
  const n = count(f.minutes, `사실 ${f.id} minutes`);
  const at = t === null ? "" : ` · ${t}`;
  const text = oneLine(f.text ?? "", "");
  let main: string;
  switch (f.kind) {
    case "SNOOZE":
      main = n === null ? `미루기${at}` : `미루기 ${n}번${at}`;
      break;
    case "LATE":
      main = n === null ? `지각${at}` : `지각 ${n}분${at}`;
      break;
    case "PREP_OVER":
      // 'N분 초과'는 'N분 넘게 걸림'으로 읽혀(012 · 036) 뜻을 풀어 씀
      main = n === null ? `준비가 예상보다 더 걸림${at}` : `준비가 예상보다 ${n}분 더 걸림${at}`;
      break;
    case "ARRIVE":
      main = `도착${t === null ? "" : ` ${t}`}${n === null ? "" : ` · 지각 ${n}분`}`;
      break;
    case "ROUTINE_DONE":
      // 루틴 이름 · 'n/m단계'는 서버 문장에 있다. 문장이 없을 때만 단계 수를 붙인다
      main = `루틴 완료${t === null ? "" : ` ${t}`}`;
      if (text !== "") return `${main} — ${text}`;
      return n === null ? main : `${main}${t === null ? "" : " ·"} ${n}단계`;
    default:
      main = `${label}${t === null ? "" : ` ${t}`}${n === null ? "" : ` · ${n}분`}`;
  }
  // 값이 비어 있는 사실은 서버 문장을 붙인다
  if (t === null && n === null && text !== "") main += ` — ${text}`;
  return main;
}

function factLine(f: Fact): string {
  const ref = f.appointment_ref ? ` · ${f.appointment_ref} 기준` : "";
  const src = pick(FACT_SOURCE_KO, f.source, "사실 출처");
  return `[${f.id}] ${factMain(f)}${ref} (${src}${f.confirmed ? " · 확인됨" : ""})`;
}

/** "[f2] 출발 09:05 (자동)" — 한 줄에 사실 하나, 서버가 준 순서 그대로 */
export function viewFacts(ctx: Context): string {
  const facts = ctx.today.facts;
  return facts.length === 0 ? "오늘 기록 없음" : facts.map(factLine).join("\n");
}

// ───────── 확인할 기록 (서버가 고름) ─────────

/** 확인 대상에서 빼는 파생 사실 — 원 기록(기상 · 출발 · 도착)에서 서버가 계산하는 값 */
const DERIVED_FACTS: readonly FactKind[] = ["LATE", "PREP_OVER"];
/** 고르는 순서 — 출발 · 도착 감지 먼저(자동 감지 오류가 가장 잦음), 다음 기상 */
const CONFIRM_RANK: Record<FactKind, number> = { DEPART: 0, ARRIVE: 0, WAKE: 1, SLEEP: 2, SNOOZE: 3, ROUTINE_DONE: 4, LATE: 9, PREP_OVER: 9 };
export const CONFIRM_FACTS_MAX = 3;
export const CONFIRM_FACTS_MIN = 2;
/**
 * 대화로 고칠 길이 붙은 사실 종류 (설계 메모 4.2 #3 · 13절 L1-3) — 출발 · 도착은 L2 정정 함수가 있다.
 * 기상은 L1의 대화 기상 정정 함수가 머지될 때까지 첫 마디가 읽어 주기만 하고 고치지는 않는다(turn-core: 기상 정정은 '대상 없음' 거절).
 */
export const FIXABLE_FACT_KINDS: readonly FactKind[] = ["DEPART", "ARRIVE"];

export interface ConfirmOptions {
  /** 자동 · 미확인 기상 1개를 늘 넣는다 (E2, 기본 true). false면 E1 때 규칙 */
  wakeAlways?: boolean;
  /** 2개보다 적으면 나머지(취침 · 미루기 · 루틴 …)로 채운다 (실험실 규칙, 기본 true). 서버는 false — 설계 메모 4.2 #4 */
  fill?: boolean;
  /** 후보로 삼을 사실 종류 (기본: 모두). 서버는 기상 · 출발 · 도착만 */
  kinds?: readonly FactKind[];
}

/** 서버 규칙 (설계 메모 4.2): 자동 감지 값만(원탭 · 직접 · 대화로 받은 값은 confirmed) · 채우기 없음 · 기상 1 + 출발 · 도착 2 */
export const SERVER_CONFIRM_OPTS: Readonly<ConfirmOptions> = Object.freeze({
  wakeAlways: true,
  fill: false,
  kinds: ["WAKE", ...FIXABLE_FACT_KINDS] as readonly FactKind[],
});

/**
 * 서버가 고르는 '확인할 기록' (7장 v4 '고르기는 서버' · 실패 분석 product_findings 1).
 * 확인됨 · 파생(지각 · 준비 초과)은 뺀다. 자동 감지 · 미확인 출발 · 도착 · 기상은 3개까지 넣고,
 * 그것이 2개보다 적으면 나머지(자동 먼저 → 취침 · 미루기 · 루틴 순)로 2개까지 채운다(fill, 기본 켬). 결과는 서버가 준 순서.
 * E2(10/10): 자동 · 미확인 기상 기록은 늘 목록에 넣는다 (E1: 목록에 든 기상 기록 36/36 고쳐짐, 빠진 것 0/10).
 *   출발 · 도착이 많은 날에도 기상 1개 + 출발 · 도착 2개까지 — 기상이 출발 · 도착에 밀려나지 않게.
 *   opts.wakeAlways=false면 E1 때의 규칙(출발 · 도착 먼저 3개)으로.
 * L4(10/29, 설계 메모 4.2): 서버는 SERVER_CONFIRM_OPTS(fill 끔 · kinds = 기상 · 출발 · 도착)로 부른다.
 */
export function pickConfirmFacts(ctx: Context, opts: ConfirmOptions = {}): string[] {
  const rank = (f: Fact): number => {
    pick(FACT_KIND_KO, f.kind, "사실 종류"); // 모르는 종류면 에러
    return (f.source === "AUTO" ? 0 : 10) + CONFIRM_RANK[f.kind];
  };
  const kinds = opts.kinds;
  const cands = ctx.today.facts
    .map((f, i) => ({ f, i, r: rank(f) }))
    .filter(({ f }) => !f.confirmed && !DERIVED_FACTS.includes(f.kind) && (kinds === undefined || kinds.includes(f.kind)))
    .sort((a, b) => a.r - b.r || a.i - b.i);
  const auto = cands.filter((c) => c.r <= CONFIRM_RANK.WAKE);
  // 자동 · 미확인 기상 기록이 있으면 첫 번째를 꼭 넣고, 남은 자리를 출발 · 도착(없으면 다른 기상)으로
  const wake = opts.wakeAlways === false ? undefined : auto.filter((c) => c.f.kind === "WAKE").sort((a, b) => a.i - b.i)[0];
  const rest = auto.filter((c) => c !== wake);
  const picked = wake ? [wake, ...rest.slice(0, CONFIRM_FACTS_MAX - 1)] : rest.slice(0, CONFIRM_FACTS_MAX);
  if (opts.fill !== false) {
    for (const c of cands) {
      if (picked.length >= CONFIRM_FACTS_MIN) break;
      if (!picked.includes(c)) picked.push(c);
    }
  }
  return picked.sort((a, b) => a.i - b.i).map((c) => c.f.id);
}

/** "확인할 기록(서버가 고름): f2 · f4" */
export function viewConfirmFacts(ids: string[]): string {
  return `확인할 기록(서버가 고름): ${ids.length === 0 ? "없음" : ids.map((id) => oneLine(id)).join(" · ")}`;
}

// ───────── 일정 ─────────

function importanceText(a: Appointment): string {
  if (a.importance === null) return "중요도 미정";
  const label = pick<Importance>(IMPORTANCE_LABEL, a.importance, "중요도");
  return `중요도 ${label}(${a.importance}${a.importance_confirmed ? "" : ", 미확인"})`;
}

function moveText(a: Appointment): string {
  const tr = a.transport === null ? null : pick(TRANSPORT_KO, a.transport, "이동 수단");
  const mins = count(a.travel_minutes, `일정 ${a.ref} travel_minutes`);
  if (tr !== null && mins !== null) return `이동 ${tr} ${mins}분`;
  if (tr !== null) return `이동 ${tr}`;
  if (mins !== null) return `이동 ${mins}분`;
  return "이동 미정";
}

function apptHead(a: Appointment): string {
  return `[${a.ref}] ${shortDate(a.date)} ${hhmm(a.time, `일정 ${a.ref} 시각`)} ${oneLine(a.title, "(제목 없음)")}`;
}

/** 지금(서울)보다 이른 날짜 · 시각인지 — 같은 분은 안 지남 */
function isBefore(date: LocalDate, time: LocalTime, now: SeoulTime): boolean {
  return `${date} ${time}` < `${now.date} ${now.time}`;
}

function apptLine(a: Appointment, now?: SeoulTime): string {
  const place = a.place === null ? "" : oneLine(a.place, "");
  const head = apptHead(a);
  // 시작 시각이 이미 지난 일정 — 기상 후 늦게 일어난 날 · 자기 전의 오늘 일정을 앞일로 안내하지 않게(069 · 048 · 003)
  const past = now !== undefined && isBefore(a.date, hhmm(a.time), now);
  const parts = [past ? `${head} · 지남` : head, place === "" ? "장소 미정" : `장소 ${place}`, importanceText(a), moveText(a)];
  if (a.repeat === "WEEKLY") parts.push("매주 반복");
  else if (a.repeat !== "NONE") throw new Error(`view: 모르는 반복 값 '${String(a.repeat)}'`);
  return parts.join(" · ");
}

/**
 * "[a2] 10-09(금) 10:00 캡스톤 발표 · 장소 강남 · 중요도 매우 중요(HIGH) · 이동 지하철 50분"
 * 날짜 · 시각 순. 비었으면 "{label} 없음". now(ISO)를 주면 시작 시각이 지난 일정 제목 뒤에 '지남'.
 */
export function viewAppointments(list: Appointment[], label: string, now?: string): string {
  const n = now === undefined ? undefined : toSeoul(now);
  return list.length === 0 ? `${label} 없음` : byWhen(list).map((a) => apptLine(a, n)).join("\n");
}

// ───────── 알람 ─────────

export interface AlarmViewOptions {
  /** 이 날짜의 알람은 날짜를 빼고 시각만 쓴다(없으면 늘 날짜를 붙임) */
  date?: LocalDate;
  /** 주면 이미 지난 알람에 '지남'을 붙인다 (ISO) */
  now?: string;
  /** 별칭 → 이름 (u1 → 서연) */
  names?: Record<string, string>;
  /** 비었을 때 문구 앞말 (기본 "알람" → "알람 없음") */
  label?: string;
}

interface AlarmLineOpts {
  date?: LocalDate;
  now?: SeoulTime;
  names: Record<string, string>;
  changedAfter?: number;
  /** changedAfter와 함께: 대화 중 새로 생긴 알람이면 '새로 생김', 아니면 '바뀜' */
  isNew?: boolean;
}

function ownerLabel(alias: string, names: Record<string, string>): string {
  const name = Object.prototype.hasOwnProperty.call(names, alias) ? names[alias] : undefined;
  return name === undefined ? alias : `${oneLine(name)}(${alias})`;
}

function alarmLine(a: AlarmPlan, o: AlarmLineOpts): string {
  ymd(a.date, `알람 ${a.ref} 날짜`);
  const time = hhmm(a.time, `알람 ${a.ref} 시각`);
  const when = o.date !== undefined && a.date === o.date ? time : `${shortDate(a.date)} ${time}`;
  const parts = [`[${a.ref}] ${pick(ALARM_TYPE_KO, a.type, "알람 종류")} ${when}`, `${pick(INTENSITY_KO, a.intensity, "강도")}(${a.intensity})`];
  if (a.appointment_ref) parts.push(`${a.appointment_ref} 기준`);
  if (a.owner !== "u0") parts.push(`${ownerLabel(a.owner, o.names)} 알람`);
  if (!a.enabled) parts.push("꺼짐");
  if (o.now && isBefore(a.date, time, o.now)) parts.push("지남");
  if (o.changedAfter !== undefined) parts.push(`${o.isNew ? "새로 생김" : "바뀜"}(사용자 말 ${o.changedAfter} 뒤)`);
  return parts.join(" · ");
}

/** "[al1] 기상 07:40 · 강하게(STRONG) · a2 기준" — 날짜 · 시각 순 */
export function viewAlarms(list: AlarmPlan[], opts: AlarmViewOptions = {}): string {
  if (list.length === 0) return `${opts.label ?? "알람"} 없음`;
  const o: AlarmLineOpts = { names: opts.names ?? {} };
  if (opts.date !== undefined) o.date = opts.date;
  if (opts.now !== undefined) o.now = toSeoul(opts.now);
  return byWhen(list).map((a) => alarmLine(a, o)).join("\n");
}

/**
 * 서버 처리 결과의 알람을 그날 목록에 덮어쓴다 — 스텁이 컨텍스트를 갱신하든 안 하든 같은 글이 나오게.
 * 그날 블록에 드는 알람 = 그날 날짜이거나, 그날 약속에 딸린 그 전 날짜 알람(이른 약속 때문에 전날 밤 기상 등).
 * 처리 결과로 다른 날로 옮겨 간 알람은 그날 블록에서 뺀다(처리 결과 블록에는 남음). 뒤의 처리 결과가 이긴다.
 */
export function effectiveAlarms(
  base: AlarmPlan[],
  events: ServerEvent[],
  date: LocalDate,
  dayRefs: Set<string>,
): { list: AlarmPlan[]; changed: Map<string, number> } {
  const list = [...base];
  const changed = new Map<string, number>(); // al# → 마지막으로 바뀐 사용자 말 번호
  const belongs = (a: AlarmPlan): boolean =>
    a.date === date || (a.appointment_ref !== null && dayRefs.has(a.appointment_ref) && a.date < date);
  for (const e of sortedEvents(events)) {
    for (const a of e.alarms) {
      ymd(a.date, `알람 ${a.ref} 날짜`);
      const at = list.findIndex((x) => x.ref === a.ref);
      if (at >= 0) {
        if (belongs(a) || a.date === (list[at] as AlarmPlan).date) {
          list[at] = a;
        } else {
          list.splice(at, 1);
          changed.delete(a.ref);
          continue;
        }
      } else if (belongs(a)) {
        list.push(a);
      } else {
        continue;
      }
      changed.set(a.ref, e.after_turn);
    }
  }
  return { list, changed };
}

// ───────── 준비물 · 할 일 ─────────

type Todo = { title: string; due_date: LocalDate | null };

function todoLine(t: Todo): string {
  return `- ${oneLine(t.title, "(제목 없음)")}${t.due_date ? ` · 마감 ${shortDate(t.due_date)}` : ""}`;
}

/** 준비물 · 할 일 목록. day를 주면 "내일 준비물:"처럼 앞에 붙인다. */
export function viewItems(items: string[], todos: Todo[], day = ""): string {
  const head = day === "" ? "준비물" : `${day} 준비물`;
  const lines: string[] = [];
  if (items.length === 0) lines.push(`${head} 없음`);
  else lines.push(`${head}:`, ...items.map((s) => `- ${oneLine(s)}`));
  if (todos.length === 0) lines.push("할 일 없음");
  else lines.push("할 일:", ...todos.map(todoLine));
  return lines.join("\n");
}

// ───────── 서버 질문 ─────────

function targetText(ctx: Context, ref: string): string {
  const fact = ctx.today.facts.find((f) => f.id === ref);
  if (fact) return `[${fact.id}] ${factMain(fact)}${fact.appointment_ref ? ` · ${fact.appointment_ref} 기준` : ""}`;
  const appt = [...ctx.today.appointments, ...ctx.tomorrow.appointments].find((a) => a.ref === ref);
  if (appt) return apptHead(appt);
  return `${ref} (목록에 없음)`;
}

/**
 * [q1] 원인 질문 · 대상 [f6] 준비 18분 초과 · a1 기준
 * 뜻: 오늘 준비가 예상보다 18분 더 걸렸어요. 이유가 있었나요?
 * 보기: 준비할 게 많았음 / 늦잠 / …
 */
export function viewQuestion(ctx: Context): string {
  const q = ctx.question;
  if (q === null) return "서버 질문 없음";
  const head = [`[${q.id}] ${pick(QUESTION_KIND_KO, q.kind, "질문 종류")}`];
  if (q.target_ref) head.push(`대상 ${targetText(ctx, q.target_ref)}`);
  const lines = [head.join(" · "), `뜻: ${oneLine(q.text)}`];
  if (q.options.length > 0) lines.push(`보기: ${q.options.map((s) => oneLine(s)).join(" / ")}`);
  return lines.join("\n");
}

// ───────── 알람 바꿀 수 있는 사람 ─────────

/** 별칭 → 이름 (u0 = 본인 포함) */
export function namesOf(ctx: Context): Record<string, string> {
  const names: Record<string, string> = { u0: ctx.user.name };
  for (const u of ctx.editable_users) names[u.alias] = u.name;
  return names;
}

/** 본인 · 바꿀 수 있는 사람마다 되는 것 · 안 되는 것. '끄기·늦추기는 본인만'은 늘 붙인다. */
export function viewEditableUsers(ctx: Context): string {
  const lines = [`[u0] ${oneLine(ctx.user.name)}(본인) — 본인 알람은 추가·앞당기기·늦추기·끄기 모두 가능`];
  if (ctx.editable_users.length === 0) lines.push("알람을 바꿀 수 있는 다른 사람 없음");
  for (const u of ctx.editable_users) {
    const can =
      !u.can_add && !u.can_earlier
        ? "바꿀 수 있는 것 없음"
        : `알람 추가(모닝콜) ${u.can_add ? "가능" : "불가"} · 앞당기기 ${u.can_earlier ? "가능" : "불가"} · 끄기·늦추기 불가`;
    lines.push(`[${u.alias}] ${oneLine(u.name)} · ${pick(RELATION_KO, u.relation, "관계")} — ${can}`);
  }
  lines.push("끄기·늦추기는 본인만 — 다른 사람 알람은 끄거나 늦출 수 없음");
  lines.push("목록에 없는 사람의 알람은 바꿀 수 없음");
  return lines.join("\n");
}

// ───────── 서버 처리 결과 ─────────

function sortedEvents(events: ServerEvent[]): ServerEvent[] {
  for (const e of events) {
    // 사용자 말 번호는 1부터 — 0이면 Turn.index(0부터)를 넣은 것
    if (!Number.isInteger(e.after_turn) || e.after_turn < 1) {
      throw new Error(`view: after_turn 값이 이상함 '${String(e.after_turn)}' (사용자 말 번호, 1부터)`);
    }
  }
  return events.map((e, i) => ({ e, i })).sort((a, b) => a.e.after_turn - b.e.after_turn || a.i - b.i).map((x) => x.e);
}

/** 위기 안내 줄 — 가장 최근 처리 결과면 이번 답에서 안내, 그 앞이면 이미 했으니 되풀이하지 않음 (실패 분석 repeat-109) */
export const CRISIS_NOW_LINE = "- 위기 안내 필요: 이번 답에서 위기 안내를 한 번 할 것 (서버가 정함)";
export const CRISIS_DONE_LINE = "- 위기 안내: 이미 함 — 다시 하지 않음";

/**
 * 무음 줄 (E5, 10/14) — 서버가 받아쓰기 빈 결과를 세어 정함. 연속 1번째면 한 번만 다시 묻고, 2번째면 마무리.
 * 가장 최근 처리 결과일 때만 지시, 앞의 것은 이미 한 일로 적음. e.silence가 있을 때만 나옴 (기본 글은 그대로).
 */
export const SILENCE_FIRST_LINE = "- 무음: 사용자가 대답하지 않음 (1번째) — 직전 물음을 한 번만 짧게 다시 물을 것, 재촉 · 사과 없이 (서버가 정함)";
export const SILENCE_SECOND_LINE = "- 무음: 사용자가 또 대답하지 않음 (2번째) — 더 묻지 말고 짧게 마무리하고 end를 true로 (서버가 정함)";
export const SILENCE_DONE_LINE = "- 무음: 사용자가 대답하지 않았음 — 이미 지나감";

function eventLines(e: ServerEvent, o: AlarmLineOpts, isNew: (a: AlarmPlan) => boolean, latest: boolean): string[] {
  const lines = [`사용자 말 ${e.after_turn} 뒤:`];
  if (e.crisis === true) lines.push(latest ? CRISIS_NOW_LINE : CRISIS_DONE_LINE);
  if (e.silence !== undefined) lines.push(latest ? (e.silence === 1 ? SILENCE_FIRST_LINE : SILENCE_SECOND_LINE) : SILENCE_DONE_LINE);
  for (const s of e.applied) lines.push(`- 저장됨: ${oneLine(s)}`);
  for (const p of e.pending) lines.push(`- 확인 필요 [${p.id}] ${pick(PENDING_KIND_KO, p.kind, "확인 항목 종류")}: ${oneLine(p.summary)}`);
  for (const r of e.rejected) lines.push(`- 거절: ${oneLine(r.target)} (${pick(REJECT_KO, r.reason, "거절 사유")})`);
  for (const c of e.clarify) lines.push(`- 되물을 것: ${oneLine(c)}`);
  for (const c of e.conflicts ?? []) lines.push(`- 겹침: ${oneLine(c)}`);
  for (const a of byWhen(e.alarms)) lines.push(`- ${isNew(a) ? "새 알람" : "바뀐 알람"}: ${alarmLine(a, o)}`);
  if (lines.length === 1) lines.push("- 바뀐 것 없음");
  return lines;
}

/** 컨텍스트 알람(오늘 + 내일)의 al# — 여기 없는 알람이 처리 결과에 나오면 대화 중 새로 생긴 것 */
function contextAlarmRefs(ctx: Context): Set<string> {
  return new Set([...ctx.today.alarms, ...ctx.tomorrow.alarms].map((a) => a.ref));
}

/**
 * 사용자 말 1 뒤:
 * - 위기 안내 필요: … (crisis — 서버가 정한 경우만)
 * - 저장됨: 준비물: 노트북 충전기
 * - 확인 필요 [c1] 일정: …
 * - 거절: … (권한 없음)
 * - 되물을 것: …
 * - 겹침: … (만들지 않은 알람 등)
 * - 새 알람: [al9] 출발 10-09(금) 13:00 · … / - 바뀐 알람: [al1] 기상 10-09(금) 07:28 · …
 * after_turn = 몇 번째 사용자 말(1부터) 뒤인지 — viewTranscript의 '나 N'과 같은 번호.
 * 새 알람 · 바뀐 알람: 처리 결과의 change 칸(NEW · CHANGED)을 따르고, 칸이 없는 옛 결과는 컨텍스트 · 앞 결과에 없던 al#이면 새 알람.
 */
export function viewEvents(ctx: Context): string {
  if (ctx.events.length === 0) return "서버 처리 결과 없음";
  const o: AlarmLineOpts = { names: namesOf(ctx), now: sessionNow(ctx) };
  const sorted = sortedEvents(ctx.events);
  const seen = contextAlarmRefs(ctx);
  const lastTurn = sorted[sorted.length - 1]?.after_turn;
  return sorted
    .flatMap((e) => {
      const fresh = new Set(e.alarms.filter((a) => (a.change === undefined ? !seen.has(a.ref) : a.change === "NEW")).map((a) => a.ref));
      for (const a of e.alarms) seen.add(a.ref);
      return eventLines(e, o, (a) => fresh.has(a.ref), e.after_turn === lastTurn);
    })
    .join("\n");
}

/**
 * 처리 결과 번호와 대화 기록 번호가 맞물리는지 확인한다(실행기용).
 * after_turn은 사용자 말 번호(1부터, viewTranscript의 '나 N')여야 한다 — Turn.index(AI · 사용자 섞어 0부터)를 넣으면
 * 둘째 사용자 말부터 '사용자 말 3 뒤'가 '나 2'와 어긋나므로, 사용자 말 수보다 큰 번호가 있으면 에러.
 */
export function assertEventTurns(events: ServerEvent[], turns: Turn[]): void {
  const users = turns.filter((t) => t.role === "user").length;
  for (const e of sortedEvents(events)) {
    if (e.after_turn > users) {
      throw new Error(
        `view: after_turn ${e.after_turn}인데 대화에는 사용자 말 ${users}개뿐 —after_turn은 사용자 말 번호(1부터, 대화 기록의 '나 N')여야 함 (Turn.index를 넣지 않았는지 확인)`,
      );
    }
  }
}

// ───────── 대화 기록 ─────────

export interface TranscriptOptions {
  /** 사용자 줄 이름 (기본 "나"). AI 쪽 프롬프트에는 사용자 이름을 넣는다. */
  userName?: string;
  /** AI 줄 이름 (기본 "AI") */
  aiName?: string;
  /** AI 줄 끝에 물음 종류 표시 [SERVER_Q q1] */
  showActs?: boolean;
}

/**
 * AI 1: …
 * 나 1: …
 * 역할마다 1부터 따로 센다(사용자 번호 = ServerEvent.after_turn). 한 턴은 늘 한 줄.
 */
export function viewTranscript(turns: Turn[], opts: TranscriptOptions = {}): string {
  if (turns.length === 0) return "아직 대화 없음";
  // 빈 이름이면 기본 이름 ('(빈 글) 1:' 같은 줄머리가 생기지 않게)
  const userName = oneLine(opts.userName ?? "나", "나");
  const aiName = oneLine(opts.aiName ?? "AI", "AI");
  // 별명이 'AI'면 사용자 말이 AI 말처럼 보인다 — 두 이름이 같으면 에러
  if (userName === aiName) throw new Error(`view: 사용자 줄 이름 '${userName}'이 AI 줄 이름과 같음 — 누가 한 말인지 구분이 안 됨`);
  let ai = 0;
  let user = 0;
  return turns
    .map((t) => {
      let head: string;
      if (t.role === "ai") head = `${aiName} ${++ai}`;
      else if (t.role === "user") head = `${userName} ${++user}`;
      else throw new Error(`view: 모르는 턴 역할 '${String((t as Turn).role)}'`);
      let line = `${head}: ${oneLine(t.text, "(말 없음)")}`;
      if (opts.showActs && t.role === "ai" && t.acts && t.acts.length > 0) {
        line += ` [${t.acts.map((a) => (a.ref ? `${a.type} ${oneLine(a.ref)}` : a.type)).join(" · ")}]`;
      }
      return line;
    })
    .join("\n");
}

// ───────── 전체 컨텍스트 ─────────

/** viewContext · contextVars 선택 — 모두 기본 끔(지금 글 그대로) */
export interface ViewOptions {
  /** true면 서버가 고른 확인할 기록(pickConfirmFacts, 서버 규칙 SERVER_CONFIRM_OPTS), 배열이면 그 f# 목록을 '오늘 기록' 끝 한 줄로 */
  confirmFacts?: boolean | string[];
  /** true면 화면의 모든 'HH:MM'을 말로 하는 시각('오후 6시 30분' · '낮 12시' · '밤 12시 30분')으로 — spokenTime 참고. 기본 끔 (E1, 10/10) */
  spokenTimes?: boolean;
}

/**
 * 고정 머리말로 모든 블록을 묶는다.
 * ### 날짜 / ### 오늘 기록 / ### 내일 일정 / ### 내일 알람 / ### 준비물·할 일 / ### 서버 질문 / ### 알람 바꿀 수 있는 사람 / ### 서버 처리 결과
 * AFTER_WAKE는 내일 대신 오늘 일정 · 알람 · 준비물을 보인다(### 오늘 일정 · ### 오늘 알람).
 * BEFORE_SLEEP의 '오늘 기록'에는 사실이 가리키는 오늘 일정도 붙인다.
 * 알람 블록에는 서버 처리 결과의 바뀐 알람을 덮어써 '지금 상태'를 보인다(바뀜 · 새로 생김 표시).
 * 일정 · 알람 모두 지금보다 이른 것에는 '지남'.
 * opts.confirmFacts: 켜면 '오늘 기록' 끝에 서버가 고른 확인할 기록 줄(pickConfirmFacts) — id 목록을 직접 줘도 됨. 기본 끔.
 */
export function viewContext(ctx: Context, opts: ViewOptions = {}): string {
  const type = ctx.session.type;
  pick(SESSION_KO, type, "세션 종류");
  const after = type === "AFTER_WAKE";
  const day = after ? ctx.today : ctx.tomorrow;
  const dayDate = after ? ctx.dates.today : ctx.dates.tomorrow;
  const dayKo = after ? "오늘" : "내일";
  const now = sessionNow(ctx);
  const dates = viewDates(ctx); // 날짜표 검사를 다른 블록보다 먼저

  let record = viewFacts(ctx);
  if (opts.confirmFacts) {
    record += `\n${viewConfirmFacts(Array.isArray(opts.confirmFacts) ? opts.confirmFacts : pickConfirmFacts(ctx, SERVER_CONFIRM_OPTS))}`;
  }
  if (!after && ctx.today.appointments.length > 0) {
    record += `\n오늘 일정:\n${viewAppointments(ctx.today.appointments, "오늘 일정", ctx.session.now)}`;
  }

  const dayRefs = new Set(day.appointments.map((a) => a.ref));
  const { list, changed } = effectiveAlarms(day.alarms, ctx.events, dayDate, dayRefs);
  const known = contextAlarmRefs(ctx);
  const o: AlarmLineOpts = { date: dayDate, now, names: namesOf(ctx) };
  const alarms =
    list.length === 0
      ? `${dayKo} 알람 없음`
      : byWhen(list)
          .map((a) => {
            const at = changed.get(a.ref);
            return alarmLine(a, at === undefined ? o : { ...o, changedAfter: at, isNew: !known.has(a.ref) });
          })
          .join("\n");

  // 여는 방식 — T1 프롬프트가 이 값(SUMMARY_FIRST · QUESTION_FIRST)으로 첫 턴을 가른다. 빠지면 8절 비교 실험의 두 변형이 같은 입력이 됨
  const opening = `대화 여는 방식: ${pick(OPENING_KO, ctx.session.opening, "여는 방식")}(${ctx.session.opening})`;

  const sections: [string, string][] = [
    ["날짜", `${dates}\n${opening}`],
    ["오늘 기록", record],
    [`${dayKo} 일정`, viewAppointments(day.appointments, `${dayKo} 일정`, ctx.session.now)],
    [`${dayKo} 알람`, alarms],
    ["준비물·할 일", viewItems(day.items, day.todos, dayKo)],
    ["서버 질문", viewQuestion(ctx)],
    ["알람 바꿀 수 있는 사람", viewEditableUsers(ctx)],
    ["서버 처리 결과", viewEvents(ctx)],
  ];
  const text = sections.map(([h, b]) => `### ${h}\n${b}`).join("\n\n");
  // 말로 하는 시각은 모든 검사(날짜표 · 사실 형식 · 알람 …)를 끝낸 글에 마지막으로 바꿈 — 서버 문장(저장됨 · 되물을 것)과 질문 안의 시각도 같이
  return opts.spokenTimes ? spokenizeTimes(text) : text;
}

/**
 * 프롬프트 템플릿에 넣을 값 묶음. {{context}} 하나로 다 넣거나 블록을 골라 쓴다.
 * 참/거짓 칸은 {{#is_after_wake}}…{{/is_after_wake}}처럼 섹션으로 쓴다.
 */
export function contextVars(ctx: Context, opts: ViewOptions = {}): Record<string, string | boolean> {
  const now = sessionNow(ctx);
  const confirm = Array.isArray(opts.confirmFacts) ? opts.confirmFacts : pickConfirmFacts(ctx, SERVER_CONFIRM_OPTS);
  const sp = (s: string): string => (opts.spokenTimes ? spokenizeTimes(s) : s); // 블록을 따로 쓰는 템플릿도 같은 시각 말씨
  return {
    context: viewContext(ctx, opts),
    // 서버가 고른 확인할 기록 줄 — {{context}}에는 opts.confirmFacts일 때만 들어가고, 이 칸은 늘 채움(템플릿이 따로 쓸 때)
    confirm_facts: viewConfirmFacts(confirm),
    dates: sp(viewDates(ctx)),
    facts: sp(viewFacts(ctx)),
    question: sp(viewQuestion(ctx)),
    editable_users: viewEditableUsers(ctx),
    events: sp(viewEvents(ctx)),
    user_name: oneLine(ctx.user.name),
    session_type: ctx.session.type,
    session_label: pick(SESSION_KO, ctx.session.type, "세션 종류"),
    is_before_sleep: ctx.session.type === "BEFORE_SLEEP",
    is_after_wake: ctx.session.type === "AFTER_WAKE",
    opening: ctx.session.opening,
    opening_label: pick(OPENING_KO, ctx.session.opening, "여는 방식"),
    opening_summary_first: ctx.session.opening === "SUMMARY_FIRST",
    opening_question_first: ctx.session.opening === "QUESTION_FIRST",
    has_question: ctx.question !== null,
    has_events: ctx.events.length > 0,
    // 자정이 지난 대화인지 — 기록 날짜(대화 기준일)가 달력 어제 (설계 메모 4.1)
    is_late_night: ctx.session.record_date !== now.date,
    now_local: sp(nowLabel(ctx.session.now)),
    record_date: ctx.session.record_date,
    today: ctx.dates.today,
    tomorrow: ctx.dates.tomorrow,
    day_after: ctx.dates.day_after,
    view_version: VIEW_VERSION,
  };
}
