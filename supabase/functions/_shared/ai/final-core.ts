// 대화 끝 정리의 순수부 (applyFinal, turn-core 머리 주석의 "PR 5 몫") — T2 전체 추출(extract.v2, 내부 모양)을
//   ① 공개 JSON(structured.v1 — conversation_sessions.extracted_data, 다른 담당자가 읽는 계약)과 ② 저장할 것(todos · daily_records)으로 바꾼다.
// 순수 TS, DB · 모델 · 현재 시각을 안 부른다. 저장 · 저장 결과 기록은 voice-commit.ts.
//
// 규칙:
//   · 사용자 말 하나는 공개 JSON에 한 번만 '기록'된다 — 행동 진술은 behavior[](b1, b2 …)가 원본이고, sleep_wake · schedule_outcomes는 그 줄에서 만든 보기(behavior_refs로 가리킴)라 값이 어긋날 수 없다.
//   · 일정 · 알람 · 준비시간은 저장하지 않는다 — 카드 [저장]으로만(turn-core). 카드 결과로 saved · declined · needs_confirm만 적는다.
//   · 할 일 · 준비물은 바로 저장(D32 A). 이 대화의 새 약속에 딸린 것은 그 카드를 저장했을 때만 그 약속에 연결.
//   · 생활 기록 표(daily_records)에는 사용자 진술용 칸(sleep_at · sleep_satisfaction · condition_note)의 빈 칸만, 확인된 진술(stated · confirmed)만 쓴다.
//     시스템 측정 칸(wake_confirmed_at · wake_reported_at · actual_prepare_minutes)과 appointment_participants · alarm_events · daily_journals는 쓰지 않는다
//     (지각 · 출발 · 도착 판정은 위치 · 원탭 담당, 일기 ai_summary는 일기 담당 — 진술은 이 JSON에만 남김).
//   · 날짜를 모름 · 말이 엇갈림(uncertain · 같은 날 같은 대상에 다른 값) · 어느 일정인지 모름은 지우지 않고 status needs_confirm + issue로 남긴다.
import type { RefsOut } from "./context-core.ts";
import { itemKey, localToIso, normTitle, prepAsked, titleMatch } from "./turn-core.ts";
import type { AlarmEffect, Appointment, BehaviorReport, Card, Context, FactSource, FinalExtract, LocalDate, LocalTime, ReasonTag } from "./types.ts";
import { addDays } from "./view.ts";
import { toMinutes } from "./guards.ts";

export const STRUCTURED_VERSION = "structured.v1";
/** 생활 기록 표에 쓸 수 있는 날짜 범위(돌아볼 날 기준) — 그 밖은 JSON에만 */
export const RECORD_PAST_DAYS = 7;

export type ConfirmStatus = "saved" | "declined" | "needs_confirm";
export type BehaviorIssue = "no_date" | "uncertain" | "conflict" | "unlinked";

export interface TodoPlan {
  title: string;
  todo_type: "TASK" | "ITEM";
  due_date: LocalDate | null;
  appointment_id: string | null;
}

/** daily_records 한 날짜에 채울 진술 칸 (빈 칸만 채움 — voice-commit) */
export interface RecordWrite {
  record_date: LocalDate;
  values: Partial<Record<"sleep_at" | "sleep_satisfaction" | "condition_note", string | number>>;
}

export interface BehaviorView {
  id: string; // b1 …
  kind: Lowercase<BehaviorReport["kind"]>;
  date: LocalDate | null;
  time: LocalTime | null;
  /** date + time (서울) — 둘 중 하나라도 없으면 null */
  at: string | null;
  minutes: number | null;
  appointment: { appointment_id: string | null; title: string | null; link: "linked" | "unlinked" } | null;
  reasons: string[];
  source: FactSource;
  status: "recorded" | "needs_confirm";
  issue: BehaviorIssue | null;
  note: string | null;
}

export interface Structured {
  schema_version: typeof STRUCTURED_VERSION;
  session: {
    session_id: string;
    reference_date: LocalDate;
    session_type: "night" | "morning" | "anytime";
    input_modes: ("text" | "voice")[];
    started_at: string;
    ended_at: string;
    extracted_at: string;
    extractor: { prompt: string; schema: "extract.v2" };
  };
  day_review: { events: { text: string; time: LocalTime | null; important: boolean; source: FactSource }[]; memorable: string | null };
  mood_condition: {
    mood: string[]; valence: number | null; valence_source: "inferred"; fatigue: number | null; stress: number | null; causes: string[]; condition_note: string | null; source: FactSource;
  };
  habit_signals: { habit: string; note: string; date: LocalDate | null; recurring: boolean; source: FactSource }[];
  goals_routine: { goals: { habit: string; goal_text: string; source: FactSource }[]; wanted_routine: string | null; suggestion_response: null };
  behavior: BehaviorView[];
  sleep_wake: {
    date: LocalDate; sleep_at: string | null; wake_at: string | null; alarm_rang_at: string | null;
    wake_delay_minutes: number | null; wake_delay_basis: "stated_minutes" | "stated_alarm_time" | "scheduled_wake_alarm" | null;
    overslept: boolean | null; sleep_satisfaction: number | null; planned_sleep_at: string | null; source: FactSource; behavior_refs: string[];
  }[];
  schedule_outcomes: {
    date: LocalDate | null; appointment_id: string | null; appointment_title: string | null; link: "linked" | "unlinked";
    is_late: boolean | null; late_minutes: number | null; causes: string[]; departed_at: string | null; arrived_at: string | null;
    source: FactSource; status: "recorded" | "needs_confirm"; behavior_refs: string[];
  }[];
  alarm_feedback: { effect: AlarmEffect; alarm_type: string | null; date: LocalDate | null; note: string | null; db_feedback_type: string | null; source: FactSource }[];
  appointments: {
    title: string; date: LocalDate | null; time: LocalTime | null; place: string | null; importance: string | null; transport: string | null; repeat: string | null;
    status: ConfirmStatus; card_id: string | null; appointment_id: string | null; unclear: string | null; source: FactSource;
  }[];
  todos: { title: string; type: "TASK" | "ITEM"; due_date: LocalDate | null; appointment_id: string | null; appointment_title: string | null; source: FactSource; stored: "inserted" | "duplicate" | "failed" | null }[];
  alarm_changes: (FinalExtract["alarm_changes"][number] & { status: ConfirmStatus })[];
  prep_adjustment: (NonNullable<FinalExtract["prep_adjustment"]> & { status: ConfirmStatus }) | null;
  other: { importance_updates: FinalExtract["importance_updates"]; fact_feedback: FinalExtract["fact_feedback"]; reason_tags: FinalExtract["reason_tags"]; safety_flag: boolean };
  pending: { section: string; ref: string; reason: string; text: string }[];
  storage: { table: "todos" | "daily_records"; key: string; column: string | null; result: "inserted" | "duplicate" | "written" | "kept_existing" | "failed" | "skipped_out_of_range" }[];
}

export interface FinalPlan {
  /** 공개 JSON 중 세션 · 저장 결과를 뺀 몫 — voice-commit이 finishStructured로 채움 */
  draft: Omit<Structured, "session" | "storage">;
  todos: TodoPlan[];
  /** draft.todos 순서와 같은 할 일의 저장 대상 (같은 대화 안에서 겹친 것은 null) */
  todoTargets: (number | null)[];
  records: RecordWrite[];
}

const APPT_CARDS: readonly Card["kind"][] = ["APPT_NEW", "APPT_OPEN"];
const ALARM_CARDS: readonly Card["kind"][] = ["ALARM_EDIT", "ALARM_NEW"];
/** 알람 평가 → DB alarm_feedback_type (알람 조정 담당이 쓸 때) — 맞는 값이 없으면 null */
const DB_FEEDBACK: Record<AlarmEffect, string | null> = { helpful: "GOOD", too_weak: "TOO_QUIET", too_strong: "TOO_LOUD", annoying_sound: "SOUND_DISLIKE", missed: null, wrong_time: null };

function statusOf(card: Card | undefined, save: string | undefined): ConfirmStatus {
  if (card?.status === "SAVED") return "saved";
  if (card?.status === "REJECTED" || save === "DECLINED") return "declined";
  return "needs_confirm";
}

const apptCardFor = (cards: Card[], title: string, date: LocalDate | null): Card | undefined =>
  cards.find((c) => APPT_CARDS.includes(c.kind) && c.draft !== null && titleMatch(c.draft.title, title) && (date === null || c.draft.date === date));

const apptIdOf = (refs: RefsOut, ref: string | null): string | null => (ref === null ? null : refs.appointments[ref]?.appointment_id || null);
const lower = (tags: ReasonTag[]): string[] => [...new Set(tags)].map((t) => t.toLowerCase());
const clean = (s: string | null | undefined): string | null => (s?.trim() ? s.trim() : null);
/** 여러 출처를 묶은 값의 출처 — 하나라도 짐작이면 inferred, 아니면 stated가 있으면 stated */
const weakest = (xs: FactSource[]): FactSource => (xs.includes("inferred") ? "inferred" : xs.includes("stated") || xs.length === 0 ? "stated" : "confirmed");
/** 잠든 시각이 속한 기록 날짜 — 정오 뒤에 잤으면 다음 날 아침의 기록 */
const sleepRecordDate = (date: LocalDate, time: LocalTime): LocalDate => (toMinutes(time) >= 12 * 60 ? addDays(date, 1) : date);
const diff = (from: LocalTime, to: LocalTime): number => Math.max(0, toMinutes(to) - toMinutes(from));

/** 행동 진술의 일정 — 돌아볼 날 일정 중 a# 또는 말한 이름이 하나에만 맞을 때만. 그 밖은 임의로 잇지 않음 */
function linkOf(b: BehaviorReport, review: LocalDate, today: Appointment[], refs: RefsOut): BehaviorView["appointment"] {
  if (b.appointment_ref === null && b.appointment_title === null) return b.kind === "LATE" ? { appointment_id: null, title: null, link: "unlinked" } : null;
  let ref: string | null = null;
  if (b.date === review) {
    if (b.appointment_ref !== null && today.some((a) => a.ref === b.appointment_ref)) ref = b.appointment_ref;
    else if (b.appointment_title !== null) {
      const hits = today.filter((a) => titleMatch(a.title, b.appointment_title as string));
      if (hits.length === 1) ref = hits[0].ref;
    }
  }
  const id = apptIdOf(refs, ref);
  const title = ref !== null ? today.find((a) => a.ref === ref)?.title ?? b.appointment_title : b.appointment_title;
  return { appointment_id: id, title: clean(title), link: id !== null ? "linked" : "unlinked" };
}

function behaviorViews(x: FinalExtract, ctx: Context, refs: RefsOut): BehaviorView[] {
  const review = ctx.session.record_date;
  const views = x.behavior.map((b, i): BehaviorView => {
    const appointment = ["LATE", "DEPART", "ARRIVE"].includes(b.kind) ? linkOf(b, review, ctx.today.appointments, refs) : null;
    const issue: BehaviorIssue | null = b.date === null ? "no_date" : clean(b.uncertain) !== null ? "uncertain" : b.kind === "LATE" && appointment?.link === "unlinked" ? "unlinked" : null;
    return {
      id: `b${i + 1}`, kind: b.kind.toLowerCase() as BehaviorView["kind"], date: b.date, time: b.time, at: b.date !== null && b.time !== null ? localToIso(b.date, b.time) : null,
      minutes: b.minutes, appointment, reasons: lower(b.reasons), source: b.source, status: issue === null ? "recorded" : "needs_confirm", issue, note: clean(b.uncertain),
    };
  });
  // 같은 날 같은 대상의 같은 종류인데 값이 다름 = 엇갈린 진술 (고친 말은 모델이 마지막 값 하나만 냄) → 모두 확인 필요
  const groups = new Map<string, BehaviorView[]>();
  for (const v of views) {
    if (v.date === null) continue;
    const target = v.appointment === null ? "" : v.appointment.appointment_id ?? normTitle(v.appointment.title ?? v.id);
    const key = `${v.kind}|${v.date}|${target}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  for (const g of groups.values()) {
    if (new Set(g.map((v) => `${v.time}|${v.minutes}`)).size > 1) for (const v of g) Object.assign(v, { status: "needs_confirm", issue: "conflict" });
  }
  return views;
}

function sleepWake(views: BehaviorView[], x: FinalExtract, ctx: Context): Structured["sleep_wake"] {
  const review = ctx.session.record_date;
  const ok = views.filter((v) => v.status === "recorded");
  const byDate = new Map<LocalDate, BehaviorView[]>();
  for (const v of ok) {
    if (!["sleep", "wake", "alarm_ring"].includes(v.kind)) continue;
    const d = v.kind === "sleep" && v.time !== null ? sleepRecordDate(v.date as LocalDate, v.time) : (v.date as LocalDate);
    byDate.set(d, [...(byDate.get(d) ?? []), v]);
  }
  const planned = x.daily_record.sleep_time;
  if ((x.daily_record.sleep_satisfaction !== null || planned !== null) && !byDate.has(review)) byDate.set(review, []);
  const wakeAlarm = ctx.today.alarms.find((a) => a.type === "WAKE" && a.enabled && a.date === review);
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, vs]) => {
    const pick = (k: string) => vs.find((v) => v.kind === k);
    const sleep = pick("sleep");
    const wake = pick("wake");
    const ring = pick("alarm_ring");
    let delay: number | null = null;
    let basis: Structured["sleep_wake"][number]["wake_delay_basis"] = null;
    if (wake?.minutes != null) [delay, basis] = [wake.minutes, "stated_minutes"];
    else if (wake?.time && ring?.time) [delay, basis] = [diff(ring.time, wake.time), "stated_alarm_time"];
    else if (wake?.time && date === review && wakeAlarm) [delay, basis] = [diff(wakeAlarm.time, wake.time), "scheduled_wake_alarm"];
    const overslept = delay !== null ? delay > 0 : wake?.reasons.includes("overslept") ? true : null;
    return {
      date, sleep_at: sleep?.at ?? null, wake_at: wake?.at ?? null, alarm_rang_at: ring?.at ?? null, wake_delay_minutes: delay, wake_delay_basis: basis, overslept,
      sleep_satisfaction: date === review ? x.daily_record.sleep_satisfaction : null,
      // 오늘 밤 예정 — 정오 전 시각(00:30)이면 달력으로 다음 날
      planned_sleep_at: date === review && planned !== null ? localToIso(toMinutes(planned) < 12 * 60 ? addDays(review, 1) : review, planned) : null,
      source: weakest(vs.map((v) => v.source)), behavior_refs: vs.map((v) => v.id),
    };
  });
}

function outcomes(views: BehaviorView[]): Structured["schedule_outcomes"] {
  const groups = new Map<string, BehaviorView[]>();
  for (const v of views) {
    if (v.appointment === null) continue;
    const a = v.appointment;
    // 일정을 모르는 지각은 서로 묶지 않음(한 줄씩), 아는 일정 · 이름은 날짜별로 묶음
    const key = a.appointment_id ?? (a.title !== null ? `t:${normTitle(a.title)}` : `b:${v.id}`);
    const k = `${v.date}|${key}`;
    groups.set(k, [...(groups.get(k) ?? []), v]);
  }
  return [...groups.values()].map((vs) => {
    const usable = vs.filter((v) => v.issue === null || v.issue === "unlinked");
    const late = usable.find((v) => v.kind === "late");
    const a = vs[0].appointment!;
    return {
      date: vs[0].date, appointment_id: a.appointment_id, appointment_title: a.title, link: a.link,
      is_late: late ? late.minutes !== 0 : null, late_minutes: late?.minutes ?? null, causes: [...new Set(usable.flatMap((v) => v.reasons))],
      departed_at: usable.find((v) => v.kind === "depart")?.at ?? null, arrived_at: usable.find((v) => v.kind === "arrive")?.at ?? null,
      source: weakest(vs.map((v) => v.source)), status: vs.every((v) => v.status === "recorded") ? "recorded" : "needs_confirm", behavior_refs: vs.map((v) => v.id),
    };
  });
}

export function applyFinal(x: FinalExtract, ctx: Context, refs: RefsOut, cards: Card[]): FinalPlan {
  const review = ctx.session.record_date;
  const safe = !x.safety_flag;

  const appointments: Structured["appointments"] = x.appointments.map((a) => {
    const card = a.ref !== null ? cards.find((c) => APPT_CARDS.includes(c.kind) && c.edit?.appointment_id === a.ref) ?? apptCardFor(cards, a.title, a.date) : apptCardFor(cards, a.title, a.date);
    const status = statusOf(card, a.save);
    return {
      title: a.title, date: a.date, time: a.time, place: a.place, importance: a.importance, transport: a.transport, repeat: a.repeat, status, card_id: card?.id ?? null,
      appointment_id: status === "saved" ? card?.appointment_id ?? apptIdOf(refs, a.ref) : apptIdOf(refs, a.ref), unclear: a.unclear, source: a.save === "CONFIRMED" ? "confirmed" : "stated",
    };
  });
  const alarm_changes = x.alarm_changes.map((c) => ({ ...c, status: statusOf(cards.find((k) => ALARM_CARDS.includes(k.kind) && (k.edit?.appointment_id ?? null) === c.appointment_ref), c.save) }));
  const prepCard = cards.find((c) => typeof c.edit?.prepare_delta === "number" && c.edit.prepare_delta !== 0);
  const prep_adjustment = x.prep_adjustment === null || x.prep_adjustment.direction === "OK" ? null : { ...x.prep_adjustment, status: statusOf(prepCard, x.prep_adjustment.save) };

  // 할 일 · 준비물 — 같은 대화 안 겹침(같은 키 + 같은 약속)은 하나만 저장 대상
  const todos: TodoPlan[] = [];
  const todoTargets: (number | null)[] = [];
  const todoViews: Structured["todos"] = [];
  const seen = new Map<string, number>();
  for (const t of x.todos) {
    const title = t.title.trim().slice(0, 100);
    if (title === "") continue;
    let appointmentId = apptIdOf(refs, t.appointment_ref);
    if (appointmentId === null && t.appointment_title !== null) {
      const card = apptCardFor(cards, t.appointment_title, null);
      if (card?.status === "SAVED") appointmentId = card.appointment_id; // 거절 · 미확인 일정이면 준비물만 남김 (D32 A)
    }
    const key = `${itemKey(title)}|${appointmentId ?? ""}`;
    todoViews.push({ title, type: t.type, due_date: t.due_date, appointment_id: appointmentId, appointment_title: clean(t.appointment_title), source: "stated", stored: null });
    if (seen.has(key)) {
      todoTargets.push(null);
      continue;
    }
    seen.set(key, todos.length);
    todoTargets.push(todos.length);
    todos.push({ title, todo_type: t.type, due_date: t.due_date, appointment_id: appointmentId });
  }

  const behavior = behaviorViews(x, ctx, refs);
  const sleep_wake = sleepWake(behavior, x, ctx);
  const schedule_outcomes = outcomes(behavior);
  const note = safe ? clean(x.daily_record.condition_note) : null;

  // 생활 기록 표 — 확인된 진술만, 날짜 범위 안만 (밖은 저장 결과에 skipped_out_of_range)
  const records = new Map<LocalDate, RecordWrite["values"]>();
  const put = (d: LocalDate, k: keyof RecordWrite["values"], v: string | number) => records.set(d, { ...(records.get(d) ?? {}), [k]: v });
  for (const s of sleep_wake) {
    const sleepSource = behavior.find((b) => s.behavior_refs.includes(b.id) && b.kind === "sleep")?.source;
    if (s.sleep_at !== null && sleepSource !== "inferred") put(s.date, "sleep_at", s.sleep_at);
  }
  if (x.daily_record.sleep_satisfaction !== null) put(review, "sleep_satisfaction", x.daily_record.sleep_satisfaction);
  if (note !== null) put(review, "condition_note", note.slice(0, 200));

  const m = x.mood_condition;
  const draft: FinalPlan["draft"] = {
    schema_version: STRUCTURED_VERSION,
    day_review: {
      events: safe ? x.day_review.events.filter((e) => clean(e.text) !== null).map((e) => ({ ...e, text: e.text.trim() })) : [],
      memorable: safe ? clean(x.day_review.memorable) : null,
    },
    mood_condition: { mood: [...new Set(m.mood)], valence: m.valence, valence_source: "inferred", fatigue: m.fatigue, stress: m.stress, causes: safe ? m.causes.map((c) => c.trim()).filter(Boolean) : [], condition_note: note, source: m.source },
    habit_signals: x.habit_signals.filter((h) => clean(h.note) !== null).map((h) => ({ ...h, note: h.note.trim() })),
    goals_routine: { goals: x.goals_routine.goals.filter((g) => clean(g.goal_text) !== null), wanted_routine: clean(x.goals_routine.wanted_routine), suggestion_response: null },
    behavior,
    sleep_wake,
    schedule_outcomes,
    alarm_feedback: x.alarm_feedback.map((f) => ({ effect: f.effect, alarm_type: f.alarm_type, date: f.date, note: clean(f.note), db_feedback_type: DB_FEEDBACK[f.effect], source: f.source })),
    appointments,
    todos: todoViews,
    alarm_changes,
    prep_adjustment,
    other: { importance_updates: x.importance_updates, fact_feedback: x.fact_feedback, reason_tags: x.reason_tags, safety_flag: x.safety_flag },
    pending: [],
  };
  draft.pending = pendingOf(draft);
  return { draft, todos, todoTargets, records: [...records.entries()].map(([record_date, values]) => ({ record_date, values })) };
}

const ISSUE_KO: Record<BehaviorIssue, string> = { no_date: "날짜를 모름", uncertain: "말이 애매함", conflict: "엇갈린 진술", unlinked: "어느 일정인지 모름" };

/** 확인이 필요한 것 — 저장하지 않았지만 JSON에는 남은 것 */
function pendingOf(d: FinalPlan["draft"]): Structured["pending"] {
  return [
    ...d.appointments.flatMap((a, i) => (a.status === "needs_confirm" ? [{ section: "appointments", ref: `appointments[${i}]`, reason: a.unclear ? "unclear" : "unconfirmed", text: `일정 확인 필요: ${a.title}${a.unclear ? ` (${a.unclear})` : ""}` }] : [])),
    ...d.alarm_changes.flatMap((c, i) => (c.status === "needs_confirm" ? [{ section: "alarm_changes", ref: `alarm_changes[${i}]`, reason: "unconfirmed", text: `알람 변경 확인 필요: ${c.type}` }] : [])),
    ...(d.prep_adjustment?.status === "needs_confirm" ? [{ section: "prep_adjustment", ref: "prep_adjustment", reason: "unconfirmed", text: "준비시간 변경 확인 필요" }] : []),
    ...d.behavior.flatMap((b) => (b.issue !== null ? [{ section: "behavior", ref: b.id, reason: b.issue, text: `${b.kind} 기록 확인 필요: ${ISSUE_KO[b.issue]}${b.note ? ` (${b.note})` : ""}` }] : [])),
  ];
}

// shortcut: 숫자 점수 표현만 봄("4점" · "8/10" · "피로도 4") — "다섯 점"처럼 글자로 쓴 숫자는 못 알아봄(점수가 지워지는 쪽이라 안전), 필요해지면 말 숫자도
//   키워드 바로 뒤 숫자만("피로도 4") — "피곤해. 앞으로 12시"의 시각 숫자를 점수로 보지 않게
const SCORE_SAID = /\d+\s*(점|\/\s*(5|10)\b)|(피로도?|스트레스)\s*(는|가|도|지수)?\s*\d/u;

/**
 * 모델 출력 중 사용자 직접 진술로 단정하면 안 되는 것을 걸러 냄 (프롬프트 규칙만으로는 안 지켜짐 — 11/8 실제 호출):
 *   · 피로 · 스트레스 점수: 사용자 말에 점수 표현이 없으면 null ("너무 피곤해" → 4 · 5가 나옴, T2.v3 · v3.1)
 *   · 감정 원인: 이유를 잇는 말이 없으면 비움 · phone_in_bed: 잠자리 말이 없으면 출처 inferred (기분 mood는 그대로)
 *   · 목표의 습관: 그 습관을 직접 말한 신호(stated · confirmed)가 없으면 other
 */
export function dropUnstatedScores(x: FinalExtract, userTexts: string[]): FinalExtract {
  const said = (re: RegExp) => userTexts.some((t) => re.test(t));
  const m = x.mood_condition;
  // '자기 전 휴대폰'은 잠자리를 말했을 때만 사용자 진술 — "새벽 1시까지 휴대폰을 봤어"의 분류는 짐작(11/8)
  const habits = x.habit_signals.map((h) => (h.habit === "phone_in_bed" && h.source !== "inferred" && !said(BED_SAID) ? { ...h, source: "inferred" as const } : h));
  return {
    ...x,
    habit_signals: habits,
    // 목표의 습관은 사용자가 그 습관을 말한 신호가 있을 때만 — "조금 더 일찍 일어나고 싶어"를 irregular_wake로 단정한 일(11/8 음성). 목표 문장은 그대로
    goals_routine: {
      ...x.goals_routine,
      goals: x.goals_routine.goals.map((g) => (g.habit === "other" || habits.some((h) => h.habit === g.habit && h.source !== "inferred") ? g : { ...g, habit: "other" as const })),
    },
    mood_condition: {
      ...m,
      ...(said(SCORE_SAID) ? {} : { fatigue: null, stress: null }),
      // 감정 원인은 사용자가 이유로 이어 말했을 때만 — "발표는 잘 끝났는데 너무 피곤해"를 원인 '발표'로 확정한 일(11/8)
      ...(said(CAUSE_SAID) ? {} : { causes: [] }),
    },
  };
}

/** 사용자가 청하지 않은 준비시간 변경은 버림 — 대화 중 카드와 같은 기준(turn-core prepAsked). 지난 일은 behavior, 바람은 goals에 이미 남음 */
export const dropUnaskedPrep = (x: FinalExtract, turns: readonly { role: string; text: string }[]): FinalExtract =>
  x.prep_adjustment === null || prepAsked(turns) ? x : { ...x, prep_adjustment: null };
// shortcut: 이어 주는 말 · 잠자리 말을 글자로만 봄 — 말투가 다르면(예: "피곤한 건 발표 탓") 원인을 비우는 쪽(안전), 자주 놓치면 목록을 늘림
//   '-아서 · -어서'(마쳐서 · 늦어서)는 말끝의 '서'로 보되 장소의 '에서'(도서관에서)는 뺌
const CAUSE_SAID = /(때문|라서|느라|니까|으니|탓|[가-힣](?<!에)서(?=[\s,.!?~]|$))/u;
const BED_SAID = /(자기\s*전|잠들기|누워|침대|이불|잠자리)/u;

/** 세션 정보 · 저장 결과를 붙여 공개 JSON 완성 */
export function finishStructured(plan: FinalPlan, session: Structured["session"], storage: Structured["storage"], todoResults: (Structured["todos"][number]["stored"])[]): Structured {
  const todos = plan.draft.todos.map((t, i) => {
    const target = plan.todoTargets[i];
    return { ...t, stored: target === null ? "duplicate" as const : todoResults[target] ?? null };
  });
  return { ...plan.draft, session, todos, storage };
}

/** 이미 있는 할 일과 겹치는지 — 같은 키 + 같은 약속이고, 약속이 없으면 같은 날짜이거나 이 대화가 만든 것 (재시도 · 카드 준비물 · 지난 대화와 겹침 막기) */
export function isDuplicateTodo(
  t: TodoPlan,
  existing: { title: string; appointment_id: string | null; due_date: string | null; source_session_id: string | null }[],
  sessionId: string,
): boolean {
  const key = itemKey(t.title);
  // 같은 대화가 이미 넣은 같은 이름은 약속 · 날짜가 달라도 겹침 — 대화 중(voice-turn)에 바로 넣은 준비물을 끝 정리(T2)가 약속에 붙여 또 넣지 않게
  return existing.some(
    (e) => itemKey(e.title) === key && (e.source_session_id === sessionId || ((e.appointment_id ?? null) === t.appointment_id && (t.appointment_id !== null || e.due_date === t.due_date))),
  );
}

/** 날짜가 생활 기록 표에 쓸 범위 안인지 */
export const recordDateInRange = (date: LocalDate, review: LocalDate): boolean => date >= addDays(review, -RECORD_PAST_DAYS) && date <= addDays(review, 1);
