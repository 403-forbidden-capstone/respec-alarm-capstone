// 문맥 모으기의 순수부 — DB 행(타입으로 정의)을 받아 context.v1로 바꾼다 (설계 메모 4 · 4.2 · 4.5절). DB를 읽는 일은 PR 4(context.ts)가 하고, 여기는 읽은 행을 해석하기만 한다.
// 순수 TS, 현재 시각 · Intl을 안 쓴다(서울 +09:00 고정 계산, view.ts와 같은 이유). 같은 입력 → 같은 결과.
//
// 규칙 요약:
//   · 사실(factsOf, 4.2): 기상(폰 사용 USAGE = 자동 · 버튼 = 원탭 · 직접 = 직접) · 출발 · 도착(위치 LOCATION = 자동 · 버튼 = 원탭 · 직접) · 앞 출발. 원탭 · 직접 · 대화로 받은 값은 confirmed.
//     지각은 DB 판정 그대로 is_late === true만 (NULL = 지각 아님, #240 judgeArrival · 설계 메모 13절 L2-3). 취침 · 미루기 사실은 아예 안 넣음(고칠 길이 없음).
//   · 앞 출발(earlierDeparturesOf, 4.5 · 13절 L2-1): #240 listEarlierDepartures(mobile/src/features/location/real.ts)와 같은 규칙 — 앱과 서버가 따로 갖는 규칙이라 시험 사례도 같음.
//   · 내일 알람: 내일 참여 행의 기상 · 준비 · 출발 · 도착 + 일정 없는 기상. 루틴 알람 뺌. 강도는 대표 강도(설계 판단).
import type { AlarmPlan, AlarmType, Appointment, Context, Fact, Importance, LocalDate, Opening, ServerQuestion, SessionType, Transport } from "./types.ts";
import { seoulLocal } from "./ko.ts";
import { addDays, weekdayOf } from "./view.ts";
import { WEEKDAYS } from "./types.ts";

// ───────── DB 행 모양 (필요한 칸만) ─────────

/** alarm_events.input_source · appointment_participants.departed_source 의 enum (event_input_source) */
export type InputSource = "BUTTON" | "LOCATION" | "VOICE" | "MANUAL" | "USAGE";

export interface AppointmentRow {
  appointment_id: string;
  title: string;
  appointment_at: string; // timestamptz
  dest_name: string;
  importance: Importance;
  recurrence_rule: string | null;
  /** 그룹 약속이면 그룹 id (NULL = 개인 일정) · 그룹 이름은 groups 임베드 — 읽은 쪽이 안 주면 칸 없음 */
  group_id?: string | null;
  groups?: { group_name: string } | null;
}

export interface ParticipantRow {
  participant_id: string;
  appointment_id: string;
  user_id: string;
  transport_type: Transport;
  est_travel_minutes: number | null;
  departed_at: string | null;
  departed_source: InputSource | null;
  arrived_at: string | null;
  arrived_source: InputSource | null;
  is_late: boolean | null;
  late_minutes: number | null;
}

/** 내 참여 행 + 그 약속 (appointment_participants ⋈ appointments) */
export type ParticipantJoin = ParticipantRow & { appointment: AppointmentRow };

export interface AlarmRow {
  alarm_id: string;
  participant_id: string | null;
  routine_id: string | null;
  alarm_type: AlarmType | "ROUTINE";
  scheduled_at: string;
  intensity: "SOFT" | "NORMAL" | "STRONG";
  is_enabled: boolean;
  time_source: "AUTO" | "MANUAL" | null;
}

export interface TodoRow {
  todo_id: string;
  appointment_id: string | null;
  title: string;
  todo_type: "TASK" | "ITEM";
  due_date: string | null;
  is_done: boolean;
}

/** 대화 기준일 '돌아볼 날'의 기상 기록 — daily_records.wake_confirmed_at + 그날 기상 알람의 WAKE_CONFIRMED 기록 출처 */
export interface WakeRecord {
  confirmed_at: string;
  input_source: InputSource | null;
}

/** 앞 출발 읽기 한 줄 — alarm_events(event_at) ⋈ alarms(alarm_type, participant_id) ⋈ appointment_participants(departed_at, departed_source), #40 real.ts와 같은 모양 */
export interface EarlierRow {
  event_at: string;
  alarms: {
    alarm_type: string;
    participant_id: string | null;
    appointment_participants: { departed_at: string | null; departed_source: InputSource | null } | null;
  } | null;
}

export interface EarlierDeparture {
  participantId: string;
  at: string; // 읽은 그대로의 시각 글자
}

// ───────── 시각 (DB timestamptz → 서울) ─────────

/** DB가 준 시각 글자를 ISO로 — 소수 3자리(Date가 확실히 읽음) · 시차 `+00` 같은 짧은 표기를 맞춤 (앱 lib/dbTime.ts와 같은 규칙) */
function normDbTime(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:(Z|z)|([+-])(\d{2})(?::?(\d{2}))?)?$/u.exec(value.trim());
  if (!m) return value;
  const ms = m[3] ? `.${m[3].slice(0, 3).padEnd(3, "0")}` : "";
  const zone = m[4] ? "Z" : m[5] ? `${m[5]}${m[6]}:${m[7] ?? "00"}` : "";
  return `${m[1]}T${m[2]}${ms}${zone}`;
}

/** DB 시각 글자 → 밀리초 (읽을 수 없으면 NaN) */
export function dbMs(value: string): number {
  return Date.parse(normDbTime(value));
}

/** DB 시각 글자 → 서울 날짜 · "HH:MM" */
export function seoulParts(value: string): { date: LocalDate; time: string; minutes: number } {
  const r = seoulLocal(normDbTime(value));
  const h = Math.floor(r.minutes / 60);
  const m = r.minutes % 60;
  return { date: r.date, time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, minutes: r.minutes };
}

// ───────── 날짜표 ─────────

/** 상대 날짜 해석표 — 대화 기준일(돌아볼 날 review) 기준. this_week = review가 든 주의 월~일 */
export function datesOf(review: LocalDate): Context["dates"] {
  const wd = weekdayOf(review);
  const monday = addDays(review, -WEEKDAYS.indexOf(wd));
  const week = (start: LocalDate): Context["dates"]["this_week"] =>
    Object.fromEntries(WEEKDAYS.map((w, i) => [w, addDays(start, i)])) as Context["dates"]["this_week"];
  return {
    today: review,
    tomorrow: addDays(review, 1),
    day_after: addDays(review, 2),
    weekday_today: wd,
    this_week: week(monday),
    next_week: week(addDays(monday, 7)),
  };
}

// ───────── 앞 출발 (설계 메모 4.5 · 13절 L2-1) ─────────

/** 지금 들어 있는 값의 출처 — 시각이 없으면 null, 출처 칸이 비면 옛 앱 원탭 값이라 BUTTON (#240 storedSource) */
export function storedSource(time: string | null, source: InputSource | null): InputSource | null {
  if (time == null) return null;
  return source ?? "BUTTON";
}

/** 사용자가 직접 알려 준 것 (원탭 · 직접 입력 …) — 위치만 자동 (#240 isResponse) */
export const isResponse = (source: InputSource): boolean => source !== "LOCATION";

/**
 * 앞 출발 거르기 — L2 규칙(13절 L2-1) 그대로, #240 listEarlierDepartures(real.ts:53-80)와 같음:
 *   그날(range가 있으면 event_at ∈ [from, to)) 위치 출발 기록(alarm_events ACKNOWLEDGED · LOCATION) 중 그 참여의 DEPARTURE 알람 줄만 보고,
 *   지금 출발이 응답(departed_source가 BUTTON · MANUAL …, 시각이 있고 출처가 NULL이면 옛 원탭 BUTTON)이면 뺌 ·
 *   event_at ≥ 지금 departed_at이면 뺌(그게 지금 출발) · departed_at이 비었으면([아니에요]로 지움) 남은 줄 모두 · 시각순.
 * 앱 쪽 규칙이 바뀌면 이 함수와 시험(context-core.test.ts)이 같이 바뀌어야 한다(규칙 두 벌 위험, 설계 메모 11절).
 */
export function earlierDeparturesOf(rows: EarlierRow[], range?: { from: string; to: string }): EarlierDeparture[] {
  const from = range ? dbMs(range.from) : -Infinity;
  const to = range ? dbMs(range.to) : Infinity;
  return rows
    .flatMap((row): (EarlierDeparture & { ms: number })[] => {
      const alarm = row.alarms;
      if (alarm?.alarm_type !== "DEPARTURE" || !alarm.participant_id) return [];
      const ms = dbMs(row.event_at);
      if (!(ms >= from && ms < to)) return [];
      const current = alarm.appointment_participants;
      const source = storedSource(current?.departed_at ?? null, current?.departed_source ?? null);
      if (source != null && isResponse(source)) return [];
      if (current?.departed_at && ms >= dbMs(current.departed_at)) return []; // 지금 출발 (또는 그 뒤)
      return [{ participantId: alarm.participant_id, at: row.event_at, ms }];
    })
    .sort((a, b) => a.ms - b.ms)
    .map(({ participantId, at }) => ({ participantId, at }));
}

// ───────── 사실 (설계 메모 4 · 4.2) ─────────

/** 출처 → 사실 출처: 폰 사용 · 위치 = 자동, 버튼 = 원탭, 직접 · 대화(VOICE) = 직접 */
export function factSourceOf(source: InputSource | null): Fact["source"] {
  if (source === "USAGE" || source === "LOCATION") return "AUTO";
  if (source === "BUTTON") return "ONE_TAP";
  return "MANUAL";
}

export interface RefsOut {
  /** a# → DB id */
  appointments: Record<string, { appointment_id: string; participant_id: string }>;
  /** al# → DB id */
  alarms: Record<string, { alarm_id: string }>;
  /** f# → 정정 대상 (출발 · 도착은 참여 행, 기상은 기록 날짜, 앞 출발이면 earlier_at) */
  facts: Record<string, { kind: Fact["kind"]; participant_id?: string; record_date?: LocalDate; earlier_at?: string }>;
}

export interface FactsInput {
  review: LocalDate;
  /** 돌아볼 날 내 참여 행 (appointment_at이 review 0시~24시) */
  participants: ParticipantJoin[];
  wake: WakeRecord | null;
  earlier: EarlierDeparture[];
  /** 참여 행 id → a# 별칭 */
  apptRefOf: (participantId: string) => string | null;
}

/**
 * 오늘 사실 — 시각순(같으면 기상 · 출발 · 도착 · 지각 순). 취침 · 미루기 사실은 안 넣는다.
 * 원탭 · 직접 · 대화로 받은 값은 confirmed: true(읽어 주지 않음), 자동(폰 사용 · 위치)만 confirmed: false.
 * 지각은 is_late === true일 때만 LATE 사실(NULL = 지각 아님, 지각 분 late_minutes).
 */
export function factsOf(input: FactsInput): { facts: Fact[]; refs: RefsOut["facts"] } {
  type Draft = { kind: Fact["kind"]; at: string | null; minutes: number | null; appt: string | null; source: Fact["source"]; text: string; ref: RefsOut["facts"][string]; earlier?: true; sortKey: number; rank: number };
  const rank: Record<string, number> = { WAKE: 0, DEPART: 1, ARRIVE: 2, LATE: 3 };
  const list: Draft[] = [];
  const push = (d: Omit<Draft, "sortKey" | "rank">): void => {
    list.push({ ...d, rank: rank[d.kind] ?? 9, sortKey: d.at === null ? Infinity : dbMs(d.at) });
  };
  if (input.wake !== null) {
    const p = seoulParts(input.wake.confirmed_at);
    push({
      kind: "WAKE", at: input.wake.confirmed_at, minutes: null, appt: null, source: factSourceOf(input.wake.input_source ?? "MANUAL"),
      text: `기상 확인 ${p.time}`, ref: { kind: "WAKE", record_date: input.review },
    });
  }
  for (const j of input.participants) {
    const apptRef = input.apptRefOf(j.participant_id);
    if (j.departed_at) {
      const src = factSourceOf(storedSource(j.departed_at, j.departed_source));
      push({ kind: "DEPART", at: j.departed_at, minutes: null, appt: apptRef, source: src, text: `출발 ${seoulParts(j.departed_at).time}`, ref: { kind: "DEPART", participant_id: j.participant_id } });
    }
    if (j.arrived_at) {
      const src = factSourceOf(storedSource(j.arrived_at, j.arrived_source));
      push({ kind: "ARRIVE", at: j.arrived_at, minutes: null, appt: apptRef, source: src, text: `도착 ${seoulParts(j.arrived_at).time}`, ref: { kind: "ARRIVE", participant_id: j.participant_id } });
      // 지각은 DB 판정 그대로 — is_late NULL = 지각 아님 (사용자에게 유리한 쪽, 설계 메모 4.2 #6)
      if (j.is_late === true) {
        push({
          kind: "LATE", at: j.arrived_at, minutes: j.late_minutes, appt: apptRef, source: src,
          text: j.late_minutes === null ? `${j.appointment.title} 지각` : `${j.appointment.title} ${j.late_minutes}분 지각`, ref: { kind: "LATE", participant_id: j.participant_id },
        });
      }
    }
  }
  const byParticipant = new Map(input.participants.map((j) => [j.participant_id, j] as const));
  for (const e of input.earlier) {
    if (!byParticipant.has(e.participantId)) continue; // 돌아볼 날 내 약속이 아님
    push({
      kind: "DEPART", at: e.at, minutes: null, appt: input.apptRefOf(e.participantId), source: "AUTO", text: "잠깐 나갔다 들어옴",
      ref: { kind: "DEPART", participant_id: e.participantId, earlier_at: e.at }, earlier: true,
    });
  }
  list.sort((a, b) => a.sortKey - b.sortKey || a.rank - b.rank);
  const refs: RefsOut["facts"] = {};
  const facts = list.map((d, i): Fact => {
    const id = `f${i + 1}`;
    refs[id] = d.ref;
    const f: Fact = {
      id, kind: d.kind, time: d.at === null ? null : seoulParts(d.at).time, minutes: d.minutes, appointment_ref: d.appt, source: d.source,
      confirmed: d.source !== "AUTO", text: d.text,
    };
    if (d.earlier) f.earlier = true;
    return f;
  });
  return { facts, refs };
}

// ───────── 일정 · 알람 · 준비물 ─────────

/** 반복 규칙 — WEEKLY만 '매주', 그 밖 NONE (설계 메모 4절) */
export function repeatOf(rule: string | null): Appointment["repeat"] {
  return rule !== null && /FREQ=WEEKLY/iu.test(rule) ? "WEEKLY" : "NONE";
}

/** 약속 한 줄 → Appointment (importance_confirmed 칸이 DB에 없어 늘 true — 중요도 질문을 안 함, 설계 메모 4절) */
export function appointmentOf(j: ParticipantJoin, ref: string): Appointment {
  const p = seoulParts(j.appointment.appointment_at);
  return {
    ref, title: j.appointment.title, date: p.date, time: p.time, place: j.appointment.dest_name === "" ? null : j.appointment.dest_name,
    importance: j.appointment.importance, importance_confirmed: true, transport: j.transport_type, travel_minutes: j.est_travel_minutes,
    repeat: repeatOf(j.appointment.recurrence_rule),
    ...(j.appointment.group_id ? { group: j.appointment.groups?.group_name ?? "" } : {}),
  };
}

export interface AlarmsInput {
  /** 내일(morning) 내 약속 (+ 고칠 대상 찾기용 이후 약속) */
  tomorrow: { participant_id: string; ref: string }[];
  alarms: AlarmRow[];
  morning: LocalDate;
  /** 지금(ISO) — 일정 없는 기상은 지금 뒤 ~ until(기본 morning) 24시까지만 */
  now: string;
  until?: LocalDate;
}

/**
 * 내일 알람 — 내일 참여 행의 기상 · 준비 · 출발 · 도착 + 일정 없는 기상(participant · routine 둘 다 NULL, 지금 뒤 ~ morning 24시).
 * 루틴 알람 뺌. 강도는 알람 줄의 대표 강도(설계 판단). time_source는 서버 질문 PREP_CHECK이 자동 기상만 고르려고 그대로 넘김.
 * 반환 refs: al# → alarm_id
 */
export function alarmsOf(input: AlarmsInput): { alarms: AlarmPlan[]; refs: RefsOut["alarms"] } {
  const refOf = new Map(input.tomorrow.map((t) => [t.participant_id, t.ref] as const));
  const nowMs = dbMs(input.now);
  const endMs = dbMs(`${addDays(input.until ?? input.morning, 1)}T00:00:00+09:00`);
  const mine: { row: AlarmRow; appt: string | null; ms: number }[] = [];
  for (const row of input.alarms) {
    if (row.alarm_type === "ROUTINE" || row.routine_id !== null) continue;
    const ms = dbMs(row.scheduled_at);
    if (row.participant_id !== null) {
      const ref = refOf.get(row.participant_id);
      if (ref !== undefined) mine.push({ row, appt: ref, ms });
    } else if (row.alarm_type === "WAKE" && ms > nowMs && ms <= endMs) {
      mine.push({ row, appt: null, ms }); // 일정 없는 기상
    }
  }
  mine.sort((a, b) => a.ms - b.ms || (a.row.alarm_id < b.row.alarm_id ? -1 : 1));
  const refs: RefsOut["alarms"] = {};
  const alarms = mine.map(({ row, appt }, i): AlarmPlan => {
    const ref = `al${i + 1}`;
    refs[ref] = { alarm_id: row.alarm_id };
    const p = seoulParts(row.scheduled_at);
    const a: AlarmPlan = {
      ref, owner: "u0", type: row.alarm_type as AlarmType, date: p.date, time: p.time, intensity: row.intensity,
      appointment_ref: appt, enabled: row.is_enabled,
    };
    if (row.time_source !== null) a.time_source = row.time_source;
    return a;
  });
  return { alarms, refs };
}

/** 준비물 · 할 일 요약 — 안 끝낸 것(is_done false) 중 내일 약속에 딸렸거나 마감이 내일인 것. ITEM = 준비물, TASK = 할 일 */
export function itemsOf(todos: TodoRow[], tomorrowAppointmentIds: string[], morning: LocalDate): { items: string[]; todos: { title: string; due_date: LocalDate | null }[] } {
  const ids = new Set(tomorrowAppointmentIds);
  const open = todos.filter((t) => !t.is_done && ((t.appointment_id !== null && ids.has(t.appointment_id)) || t.due_date === morning));
  return {
    items: open.filter((t) => t.todo_type === "ITEM").map((t) => t.title),
    todos: open.filter((t) => t.todo_type === "TASK").map((t) => ({ title: t.title, due_date: t.due_date })),
  };
}

/** 사용자 이름 — profiles.nickname이 비거나 'AI'면 "나" (대화 글에서 사용자 말과 AI 말이 섞이지 않게, view.ts viewTranscript) */
export function userNameOf(nickname: string | null | undefined): string {
  const n = (nickname ?? "").trim();
  return n === "" || n === "AI" ? "나" : n;
}

/** 여는 방식 — 확인할 기록이 있으면 요약 먼저, 기록이 없고 서버 질문만 있으면 질문 먼저 (06-서버지침.md 6번) */
export function openingOf(confirmFactIds: string[], question: ServerQuestion | null): Opening {
  return confirmFactIds.length === 0 && question !== null ? "QUESTION_FIRST" : "SUMMARY_FIRST";
}

// ───────── 전체 ─────────

export interface ContextInput {
  type?: SessionType;
  now: string; // ISO
  /** 대화 기준일 — turn-core dayOf 결과 */
  days: { review: LocalDate; morning: LocalDate };
  nickname: string | null;
  /** 내 참여 행 ⋈ 약속: 돌아볼 날 + 내일 둘 다 (날짜는 서버가 서울 날짜로 가름) */
  participants: ParticipantJoin[];
  alarms: AlarmRow[];
  wake: WakeRecord | null;
  earlierRows: EarlierRow[];
  /** 앞 출발을 읽은 날 범위 (review 0시 ~ 24시) — 주면 그 밖의 줄은 거름 */
  earlierRange?: { from: string; to: string };
  todos: TodoRow[];
  question?: ServerQuestion | null;
  /** 뽑은 확인할 기록(f#) — 여는 방식 계산용 */
  confirmFactIds?: string[];
  /** 내가 가입한(JOINED) 그룹 행 — 새 일정을 그룹 일정으로 걸 후보 */
  groups?: { group_id: string; groups: { group_name: string } | null }[];
}

/** 내일 뒤 며칠까지 고칠 대상(약속 · 알람)으로 읽을지 — "25일 알람 바꿔줘"를 찾으려고. 이 날들은 대화 화제가 아니라 찾기용 */
export const LATER_DAYS = 7;

export interface ContextOut {
  context: Context;
  refs: RefsOut;
}

/**
 * DB 행 → context.v1 (events는 빈 목록 — 서버가 대화 중에 채움). 별칭: a# = 돌아볼 날 약속 먼저(시각순), 그다음 내일 약속(시각순).
 * 같은 약속에 내 참여 행이 둘 있을 수 없어(appointment, user 유일) participant_id로 가름.
 */
export function buildContext(input: ContextInput): ContextOut {
  const { review, morning } = input.days;
  const dayOfJoin = (j: ParticipantJoin): LocalDate => seoulParts(j.appointment.appointment_at).date;
  const byTime = (a: ParticipantJoin, b: ParticipantJoin): number => dbMs(a.appointment.appointment_at) - dbMs(b.appointment.appointment_at) || (a.participant_id < b.participant_id ? -1 : 1);
  const reviewJoins = input.participants.filter((j) => dayOfJoin(j) === review).sort(byTime);
  const morningJoins = input.participants.filter((j) => dayOfJoin(j) === morning).sort(byTime);
  const until = addDays(morning, LATER_DAYS);
  const laterJoins = input.participants.filter((j) => dayOfJoin(j) > morning && dayOfJoin(j) <= until).sort(byTime);
  const refMap = new Map<string, string>();
  const refs: RefsOut = { appointments: {}, alarms: {}, facts: {} };
  [...reviewJoins, ...morningJoins, ...laterJoins].forEach((j, i) => {
    const ref = `a${i + 1}`;
    refMap.set(j.participant_id, ref);
    refs.appointments[ref] = { appointment_id: j.appointment_id, participant_id: j.participant_id };
  });
  const apptRefOf = (pid: string): string | null => refMap.get(pid) ?? null;
  const toAppt = (j: ParticipantJoin): Appointment => appointmentOf(j, refMap.get(j.participant_id) as string);

  const earlier = earlierDeparturesOf(input.earlierRows, input.earlierRange);
  const { facts, refs: factRefs } = factsOf({ review, participants: reviewJoins, wake: input.wake, earlier, apptRefOf });
  refs.facts = factRefs;

  const al = alarmsOf({ tomorrow: [...morningJoins, ...laterJoins].map((j) => ({ participant_id: j.participant_id, ref: refMap.get(j.participant_id) as string })), alarms: input.alarms, morning, now: input.now, until });
  refs.alarms = al.refs;
  // 이후 약속에 딸린 알람 · 내일 뒤 날짜의 일정 없는 기상은 later로 (내일 블록 · 준비시간 계산에는 안 섞음)
  const laterRefs = new Set(laterJoins.map((j) => refMap.get(j.participant_id) as string));
  const isLater = (a: AlarmPlan): boolean => (a.appointment_ref !== null ? laterRefs.has(a.appointment_ref) : a.date > morning);
  const stuff = itemsOf(input.todos, morningJoins.map((j) => j.appointment_id), morning);
  const question = input.question ?? null;
  // 이름을 못 읽은 그룹은 말과 맞춰 볼 수 없어 뺌
  const groups = (input.groups ?? []).filter((g) => (g.groups?.group_name ?? "").trim() !== "").map((g) => ({ id: g.group_id, name: (g.groups as { group_name: string }).group_name.trim() }));

  const context: Context = {
    context_version: "context.v1",
    session: { type: input.type ?? "BEFORE_SLEEP", now: input.now, timezone: "Asia/Seoul", record_date: review, opening: openingOf(input.confirmFactIds ?? [], question) },
    dates: datesOf(review),
    user: { alias: "u0", name: userNameOf(input.nickname) },
    today: { facts, appointments: reviewJoins.map(toAppt), alarms: [], items: [], todos: [] },
    tomorrow: { appointments: morningJoins.map(toAppt), alarms: al.alarms.filter((a) => !isLater(a)), items: stuff.items, todos: stuff.todos },
    ...(laterJoins.length > 0 || al.alarms.some(isLater) ? { later: { appointments: laterJoins.map(toAppt), alarms: al.alarms.filter(isLater) } } : {}),
    question,
    editable_users: [], // 친구 알람은 v0 범위 밖 (설계 메모 4절)
    events: [],
    ...(groups.length > 0 ? { groups } : {}),
  };
  return { context, refs };
}
