// 서버 AI 공통 계약 — 실험실 lib/types.ts의 context.v1 · 대화 · T1/T2 출력 · 처리 결과 계약 + 자기 전 대화 카드 · 정정 · 응답 모양(L4 설계 메모 2절).
// 시각 표기: 로컬 날짜 "YYYY-MM-DD", 로컬 시각 "HH:MM"(24시간). 시간대(Asia/Seoul)는 서버가 붙인다.
// 저장 날짜 경계는 로컬 0시(D7 10/29, 문서보완_목록 #14). 대화 기준일(session.record_date = 돌아볼 날)은 view.ts · turn-core.ts `dayOf`의 규칙을 따른다(설계 메모 4.1, 헤드 H1).
// 런타임 코드는 Node · Deno 전용 API를 쓰지 않는다 — 순수 TS라 node --test와 Edge Function이 같은 파일을 쓴다.
// 실험실에서 뺀 것: TruthItem · Scenario · Persona · CallRecord · T4 · T5 출력(시뮬레이터 · 분석 · 일기 전용, 설계 메모 7절).

// ───────── 열거값 ─────────

export type SessionType = "BEFORE_SLEEP" | "AFTER_WAKE";
export type Opening = "SUMMARY_FIRST" | "QUESTION_FIRST";

export type Importance = "LOW" | "NORMAL" | "HIGH";
/** 화면 라벨 — FE 코드(10/8) 기준. DB 값은 그대로 LOW/NORMAL/HIGH. */
export const IMPORTANCE_LABEL: Record<Importance, string> = { LOW: "평소", NORMAL: "중요", HIGH: "매우 중요" };

export const REASON_TAGS = [
  "MORE_TASKS", "OVERSLEPT", "HAIR_WASH", "TRAFFIC", "UNEXPECTED",
  "ESTIMATE_SHORT", "ETC", "MAKEUP", "PRESENTATION",
] as const;
export type ReasonTag = (typeof REASON_TAGS)[number];
export const REASON_LABEL: Record<ReasonTag, string> = {
  MORE_TASKS: "준비할 게 많았음",
  OVERSLEPT: "늦잠",
  HAIR_WASH: "씻기·머리",
  TRAFFIC: "교통",
  UNEXPECTED: "갑작스러운 일",
  ESTIMATE_SHORT: "예상 자체가 짧음",
  ETC: "기타",
  MAKEUP: "화장",
  PRESENTATION: "발표",
};

export type AlarmType = "WAKE" | "PREPARE" | "DEPARTURE" | "ARRIVE";
export type Intensity = "SOFT" | "NORMAL" | "STRONG";
export type Transport = "WALK" | "TRANSIT" | "BUS" | "SUBWAY" | "CAR";
export type Weekday = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";
export const WEEKDAYS: Weekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
export const WEEKDAY_KO: Record<Weekday, string> = { MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토", SUN: "일" };

export type LocalDate = string; // "2026-10-09"
export type LocalTime = string; // "07:40"

// ───────── 컨텍스트 (입력 계약 context.v1) ─────────

export interface Appointment {
  ref: string; // 짧은 별칭 a1, a2 … (서버가 UUID로 바꿈)
  title: string;
  date: LocalDate;
  time: LocalTime;
  place: string | null;
  importance: Importance | null; // null = 아직 모름(서버 키워드 사전이 채울 몫)
  importance_confirmed: boolean;
  transport: Transport | null;
  travel_minutes: number | null;
  repeat: "NONE" | "WEEKLY";
  /** 그룹 약속이면 그룹 이름(읽을 수 없으면 ""), 개인 일정이면 칸 없음 — 고칠 알람을 '캡스톤 그룹 알람'처럼 고를 때 씀 */
  group?: string;
}

export interface AlarmPlan {
  ref: string; // al1 …
  owner: string; // 사용자 별칭 u0(본인) · u1 …
  type: AlarmType;
  date: LocalDate;
  time: LocalTime;
  intensity: Intensity;
  appointment_ref: string | null;
  enabled: boolean;
  /** 서버 처리 결과(ServerEvent.alarms)에서만: 이번에 새로 만든 알람인지(NEW) · 있던 알람이 바뀐 것인지(CHANGED, 꺼짐 포함) */
  change?: "NEW" | "CHANGED";
  /**
   * 시각을 자동으로 계산했는지(AUTO) 직접 골랐는지(MANUAL) — DB alarms.time_source. 서버만 쓰는 칸이라 화면(view.ts)은 안 읽는다.
   * 서버 질문 PREP_CHECK는 AUTO 기상일 때만 묻는다(설계 메모 4.3 ② — 직접 고른 기상은 준비를 늘려도 안 바뀜). 없으면 AUTO로 본다.
   */
  time_source?: "AUTO" | "MANUAL";
}

export type FactKind = "SLEEP" | "WAKE" | "SNOOZE" | "DEPART" | "ARRIVE" | "LATE" | "PREP_OVER" | "ROUTINE_DONE";

/** 서버가 자동 · 원탭으로 모은 오늘 사실. AI는 이것만 숫자로 말할 수 있다. */
export interface Fact {
  id: string; // f1 …
  kind: FactKind;
  time: LocalTime | null;
  minutes: number | null; // 지각 분 · 준비 초과 분 · 미루기 횟수 등
  appointment_ref: string | null;
  source: "AUTO" | "ONE_TAP" | "MANUAL";
  confirmed: boolean;
  text: string; // 사람이 읽는 한 줄 ("기상 확인 08:12")
  /**
   * 앞 출발 표시(설계 메모 4.5) — 위치로 잡은 출발이 나중 출발로 바뀐 뒤 남은 앞선 출발 기록("잠깐 나갔다 들어옴").
   * 서버만 쓰는 칸이라 화면(view.ts)은 안 읽는다. 이 사실을 [아니에요]하면 바꿀 값이 없어 앱에 정정을 안 보냄(turn-core).
   * (설계 판단 — 설계 메모엔 칸 이름이 없어 PR 3에서 정함)
   */
  earlier?: true;
}

export type QuestionKind = "CAUSE" | "IMPORTANCE" | "TOMORROW_REASON" | "PREP_CHECK" | "ITEMS";

/** 서버가 고른 질문 — 세션당 최대 1개. AI는 이 질문만 할 수 있다(REFLECT 제외). */
export interface ServerQuestion {
  id: string; // q1
  kind: QuestionKind;
  text: string; // 서버가 정한 질문 뜻 ("오늘 준비가 예상보다 18분 더 걸렸어요. 이유가 있었나요?")
  target_ref: string | null; // f# 또는 a#
  options: string[]; // 원인 칩 라벨 등 (없으면 [])
}

export interface EditableUser {
  alias: string; // u1 …
  name: string;
  relation: "FRIEND" | "GROUP" | "FAMILY";
  can_add: boolean; // 새 알람 추가(모닝콜)
  can_earlier: boolean; // 앞당기기
  // 끄기 · 늦추기는 본인만 — 다른 사람에게는 언제나 거절
}

export type RejectReason = "NO_PERMISSION" | "AMBIGUOUS" | "PAST_TIME" | "NOT_FOUND";

export interface PendingItem {
  id: string; // c1 … 확인 대기 항목(= 카드 번호)
  kind: "APPOINTMENT" | "IMPORTANCE" | "ALARM_CHANGE";
  summary: string; // "10/9(금) 14:00 스터디 · 학교 도서관"
}

/** 직전 사용자 턴을 서버가 처리한 결과. T1은 숫자 · 저장 결과를 여기 있을 때만 말한다. */
export interface ServerEvent {
  after_turn: number; // 몇 번째 사용자 턴 뒤인지
  applied: string[]; // 저장한 것 요약 ("준비물: 노트북 충전기")
  pending: PendingItem[]; // 사용자 확인이 필요한 것
  rejected: { target: string; reason: RejectReason }[];
  clarify: string[]; // 모호해서 되물어야 하는 것 ("'점심 먹고'의 정확한 시각")
  alarms: AlarmPlan[]; // 다시 계산한 알람 (바뀐 것만)
  /** 다른 일정과 겹쳐 만들지 않은 알람 등 — 사용자에게 알릴 것 (없으면 칸 없음) */
  conflicts?: string[];
  /** 서버가 정한 위기 안내 시점 — 이번 사용자 말에 위험 표시가 처음 나옴(대화당 1회) */
  crisis?: boolean;
  /** T2F가 실패하거나 제한 시간을 넘겨 이 턴 위험 판단이 없음('모름') — 가드가 모델이 낸 109를 지우지 않게 하는 표시. 위기 안내 줄은 아님(없으면 칸 없음) */
  risk_unknown?: boolean;
  /** 서버가 센 무음(받아쓰기가 빈 글) — 연속 1번째 · 2번째. 텍스트 대화에서는 안 씀(E5 기본안 A) */
  silence?: 1 | 2;
}

export interface Context {
  context_version: "context.v1";
  session: {
    type: SessionType;
    now: string; // ISO "2026-10-08T22:30:00+09:00"
    timezone: "Asia/Seoul";
    /** 돌아볼 날(= dates.today). 대화 기준일 규칙(헤드 H1): 정오 전이고 달력 오늘 기상 기록이 없으면 전날 밤 대화 */
    record_date: LocalDate;
    opening: Opening;
  };
  /** 상대 날짜 해석표 — 서버가 record_date(돌아볼 날) 기준으로 만든다. */
  dates: {
    today: LocalDate;
    tomorrow: LocalDate;
    day_after: LocalDate;
    weekday_today: Weekday;
    this_week: Record<Weekday, LocalDate>;
    next_week: Record<Weekday, LocalDate>;
  };
  user: { alias: "u0"; name: string };
  today: {
    facts: Fact[];
    appointments: Appointment[];
    alarms: AlarmPlan[];
    items: string[];
    todos: { title: string; due_date: LocalDate | null }[];
  };
  tomorrow: {
    appointments: Appointment[];
    alarms: AlarmPlan[];
    items: string[];
    todos: { title: string; due_date: LocalDate | null }[];
  };
  /** 내일 뒤 며칠(LATER_DAYS)의 내 약속 · 내 알람 — "25일 알람 바꿔줘"처럼 고칠 대상을 찾을 때만 씀. 예전 대화는 칸 없음 */
  later?: { appointments: Appointment[]; alarms: AlarmPlan[] };
  question: ServerQuestion | null;
  editable_users: EditableUser[];
  events: ServerEvent[];
  /** 내가 가입한(JOINED) 그룹 — 새 일정을 그룹 일정으로 걸지 고를 때만 씀(서버 전용, 화면 글 view.ts는 안 읽음). 없으면 칸 없음 */
  groups?: GroupRef[];
}

export interface GroupRef {
  id: string; // groups.group_id
  name: string;
}

// ───────── 대화 ─────────

export type ActType = "SERVER_Q" | "CONFIRM" | "CLARIFY" | "REFLECT" | "OTHER_Q";
export interface Act {
  type: ActType;
  ref: string | null; // SERVER_Q → q#, CONFIRM → c#, CLARIFY → 대상 설명
}

export interface Turn {
  index: number; // 0부터, ai/user 섞어서
  role: "ai" | "user";
  text: string;
  acts?: Act[]; // ai 턴
  latency_ms?: number;
  /** ai 턴: T1 호출의 생각 블록 글(요약). 생각이 없었으면 null */
  thinking?: string | null;
}

// ───────── 출력 계약 ─────────

/** T1 대화 답변 */
export interface T1Output {
  reply: string;
  acts: Act[];
  end: boolean; // 대화를 마무리하자는 답인지
}

export type SaveStatus = "CONFIRMED" | "DECLINED" | "UNCONFIRMED";

/** T2 대화 분석 — 정규형(schemas/extract.v1.json, 대화 끝 정리 칸을 더한 판은 아래 FinalExtract). 지금까지의 대화 전체에서 뽑은 '현재 상태'를 낸다(변화분 아님). */
export interface Extract {
  schema_version: string; // "2.0-lab.N"
  appointments: {
    ref: string | null; // 기존 약속을 고친 것이면 a#, 새 약속이면 null
    title: string;
    date: LocalDate | null;
    time: LocalTime | null;
    place: string | null;
    importance: Importance | null; // 사용자가 말했을 때만
    transport: Transport | null;
    repeat: "NONE" | "WEEKLY" | null;
    save: SaveStatus;
    unclear: string | null; // 모호해서 확인이 필요한 이유 (없으면 null)
  }[];
  todos: { title: string; type: "TASK" | "ITEM"; due_date: LocalDate | null; appointment_ref: string | null }[];
  importance_updates: { appointment_ref: string; importance: Importance; save: SaveStatus }[];
  alarm_changes: {
    target: string; // u0(본인) 또는 u# 별칭
    appointment_ref: string | null;
    type: AlarmType;
    date: LocalDate | null;
    time: LocalTime | null;
    intensity: Intensity | null;
    enabled: boolean | null;
    save: SaveStatus;
  }[];
  fact_feedback: {
    fact_id: string;
    status: "CONFIRMED" | "CORRECTED" | "DENIED" | "UNCLEAR";
    value_time: LocalTime | null;
    approx: boolean;
  }[];
  reason_tags: { tag: ReasonTag; applies_to: "TODAY" | "TOMORROW"; always: boolean }[];
  // 내일만. save는 선택 칸
  prep_adjustment: { direction: "MORE" | "LESS" | "OK"; minutes: number | null; save?: SaveStatus } | null;
  daily_record: { sleep_time: LocalTime | null; sleep_satisfaction: number | null; condition_note: string | null };
  safety_flag: boolean;
}

/** T2F(빠른 추출) 출력 — 서버를 움직이는 칸만 (E2, 06-서버지침.md 30번). `expandFast`가 전체 Extract로 펼친다. */
export interface FastExtract {
  appointments: Extract["appointments"];
  alarm_changes: Extract["alarm_changes"];
  fact_feedback: Extract["fact_feedback"];
  prep_adjustment: Extract["prep_adjustment"];
  safety_flag: boolean;
  /** 준비물 (T2F.v2-d · extract-fast.v2, 선택 칸). date "" = 날짜를 모름 → 서버가 되물음 */
  items?: { title: string; date: string }[];
  /** 나가기 전 할 일 (T2F.v2-e · extract-fast.v3, 선택 칸) — 집 · 온라인에서 하는 회의 · 과제 · 공부. 일정 카드를 만들지 않고 기상 시각을 확인하는 계기만 됨. 제목 모르면 "할 일" */
  pre_tasks?: { title: string }[];
  /** 기상 시각 답 (T2F.v2-e · extract-fast.v3, 선택 칸) — NONE 말 없음 · KEEP 계산된 시각 그대로 · TIME 정한 시각(time) · VAGUE "좀 일찍"처럼 시각 없음. time "" = 없음 */
  wake_reply?: { choice: WakeChoice; time: string };
}

export type WakeChoice = "NONE" | "KEEP" | "TIME" | "VAGUE";

/**
 * 나가기 전 할 일이 있는 새 일정 카드의 기상 확인 (AI 대화 전용, 서버 · 앱이 같이 읽음)
 *   ASK = 계산된 기상 시각을 사용자에게 묻는 중 — 답 전에는 저장 안 함 · KEEP = 계산된 기상 그대로 · SET = 사용자가 정한 time(HH:MM)으로 기상만 옮김
 *   준비 · 출발 알람은 기상을 따라 움직이지 않음 (앱 estimateNew가 기상만 옮김)
 */
export interface PreTask {
  title: string;
  wake: "ASK" | "KEEP" | "SET";
  time: LocalTime | null;
}

/**
 * 새 일정 카드를 그룹 일정으로 걸지 (AI 대화 전용, 서버 · 앱이 같이 읽음) — 말이나 제목에 가입한 그룹 이름 · '그룹'이 나올 때만 붙음
 *   ASK = 그룹 일정인지 개인 일정인지(후보가 여럿이면 어느 그룹인지) 묻는 중 — 답 전에는 저장 안 함
 *   GROUP = id 그룹 일정으로 저장 · PERSONAL = 그룹 없이 저장. candidates = 고를 수 있는 가입 그룹(앱 칩)
 */
export interface CardGroup {
  choice: "ASK" | "GROUP" | "PERSONAL";
  id: string | null;
  candidates: GroupRef[];
}

/** 사실의 출처 — 입력 방식(글 · Live 음성)과 다른 개념. stated 사용자가 직접 말함 · confirmed 확인 질문에 동의 · inferred AI 짐작 */
export type FactSource = "stated" | "confirmed" | "inferred";

/** 사용자가 대화에서 말한 실제 행동 한 줄 (T2.v3 behavior) — 시스템이 잰 값(Fact)과 달리 사용자 진술 */
export type BehaviorKind = "SLEEP" | "WAKE" | "ALARM_RING" | "SNOOZE" | "PREP_START" | "PREP_DURATION" | "PREP_OVER" | "DEPART" | "ARRIVE" | "LATE";
export interface BehaviorReport {
  kind: BehaviorKind;
  /** 그 일이 일어난 달력 날짜 · 시각 (새벽 1시 반에 잤으면 그 새벽의 날짜) */
  date: LocalDate | null;
  time: LocalTime | null;
  /** WAKE 사용자가 직접 말한 늦은 분만 · SNOOZE 횟수 · PREP_DURATION 전체 분 · PREP_OVER 더 걸린 분 · LATE 늦은 분(0 = 제시간) */
  minutes: number | null;
  appointment_ref: string | null;
  appointment_title: string | null;
  reasons: ReasonTag[];
  source: FactSource;
  /** 말이 서로 맞지 않거나 애매해 확인이 필요한 이유 */
  uncertain: string | null;
}
export type Habit = "late_bedtime" | "phone_in_bed" | "snooze_repeat" | "skip_breakfast" | "slow_prep" | "forgot_item" | "late_departure" | "irregular_wake" | "other";
export type Mood = "good" | "calm" | "tired" | "stressed" | "anxious" | "sad" | "angry" | "mixed";
export type AlarmEffect = "helpful" | "too_weak" | "too_strong" | "missed" | "annoying_sound" | "wrong_time";

/** T2 대화 끝 전체 추출 출력 (schemas/extract.v2, T2.v3) — Extract + 대화 끝 정리 칸. 공개 모양(structured.v1)은 final-core가 만든다 */
export interface FinalExtract extends Omit<Extract, "todos"> {
  todos: (Extract["todos"][number] & { appointment_title: string | null })[];
  behavior: BehaviorReport[];
  alarm_feedback: { effect: AlarmEffect; alarm_type: AlarmType | null; date: LocalDate | null; note: string | null; source: FactSource }[];
  day_review: { events: { text: string; time: LocalTime | null; important: boolean; source: FactSource }[]; memorable: string | null };
  mood_condition: { mood: Mood[]; valence: number | null; fatigue: number | null; stress: number | null; causes: string[]; source: FactSource };
  habit_signals: { habit: Habit; note: string; date: LocalDate | null; recurring: boolean; source: FactSource }[];
  goals_routine: { goals: { habit: Habit; goal_text: string; source: FactSource }[]; wanted_routine: string | null };
}

// ───────── 자기 전 대화 카드 · 정정 · 앱 일 (설계 메모 2.2 · 5절) ─────────

/** 카드 종류 — APPT_NEW 새 약속(앱이 계산 · 저장) · ALARM_EDIT 있는 약속 알람 고침 · ALARM_NEW 약속 없는 알람 · APPT_OPEN 있는 약속 변경(저장 없이 [일정 열기]만) */
export type CardKind = "APPT_NEW" | "ALARM_EDIT" | "ALARM_NEW" | "APPT_OPEN";
/** NEEDS_ESTIMATE → READY | NEEDS_PLACE | FAILED → SAVED | REJECTED */
export type CardStatus = "NEEDS_ESTIMATE" | "READY" | "NEEDS_PLACE" | "FAILED" | "SAVED" | "REJECTED";
/** 앱이 계산에 쓰는 약속 초안 재료(AppointmentDraft, 설계 메모 2.2 표) */
export interface ApptDraft {
  title: string;
  date: LocalDate;
  time: LocalTime;
  place: string | null;
  importance: Importance | null;
  transport: Transport | null;
  repeat: Weekday[]; // 빈 배열 = 반복 없음
  items: string[]; // 카드에 딸린 준비물(PR 5가 채움)
  alarms: { WAKE: boolean; PREPARE: boolean; DEPARTURE: boolean };
}
/** 알람 고침 재료 — 있는 약속(appointment_id = a# 별칭, 서버가 DB id로 바꿈) */
export interface CardEdit {
  appointment_id?: string | null;
  times?: Partial<Record<AlarmType, string>>; // ISO
  levels?: { sound: number | null; voice: number | null; vibration: number | null };
  enabled?: Partial<Record<AlarmType, boolean>>;
  prepare_delta?: number;
  /** ALARM_NEW */
  at?: string; // ISO
  level?: number | null;
  /** APPT_OPEN — 바뀔 값 */
  changes?: Partial<Pick<ApptDraft, "title" | "date" | "time" | "place" | "importance" | "transport">>;
}
/** 앱이 보낸 계산 요약 — 알람 시각 · 켜짐 · 강도만. 이동 분은 안 남긴다(D5) */
export interface Digest {
  alarms: { kind: AlarmType; at: string; enabled: boolean }[];
  level: number | null;
  with_wake: boolean;
  /** 기상 알람 계산 근거(분) — 앱이 L1 결과에서 준 값을 서버가 검사해 통과한 것만 (checkBasis). 없으면 근거를 말하지 않음 */
  basis?: Basis | null;
}
/** 기상 = 약속 시각 − 이동 − 준비 − 여유 */
export interface Basis {
  travel_minutes: number;
  prepare_minutes: number;
  buffer_minutes: number;
}
export interface Card {
  id: string; // c1 — 처리 결과의 확인 대기 번호와 같음
  kind: CardKind;
  status: CardStatus;
  first_of_day: boolean;
  highlight: boolean;
  summary: string;
  draft: ApptDraft | null;
  edit: CardEdit | null;
  digest: Digest | null;
  items: string[];
  appointment_id: string | null;
  error: string | null;
  /** 카드를 처음 만든 때(서울 ISO) — 다시 열 때 앱이 카드를 그 자리에 놓음. 예전 카드는 없음 */
  at?: string;
  /** 카드를 만든 사용자 말 번호 — 한 번의 요청에서 일정 카드는 하나만 저장 (앱 saveCard가 봄). 예전 카드는 없음 */
  turn?: number;
  /** 나가기 전 할 일 · 기상 확인 (새 일정 카드만). 없으면 할 일 말 없음 */
  pre_task?: PreTask;
  /** 그룹 일정 선택 (새 일정 카드만). 없으면 그룹 말 없음 = 개인 일정 */
  group?: CardGroup;
}
/** 기록 정정 — 앱이 L2 함수로 반영한다(설계 메모 4.5 · 13절 L2-2) */
export interface Fix {
  id: string; // x1
  fact: string; // f#
  kind: FactKind;
  participant_id: string | null; // 서버가 DB id로 채움(refs)
  action: "CORRECT" | "DENY";
  to: string | null; // ISO
}

/** 앱이 계산해 돌려준 카드 상태 · 정정 결과(voice-turn `results`) */
export interface TaskResults {
  cards: {
    id: string;
    status: "READY" | "NEEDS_PLACE" | "FAILED";
    estimate?: { alarms: { kind: AlarmType; at: string; enabled: boolean }[]; level: number | null; with_wake: boolean; basis?: unknown } | null;
    error?: string | null;
  }[];
  fixes: { id: string; ok: boolean; error?: string | null }[];
}
/** 카드 버튼(voice-turn `card_action`) — GROUP = 그룹 · 개인 일정 칩 (group_id null = 개인) */
export interface CardAction {
  id: string;
  action: "SAVED" | "REJECTED" | "GROUP";
  group_id?: string | null;
  appointment_id?: string | null;
  alarms?: { kind: AlarmType; at: string; enabled: boolean; level: number | null }[];
}
export interface TurnLimits {
  turns_left: number;
  sessions_left_today: number;
  reached: null | "TURN" | "DAY";
}
/** voice-turn 응답 모양(설계 메모 2.2) — PR 4가 채운다 */
export interface VoiceTurnResponse {
  rev: number;
  turn_seq: number;
  next: "USER" | "APP_TASKS";
  reply: { text: string; acts: Act[]; end: boolean } | null;
  cards: Card[];
  fixes: Fix[];
  limits: TurnLimits;
}
