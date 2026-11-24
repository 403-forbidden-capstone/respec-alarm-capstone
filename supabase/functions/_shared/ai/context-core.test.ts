// context-core.ts 시험 — DB 행 → context.v1 (설계 메모 4 · 4.2 · 4.5절 · 13절 L2-1/L2-3)
//   · 앞 출발 거르기: #40(출발 · 도착 기록) PR의 mobile/src/features/location/__tests__/api.test.ts 121-160줄 'listEarlierDepartures' 사례를 그대로 옮김 —
//     앱과 서버가 같은 규칙을 따로 갖고 있어(규칙 두 벌 위험) 같은 입력이 같은 답을 내는지 고정한다.
//   · 지각 NULL = 지각 아님 · 확인할 기록 채우기 없음 · 자정 대화(00:30 · 23:50, 헤드 H1)는 새 사례.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "./types.ts";
import {
  buildContext, datesOf, earlierDeparturesOf, factSourceOf, factsOf, itemsOf, alarmsOf, appointmentOf, openingOf, repeatOf, seoulParts, storedSource, userNameOf,
} from "./context-core.ts";
import type { AlarmRow, EarlierRow, InputSource, ParticipantJoin, TodoRow } from "./context-core.ts";
import { dayOf } from "./turn-core.ts";
import { pickConfirmFacts, SERVER_CONFIRM_OPTS, viewContext, viewFacts } from "./view.ts";

// ───────── 앞 출발 (#40 listEarlierDepartures 사례 그대로) ─────────

describe("earlierDeparturesOf — #40 listEarlierDepartures와 같은 규칙 (L2-1)", () => {
  // 앱 시험의 iso('08:10') — 그날 08:10(서울). 앱 시험은 로컬 시간대 기준이라 여기서는 서울 +09:00로 못박음
  const iso = (hhmm: string): string => `2026-10-29T${hhmm}:00+09:00`;
  type Cur = { departed_at: string | null; departed_source: InputSource | null };
  // 위치 기록 한 줄 — 출발 알람(그 참여 조건의 지금 출발 · 출처)
  const event = (hhmm: string, current: Cur, over: { alarm_type?: string; participant_id?: string | null } = {}): EarlierRow => ({
    event_at: iso(hhmm),
    alarms: { alarm_type: over.alarm_type ?? "DEPARTURE", participant_id: over.participant_id === undefined ? "p-1" : over.participant_id, appointment_participants: current },
  });
  const nowLocation: Cur = { departed_at: iso("08:40"), departed_source: "LOCATION" };

  it("지금 출발보다 앞선 위치 출발 줄만, 시각순 — 출발 알람의 줄만 읽음 (앱 시험 1)", () => {
    const rows = [event("08:40", nowLocation), event("08:10", nowLocation), event("07:30", nowLocation), event("08:00", nowLocation, { alarm_type: "PREPARE" })];
    assert.deepEqual(earlierDeparturesOf(rows), [
      { participantId: "p-1", at: iso("07:30") },
      { participantId: "p-1", at: iso("08:10") },
    ]);
  });

  it("지금 출발이 응답(원탭 · 직접 입력 · 옛 앱 원탭)이면 이미 답한 것이라 뺌, 지금 출발이 비었으면([아니에요]) 남은 줄 모두 (앱 시험 2)", () => {
    const rows = [
      event("08:10", { departed_at: iso("08:40"), departed_source: "BUTTON" }),
      event("08:15", { departed_at: iso("08:40"), departed_source: null }, { participant_id: "p-2" }),
      event("12:10", { departed_at: null, departed_source: null }, { participant_id: "p-3" }),
      event("12:20", { departed_at: null, departed_source: null }, { participant_id: null }), // 참여 조건 없는 알람
    ];
    assert.deepEqual(earlierDeparturesOf(rows), [{ participantId: "p-3", at: iso("12:10") }]);
  });

  it("L2-1 규칙 5줄: 그날 범위 · 직접 입력(MANUAL)도 응답 · 지금 출발 시각 이상은 지금 출발 · 알람이 없는 줄 · 시각순", () => {
    const manual: Cur = { departed_at: iso("08:40"), departed_source: "MANUAL" };
    assert.deepEqual(earlierDeparturesOf([event("08:10", manual)]), []);
    assert.deepEqual(earlierDeparturesOf([event("08:10", { departed_at: iso("08:40"), departed_source: "VOICE" })]), [], "위치가 아니면 모두 응답");
    // event_at ≥ departed_at은 지금 출발(또는 그 뒤) — 같은 분도 뺌
    assert.deepEqual(earlierDeparturesOf([event("08:40", nowLocation), event("09:10", nowLocation)]), []);
    assert.deepEqual(earlierDeparturesOf([{ event_at: iso("07:30"), alarms: null }]), []);
    // 시각순 (들어온 순서와 무관)
    const out = earlierDeparturesOf([event("08:20", nowLocation), event("07:10", nowLocation), event("08:05", nowLocation)]);
    assert.deepEqual(out.map((e) => e.at), [iso("07:10"), iso("08:05"), iso("08:20")]);
    // 그날 범위 (event_at ∈ [from, to)) — 앱 쿼리의 gte/lt와 같음
    const rows = [event("23:30", { departed_at: null, departed_source: null }), { ...event("00:10", { departed_at: null, departed_source: null }), event_at: "2026-10-30T00:10:00+09:00" }];
    assert.equal(earlierDeparturesOf(rows).length, 2);
    assert.deepEqual(earlierDeparturesOf(rows, { from: "2026-10-29T00:00:00+09:00", to: "2026-10-30T00:00:00+09:00" }).map((e) => e.at), [iso("23:30")]);
  });

  it("DB가 주는 시각 모양(마이크로초 · +00 · 공백 구분)도 같은 순서로 읽음", () => {
    const cur: Cur = { departed_at: "2026-10-29 23:40:00.123456+00", departed_source: "LOCATION" }; // = 10/30 08:40 KST
    const rows: EarlierRow[] = [
      { event_at: "2026-10-29T22:10:00.5+00:00", alarms: { alarm_type: "DEPARTURE", participant_id: "p", appointment_participants: cur } }, // 07:10 KST
      { event_at: "2026-10-29T23:41:00+00:00", alarms: { alarm_type: "DEPARTURE", participant_id: "p", appointment_participants: cur } }, // 지금 출발 뒤
    ];
    assert.deepEqual(earlierDeparturesOf(rows).map((e) => seoulParts(e.at).time), ["07:10"]);
  });
});

// ───────── 출처 · 사실 ─────────

describe("출처 · 사실 (설계 메모 4 · 4.2)", () => {
  it("출처: 폰 사용 · 위치 = 자동, 버튼 = 원탭, 직접 · 대화 = 직접 / 출처 칸이 비면 옛 원탭(BUTTON), 시각이 없으면 null", () => {
    assert.deepEqual((["USAGE", "LOCATION", "BUTTON", "MANUAL", "VOICE"] as InputSource[]).map(factSourceOf), ["AUTO", "AUTO", "ONE_TAP", "MANUAL", "MANUAL"]);
    assert.equal(storedSource("2026-10-29T08:40:00+09:00", null), "BUTTON");
    assert.equal(storedSource(null, "LOCATION"), null);
    assert.equal(storedSource("2026-10-29T08:40:00+09:00", "MANUAL"), "MANUAL");
  });

  const appt = (id: string, title: string, at: string) => ({ appointment_id: id, title, appointment_at: at, dest_name: "공학관", importance: "NORMAL" as const, recurrence_rule: null });
  const join = (pid: string, over: Partial<ParticipantJoin> = {}): ParticipantJoin => ({
    participant_id: pid, appointment_id: `ap-${pid}`, user_id: "me", transport_type: "TRANSIT", est_travel_minutes: 30,
    departed_at: null, departed_source: null, arrived_at: null, arrived_source: null, is_late: null, late_minutes: null,
    appointment: appt(`ap-${pid}`, "자료구조", "2026-10-29T10:00:00+09:00"), ...over,
  });
  const base = { review: "2026-10-29", apptRefOf: (pid: string) => (pid === "p1" ? "a1" : null) };

  it("지각은 DB 판정 그대로 — is_late NULL = 지각 아님(사실 없음), false도 없음, true만 LATE 사실 (L2-3)", () => {
    const arrived = { arrived_at: "2026-10-29T10:20:00+09:00", arrived_source: "LOCATION" as const };
    const none = factsOf({ ...base, participants: [join("p1", { ...arrived, is_late: null })], wake: null, earlier: [] });
    assert.deepEqual(none.facts.map((f) => f.kind), ["ARRIVE"]);
    assert.ok(!viewFacts({ today: { facts: none.facts } } as unknown as Context).includes("지각"));
    const no = factsOf({ ...base, participants: [join("p1", { ...arrived, is_late: false })], wake: null, earlier: [] });
    assert.deepEqual(no.facts.map((f) => f.kind), ["ARRIVE"]);
    const late = factsOf({ ...base, participants: [join("p1", { ...arrived, is_late: true, late_minutes: 14 })], wake: null, earlier: [] });
    assert.deepEqual(late.facts.map((f) => [f.id, f.kind, f.minutes, f.appointment_ref, f.text]), [
      ["f1", "ARRIVE", null, "a1", "도착 10:20"],
      ["f2", "LATE", 14, "a1", "자료구조 14분 지각"],
    ]);
  });

  it("자동(폰 사용 기상 · 위치 출발 · 도착)은 confirmed false, 원탭 · 직접은 confirmed true", () => {
    const facts = factsOf({
      ...base,
      participants: [join("p1", { departed_at: "2026-10-29T09:20:00+09:00", departed_source: "LOCATION", arrived_at: "2026-10-29T09:58:00+09:00", arrived_source: "BUTTON" })],
      wake: { confirmed_at: "2026-10-29T08:12:00+09:00", input_source: "USAGE" },
      earlier: [],
    }).facts;
    assert.deepEqual(facts.map((f) => [f.kind, f.time, f.source, f.confirmed]), [
      ["WAKE", "08:12", "AUTO", false],
      ["DEPART", "09:20", "AUTO", false],
      ["ARRIVE", "09:58", "ONE_TAP", true],
    ]);
    const manual = factsOf({ ...base, participants: [], wake: { confirmed_at: "2026-10-29T07:00:00+09:00", input_source: "MANUAL" }, earlier: [] }).facts;
    assert.deepEqual([manual[0]?.source, manual[0]?.confirmed], ["MANUAL", true]);
    const unknown = factsOf({ ...base, participants: [], wake: { confirmed_at: "2026-10-29T07:00:00+09:00", input_source: null }, earlier: [] }).facts;
    assert.equal(unknown[0]?.confirmed, true, "출처를 모르는 기상은 읽지 않음(직접으로 봄)");
  });

  it("출발 출처가 비고 시각만 있으면 옛 앱 원탭 — 확인할 기록에서 빠짐", () => {
    const f = factsOf({ ...base, participants: [join("p1", { departed_at: "2026-10-29T09:20:00+09:00", departed_source: null })], wake: null, earlier: [] }).facts;
    assert.deepEqual([f[0]?.source, f[0]?.confirmed], ["ONE_TAP", true]);
  });

  it("앞 출발: DEPART · 자동 · '잠깐 나갔다 들어옴' · earlier 표시, 시각 순서 자리에 끼고 돌아볼 날 내 약속만", () => {
    const { facts, refs } = factsOf({
      ...base,
      participants: [join("p1", { departed_at: "2026-10-29T08:40:00+09:00", departed_source: "LOCATION" })],
      wake: { confirmed_at: "2026-10-29T08:12:00+09:00", input_source: "USAGE" },
      earlier: [{ participantId: "p1", at: "2026-10-29T07:45:00+09:00" }, { participantId: "pX", at: "2026-10-29T06:00:00+09:00" }],
    });
    assert.deepEqual(facts.map((f) => [f.id, f.kind, f.time, f.text, f.earlier ?? false, f.appointment_ref]), [
      ["f1", "DEPART", "07:45", "잠깐 나갔다 들어옴", true, "a1"],
      ["f2", "WAKE", "08:12", "기상 확인 08:12", false, null],
      ["f3", "DEPART", "08:40", "출발 08:40", false, "a1"],
    ]);
    assert.deepEqual(refs["f1"], { kind: "DEPART", participant_id: "p1", earlier_at: "2026-10-29T07:45:00+09:00" });
    assert.deepEqual(refs["f2"], { kind: "WAKE", record_date: "2026-10-29" });
  });

  it("확인할 기록은 서버 규칙(채우기 없음): 자동 값만, 출발 → 도착 → 앞 출발 3개 상한, 기상은 안 읽음 (헤드 10/30)", () => {
    const ctx = buildContext(seed()).context;
    // 앞 출발(f1) · 기상(f2) · 출발(f3) · 도착(f4): 기상은 빠지고 셋 다 들어감(앞 출발이 도착을 밀어내지 않음)
    assert.deepEqual(pickConfirmFacts(ctx, SERVER_CONFIRM_OPTS), ["f1", "f3", "f4"]);
    // 원탭으로 받은 도착은 처음부터 안 읽음
    const oneTap = seed({ arrivedSource: "BUTTON" });
    assert.deepEqual(buildContext(oneTap).context.today.facts.map((f) => f.confirmed), [false, false, false, true]);
  });
});

// ───────── 일정 · 알람 · 준비물 ─────────

describe("일정 · 알람 · 준비물", () => {
  const row = (alarm_id: string, over: Partial<AlarmRow>): AlarmRow => ({
    alarm_id, participant_id: null, routine_id: null, alarm_type: "WAKE", scheduled_at: "2026-10-30T07:40:00+09:00", intensity: "STRONG", is_enabled: true, time_source: "AUTO", ...over,
  });
  const NOW = "2026-10-29T20:30:00+09:00";

  it("반복: WEEKLY만 '매주', 그 밖 규칙은 NONE · 장소 빈 글은 null", () => {
    assert.equal(repeatOf("FREQ=WEEKLY;BYDAY=MO"), "WEEKLY");
    assert.equal(repeatOf("FREQ=DAILY"), "NONE");
    assert.equal(repeatOf(null), "NONE");
    const j = seed().participants[1] as ParticipantJoin;
    assert.equal(appointmentOf({ ...j, appointment: { ...j.appointment, dest_name: "" } }, "a9").place, null);
    assert.equal(appointmentOf(j, "a2").importance_confirmed, true, "importance_confirmed 칸이 DB에 없어 늘 true");
  });

  it("내일 알람: 내일 참여 행의 기상 · 준비 · 출발 · 도착 + 일정 없는 기상, 루틴 알람 · 남의 참여 행 뺌, 시각순 al#", () => {
    const rows = [
      row("x1", { participant_id: "p9", alarm_type: "DEPARTURE", scheduled_at: "2026-10-30T08:55:00+09:00" }),
      row("x2", { participant_id: "p9", alarm_type: "WAKE" }),
      row("x3", { routine_id: "r1", alarm_type: "ROUTINE", scheduled_at: "2026-10-30T07:00:00+09:00" }),
      row("x4", { participant_id: "pOther", alarm_type: "WAKE", scheduled_at: "2026-10-30T06:00:00+09:00" }),
      row("x5", { alarm_type: "WAKE", scheduled_at: "2026-10-30T06:30:00+09:00", intensity: "SOFT", time_source: "MANUAL", is_enabled: false }), // 일정 없는 기상
      row("x6", { alarm_type: "WAKE", scheduled_at: "2026-10-29T19:00:00+09:00" }), // 지금 이전
      row("x7", { alarm_type: "WAKE", scheduled_at: "2026-10-31T06:30:00+09:00" }), // 내일 24시 뒤
      row("x8", { alarm_type: "DEPARTURE", scheduled_at: "2026-10-30T06:00:00+09:00" }), // 일정 없는 기상이 아님
    ];
    const { alarms, refs } = alarmsOf({ tomorrow: [{ participant_id: "p9", ref: "a2" }], alarms: rows, morning: "2026-10-30", now: NOW });
    assert.deepEqual(alarms.map((a) => [a.ref, a.type, a.time, a.appointment_ref, a.intensity, a.enabled, a.time_source]), [
      ["al1", "WAKE", "06:30", null, "SOFT", false, "MANUAL"],
      ["al2", "WAKE", "07:40", "a2", "STRONG", true, "AUTO"],
      ["al3", "DEPARTURE", "08:55", "a2", "STRONG", true, "AUTO"],
    ]);
    assert.deepEqual(refs, { al1: { alarm_id: "x5" }, al2: { alarm_id: "x2" }, al3: { alarm_id: "x1" } });
  });

  it("준비물 · 할 일: 안 끝낸 것 중 내일 약속에 딸렸거나 마감이 내일인 것만, ITEM = 준비물 · TASK = 할 일", () => {
    const t = (todo_id: string, over: Partial<TodoRow>): TodoRow => ({ todo_id, appointment_id: null, title: todo_id, todo_type: "TASK", due_date: null, is_done: false, ...over });
    const out = itemsOf([
      t("노트북 충전기", { todo_type: "ITEM", appointment_id: "ap-1" }),
      t("머리 감기", { due_date: "2026-10-30" }),
      t("끝낸 일", { due_date: "2026-10-30", is_done: true }),
      t("다음 주 일", { due_date: "2026-11-05" }),
      t("남의 약속 준비물", { todo_type: "ITEM", appointment_id: "ap-9" }),
    ], ["ap-1"], "2026-10-30");
    assert.deepEqual(out, { items: ["노트북 충전기"], todos: [{ title: "머리 감기", due_date: "2026-10-30" }] });
  });

  it("이름: 비거나 'AI'면 '나' · 여는 방식: 확인할 기록이 있으면 요약 먼저, 없고 서버 질문만 있으면 질문 먼저", () => {
    assert.deepEqual([userNameOf(null), userNameOf("  "), userNameOf("AI"), userNameOf("지수")], ["나", "나", "나", "지수"]);
    const q = { id: "q1", kind: "PREP_CHECK" as const, text: "t", target_ref: "a2", options: [] };
    assert.equal(openingOf(["f1"], q), "SUMMARY_FIRST");
    assert.equal(openingOf([], q), "QUESTION_FIRST");
    assert.equal(openingOf([], null), "SUMMARY_FIRST");
  });
});

// ───────── 날짜표 · 자정 대화 ─────────

describe("날짜표 · 자정 대화 (설계 메모 4.1, 헤드 H1)", () => {
  it("datesOf: 돌아볼 날 기준 오늘 · 내일 · 모레 · 이번 주 · 다음 주 (일요일 밤은 끝난 주)", () => {
    const d = datesOf("2026-10-29");
    assert.deepEqual([d.today, d.tomorrow, d.day_after, d.weekday_today], ["2026-10-29", "2026-10-30", "2026-10-31", "THU"]);
    assert.deepEqual([d.this_week.MON, d.this_week.SUN, d.next_week.MON], ["2026-10-26", "2026-11-01", "2026-11-02"]);
    const sun = datesOf("2026-10-11");
    assert.deepEqual([sun.weekday_today, sun.this_week.SUN, sun.tomorrow], ["SUN", "2026-10-11", "2026-10-12"]);
  });

  it("00:30 대화(새벽 4시 전): 돌아볼 날 = 전날 — 그날 기록 · 일정이 '오늘'로, 달력 오늘 일정이 '내일'로, 화면이 에러 없이 나옴", () => {
    const now = "2026-10-30T00:30:00+09:00";
    const days = dayOf(now, "Asia/Seoul");
    assert.deepEqual([days.review, days.morning], ["2026-10-29", "2026-10-30"]);
    const { context } = buildContext({ ...seed(), now, days });
    assert.equal(context.session.record_date, "2026-10-29");
    assert.deepEqual(context.tomorrow.appointments.map((a) => [a.date, a.title]), [["2026-10-30", "캡스톤 발표"]]);
    // 00:30 이후 일정 없는 기상 알람은 '지금 뒤 ~ morning 24시'
    const out = viewContext(context, { confirmFacts: true });
    assert.ok(out.includes("이 대화의 '오늘'은 2026-10-29(목) · '어제'는 2026-10-28(수) · '내일'은 2026-10-30(금)"), out);
    assert.ok(out.includes("### 내일 일정\n[a2] 10-30(금) 10:00 캡스톤 발표"), out);
  });

  it("23:50 대화: 달력 오늘이 돌아볼 날, 새벽 줄 없음", () => {
    const now = "2026-10-29T23:50:00+09:00";
    const days = dayOf(now, "Asia/Seoul");
    const { context } = buildContext({ ...seed(), now, days });
    assert.ok(!viewContext(context).includes("새벽 4시에 바뀌어"));
    assert.equal(context.dates.tomorrow, "2026-10-30");
  });

  it("04:00이 지나면 기상 기록이 없어도 달력 그대로 — 어제 기록은 '오늘'이 아님", () => {
    const now = "2026-10-30T04:00:00+09:00";
    const days = dayOf(now, "Asia/Seoul");
    assert.deepEqual([days.review, days.morning], ["2026-10-30", "2026-10-31"]);
    const { context } = buildContext({ ...seed(), now, days, wake: null });
    // 10/30이 '오늘'이라 캡스톤 발표가 오늘 일정, 내일(10/31) 일정은 없음
    assert.deepEqual(context.today.appointments.map((a) => [a.date, a.title]), [["2026-10-30", "캡스톤 발표"]]);
    assert.deepEqual(context.tomorrow.appointments, []);
    assert.equal(context.dates.today, "2026-10-30");
  });
});

// ───────── 한 바퀴 (설계 메모 8절 녹화 시험의 시드) ─────────

/**
 * 시드: 10/29(목) 기상 08:12 USAGE · 07:45 위치 출발(앞 출발) · 08:40 위치 출발 · 10:00 수업 도착 10:07 LOCATION(is_late false) /
 * 내일 10/30 10:00 캡스톤 발표(HIGH) 알람 기상 07:40 강하게 · 준비 07:50 · 출발 08:55 / 루틴 알람 하나.
 */
function seed(over: { arrivedSource?: InputSource } = {}): Parameters<typeof buildContext>[0] {
  const cls = {
    participant_id: "p1", appointment_id: "ap-1", user_id: "me", transport_type: "TRANSIT" as const, est_travel_minutes: 40,
    departed_at: "2026-10-28T23:40:00.123456+00:00", departed_source: "LOCATION" as const, // 08:40 KST
    arrived_at: "2026-10-29T01:07:00+00:00", arrived_source: over.arrivedSource ?? ("LOCATION" as const), // 10:07 KST
    is_late: false, late_minutes: 0,
    appointment: { appointment_id: "ap-1", title: "데이터구조 수업", appointment_at: "2026-10-29T01:00:00+00:00", dest_name: "공학관", importance: "NORMAL" as const, recurrence_rule: "FREQ=WEEKLY;BYDAY=TH" },
  };
  const cap = {
    participant_id: "p2", appointment_id: "ap-2", user_id: "me", transport_type: "SUBWAY" as const, est_travel_minutes: 50,
    departed_at: null, departed_source: null, arrived_at: null, arrived_source: null, is_late: null, late_minutes: null,
    appointment: { appointment_id: "ap-2", title: "캡스톤 발표", appointment_at: "2026-10-30T10:00:00+09:00", dest_name: "강남역", importance: "HIGH" as const, recurrence_rule: null },
  };
  const wakeAlarm = (id: string, type: AlarmRow["alarm_type"], at: string): AlarmRow => ({
    alarm_id: id, participant_id: "p2", routine_id: null, alarm_type: type, scheduled_at: at, intensity: "STRONG", is_enabled: true, time_source: "AUTO",
  });
  return {
    now: "2026-10-29T20:30:00+09:00",
    days: { review: "2026-10-29", morning: "2026-10-30" },
    nickname: "지수",
    participants: [cap, cls], // 일부러 뒤섞음 — 별칭은 돌아볼 날(수업) 먼저
    alarms: [
      wakeAlarm("al-w", "WAKE", "2026-10-30T07:40:00+09:00"), wakeAlarm("al-p", "PREPARE", "2026-10-30T07:50:00+09:00"), wakeAlarm("al-d", "DEPARTURE", "2026-10-30T08:55:00+09:00"),
      { alarm_id: "al-r", participant_id: null, routine_id: "r1", alarm_type: "ROUTINE", scheduled_at: "2026-10-30T07:00:00+09:00", intensity: "NORMAL", is_enabled: true, time_source: null },
    ],
    wake: { confirmed_at: "2026-10-29T08:12:00+09:00", input_source: "USAGE" },
    earlierRows: [
      { event_at: "2026-10-29T07:45:00+09:00", alarms: { alarm_type: "DEPARTURE", participant_id: "p1", appointment_participants: { departed_at: "2026-10-28T23:40:00.123456+00:00", departed_source: "LOCATION" } } },
      // 지금 출발 기록 줄 — 앱은 같은 시각 값을 두 곳(참여 행 · 기록)에 쓰므로 event_at이 departed_at과 같다
      { event_at: "2026-10-28T23:40:00.123456+00:00", alarms: { alarm_type: "DEPARTURE", participant_id: "p1", appointment_participants: { departed_at: "2026-10-28T23:40:00.123456+00:00", departed_source: "LOCATION" } } },
    ],
    todos: [{ todo_id: "t1", appointment_id: "ap-2", title: "발표 자료 USB", todo_type: "ITEM", due_date: null, is_done: false }],
  };
}

describe("buildContext — 한 바퀴 (설계 메모 8절 시드)", () => {
  it("context.v1: 별칭 · 사실 · 일정 · 알람 · 준비물, 지각 말 없음", () => {
    const { context, refs } = buildContext(seed());
    assert.equal(context.context_version, "context.v1");
    assert.deepEqual(context.user, { alias: "u0", name: "지수" });
    assert.deepEqual(context.today.appointments.map((a) => [a.ref, a.title, a.time, a.repeat]), [["a1", "데이터구조 수업", "10:00", "WEEKLY"]]);
    assert.deepEqual(context.tomorrow.appointments.map((a) => [a.ref, a.title, a.time, a.place, a.importance, a.transport, a.travel_minutes]), [["a2", "캡스톤 발표", "10:00", "강남역", "HIGH", "SUBWAY", 50]]);
    assert.deepEqual(context.today.facts.map((f) => [f.id, f.kind, f.time, f.source, f.confirmed, f.appointment_ref]), [
      ["f1", "DEPART", "07:45", "AUTO", false, "a1"],
      ["f2", "WAKE", "08:12", "AUTO", false, null],
      ["f3", "DEPART", "08:40", "AUTO", false, "a1"],
      ["f4", "ARRIVE", "10:07", "AUTO", false, "a1"],
    ]);
    assert.ok(!context.today.facts.some((f) => f.kind === "LATE" || f.kind === "SLEEP" || f.kind === "SNOOZE"));
    assert.deepEqual(context.tomorrow.alarms.map((a) => [a.ref, a.type, a.time, a.appointment_ref]), [["al1", "WAKE", "07:40", "a2"], ["al2", "PREPARE", "07:50", "a2"], ["al3", "DEPARTURE", "08:55", "a2"]]);
    assert.deepEqual(context.tomorrow.items, ["발표 자료 USB"]);
    assert.deepEqual([context.editable_users, context.events, context.question], [[], [], null]);
    assert.deepEqual(refs.appointments, { a1: { appointment_id: "ap-1", participant_id: "p1" }, a2: { appointment_id: "ap-2", participant_id: "p2" } });
    assert.deepEqual(refs.alarms["al1"], { alarm_id: "al-w" });
    assert.deepEqual(refs.facts["f1"], { kind: "DEPART", participant_id: "p1", earlier_at: "2026-10-29T07:45:00+09:00" });
    assert.deepEqual(refs.facts["f4"], { kind: "ARRIVE", participant_id: "p1" });
  });

  it("T1 화면: 확인할 기록 줄 · 날짜 · 내일 일정 · 알람 (viewContext가 에러 없이 나옴)", () => {
    const { context } = buildContext(seed());
    const out = viewContext(context, { confirmFacts: true });
    assert.ok(out.includes("확인할 기록(서버가 고름): f1 · f3 · f4"), out);
    assert.ok(out.includes("[f1] 출발 07:45 · a1 기준 (자동)"), out);
    assert.ok(out.includes("[a2] 10-30(금) 10:00 캡스톤 발표 · 장소 강남역 · 중요도 매우 중요(HIGH) · 이동 지하철 50분"), out);
    assert.ok(out.includes("[al1] 기상 07:40 · 강하게(STRONG) · a2 기준"), out);
    assert.ok(!out.includes("지각"), "지각 말 없음");
  });

  it("같은 입력은 같은 결과 · 입력을 바꾸지 않음", () => {
    const input = seed();
    const snap = JSON.stringify(input);
    assert.deepEqual(buildContext(input), buildContext(structuredClone(input)));
    assert.equal(JSON.stringify(input), snap);
  });

  it("여는 방식: 확인할 기록 id가 있으면 SUMMARY_FIRST", () => {
    assert.equal(buildContext({ ...seed(), confirmFactIds: ["f1"] }).context.session.opening, "SUMMARY_FIRST");
    const q = { id: "q1", kind: "PREP_CHECK" as const, text: "t", target_ref: "a2", options: [] };
    assert.equal(buildContext({ ...seed(), confirmFactIds: [], question: q }).context.session.opening, "QUESTION_FIRST");
  });
});

describe("이후 일정 · 알람 (고칠 대상 찾기용 ctx.later) · 그룹 약속", () => {
  // 시드 + 모레 10/31 그룹 약속(캡스톤 팀) · 그 알람 · 10/31 일정 없는 기상 / 창(내일 + LATER_DAYS일) 밖 11/8 약속
  function withLater(): Parameters<typeof buildContext>[0] {
    const base = seed();
    const part = (pid: string, aid: string, title: string, at: string, group: { group_id: string; groups: { group_name: string } | null } | null) => ({
      participant_id: pid, appointment_id: aid, user_id: "me", transport_type: "TRANSIT" as const, est_travel_minutes: 30,
      departed_at: null, departed_source: null, arrived_at: null, arrived_source: null, is_late: null, late_minutes: null,
      appointment: { appointment_id: aid, title, appointment_at: at, dest_name: "", importance: "NORMAL" as const, recurrence_rule: null, ...(group ?? { group_id: null }) },
    });
    base.participants.push(
      part("p3", "ap-3", "캡스톤 회의", "2026-10-31T14:00:00+09:00", { group_id: "g1", groups: { group_name: "캡스톤 팀" } }),
      part("p4", "ap-4", "먼 약속", "2026-11-08T10:00:00+09:00", null),
    );
    base.alarms.push(
      { alarm_id: "al-3w", participant_id: "p3", routine_id: null, alarm_type: "WAKE", scheduled_at: "2026-10-31T11:00:00+09:00", intensity: "NORMAL", is_enabled: true, time_source: "AUTO" },
      { alarm_id: "al-solo", participant_id: null, routine_id: null, alarm_type: "WAKE", scheduled_at: "2026-10-31T09:00:00+09:00", intensity: "NORMAL", is_enabled: true, time_source: "MANUAL" },
    );
    return base;
  }

  it("내일 뒤 약속 · 알람은 later로 (내일 블록 · 준비물은 그대로), 별칭은 이어서, 그룹 약속은 그룹 이름, 창 밖은 뺌", () => {
    const { context, refs } = buildContext(withLater());
    assert.deepEqual(context.tomorrow.appointments.map((a) => a.ref), ["a2"]);
    assert.deepEqual(context.tomorrow.alarms.map((a) => a.ref), ["al1", "al2", "al3"]);
    assert.deepEqual(context.later?.appointments.map((a) => [a.ref, a.title, a.date, a.group]), [["a3", "캡스톤 회의", "2026-10-31", "캡스톤 팀"]]);
    assert.deepEqual(context.later?.alarms.map((a) => [a.ref, a.type, a.date, a.time, a.appointment_ref]), [["al4", "WAKE", "2026-10-31", "09:00", null], ["al5", "WAKE", "2026-10-31", "11:00", "a3"]]);
    assert.deepEqual(refs.appointments["a3"], { appointment_id: "ap-3", participant_id: "p3" });
    assert.equal(refs.appointments["a4"], undefined, "11/8은 창 밖");
    assert.equal("group" in (context.tomorrow.appointments[0] ?? {}), false, "개인 일정은 group 칸 없음");
    // 그룹 이름을 못 읽으면(그룹을 나감 등) 빈 이름 — 그룹 약속인 것은 남김
    const hidden = withLater();
    (hidden.participants[2] as { appointment: { groups: unknown } }).appointment.groups = null;
    assert.equal(buildContext(hidden).context.later?.appointments[0]?.group, "");
  });

  it("화면: later가 있으면 '이후 일정·알람' 블록 · 그룹 약속 표시, 없으면 블록 없음(예전 글 그대로)", () => {
    const out = viewContext(buildContext(withLater()).context);
    assert.ok(out.includes("### 이후 일정·알람 (사용자가 고쳐 달라고 할 때만 참고)"), out);
    assert.ok(out.includes("[a3] 10-31(토) 14:00 캡스톤 회의 · 장소 미정 · 중요도 중요(NORMAL) · 이동 대중교통 30분 · 그룹 약속(캡스톤 팀)"), out);
    assert.ok(out.includes("[al5] 기상 10-31(토) 11:00 · 보통(NORMAL) · a3 기준"), out);
    assert.ok(!viewContext(buildContext(seed()).context).includes("이후 일정"));
  });
});
