// 시험용 가짜 컨텍스트 (실험실 lib/fixtures.ts 이식) — 학생 지민(가명). 순수 TS, 부를 때마다 새 객체(고쳐 써도 다른 테스트에 안 번짐).
// *.test.ts만 불러 쓴다(서버 코드는 가져오지 않음).
// BEFORE_SLEEP: 2026-10-08(목) 22:30, 내일 10:00 강남 캡스톤 발표(HIGH). 서버 처리 결과 1건(사용자 말 1 뒤).
// AFTER_WAKE:  2026-10-09(금) 07:35, 발표 당일 아침. 질문 · 처리 결과 없음.
// 숫자는 정답 계산식(truth.ts planAlarms와 같은 식)에 맞춰 둠 — 출발 = 약속 − 이동 − 여유, 기상 = 출발 − 준비,
// 준비 시작 = 기상 + 10분, 도착 확인 = 약속 시각, 강도 = 중요도(LOW 약하게 · 미정/NORMAL 보통 · HIGH 강하게), 도착 확인은 약하게.
//   지민: 준비 60분 · 여유 15분 · 기본 이동 40분 · 발표 날 +15분(PRESENTATION) · 머리 감기 +12분(HAIR_WASH)
//   오늘 a1 10:00 버스 25분 → 출발 09:20 · 기상 08:20. 실제: 2번 미루고 08:37 기상, 준비 18분 초과 → 09:55 출발 · 10:20 도착(지각 20분)
//   내일 a2 10:00 지하철 50분 → 출발 08:55 · 준비 75분 → 기상 07:40 · 준비 시작 07:50 / a3 18:30 → 출발 17:35
//   사용자 말 1(머리 감아야 해) 뒤 준비 87분 → 기상 07:28 · 준비 시작 07:38
//   a3 '동아리 모임'은 서버 키워드 사전에 없는 제목이라 중요도 미정(null)

import type { AlarmPlan, Appointment, Context, LocalDate, SessionType, Turn, Weekday } from "./types.ts";
import { REASON_LABEL, WEEKDAYS } from "./types.ts";
import { addDays, weekdayOf } from "./view.ts";

/** record_date 기준 상대 날짜표 (주는 월~일) */
export function datesFor(recordDate: LocalDate): Context["dates"] {
  const wd = weekdayOf(recordDate);
  const monday = addDays(recordDate, -WEEKDAYS.indexOf(wd));
  const week = (start: LocalDate): Record<Weekday, LocalDate> => {
    const w = {} as Record<Weekday, LocalDate>;
    WEEKDAYS.forEach((k, i) => {
      w[k] = addDays(start, i);
    });
    return w;
  };
  return {
    today: recordDate,
    tomorrow: addDays(recordDate, 1),
    day_after: addDays(recordDate, 2),
    weekday_today: wd,
    this_week: week(monday),
    next_week: week(addDays(monday, 7)),
  };
}

export interface SampleOptions {
  /** BEFORE_SLEEP만: 자정 뒤 01:30(10-09)에 연 대화 — record_date(대화 기준일)는 그대로 10-08 (설계 메모 4.1, 아직 안 잔 밤) */
  midnight?: boolean;
  /** BEFORE_SLEEP만: 사용자 말 1 뒤 서버 처리 결과를 넣을지 (기본 true, false면 대화 시작 시점) */
  events?: boolean;
}

const CAUSE_OPTIONS = (["MORE_TASKS", "OVERSLEPT", "HAIR_WASH", "TRAFFIC", "UNEXPECTED", "ESTIMATE_SHORT", "ETC"] as const).map((t) => REASON_LABEL[t]);

function alarm(ref: string, type: AlarmPlan["type"], date: LocalDate, time: string, intensity: AlarmPlan["intensity"], appointment_ref: string | null, extra: Partial<AlarmPlan> = {}): AlarmPlan {
  return { ref, owner: "u0", type, date, time, intensity, appointment_ref, enabled: true, ...extra };
}

function presentation(ref: string, date: LocalDate): Appointment {
  return {
    ref,
    title: "캡스톤 발표",
    date,
    time: "10:00",
    place: "강남",
    importance: "HIGH",
    importance_confirmed: true,
    transport: "SUBWAY",
    travel_minutes: 50,
    repeat: "NONE",
  };
}

function clubGathering(ref: string, date: LocalDate): Appointment {
  return {
    ref,
    title: "동아리 모임",
    date,
    time: "18:30",
    place: null,
    importance: null,
    importance_confirmed: false,
    transport: null,
    travel_minutes: null,
    repeat: "NONE",
  };
}

function beforeSleep(opts: SampleOptions): Context {
  const rec = "2026-10-08";
  const tmr = "2026-10-09";
  const withEvent = opts.events ?? true;
  // 처리 결과가 있으면 서버가 다시 만든 컨텍스트(준비물 · 알람 갱신)로 본다
  const wake = withEvent ? "07:28" : "07:40";
  const prep = withEvent ? "07:38" : "07:50";
  return {
    context_version: "context.v1",
    session: {
      type: "BEFORE_SLEEP",
      now: opts.midnight ? "2026-10-09T01:30:00+09:00" : "2026-10-08T22:30:00+09:00",
      timezone: "Asia/Seoul",
      record_date: rec,
      opening: "SUMMARY_FIRST",
    },
    dates: datesFor(rec),
    user: { alias: "u0", name: "지민" },
    today: {
      facts: [
        { id: "f1", kind: "SNOOZE", time: "08:20", minutes: 2, appointment_ref: null, source: "AUTO", confirmed: false, text: "알람 2번 미룸" },
        { id: "f2", kind: "WAKE", time: "08:37", minutes: null, appointment_ref: null, source: "ONE_TAP", confirmed: true, text: "기상 확인 08:37" },
        { id: "f3", kind: "DEPART", time: "09:55", minutes: null, appointment_ref: null, source: "AUTO", confirmed: false, text: "출발 09:55" },
        { id: "f4", kind: "ARRIVE", time: "10:20", minutes: null, appointment_ref: "a1", source: "AUTO", confirmed: false, text: "도착 10:20" },
        { id: "f5", kind: "LATE", time: null, minutes: 20, appointment_ref: "a1", source: "AUTO", confirmed: false, text: "데이터구조 20분 지각" },
        { id: "f6", kind: "PREP_OVER", time: null, minutes: 18, appointment_ref: "a1", source: "AUTO", confirmed: false, text: "준비가 예상보다 18분 더 걸림" },
      ],
      appointments: [
        {
          ref: "a1",
          title: "데이터구조",
          date: rec,
          time: "10:00",
          place: "공학관 302호",
          importance: "LOW",
          importance_confirmed: true,
          transport: "BUS",
          travel_minutes: 25,
          repeat: "WEEKLY",
        },
      ],
      alarms: [alarm("al7", "WAKE", rec, "08:20", "SOFT", "a1"), alarm("al8", "PREPARE", rec, "08:30", "SOFT", "a1")],
      items: [],
      todos: [],
    },
    tomorrow: {
      appointments: [presentation("a2", tmr), clubGathering("a3", tmr)],
      alarms: [
        alarm("al1", "WAKE", tmr, wake, "STRONG", "a2"),
        alarm("al2", "PREPARE", tmr, prep, "STRONG", "a2"),
        alarm("al3", "DEPARTURE", tmr, "08:55", "STRONG", "a2"),
        alarm("al4", "ARRIVE", tmr, "10:00", "SOFT", "a2"),
        alarm("al5", "DEPARTURE", tmr, "17:35", "NORMAL", "a3"),
        // 지민이 꺼 둔 도착 확인
        alarm("al6", "ARRIVE", tmr, "18:30", "SOFT", "a3", { enabled: false }),
      ],
      items: withEvent ? ["발표 자료 USB", "노트북 충전기"] : ["발표 자료 USB"],
      todos: [{ title: "발표 대본 마지막 점검", due_date: tmr }],
    },
    question: {
      id: "q1",
      kind: "CAUSE",
      text: "오늘 준비가 예상보다 18분 더 걸렸어요. 이유가 있었나요?",
      target_ref: "f6",
      options: CAUSE_OPTIONS,
    },
    editable_users: [{ alias: "u1", name: "서연", relation: "FRIEND", can_add: true, can_earlier: true }],
    events: withEvent
      ? [
          {
            after_turn: 1,
            applied: ["준비물: 노트북 충전기", "내일 사유: 씻기·머리 (+12분)"],
            pending: [{ id: "c1", kind: "APPOINTMENT", summary: "10/9(금) 14:00 스터디 · 도서관" }],
            rejected: [{ target: "서연(u1) 10/9(금) 기상 알람 끄기", reason: "NO_PERMISSION" }],
            clarify: ["'그 팀플'이 어느 일정인지"],
            alarms: [alarm("al1", "WAKE", tmr, "07:28", "STRONG", "a2"), alarm("al2", "PREPARE", tmr, "07:38", "STRONG", "a2")],
          },
        ]
      : [],
  };
}

function afterWake(): Context {
  const rec = "2026-10-09";
  return {
    context_version: "context.v1",
    session: { type: "AFTER_WAKE", now: "2026-10-09T07:35:00+09:00", timezone: "Asia/Seoul", record_date: rec, opening: "QUESTION_FIRST" },
    dates: datesFor(rec),
    user: { alias: "u0", name: "지민" },
    today: {
      facts: [
        { id: "f1", kind: "SLEEP", time: "00:40", minutes: null, appointment_ref: null, source: "AUTO", confirmed: false, text: "취침 00:40 (폰 사용 기준)" },
        { id: "f2", kind: "SNOOZE", time: "07:28", minutes: 1, appointment_ref: null, source: "AUTO", confirmed: false, text: "알람 1번 미룸" },
        { id: "f3", kind: "WAKE", time: "07:33", minutes: null, appointment_ref: null, source: "ONE_TAP", confirmed: true, text: "기상 확인 07:33" },
      ],
      appointments: [
        presentation("a1", rec),
        {
          ref: "a2",
          title: "스터디",
          date: rec,
          time: "14:00",
          place: "도서관",
          importance: null,
          importance_confirmed: false,
          transport: null,
          travel_minutes: null,
          repeat: "NONE",
        },
        clubGathering("a3", rec),
      ],
      alarms: [
        alarm("al1", "WAKE", rec, "07:28", "STRONG", "a1"),
        alarm("al2", "PREPARE", rec, "07:38", "STRONG", "a1"),
        alarm("al3", "DEPARTURE", rec, "08:55", "STRONG", "a1"),
        alarm("al4", "ARRIVE", rec, "10:00", "SOFT", "a1"),
        alarm("al5", "DEPARTURE", rec, "13:05", "NORMAL", "a2"),
        alarm("al6", "ARRIVE", rec, "14:00", "SOFT", "a2"),
        alarm("al7", "DEPARTURE", rec, "17:35", "NORMAL", "a3"),
        alarm("al8", "ARRIVE", rec, "18:30", "SOFT", "a3", { enabled: false }),
        // 어젯밤 지민이 서연에게 걸어 준 모닝콜
        alarm("al9", "WAKE", rec, "07:30", "NORMAL", null, { owner: "u1" }),
      ],
      items: ["발표 자료 USB", "노트북 충전기"],
      todos: [{ title: "발표 대본 마지막 점검", due_date: rec }],
    },
    tomorrow: { appointments: [], alarms: [], items: [], todos: [] },
    question: null,
    editable_users: [{ alias: "u1", name: "서연", relation: "FRIEND", can_add: true, can_earlier: true }],
    events: [],
  };
}

/** 지민의 가짜 컨텍스트. 부를 때마다 새 객체. */
export function sampleContext(type: SessionType, opts: SampleOptions = {}): Context {
  if (type === "BEFORE_SLEEP") return beforeSleep(opts);
  if (type === "AFTER_WAKE") {
    if (opts.midnight || opts.events) throw new Error("sampleContext: midnight · events 옵션은 BEFORE_SLEEP만");
    return afterWake();
  }
  throw new Error(`sampleContext: 모르는 세션 종류 '${String(type)}'`);
}

/** sampleContext와 맞물리는 대화 — BEFORE_SLEEP은 AI 1 · 나 1(서버 처리 결과 1건의 원인), AFTER_WAKE는 AI 여는 말만. */
export function sampleTranscript(type: SessionType, opts: SampleOptions = {}): Turn[] {
  if (type === "AFTER_WAKE") {
    return [{ index: 0, role: "ai", text: "지민 님, 잘 잤어요? 오늘 10:00에 캡스톤 발표가 있어요." }];
  }
  const turns: Turn[] = [
    {
      index: 0,
      role: "ai",
      text: "지민 님, 오늘은 08:37에 일어나서 09:55에 출발했고 10:20에 도착했어요. 오늘 준비가 예상보다 18분 더 걸렸는데, 이유가 있었나요?",
      acts: [{ type: "SERVER_Q", ref: "q1" }],
    },
  ];
  if (opts.events ?? true) {
    turns.push({
      index: 1,
      role: "user",
      text: "응 머리 감느라 늦었어 ㅠ 내일도 발표라 머리 감아야 돼. 노트북 충전기 챙겨야 하고\n내일 2시에 도서관에서 스터디 있어. 그 팀플 시간도 좀 당겨 줘. 아 서연이 알람은 꺼 줘",
    });
  }
  return turns;
}
