// turn-core.ts 시험 — 실험실 tests/stub.test.ts(재계산 없는 사례: 대기 c# · 권한 · 지난 시각 · 되묻기 · 정정 · 위기) + tests/e2.test.ts(expandFast · needKinds)를
// 같은 입력 같은 답으로 옮기고(카드로 바뀐 곳은 주석에 "설계 메모 n절"), 새 사례를 더한다:
//   카드 상태 전이 · 말 "응" = 강조만(저장 아님) · 앱이 보낸 요약이 범위 밖이면 거절 · 질문 예산(하루 1 · 주 3 · 같은 키 24h) · 앞 출발 · 자정 대화.
// 알람 재계산 시험(시각 연쇄 · 겹침 · 준비 가산)은 서버가 계산하지 않으므로(앱이 L1 함수) 옮기지 않았다 — 설계 메모 7절.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AlarmPlan, Appointment, Card, CardAction, Context, Fact, FastExtract, ServerEvent, TaskResults } from "./types.ts";
import { datesFor } from "./testing.ts";
import {
  prepAsked,
  appointmentSummary, applyCardAction as applyCardActionRaw, applyFast, applyTaskResults as applyTaskResultsRaw, checkBasis, checkDigest, dateKo, dayOf, dayStartIso, eventAt, expandFast, initTurnState, isoToLocal, itemKey, lifeDate,
  keywordImportance, nearTitle, needKinds, normTitle, pickServerQuestion, questionSubjectKey, titleMatch,
} from "./turn-core.ts";
import type { CardOutcome, QuestionHistory, TaskOutcome, TurnState } from "./turn-core.ts";
import { eventsForView } from "./guards.ts";
import { viewEvents } from "./view.ts";

// 순수 함수는 입력 모양이 이상하면 던지지 않고 { ok: false, reason }을 돌려준다 — 정상 사례에서는 ok를 확인하고 꺼내 쓴다
function applyTaskResults(...args: Parameters<typeof applyTaskResultsRaw>): TaskOutcome {
  const r = applyTaskResultsRaw(...args);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  return r as TaskOutcome;
}
function applyCardAction(...args: Parameters<typeof applyCardActionRaw>): CardOutcome {
  const r = applyCardActionRaw(...args);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  return r as CardOutcome;
}

// ───────── 고정 데이터 ─────────

const NOW = "2026-10-08T22:30:00+09:00"; // 목요일 밤, 내일 = 10/9(금)

type XAppt = FastExtract["appointments"][number];
type XAlarm = FastExtract["alarm_changes"][number];

function appt(over: Partial<Appointment> = {}): Appointment {
  return {
    ref: "a1", title: "알고리즘 수업", date: "2026-10-09", time: "10:00", place: "공학관", importance: "NORMAL",
    importance_confirmed: true, transport: "TRANSIT", travel_minutes: null, repeat: "WEEKLY", ...over,
  };
}

const al = (ref: string, type: AlarmPlan["type"], time: string, intensity: AlarmPlan["intensity"], over: Partial<AlarmPlan> = {}): AlarmPlan => ({
  ref, owner: "u0", type, date: "2026-10-09", time, intensity, appointment_ref: "a1", enabled: true, ...over,
});

const FACTS: Fact[] = [
  { id: "f1", kind: "WAKE", time: "08:12", minutes: null, appointment_ref: null, source: "AUTO", confirmed: false, text: "기상 확인 08:12" },
  { id: "f2", kind: "SNOOZE", time: null, minutes: 2, appointment_ref: null, source: "AUTO", confirmed: false, text: "미루기 2회" },
  { id: "f3", kind: "DEPART", time: "09:05", minutes: null, appointment_ref: null, source: "AUTO", confirmed: false, text: "출발 09:05" },
  { id: "f4", kind: "ARRIVE", time: "10:07", minutes: null, appointment_ref: "a0", source: "AUTO", confirmed: false, text: "도착 10:07" },
  { id: "f5", kind: "DEPART", time: "07:45", minutes: null, appointment_ref: null, source: "AUTO", confirmed: false, text: "잠깐 나갔다 들어옴", earlier: true },
];

function ctx(over: { now?: string; review?: string; tomorrow?: Appointment[]; alarms?: AlarmPlan[]; type?: Context["session"]["type"] } = {}): Context {
  const now = over.now ?? NOW;
  const review = over.review ?? "2026-10-08";
  const tomorrowAppts = over.tomorrow ?? [appt()];
  return {
    context_version: "context.v1",
    session: { type: over.type ?? "BEFORE_SLEEP", now, timezone: "Asia/Seoul", record_date: review, opening: "SUMMARY_FIRST" },
    dates: datesFor(review),
    user: { alias: "u0", name: "지수" },
    today: { facts: FACTS, appointments: [], alarms: [], items: [], todos: [] },
    tomorrow: {
      appointments: tomorrowAppts,
      alarms: over.alarms ?? (tomorrowAppts.length === 0 ? [] : [al("al1", "WAKE", "08:00", "NORMAL"), al("al2", "PREPARE", "08:10", "NORMAL"), al("al3", "DEPARTURE", "09:00", "NORMAL"), al("al4", "ARRIVE", "10:00", "SOFT")]),
      items: [],
      todos: [],
    },
    question: null,
    // v0에서는 늘 빈 목록이지만(설계 메모 4절), 거절 글에 이름이 들어가는 경로를 시험하려고 둠
    editable_users: [
      { alias: "u1", name: "민지", relation: "FRIEND", can_add: true, can_earlier: false },
      { alias: "u2", name: "준호", relation: "GROUP", can_add: false, can_earlier: true },
    ],
    events: [],
  };
}

function fast(over: Partial<FastExtract> = {}): FastExtract {
  return { appointments: [], alarm_changes: [], fact_feedback: [], prep_adjustment: null, safety_flag: false, ...over };
}

function study(over: Partial<XAppt> = {}): XAppt {
  return {
    ref: null, title: "스터디", date: "2026-10-09", time: "14:00", place: "학교 도서관", importance: null, transport: null,
    repeat: null, save: "UNCONFIRMED", unclear: null, ...over,
  };
}

function alarm(over: Partial<XAlarm> = {}): XAlarm {
  return {
    target: "u0", appointment_ref: null, type: "WAKE", date: "2026-10-09", time: null, intensity: null, enabled: null,
    save: "CONFIRMED", ...over,
  };
}

const iso = (date: string, time: string): string => `${date}T${time}:00+09:00`;

/** 앱이 계산해 돌려주는 카드 READY (기상 wake · 준비 +10 · 출발 depart) */
function ready(id: string, wake: string, over: { depart?: string; level?: number | null; with_wake?: boolean; date?: string } = {}): TaskResults["cards"][number] {
  const date = over.date ?? "2026-10-09";
  const [h, m] = wake.split(":").map(Number) as [number, number];
  const prep = `${String(Math.floor((h * 60 + m + 10) / 60)).padStart(2, "0")}:${String((m + 10) % 60).padStart(2, "0")}`;
  return {
    id, status: "READY",
    estimate: {
      alarms: [
        { kind: "WAKE", at: iso(date, wake), enabled: true }, { kind: "PREPARE", at: iso(date, prep), enabled: true },
        { kind: "DEPARTURE", at: iso(date, over.depart ?? "08:55"), enabled: true },
      ],
      level: over.level === undefined ? 2 : over.level, with_wake: over.with_wake ?? true,
    },
  };
}

/** 턴을 차례로 돌림 (앱 일 없음 — 카드는 NEEDS_ESTIMATE로 남음) */
function run(c: Context, fasts: FastExtract[], start?: TurnState): { state: TurnState; events: ServerEvent[] } {
  let state = start ?? initTurnState(c);
  const events: ServerEvent[] = [];
  fasts.forEach((f, i) => {
    const r = applyFast(state, f, c, i + 1);
    state = r.state;
    events.push(r.event);
  });
  return { state, events };
}

const isEmpty = (e: ServerEvent): boolean =>
  e.applied.length + e.pending.length + e.rejected.length + e.clarify.length + e.alarms.length === 0 && (e.conflicts ?? []).length === 0 && e.crisis !== true;

const times = (alarms: AlarmPlan[]): string[] => alarms.map((a) => `${a.ref}:${a.type}:${a.time}`);
const card = (s: TurnState, id: string): Card => s.cards.find((c) => c.id === id) as Card;

// ───────── 초기화 · 도우미 ─────────

describe("초기화 · 도우미", () => {
  it("initTurnState: 컨텍스트 복사 · 번호 이어 쓰기", () => {
    const c = ctx();
    const s = initTurnState(c);
    assert.equal(s.appointments.length, 1);
    assert.equal(s.alarms.length, 4);
    assert.equal(s.apptSeq, 1);
    assert.equal(s.alarmSeq, 4);
    assert.equal(s.pendingSeq, 0);
    assert.deepEqual([s.cards, s.fixes, s.awaiting], [[], [], null]);
    s.appointments[0]!.time = "11:00";
    assert.equal(c.tomorrow.appointments[0]?.time, "10:00"); // 컨텍스트는 그대로
  });

  it("제목 비교 · 요약 문장", () => {
    assert.equal(normTitle(" 캡스톤 팀플! "), "캡스톤팀플");
    assert.ok(titleMatch("스터디", "도서관 스터디"));
    assert.ok(!titleMatch("스터디", "수업"));
    assert.ok(!titleMatch("", ""));
    assert.equal(appointmentSummary({ date: "2026-10-09", time: "14:00", title: "스터디", place: "학교 도서관" }), "10/9(금) 14:00 스터디 · 학교 도서관");
    assert.equal(appointmentSummary({ date: "2026-10-09", time: "14:00", title: "스터디", place: null }), "10/9(금) 14:00 스터디");
    assert.equal(dateKo("2026-10-09"), "10/9(금)");
  });

  it("한글 제목 NFC · NFD(맥 · 받아쓰기 조합형)도 같은 제목", () => {
    const nfd = "노트북 충전기".normalize("NFD");
    assert.notEqual(nfd, "노트북 충전기");
    assert.equal(normTitle(nfd), normTitle("노트북 충전기"));
    assert.ok(titleMatch("스터디".normalize("NFD"), "도서관 스터디"));
  });

  it("itemKey: '우산 챙기기'와 '우산'은 같은 키 (059 · 060) — 대화 끝 추출(PR 5)이 씀", () => {
    assert.equal(itemKey("우산 챙기기"), itemKey("우산"));
    assert.equal(itemKey("우산을 가져가기"), itemKey("우산"));
    assert.equal(itemKey("노트북 충전기 챙겨가기"), itemKey("노트북 충전기"));
    assert.equal(itemKey("챙기기"), "챙기기"); // 다 떼면 빈 키 — 그대로 둠
  });

  it("keywordImportance: 서버 키워드 사전 (발표 → HIGH · 수업 → NORMAL · 그 밖 null)", () => {
    assert.equal(keywordImportance("캡스톤 발표"), "HIGH");
    assert.equal(keywordImportance("자료구조 수업"), "NORMAL");
    assert.equal(keywordImportance("스터디"), null);
  });
});

// ───────── 대화 기준일 (설계 메모 4.1, 헤드 H1) ─────────

describe("dayOf — 대화 기준일 (KST 새벽 4시 경계)", () => {
  const days = (now: string) => {
    const d = dayOf(now, "Asia/Seoul");
    return [d.review, d.morning];
  };

  it("23:59 → 00:00 → 03:59는 같은 기준일, 04:00에 바뀜", () => {
    assert.deepEqual(days("2026-11-11T23:59:00+09:00"), ["2026-11-11", "2026-11-12"]);
    assert.deepEqual(days("2026-11-12T00:00:00+09:00"), ["2026-11-11", "2026-11-12"]);
    assert.deepEqual(days("2026-11-12T01:00:00+09:00"), ["2026-11-11", "2026-11-12"]);
    assert.deepEqual(days("2026-11-12T03:59:00+09:00"), ["2026-11-11", "2026-11-12"]);
    assert.deepEqual(days("2026-11-12T04:00:00+09:00"), ["2026-11-12", "2026-11-13"]);
    assert.deepEqual(days("2026-11-12T11:00:00+09:00"), ["2026-11-12", "2026-11-13"]);
  });

  it("기상 여부를 받지 않음 — 아침에 안 일어났어도 04:00 뒤면 달력 오늘", () => {
    assert.equal(dayOf.length, 2);
    assert.deepEqual(days("2026-10-09T05:10:00+09:00"), ["2026-10-09", "2026-10-10"]);
  });

  it("공통 함수: lifeDate · dayStartIso", () => {
    assert.equal(lifeDate("2026-11-12T03:59:59+09:00"), "2026-11-11");
    assert.equal(lifeDate("2026-11-11T19:00:00Z"), "2026-11-12"); // = 11/12 04:00 KST
    assert.equal(dayStartIso("2026-11-11"), "2026-11-11T04:00:00+09:00");
  });

  it("달 · 해 · 일요일 넘김, 다른 시간대는 서울로 보고 경고", () => {
    assert.deepEqual(days("2026-12-01T03:30:00+09:00"), ["2026-11-30", "2026-12-01"]); // 월말
    assert.deepEqual(days("2027-01-01T00:20:00+09:00"), ["2026-12-31", "2027-01-01"]); // 연말
    assert.deepEqual(days("2027-01-01T04:00:00+09:00"), ["2027-01-01", "2027-01-02"]);
    assert.deepEqual(days("2026-10-12T00:30:00+09:00"), ["2026-10-11", "2026-10-12"]); // 일 → 월 새벽
    assert.deepEqual(days("2026-10-08T15:30:00Z"), ["2026-10-08", "2026-10-09"]); // = 10/9 00:30 KST
    assert.equal(dayOf(NOW, "America/Los_Angeles").tzSupported, false);
    assert.equal(dayOf(NOW, "Asia/Seoul").tzSupported, true);
  });
});

// ───────── 약속 카드: 만들기 → 계산 → 강조 → 저장 ─────────

describe("새 약속 카드 (APPT_NEW)", () => {
  it("말 → 카드(NEEDS_ESTIMATE) → 같은 추출 반복은 다시 안 냄 → 앱 계산 READY → '확인 필요' 줄", () => {
    const c = ctx({ tomorrow: [] });
    const cap = study({ title: "캡스톤 발표", time: "10:00", place: "강남역" });
    const r1 = applyFast(initTurnState(c), fast({ appointments: [cap] }), c, 1);
    assert.equal(r1.tasks, true);
    assert.equal(r1.deferred, false);
    assert.deepEqual(r1.cards.map((x) => [x.id, x.kind, x.status, x.first_of_day, x.highlight]), [["c1", "APPT_NEW", "NEEDS_ESTIMATE", true, false]]);
    assert.deepEqual(r1.cards[0]!.draft, {
      title: "캡스톤 발표", date: "2026-10-09", time: "10:00", place: "강남역", importance: "HIGH", transport: null, repeat: [], items: [],
      alarms: { WAKE: true, PREPARE: true, DEPARTURE: true },
    });
    assert.equal(r1.cards[0]!.summary, "10/9(금) 10:00 캡스톤 발표 · 강남역");
    assert.deepEqual(r1.state.awaiting, { after_turn: 1, cards: ["c1"], fixes: [] });
    // 앱 일이 끝나기 전 처리 결과는 비어 있음 (저장됨 · 확인 필요 없음)
    assert.ok(isEmpty(r1.event));
    // 같은 전체 상태를 다시 받으면 아무것도 안 냄
    const again = applyFast(r1.state, fast({ appointments: [cap] }), c, 2);
    assert.ok(isEmpty(again.event));
    assert.equal(again.tasks, true); // 아직 계산 결과가 안 와서 앱 일이 남아 있음
    // 앱이 계산해 돌려줌
    const t = applyTaskResults(r1.state, { cards: [ready("c1", "07:40")], fixes: [] }, c, 1);
    assert.equal(t.done, true);
    assert.deepEqual(t.event.pending, [{
      id: "c1", kind: "APPOINTMENT",
      summary: "10/9(금) 10:00 캡스톤 발표 · 강남역 · 중요도 매우 중요 · 알람 기상 07:40 강하게 · 카드의 [저장]으로 저장",
    }]);
    assert.equal(card(t.state, "c1").status, "READY");
    assert.deepEqual(t.state.events.map((e) => e.after_turn), [1]);
    // 처리 결과 글 (T1 화면)
    c.events = eventsForView(t.state.events, t.state);
    assert.ok(viewEvents(c).includes("- 확인 필요 [c1] 일정: 10/9(금) 10:00 캡스톤 발표 · 강남역 · 중요도 매우 중요 · 알람 기상 07:40 강하게 · 카드의 [저장]으로 저장"));
  });

  it("말 '응'(CONFIRMED)은 카드 강조만 — 저장하지 않고, 같은 c# '확인 필요' 줄을 이번 말 뒤에 다시 냄", () => {
    const c = ctx({ tomorrow: [] });
    const cap = study({ title: "캡스톤 발표", time: "10:00", place: "강남역" });
    let s = applyFast(initTurnState(c), fast({ appointments: [cap] }), c, 1).state;
    s = applyTaskResults(s, { cards: [ready("c1", "07:40")], fixes: [] }, c, 1).state;
    const r = applyFast(s, fast({ appointments: [{ ...cap, save: "CONFIRMED" }] }), c, 2);
    assert.deepEqual(r.cards.map((x) => [x.id, x.status, x.highlight]), [["c1", "READY", true]]);
    assert.equal(r.tasks, false, "재료가 안 바뀌었으니 다시 계산하지 않음");
    assert.deepEqual(r.event.applied, []);
    assert.deepEqual(r.event.pending.map((p) => p.id), ["c1"]);
    assert.ok(r.event.pending[0]!.summary.endsWith("카드의 [저장]으로 저장"));
    // 저장되지 않음: 약속 · 알람 그대로, 카드는 열려 있음
    assert.equal(r.state.appointments.length, 0);
    assert.equal(r.state.alarms.length, 0);
    assert.deepEqual(Object.keys(r.state.pending), ["c1"]);
    assert.deepEqual(r.state.applied, []);
    // T1 화면: 첫 번째 줄은 '지워진' 대기(eventsForView), 마지막 말 뒤에만 남음
    c.events = eventsForView(r.state.events, r.state);
    const shown = viewEvents(c);
    assert.equal((shown.match(/확인 필요 \[c1\]/g) ?? []).length, 1);
    assert.ok(shown.includes("사용자 말 2 뒤:\n- 확인 필요 [c1]"));
  });

  it("카드 상태 전이: NEEDS_ESTIMATE → READY → SAVED (저장은 카드 [저장]으로만), 새 알람은 기상만 처리 결과에", () => {
    const c = ctx({ tomorrow: [] });
    const cap = study({ title: "캡스톤 발표", time: "10:00", place: "강남역" });
    let s = applyFast(initTurnState(c), fast({ appointments: [cap] }), c, 1).state;
    assert.equal(card(s, "c1").status, "NEEDS_ESTIMATE");
    s = applyTaskResults(s, { cards: [ready("c1", "07:40")], fixes: [] }, c, 1).state;
    assert.equal(card(s, "c1").status, "READY");
    assert.deepEqual(card(s, "c1").digest?.alarms.map((a) => a.kind), ["WAKE", "PREPARE", "DEPARTURE"]);
    const action: CardAction = {
      id: "c1", action: "SAVED", appointment_id: "uuid-1",
      alarms: [
        { kind: "WAKE", at: iso("2026-10-09", "07:40"), enabled: true, level: 2 },
        { kind: "PREPARE", at: iso("2026-10-09", "07:50"), enabled: true, level: 2 },
        { kind: "DEPARTURE", at: iso("2026-10-09", "08:55"), enabled: true, level: 2 },
      ],
    };
    const r = applyCardAction(s, action, c, 2);
    assert.deepEqual([r.status, r.needsReply, r.invalid], ["OK", true, null]);
    assert.equal(r.card?.status, "SAVED");
    assert.equal(r.card?.appointment_id, "uuid-1");
    assert.deepEqual(r.event.applied, ["일정 저장: 10/9(금) 10:00 캡스톤 발표 · 강남역", "그 밖의 알람(준비 · 출발)도 같이 맞춤"]);
    assert.deepEqual(r.event.alarms.map((a) => [a.ref, a.type, a.time, a.intensity, a.change]), [["al1", "WAKE", "07:40", "STRONG", "NEW"]]);
    assert.deepEqual(r.state.pending, {});
    assert.equal(r.state.appointments.find((a) => a.ref === "a1")?.title, "캡스톤 발표");
    assert.equal(r.state.bound["a1"], "uuid-1");
    assert.equal(r.state.alarms.length, 3); // 기상 · 준비 · 출발 모두 상태에는 들어감
    assert.equal(r.state.events.length, 2); // 말 1 뒤(계산) · 카드 버튼 뒤(저장) — 둘 다 after_turn이 달라 따로
    // 저장 뒤 같은 카드를 또 저장해도 아무 일 없음
    assert.equal(applyCardAction(r.state, action, c, 2).status, "NOOP");
    assert.equal(applyCardAction(r.state, { ...action, id: "c9" }, c, 2).status, "NOT_FOUND");
    // 처리 결과 글: 저장됨 + 새 알람
    const cc = ctx({ tomorrow: [] });
    cc.events = eventsForView(r.state.events, r.state);
    const out = viewEvents(cc);
    assert.ok(out.includes("- 저장됨: 일정 저장: 10/9(금) 10:00 캡스톤 발표 · 강남역"), out);
    assert.ok(out.includes("- 새 알람: [al1] 기상 10-09(금) 07:40 · 강하게(STRONG) · a1 기준"), out);
    assert.ok(!out.includes("확인 필요 [c1]"), "저장한 카드의 확인 필요 줄은 안 보임");
  });

  it("카드 [저장 안 함](REJECTED): 상태만 바꾸고 T1은 안 부름, 말로 DECLINED도 REJECTED", () => {
    const c = ctx({ tomorrow: [] });
    const cap = study({ title: "캡스톤 발표", time: "10:00", place: "강남역" });
    let s = applyFast(initTurnState(c), fast({ appointments: [cap] }), c, 1).state;
    s = applyTaskResults(s, { cards: [ready("c1", "07:40")], fixes: [] }, c, 1).state;
    const btn = applyCardAction(s, { id: "c1", action: "REJECTED" }, c, 2);
    assert.deepEqual([btn.status, btn.needsReply, btn.card?.status], ["OK", false, "REJECTED"]);
    assert.deepEqual(btn.state.pending, {});
    assert.ok(isEmpty(btn.event));
    // 말로 "아니 저장하지 마" (T2F save DECLINED)
    const said = applyFast(s, fast({ appointments: [{ ...cap, save: "DECLINED" }] }), c, 2);
    assert.deepEqual(said.cards.map((x) => [x.id, x.status]), [["c1", "REJECTED"]]);
    assert.deepEqual(said.state.pending, {});
    assert.ok(isEmpty(said.event));
    assert.equal(said.state.appointments.length, 0);
    // 닫힌 카드는 더 못 바꿈
    assert.equal(applyCardAction(btn.state, { id: "c1", action: "SAVED", alarms: [] }, c, 3).status, "NOOP");
  });

  it("거절(DECLINED)하면 열린 카드만 거두고 처리 결과는 비어 있음", () => {
    const { state, events } = run(ctx(), [fast({ appointments: [study()] }), fast({ appointments: [study({ save: "DECLINED" })] })]);
    assert.deepEqual(state.pending, {});
    assert.equal(card(state, "c1").status, "REJECTED");
    assert.ok(isEmpty(events[1] as ServerEvent));
    assert.equal(state.appointments.length, 1);
  });

  it("키워드 사전이 중요도를 채움 · 그날 첫 일정이 아니면 알람은 '출발 알림'만 (D36)", () => {
    const c = ctx(); // 내일 10:00 수업이 이미 있음
    const r = applyFast(initTurnState(c), fast({ appointments: [study({ title: "캡스톤 발표", time: "15:00", place: "공학관", save: "CONFIRMED" })] }), c, 1);
    assert.equal(r.cards[0]?.draft?.importance, "HIGH");
    assert.equal(r.cards[0]?.first_of_day, false);
    assert.equal(r.cards[0]?.highlight, true, "처음부터 CONFIRMED여도 저장이 아니라 강조");
    const t = applyTaskResults(r.state, { cards: [ready("c1", "08:00", { depart: "14:05", with_wake: false })], fixes: [] }, c, 1);
    assert.equal(t.event.pending[0]?.summary, "10/9(금) 15:00 캡스톤 발표 · 공학관 · 중요도 매우 중요 · 알람: 출발 알림 · 카드의 [저장]으로 저장");
  });

  it("더 이른 일정이면 그날 첫 일정(first_of_day) — 기존 수업보다 이르면 true, 같은 시각이면 false", () => {
    const c = ctx();
    const early = applyFast(initTurnState(c), fast({ appointments: [study({ title: "토익 시험", time: "08:00" })] }), c, 1);
    assert.equal(early.cards[0]?.first_of_day, true);
    const tie = applyFast(initTurnState(c), fast({ appointments: [study({ title: "스터디", time: "10:00" })] }), c, 1);
    assert.equal(tie.cards[0]?.first_of_day, false);
  });

  it("모호: 날짜 · 시각이 비면 되묻기만(문구는 서버가 빈 칸으로 만듦), 같은 상태 반복은 다시 안 냄", () => {
    const { state, events } = run(ctx(), [
      fast({ appointments: [study({ time: null })] }),
      fast({ appointments: [study({ time: null })] }),
      fast({ appointments: [study({ time: null, unclear: "'점심 먹고'의 정확한 시각" })] }),
      fast({ appointments: [study({ time: "13:00" })] }),
    ]);
    assert.deepEqual(events[0]?.clarify, ["'스터디'의 정확한 시각"]);
    assert.deepEqual(events[0]?.pending, []);
    assert.ok(isEmpty(events[1] as ServerEvent));
    // T2 unclear 원문은 넘기지 않음 — 빈 칸(시각)으로 서버 문구 (실패 분석 STUB raw_unclear_passthrough)
    assert.deepEqual(events[2]?.clarify, ["'스터디'의 정확한 시각"]);
    assert.deepEqual(Object.keys(state.pending), ["c1"]);
    assert.equal(card(state, "c1").draft?.time, "13:00");
    const noDate = run(ctx(), [fast({ appointments: [study({ date: null, time: null })] })]);
    assert.deepEqual(noDate.events[0]?.clarify, ["'스터디'의 정확한 날짜·시각"]);
  });

  it("PAST_TIME: 지금보다 이른 약속은 거절 (카드를 만들지 않음)", () => {
    const { state, events } = run(ctx(), [fast({ appointments: [study({ date: "2026-10-08", time: "21:00", save: "CONFIRMED" })] })]);
    assert.deepEqual(events[0]?.rejected, [{ target: "10/8(목) 21:00 스터디 · 학교 도서관", reason: "PAST_TIME" }]);
    assert.deepEqual(events[0]?.applied, []);
    assert.deepEqual(state.cards, []);
    assert.equal(state.appointments.length, 1);
  });

  it("PAST_TIME: 자정 뒤 00:30 대화 — 대화 기준일은 전날이지만 지난 시각은 달력 기준 (설계 메모 4.1)", () => {
    const c = ctx({ now: "2026-10-09T00:30:00+09:00" });
    assert.equal(c.session.record_date, "2026-10-08");
    assert.equal(c.dates.tomorrow, "2026-10-09");
    const { events } = run(c, [fast({ appointments: [study({ time: "00:10" }), study({ title: "운동", time: "14:00", place: null })] })]);
    assert.deepEqual(events[0]?.rejected.map((r) => r.reason), ["PAST_TIME"]);
    // 카드는 계산을 기다리는 중이라 확인 필요 줄은 아직 없음 — 앱 결과가 오면 생김
    const c2 = ctx({ now: "2026-10-09T00:30:00+09:00" });
    const r = applyFast(initTurnState(c2), fast({ appointments: [study({ time: "00:10" }), study({ title: "운동", time: "14:00", place: null })] }), c2, 1);
    assert.deepEqual(r.cards.map((x) => x.summary), ["10/9(금) 14:00 운동"]);
  });

  it("23:50 대화: 내일(10/9) 00:10 약속은 지나지 않음, 오늘(10/8) 23:40은 지남", () => {
    const c = ctx({ now: "2026-10-08T23:50:00+09:00" });
    const ok = applyFast(initTurnState(c), fast({ appointments: [study({ time: "00:10" })] }), c, 1);
    assert.deepEqual([ok.event.rejected, ok.cards.length], [[], 1]);
    const late = applyFast(initTurnState(c), fast({ appointments: [study({ date: "2026-10-08", time: "23:40" })] }), c, 1);
    assert.deepEqual(late.event.rejected.map((r) => r.reason), ["PAST_TIME"]);
  });

  it("대화 중 시각 변경: 같은 c#을 이어 쓰고 요약만 바뀌어 다시 계산, 되돌리면 다시 처음 값", () => {
    const c = ctx();
    const a = study();
    const b = study({ time: "15:00" });
    const { state } = run(c, [fast({ appointments: [a] }), fast({ appointments: [b] }), fast({ appointments: [b] }), fast({ appointments: [a] })]);
    assert.deepEqual(Object.keys(state.pending), ["c1"]);
    assert.equal(state.cards.length, 1);
    assert.equal(card(state, "c1").draft?.time, "14:00", "A → B → A로 되돌리면 상태도 A");
    assert.equal(card(state, "c1").status, "NEEDS_ESTIMATE");
    const mid = run(c, [fast({ appointments: [a] }), fast({ appointments: [b] })]);
    assert.equal(card(mid.state, "c1").summary, "10/9(금) 15:00 스터디 · 학교 도서관");
  });

  it("READY였던 카드의 재료가 바뀌면 다시 NEEDS_ESTIMATE · 앱 일 다시 (계산 결과를 버림)", () => {
    const c = ctx({ tomorrow: [] });
    const a = study({ title: "캡스톤 발표", time: "10:00", place: "강남역" });
    let s = applyFast(initTurnState(c), fast({ appointments: [a] }), c, 1).state;
    s = applyTaskResults(s, { cards: [ready("c1", "07:40")], fixes: [] }, c, 1).state;
    const r = applyFast(s, fast({ appointments: [{ ...a, time: "11:00" }] }), c, 2);
    assert.equal(r.tasks, true);
    assert.deepEqual(r.cards.map((x) => [x.id, x.status, x.digest]), [["c1", "NEEDS_ESTIMATE", null]]);
    assert.deepEqual(r.event.pending, []);
  });

  it("대화 중 날짜를 옮긴 새 약속(금 → 토)도 같은 c1, 되돌리면 다시 금요일", () => {
    const sat = study({ date: "2026-10-10" });
    const { state } = run(ctx(), [fast({ appointments: [study()] }), fast({ appointments: [sat] }), fast({ appointments: [study()] })]);
    assert.equal(card(state, "c1").draft?.date, "2026-10-09");
    assert.equal(state.cards.length, 1);
  });

  it("c# 번호는 턴이 지나도 그대로, 새 항목은 다음 번호", () => {
    const { state } = run(ctx(), [
      fast({ appointments: [study()] }),
      fast({ appointments: [study({ save: "CONFIRMED" })] }),
      fast({ appointments: [study(), study({ title: "동아리 회식", time: "19:00", place: "신촌" })] }),
    ]);
    assert.deepEqual(state.cards.map((x) => x.id), ["c1", "c2"]);
    assert.equal(card(state, "c2").summary, "10/9(금) 19:00 동아리 회식 · 신촌");
    assert.equal(state.pending["c1"]?.summary, "10/9(금) 14:00 스터디 · 학교 도서관");
  });

  it("ref가 없는 약속이 이미 있는 약속과 같으면 새 카드를 만들지 않음 · 모르는 ref는 NOT_FOUND", () => {
    const nf = run(ctx(), [fast({ appointments: [study({ ref: "a9", save: "CONFIRMED" })] })]);
    assert.deepEqual(nf.events[0]?.rejected, [{ target: "스터디 (a9)", reason: "NOT_FOUND" }]);
    const same = run(ctx(), [fast({ appointments: [study({ title: "알고리즘 수업", time: "10:00", place: "공학관", save: "CONFIRMED" })] })]);
    assert.ok(isEmpty(same.events[0] as ServerEvent));
    assert.deepEqual(same.state.cards, []);
  });

  it("컨텍스트에 이미 있는 오늘(지난) 약속을 ref 없이 다시 말해도 PAST_TIME으로 거절하지 않음", () => {
    const c = ctx();
    c.today.appointments = [appt({ ref: "a5", title: "데이터구조", date: "2026-10-08", time: "10:00", place: "공학관 302호" })];
    const { events } = run(c, [fast({ appointments: [study({ title: "데이터구조", date: "2026-10-08", time: "10:00", place: "공학관 302호", save: "CONFIRMED" })] })]);
    assert.ok(isEmpty(events[0] as ServerEvent));
  });

  it("빈 제목(공백 · 문장부호만) 약속은 되묻는다", () => {
    const { events } = run(ctx(), [fast({ appointments: [study({ title: " ! ", time: "13:00" })] })]);
    assert.deepEqual(events[0]?.clarify, ["10/9(금) 13:00 일정의 이름"]);
  });
});

// ───────── 있는 약속 변경 카드 (APPT_OPEN) ─────────

describe("약속 변경 카드 (APPT_OPEN) — 저장 없이 [일정 열기]만", () => {
  it("저장한 뒤 시각을 바꾸면 '변경' 카드 — 확인 필요 줄에 [일정 열기]", () => {
    const c = ctx({ tomorrow: [] });
    const cap = study({ title: "캡스톤 발표", time: "10:00", place: "강남역" });
    let s = applyFast(initTurnState(c), fast({ appointments: [cap] }), c, 1).state;
    s = applyTaskResults(s, { cards: [ready("c1", "07:40")], fixes: [] }, c, 1).state;
    s = applyCardAction(s, { id: "c1", action: "SAVED", appointment_id: "u1", alarms: [{ kind: "WAKE", at: iso("2026-10-09", "07:40"), enabled: true, level: 2 }] }, c, 2).state;
    const r = applyFast(s, fast({ appointments: [{ ...cap, time: "11:00" }] }), c, 3);
    assert.equal(r.tasks, false, "저장 없는 카드는 앱 계산이 필요 없음");
    assert.deepEqual(r.event.pending, [{ id: "c2", kind: "APPOINTMENT", summary: "변경: 10/9(금) 11:00 캡스톤 발표 · 강남역 · 카드의 [일정 열기]로" }]);
    assert.deepEqual(r.cards.map((x) => [x.id, x.kind, x.status]), [["c2", "APPT_OPEN", "READY"]]);
    assert.deepEqual(r.cards[0]?.edit, { appointment_id: "a1", changes: { time: "11:00" } });
    assert.equal(r.state.appointments.find((a) => a.ref === "a1")?.time, "10:00", "서버가 약속을 고치지 않음 (D41)");
    // 저장 버튼은 의미 없음
    assert.equal(applyCardAction(r.state, { id: "c2", action: "SAVED" }, c, 3).status, "NOOP");
  });

  it("기존 약속(ref)의 시각 · 날짜 변경도 카드 — 알람 재계산은 안 함", () => {
    const r = applyFast(initTurnState(ctx()), fast({ appointments: [study({ ref: "a1", title: "알고리즘 수업", time: "09:00", place: null, save: "CONFIRMED" })] }), ctx(), 1);
    assert.deepEqual(r.event.pending.map((p) => p.summary), ["변경: 10/9(금) 09:00 알고리즘 수업 · 공학관 · 카드의 [일정 열기]로"]);
    assert.deepEqual(r.event.alarms, []);
    assert.equal(r.state.alarms.length, 4);
    const moved = applyFast(initTurnState(ctx()), fast({ appointments: [study({ ref: "a1", title: "알고리즘 수업", date: "2026-10-10", time: null, place: null, save: "CONFIRMED" })] }), ctx(), 1);
    assert.equal(moved.event.pending[0]?.summary, "변경: 10/10(토) 10:00 알고리즘 수업 · 공학관 · 카드의 [일정 열기]로");
  });

  it("바뀐 시각을 모름(ref · time null · 모호 메모)이면 옛 값으로 묻지 않고 빈 칸을 되물음 (원문 안 넘김)", () => {
    const { events } = run(ctx(), [fast({ appointments: [study({ ref: "a1", title: "알고리즘 수업", time: null, place: null, unclear: "점심 먹고로 미뤄짐" })] })]);
    assert.deepEqual(events[0]?.clarify, ["'알고리즘 수업'의 바뀐 시각"]);
    assert.deepEqual(events[0]?.pending, []);
  });

  it("중요도만 바뀌는 변경은 요약에 중요도를 보여 줌", () => {
    const { events } = run(ctx(), [fast({ appointments: [study({ title: "알고리즘 수업", time: "10:00", place: "공학관", importance: "HIGH" })] })]);
    assert.deepEqual(events[0]?.pending.map((p) => p.summary), ["변경: 10/9(금) 10:00 알고리즘 수업 · 공학관 · 중요도 매우 중요 · 카드의 [일정 열기]로"]);
  });

  /** 스터디 카드를 만들어 저장까지 마친 상태 (a2로 저장됨, 다음 말은 3번째) */
  function withSaved(c: Context): TurnState {
    let s = applyFast(initTurnState(c), fast({ appointments: [study()] }), c, 1).state;
    s = applyTaskResults(s, { cards: [ready("c1", "08:00", { depart: "13:00", with_wake: false })], fixes: [] }, c, 1).state;
    return applyCardAction(s, { id: "c1", action: "SAVED", appointment_id: "u1", alarms: [{ kind: "DEPARTURE", at: iso("2026-10-09", "13:00"), enabled: true, level: null }] }, c, 2).state;
  }
  const step = (s: TurnState, c: Context, j: number, ...xs: XAppt[]) => applyFast(s, fast({ appointments: xs }), c, j);

  it("저장한 약속의 '변경' 카드 대기 중 B → C로 또 바꾸면 같은 c#, 원래 값(A)으로 돌아가면 카드를 거둠", () => {
    const c = ctx();
    const s0 = withSaved(c);
    assert.equal(s0.appointments.find((a) => a.ref === "a2")?.title, "스터디");
    const b = step(s0, c, 3, study({ time: "15:00" }));
    assert.deepEqual(b.event.pending, [{ id: "c2", kind: "APPOINTMENT", summary: "변경: 10/9(금) 15:00 스터디 · 학교 도서관 · 카드의 [일정 열기]로" }]);
    const cc = step(b.state, c, 4, study({ time: "16:00" }));
    assert.deepEqual(cc.event.pending.map((p) => [p.id, p.summary]), [["c2", "변경: 10/9(금) 16:00 스터디 · 학교 도서관 · 카드의 [일정 열기]로"]]);
    const back = step(cc.state, c, 5, study({ save: "CONFIRMED" }));
    assert.deepEqual(back.state.pending, {}, "되돌렸으니 '변경: 16:00' 카드는 없어야 함");
    assert.equal(card(back.state, "c2").status, "REJECTED");
    assert.equal(back.state.appointments.find((a) => a.ref === "a2")?.time, "14:00");
    assert.ok(isEmpty(back.event));
  });

  it("변경 카드 대기 중 옛 값 · 새 값이 같이 와도(모델 중복) 카드는 남음", () => {
    const c = ctx();
    const b = step(withSaved(c), c, 3, study({ time: "15:00" }));
    const both = step(b.state, c, 4, study({ save: "CONFIRMED" }), study({ time: "15:00" }));
    assert.equal(Object.keys(both.state.pending).length, 1);
    assert.equal(card(both.state, "c2").status, "READY");
  });

  it("같은 추출 반복 — 되돌림 처리 뒤에도 같은 상태를 다시 받으면 아무것도 안 냄", () => {
    const c = ctx();
    const A = study({ save: "CONFIRMED" });
    const B = study({ time: "15:00", save: "CONFIRMED" });
    let s = withSaved(c);
    const out: ServerEvent[] = [];
    [A, B, A, A, B, B].forEach((x, i) => {
      const r = step(s, c, 3 + i, x);
      s = r.state;
      out.push(r.event);
    });
    assert.deepEqual(out.map((e) => e.pending.length), [0, 1, 0, 0, 1, 0]);
    assert.ok(isEmpty(out[3] as ServerEvent));
    assert.ok(isEmpty(out[5] as ServerEvent));
  });
});

// ───────── 알람 변경 카드 ─────────

describe("알람 변경 카드 (ALARM_EDIT · ALARM_NEW) · 권한", () => {
  it("NO_PERMISSION: 친구 알람은 끄기 · 늦추기 · 앞당기기 · 추가 모두 거절 (v0에는 다른 사람 알람 권한 길이 없음)", () => {
    const { state, events } = run(ctx(), [fast({
      alarm_changes: [
        alarm({ target: "u1", enabled: false }), alarm({ target: "u2", enabled: false }), alarm({ target: "u2", time: "08:30" }),
        alarm({ target: "u2", time: "07:30" }), alarm({ target: "u1", time: "07:00" }), alarm({ target: "u9", time: "07:00" }),
      ],
    })]);
    assert.deepEqual(events[0]?.rejected, [
      { target: "민지(u1) 10/9(금) 기상 알람 끄기", reason: "NO_PERMISSION" },
      { target: "준호(u2) 10/9(금) 기상 알람 끄기", reason: "NO_PERMISSION" },
      { target: "준호(u2) 10/9(금) 08:30 기상 알람 추가", reason: "NO_PERMISSION" },
      { target: "준호(u2) 10/9(금) 07:30 기상 알람 추가", reason: "NO_PERMISSION" },
      { target: "민지(u1) 10/9(금) 07:00 기상 알람 추가", reason: "NO_PERMISSION" },
      { target: "u9 10/9(금) 07:00 기상 알람 추가", reason: "NO_PERMISSION" },
    ]);
    assert.deepEqual(state.cards, []);
  });

  it("본인 알람 시각 고침: 카드(NEEDS_ESTIMATE) → 앱 미리 보기 READY → [바꾸기] → 알람 CHANGED", () => {
    const c = ctx();
    const r = applyFast(initTurnState(c), fast({ alarm_changes: [alarm({ time: "08:30" })] }), c, 1);
    assert.equal(r.tasks, true);
    assert.deepEqual(r.cards.map((x) => [x.id, x.kind, x.status]), [["c1", "ALARM_EDIT", "NEEDS_ESTIMATE"]]);
    assert.deepEqual(r.cards[0]?.edit, { appointment_id: "a1", times: { WAKE: iso("2026-10-09", "08:30") } });
    assert.equal(r.cards[0]?.summary, "10/9(금) 기상 알람 08:30으로");
    const t = applyTaskResults(r.state, { cards: [ready("c1", "08:30")], fixes: [] }, c, 1);
    assert.deepEqual(t.event.pending, [{ id: "c1", kind: "ALARM_CHANGE", summary: "10/9(금) 기상 알람 08:30으로 · 카드의 [바꾸기]로" }]);
    const saved = applyCardAction(t.state, {
      id: "c1", action: "SAVED",
      alarms: [{ kind: "WAKE", at: iso("2026-10-09", "08:30"), enabled: true, level: null }, { kind: "PREPARE", at: iso("2026-10-09", "08:40"), enabled: true, level: null }],
    }, c, 2);
    assert.deepEqual(saved.event.applied, ["알람 변경: 10/9(금) 기상 알람 08:30으로", "그 밖의 알람(준비)도 같이 맞춤"]);
    assert.deepEqual(times(saved.event.alarms), ["al1:WAKE:08:30"]);
    assert.equal(saved.event.alarms[0]?.change, "CHANGED");
    assert.equal(saved.state.alarms.find((a) => a.ref === "al1")?.time, "08:30");
    assert.equal(saved.state.alarms.find((a) => a.ref === "al2")?.time, "08:40");
    assert.equal(saved.state.alarms.length, 4, "있는 알람을 고치는 거라 새 알람이 생기지 않음");
  });

  it("본인 알람 끄기 · 강도: 시각이 안 바뀌면 앱 계산 없이 바로 READY (강도 약하게 = 세 칸 0, 보통 = 자동 null)", () => {
    const c = ctx();
    const off = applyFast(initTurnState(c), fast({ alarm_changes: [alarm({ type: "ARRIVE", enabled: false })] }), c, 1);
    assert.equal(off.tasks, false);
    assert.deepEqual(off.cards.map((x) => [x.kind, x.status, x.edit]), [["ALARM_EDIT", "READY", { appointment_id: "a1", enabled: { ARRIVE: false } }]]);
    assert.deepEqual(off.event.pending.map((p) => p.summary), ["10/9(금) 도착 알람 끄기 · 카드의 [바꾸기]로"]);
    const soft = applyFast(initTurnState(c), fast({ alarm_changes: [alarm({ intensity: "SOFT" })] }), c, 1);
    assert.deepEqual(soft.cards[0]?.edit, { appointment_id: "a1", levels: { sound: 0, voice: 0, vibration: 0 } });
    const strong = applyFast(initTurnState(c), fast({ alarm_changes: [alarm({ intensity: "STRONG" })] }), c, 1);
    assert.deepEqual(strong.cards[0]?.edit?.levels, { sound: 2, voice: 2, vibration: 2 });
  });

  it("본인 알람: 지난 시각 · 없는 알람 · 여러 개라 모호 · 이미 그 값 · 아무 변경 없음", () => {
    const c = ctx();
    // 지난 시각
    assert.deepEqual(run(c, [fast({ alarm_changes: [alarm({ date: "2026-10-08", time: "21:00" })] })]).events[0]?.rejected, [
      { target: "10/8(목) 21:00 기상 알람 추가", reason: "PAST_TIME" },
    ]);
    // 약속 없는 날에 출발 알람 고침 / 모르는 약속 / 약속 없이 새 출발 알람
    assert.deepEqual(run(c, [fast({ alarm_changes: [alarm({ appointment_ref: "a7", time: "08:00" })] })]).events[0]?.rejected, [
      { target: "a7 기상 알람", reason: "NOT_FOUND" },
    ]);
    assert.deepEqual(run(c, [fast({ alarm_changes: [alarm({ type: "DEPARTURE", date: "2026-10-10", time: "08:00" })] })]).events[0]?.rejected.map((r) => r.reason), ["NOT_FOUND"]);
    // 아무 변경 없음 → 되물음, 이미 그 값 → 조용히
    assert.deepEqual(run(c, [fast({ alarm_changes: [alarm()] })]).events[0]?.clarify, ["기상 알람을 어떻게 바꿀지"]);
    assert.ok(isEmpty(run(c, [fast({ alarm_changes: [alarm({ time: "08:00" })] })]).events[0] as ServerEvent));
    // 후보 여럿 → 모호함, 그중 하나가 이미 그 값이면 모호함 거절 안 함
    const two = ctx({ alarms: [al("al1", "WAKE", "08:00", "NORMAL"), al("al9", "WAKE", "08:30", "NORMAL", { appointment_ref: null })] });
    assert.deepEqual(run(two, [fast({ alarm_changes: [alarm({ time: "07:30" })] })]).events[0]?.rejected, [{ target: "10/9(금) 07:30 기상 알람 추가", reason: "AMBIGUOUS" }]);
    assert.ok(isEmpty(run(two, [fast({ alarm_changes: [alarm({ time: "08:30" })] })]).events[0] as ServerEvent));
  });

  it("DECLINED: 알람 고침을 거절하면 열린 카드만 거둠", () => {
    const { state, events } = run(ctx(), [fast({ alarm_changes: [alarm({ time: "08:30", save: "UNCONFIRMED" })] }), fast({ alarm_changes: [alarm({ time: "08:30", save: "DECLINED" })] })]);
    assert.equal(card(state, "c1").status, "REJECTED");
    assert.deepEqual(state.pending, {});
    assert.ok(isEmpty(events[1] as ServerEvent));
  });

  it("약속 없는 날 '7시에 깨워줘' = ALARM_NEW: 계산 없이 바로 READY → [저장] → 새 알람", () => {
    const c = ctx({ tomorrow: [] });
    const r = applyFast(initTurnState(c), fast({ alarm_changes: [alarm({ time: "07:00" })] }), c, 1);
    assert.equal(r.tasks, false);
    assert.deepEqual(r.cards.map((x) => [x.kind, x.status, x.edit]), [["ALARM_NEW", "READY", { at: iso("2026-10-09", "07:00"), level: null }]]);
    assert.deepEqual(r.event.pending, [{ id: "c1", kind: "ALARM_CHANGE", summary: "10/9(금) 07:00 기상 알람 추가 · 카드의 [저장]으로" }]);
    const s = applyCardAction(r.state, { id: "c1", action: "SAVED", appointment_id: "al-uuid", alarms: [{ kind: "WAKE", at: iso("2026-10-09", "07:00"), enabled: true, level: null }] }, c, 2);
    assert.deepEqual(s.event.applied, ["알람 변경: 10/9(금) 07:00 기상 알람 추가"]);
    assert.deepEqual(s.event.alarms.map((a) => [a.ref, a.type, a.time, a.appointment_ref, a.change]), [["al1", "WAKE", "07:00", null, "NEW"]]);
    assert.equal(s.state.bound["al1"], "al-uuid");
  });

  it("같은 분에 이미 켜진 알람이 있으면 만들지 않고 겹침으로 알림", () => {
    const c = ctx();
    const r = applyFast(initTurnState(c), fast({ alarm_changes: [alarm({ appointment_ref: null, date: "2026-10-09", time: "09:00", type: "WAKE" })] }), c, 1);
    // 후보(기상)는 08:00 하나라 '있는 알람 고침'이 되고, 새 알람이 아님
    assert.deepEqual(r.cards.map((x) => x.kind), ["ALARM_EDIT"]);
    const none = ctx({ tomorrow: [], alarms: [al("al1", "DEPARTURE", "07:00", "NORMAL", { appointment_ref: null })] });
    const twin = applyFast(initTurnState(none), fast({ alarm_changes: [alarm({ time: "07:00" })] }), none, 1);
    assert.deepEqual(twin.event.conflicts, ["10/9(금) 07:00 기상 알람 안 만듦 — 같은 시각 출발 알람이 이미 있음"]);
    assert.deepEqual(twin.cards, []);
  });

  it("기상 후 세션: 날짜 없는 알람 변경은 오늘 알람을 가리킴", () => {
    const c = ctx({ now: "2026-10-09T07:10:00+09:00", review: "2026-10-09", type: "AFTER_WAKE" });
    c.today.alarms = [al("al3", "DEPARTURE", "09:00", "NORMAL")];
    c.tomorrow.alarms = [];
    const r = applyFast(initTurnState(c), fast({ alarm_changes: [alarm({ type: "DEPARTURE", date: null, time: "08:50" })] }), c, 1);
    assert.equal(r.cards[0]?.summary, "10/9(금) 출발 알람 08:50으로");
  });
});

// ───────── 내일만 준비시간 ─────────

describe("내일만 준비시간 가감 — ALARM_EDIT 카드 (prepare_delta)", () => {
  const prep = (direction: "MORE" | "LESS" | "OK", minutes: number | null, save?: "CONFIRMED" | "DECLINED" | "UNCONFIRMED") => fast({ prep_adjustment: { direction, minutes, ...(save ? { save } : {}) } });

  it("'좀 더'(분 없음) = +10 카드 → 앱 미리 보기 → '기상 08:00 → 07:50' 줄 (설계 메모 5.1)", () => {
    const c = ctx();
    const r = applyFast(initTurnState(c), prep("MORE", null), c, 1);
    assert.deepEqual(r.cards.map((x) => [x.kind, x.summary, x.edit]), [["ALARM_EDIT", "내일만 준비시간 +10분", { appointment_id: "a1", prepare_delta: 10 }]]);
    assert.equal(r.tasks, true);
    const t = applyTaskResults(r.state, { cards: [ready("c1", "07:50")], fixes: [] }, c, 1);
    assert.deepEqual(t.event.pending, [{ id: "c1", kind: "ALARM_CHANGE", summary: "내일만 준비시간 +10분 · 기상 08:00 → 07:50 · 카드의 [바꾸기]로" }]);
  });

  it("분을 말하면 그 값(60 상한), 줄이기 · 원래대로, 같은 말 반복은 다시 안 냄", () => {
    const c = ctx();
    const d = (f: FastExtract) => applyFast(initTurnState(c), f, c, 1).cards[0]?.edit?.prepare_delta;
    assert.equal(d(prep("MORE", 15)), 15);
    assert.equal(d(prep("MORE", 200)), 60);
    assert.equal(d(prep("LESS", 20)), -20);
    assert.equal(d(prep("LESS", null)), -10);
    assert.equal(d(prep("OK", null)), 0);
    assert.equal(applyFast(initTurnState(c), prep("OK", null), c, 1).cards[0]?.summary, "내일만 준비시간 원래대로");
    const rep = run(c, [prep("MORE", 15), prep("MORE", 15)]);
    assert.ok(isEmpty(rep.events[1] as ServerEvent));
    assert.equal(rep.state.cards.length, 1);
  });

  it("대상은 내일 기상 기준 일정 — 기상이 가장 이른 켜진 알람의 약속 (day 범위)", () => {
    const c = ctx({
      tomorrow: [appt(), appt({ ref: "a2", title: "스터디", time: "14:00" })],
      alarms: [al("al1", "WAKE", "08:00", "NORMAL"), al("al5", "WAKE", "06:30", "NORMAL", { appointment_ref: "a2" }), al("al6", "WAKE", "05:00", "NORMAL", { appointment_ref: "a2", enabled: false })],
    });
    assert.equal(applyFast(initTurnState(c), prep("MORE", 15), c, 1).cards[0]?.edit?.appointment_id, "a2");
  });

  it("내일 일정이 없으면 대상 없음(NOT_FOUND) · 거절이면 카드를 거둠", () => {
    const none = ctx({ tomorrow: [] });
    assert.deepEqual(run(none, [prep("MORE", 10)]).events[0]?.rejected, [{ target: "내일 준비시간", reason: "NOT_FOUND" }]);
    const r = run(ctx(), [prep("MORE", null), prep("MORE", null, "DECLINED")]);
    assert.equal(card(r.state, "c1").status, "REJECTED");
  });

  it("저장 전 새 약속 카드가 내일 첫 일정이면 그 카드에 붙음 (저장 뒤 앱이 saveAlarmSettings 한 번 더)", () => {
    const c = ctx({ tomorrow: [] });
    const cap = study({ title: "캡스톤 발표", time: "10:00", place: "강남역" });
    let s = applyFast(initTurnState(c), fast({ appointments: [cap] }), c, 1).state;
    s = applyTaskResults(s, { cards: [ready("c1", "07:40")], fixes: [] }, c, 1).state;
    const r = applyFast(s, prep("MORE", 15), c, 2);
    assert.equal(r.state.cards.length, 1, "새 카드를 만들지 않고");
    assert.deepEqual(card(r.state, "c1").edit, { prepare_delta: 15 });
    assert.equal(card(r.state, "c1").status, "READY", "재료(초안)가 안 바뀌어 다시 계산하지 않음");
    assert.ok(r.event.pending[0]!.summary.includes("내일만 준비시간 +15분 · 카드의 [저장]으로 저장"), r.event.pending[0]!.summary);
    const saved = applyCardAction(r.state, { id: "c1", action: "SAVED", appointment_id: "u1", alarms: [{ kind: "WAKE", at: iso("2026-10-09", "07:25"), enabled: true, level: 2 }] }, c, 3);
    assert.ok(saved.event.applied.includes("내일만 준비시간 원래보다 +15분"));
    // 새 약속 재료가 바뀌어도 붙은 가감은 유지
    const moved = applyFast(r.state, fast({ appointments: [{ ...cap, place: "역삼역" }] }), c, 3);
    assert.deepEqual(card(moved.state, "c1").edit, { prepare_delta: 15 });
    assert.equal(card(moved.state, "c1").status, "NEEDS_ESTIMATE");
  });
});

// ───────── 기록 정정 · 위기 ─────────

describe("기록 정정(fixes) · 앞 출발 · 위기", () => {
  const fb = (fact_id: string, status: "CONFIRMED" | "CORRECTED" | "DENIED" | "UNCLEAR", value_time: string | null = null, approx = false) => ({ fact_id, status, value_time, approx });

  it("도착 정정: x1 → 앱이 L2 함수로 반영 → '저장됨: 도착 시각 10:20으로 정정'", () => {
    const c = ctx();
    const r = applyFast(initTurnState(c), fast({ fact_feedback: [fb("f4", "CORRECTED", "10:20")] }), c, 1);
    assert.equal(r.tasks, true);
    assert.deepEqual(r.fixes, [{ id: "x1", fact: "f4", kind: "ARRIVE", participant_id: null, action: "CORRECT", to: iso("2026-10-08", "10:20") }]);
    assert.deepEqual(r.event.applied, [], "앱이 반영하기 전엔 저장됨 줄이 없음");
    const t = applyTaskResults(r.state, { cards: [], fixes: [{ id: "x1", ok: true }] }, c, 1);
    assert.deepEqual(t.event.applied, ["도착 시각 10:20으로 정정"]);
    assert.equal(t.done, true);
    assert.equal(t.state.awaiting, null);
    const bad = applyTaskResults(r.state, { cards: [], fixes: [{ id: "x1", ok: false, error: "대상 없음" }] }, c, 1);
    assert.deepEqual(bad.event.rejected, [{ target: "도착 기록 정정", reason: "NOT_FOUND" }]);
    assert.deepEqual(bad.event.applied, []);
  });

  it("출발 부정: x1 DENY → '저장됨: 기록 정정: 출발 09:05 → 아님' · 같은 말 되풀이는 한 번만", () => {
    const c = ctx();
    const { state } = run(c, [fast({ fact_feedback: [fb("f3", "DENIED")] })]);
    assert.deepEqual(state.fixes.map((x) => [x.id, x.action, x.to, x.status]), [["x1", "DENY", null, "SENT"]]);
    const again = applyFast(state, fast({ fact_feedback: [fb("f3", "DENIED")] }), c, 2);
    assert.ok(isEmpty(again.event));
    assert.equal(again.state.fixes.length, 1);
    const t = applyTaskResults(state, { cards: [], fixes: [{ id: "x1", ok: true }] }, c, 1);
    assert.deepEqual(t.event.applied, ["기록 정정: 출발 09:05 → 아님"]);
  });

  it("기상 정정 · 부정은 L1 정정 함수가 없어 '대상 없음' 거절 (FIXABLE = 출발 · 도착만), 모르는 id도 NOT_FOUND", () => {
    const { events, state } = run(ctx(), [fast({ fact_feedback: [fb("f1", "CORRECTED", "08:00", true), fb("f99", "DENIED")] }), fast({ fact_feedback: [fb("f1", "DENIED")] })]);
    assert.deepEqual(events[0]?.rejected, [{ target: "기상 기록 정정", reason: "NOT_FOUND" }, { target: "기록 f99", reason: "NOT_FOUND" }]);
    assert.deepEqual(events[1]?.rejected, [{ target: "기상 기록 정정", reason: "NOT_FOUND" }]);
    assert.deepEqual(state.fixes, []);
  });

  it("기록과 같은 값으로 '정정'은 확인 · 확인(CONFIRMED) · 애매함은 정정 없음 — 상태에만 기록", () => {
    const { state, events } = run(ctx(), [fast({ fact_feedback: [fb("f3", "CORRECTED", "09:05"), fb("f4", "CONFIRMED"), fb("f2", "UNCLEAR")] })]);
    assert.ok(isEmpty(events[0] as ServerEvent));
    assert.deepEqual(state.fixes, []);
    assert.deepEqual(state.factFeedback.map((f) => [f.fact_id, f.status]), [["f3", "CONFIRMED"], ["f4", "CONFIRMED"], ["f2", "UNCLEAR"]]);
  });

  it("앞 출발(f5, 07:45 잠깐 나갔다 들어옴): 부정하면 바꿀 값이 없어 앱에 정정을 안 보내고 줄만, 지금 출발을 앞 시각으로 정정하면 fix", () => {
    const c = ctx();
    const deny = applyFast(initTurnState(c), fast({ fact_feedback: [fb("f5", "DENIED")] }), c, 1);
    assert.deepEqual(deny.event.applied, ["기록 정정: 출발 07:45 → 아님"]);
    assert.deepEqual([deny.fixes, deny.tasks], [[], false]);
    // "그때 나간 게 맞아" → 지금 출발 사실(f3)이 앞 시각으로 정정
    const fix = applyFast(initTurnState(c), fast({ fact_feedback: [fb("f3", "CORRECTED", "07:45")] }), c, 1);
    assert.deepEqual(fix.fixes.map((x) => [x.fact, x.kind, x.action, x.to]), [["f3", "DEPART", "CORRECT", iso("2026-10-08", "07:45")]]);
  });

  it("위기: 위험 표시가 켜진 턴마다 crisis (헤드 10/30 B안 — 이어지는 위기 말에도 다시 안내), 꺼진 턴과 기본은 칸 없음", () => {
    const turns = [fast(), fast({ safety_flag: true }), fast({ safety_flag: true }), fast(), fast({ safety_flag: true })];
    const on = run(ctx(), turns);
    assert.deepEqual(on.events.map((e) => e.crisis === true), [false, true, true, false, true]);
    assert.equal(on.state.crisisNotified, true);
    assert.equal(on.state.safetyFlag, true);
    assert.ok(on.events.every((e, i) => ([1, 2, 4].includes(i) ? "crisis" in e : !("crisis" in e))));
  });

  it("위기 턴은 앱 일을 다음 턴으로 미룸 — 그 턴엔 tasks false · deferred true, 다음 턴에 다시 내보냄", () => {
    const c = ctx();
    const cap = study();
    const r1 = applyFast(initTurnState(c), fast({ appointments: [cap], fact_feedback: [fb("f4", "CORRECTED", "10:20")], safety_flag: true }), c, 1);
    assert.deepEqual([r1.tasks, r1.deferred, r1.fixes, r1.event.crisis], [false, true, [], true]);
    assert.equal(r1.state.awaiting, null);
    assert.equal(r1.cards.length, 1);
    assert.equal(r1.state.fixes[0]?.status, "PENDING");
    // 위험 표시가 계속 켜져 있으면 앱 일도 계속 미룸(안내가 먼저), 꺼진 턴에 내보냄
    const stay = applyFast(r1.state, fast({ appointments: [cap], safety_flag: true }), c, 2);
    assert.deepEqual([stay.tasks, stay.deferred, stay.event.crisis], [false, true, true]);
    const r2 = applyFast(stay.state, fast({ appointments: [cap] }), c, 3);
    assert.deepEqual([r2.tasks, r2.deferred, r2.event.crisis], [true, false, undefined]);
    assert.deepEqual(r2.cards.map((x) => [x.id, x.status]), [["c1", "NEEDS_ESTIMATE"]]);
    assert.deepEqual(r2.fixes.map((x) => x.id), ["x1"]);
    assert.deepEqual(r2.state.awaiting, { after_turn: 3, cards: ["c1"], fixes: ["x1"] });
    // 미뤘던 결과는 앱 일을 내보낸 턴(3) 처리 결과 뒤에 붙는다
    const t = applyTaskResults(r2.state, { cards: [ready("c1", "07:40", { date: "2026-10-09", depart: "13:00" })], fixes: [{ id: "x1", ok: true }] }, c, 3);
    assert.deepEqual(t.event.after_turn, 3);
    assert.deepEqual(t.event.applied, ["도착 시각 10:20으로 정정"]);
  });
});

// ───────── 앱 일 결과 · 앱이 보낸 요약 검사 ─────────

describe("앱이 보낸 요약은 믿지 않음 (설계 메모 5절)", () => {
  const cap = study({ title: "캡스톤 발표", time: "10:00", place: "강남역" });
  const start = () => {
    const c = ctx({ tomorrow: [] });
    return { c, s: applyFast(initTurnState(c), fast({ appointments: [cap] }), c, 1).state };
  };
  const est = (alarms: { kind: string; at: string; enabled?: boolean }[], level: number | null = 2): TaskResults["cards"][number] => ({
    id: "c1", status: "READY",
    estimate: { alarms: alarms.map((a) => ({ kind: a.kind as "WAKE", at: a.at, enabled: a.enabled ?? true })), level, with_wake: true },
  });

  it("checkDigest: 종류 · 지난 시각 · 약속 뒤 · 24시간 밖 · 강도 0~2 밖 · 시각 형식", () => {
    const now = isoToLocal(NOW);
    const at = isoToLocal(iso("2026-10-09", "10:00"));
    const ok = { alarms: [{ kind: "WAKE" as const, at: iso("2026-10-09", "07:40"), enabled: true }], level: 2, with_wake: true };
    assert.equal(checkDigest(ok, now, at), null);
    assert.match(checkDigest({ ...ok, alarms: [{ kind: "ARRIVE", at: iso("2026-10-09", "09:50"), enabled: true }] }, now, at) ?? "", /울리는 알람이 아님/);
    assert.match(checkDigest({ ...ok, alarms: [{ kind: "WAKE", at: iso("2026-10-08", "21:00"), enabled: true }] }, now, at) ?? "", /이미 지난 시각/);
    assert.match(checkDigest({ ...ok, alarms: [{ kind: "WAKE", at: iso("2026-10-09", "10:30"), enabled: true }] }, now, at) ?? "", /약속 뒤/);
    // 24시간 밖: 약속(10/12 10:00)보다 하루 넘게 이른 알람 — 지금(10/8 22:30)은 지났어도 약속 24시간 전 안쪽이어야 함
    const far = isoToLocal(iso("2026-10-12", "10:00"));
    assert.match(checkDigest({ ...ok, alarms: [{ kind: "WAKE", at: iso("2026-10-10", "09:00"), enabled: true }] }, now, far) ?? "", /24시간 밖/);
    assert.equal(checkDigest({ ...ok, alarms: [{ kind: "WAKE", at: iso("2026-10-11", "12:00"), enabled: true }] }, now, far), null);
    assert.match(checkDigest({ ...ok, level: 3 }, now, at) ?? "", /강도/);
    assert.match(checkDigest({ ...ok, alarms: [{ kind: "WAKE", at: "내일 아침", enabled: true }] }, now, at) ?? "", /시각 형식/);
    assert.match(checkDigest(null, now, at) ?? "", /요약이 없음/);
    // 약속을 모르면 약속 기준 검사 대신 지금부터 48시간 상한
    assert.equal(checkDigest({ ...ok, alarms: [{ kind: "WAKE", at: iso("2026-10-10", "07:40"), enabled: true }] }, now, null), null);
    assert.match(checkDigest({ ...ok, alarms: [{ kind: "WAKE", at: iso("2026-10-12", "07:40"), enabled: true }] }, now, null) ?? "", /48시간 밖/);
    // 모양이 이상해도 던지지 않고 이유를 돌려줌
    assert.match(checkDigest({ ...ok, alarms: [null as never] }, now, at) ?? "", /객체가 아님/);
    assert.match(checkDigest({ ...ok, alarms: "x" as never }, now, at) ?? "", /요약이 없음/);
    assert.match(checkDigest("x" as never, now, at) ?? "", /요약이 없음/);
    assert.match(checkDigest({ ...ok, alarms: [{ kind: "WAKE", at: 5 as never, enabled: true }] }, now, at) ?? "", /시각 형식/);
  });

  it("범위 밖 요약(종류 · 지난 시각 · 약속 뒤 · 24시간 밖 · 강도 0~2 밖)이면 카드를 READY로 만들지 않고 FAILED + 되물음", () => {
    const bad: [string, TaskResults["cards"][number], string?][] = [
      ["종류", est([{ kind: "ARRIVE", at: iso("2026-10-09", "09:50") }])],
      ["지난 시각", est([{ kind: "WAKE", at: iso("2026-10-08", "21:00") }])],
      ["약속 뒤", est([{ kind: "WAKE", at: iso("2026-10-09", "10:30") }])],
      ["강도", est([{ kind: "WAKE", at: iso("2026-10-09", "07:40") }], 3)],
      // 약속이 10/12 10:00인데 알람이 이틀 전 — 24시간 밖
      ["24시간 밖", est([{ kind: "WAKE", at: iso("2026-10-10", "08:00") }]), "2026-10-12"],
    ];
    for (const [why, r, date] of bad) {
      const c = ctx({ tomorrow: [] });
      const s = applyFast(initTurnState(c), fast({ appointments: [{ ...cap, ...(date ? { date } : {}) }] }), c, 1).state;
      const t = applyTaskResults(s, { cards: [r], fixes: [] }, c, 1);
      assert.equal(card(t.state, "c1").status, "FAILED", why);
      assert.deepEqual(t.event.pending, [], why);
      assert.deepEqual(t.event.clarify, ["'캡스톤 발표' 알람 계산"], why);
      assert.ok(t.invalid["c1"], why);
      assert.equal(card(t.state, "c1").digest, null, why);
    }
    // 요약 없이 READY라고만 보내도 거절
    const { c, s } = start();
    assert.ok(applyTaskResults(s, { cards: [{ id: "c1", status: "READY" }], fixes: [] }, c, 1).invalid["c1"]);
  });

  it("NEEDS_PLACE · FAILED: 되물을 것으로 전함 (앱 문구 그대로), 장소를 고른 뒤 다시 READY가 될 수 있음", () => {
    const { c, s } = start();
    const place = applyTaskResults(s, { cards: [{ id: "c1", status: "NEEDS_PLACE" }], fixes: [] }, c, 1);
    assert.deepEqual(place.event.clarify, ["'캡스톤 발표' 장소 (카드의 [장소 고르기])"]);
    assert.equal(card(place.state, "c1").status, "NEEDS_PLACE");
    const fail = applyTaskResults(s, { cards: [{ id: "c1", status: "FAILED", error: "기상이 준비 시작보다 늦을 수 없어요" }], fixes: [] }, c, 1);
    assert.deepEqual(fail.event.clarify, ["기상이 준비 시작보다 늦을 수 없어요"]);
    assert.equal(card(fail.state, "c1").error, "기상이 준비 시작보다 늦을 수 없어요");
    const again = applyTaskResults(place.state, { cards: [ready("c1", "07:40")], fixes: [] }, c, 2);
    assert.equal(card(again.state, "c1").status, "READY");
    assert.deepEqual(again.event.pending.map((p) => p.id), ["c1"]);
  });

  it("모르는 카드 · 정정 번호는 unknown으로 돌려줌", () => {
    const { c, s } = start();
    const t = applyTaskResults(s, { cards: [{ id: "c9", status: "FAILED" }], fixes: [{ id: "x9", ok: true }] }, c, 1);
    assert.deepEqual(t.unknown, ["c9", "x9"]);
    assert.equal(t.done, false, "c1 계산이 아직 안 와서 기다리는 중");
  });

  it("[저장] 때 보낸 알람 요약이 범위 밖이면 그 알람은 상태 · 처리 결과에 안 넣음 (앱은 이미 저장했으므로 일정 저장 줄은 남김)", () => {
    const { c, s } = start();
    const r0 = applyTaskResults(s, { cards: [ready("c1", "07:40")], fixes: [] }, c, 1).state;
    const r = applyCardAction(r0, {
      id: "c1", action: "SAVED", appointment_id: "u1",
      alarms: [{ kind: "WAKE", at: iso("2026-10-09", "11:00"), enabled: true, level: 2 }], // 약속(10:00) 뒤
    }, c, 2);
    assert.match(r.invalid ?? "", /약속 뒤/);
    assert.deepEqual(r.event.applied, ["일정 저장: 10/9(금) 10:00 캡스톤 발표 · 강남역"]);
    assert.deepEqual(r.event.alarms, []);
    assert.equal(r.state.alarms.length, 0);
    assert.equal(r.card?.status, "SAVED");
    const lvl = applyCardAction(r0, { id: "c1", action: "SAVED", alarms: [{ kind: "WAKE", at: iso("2026-10-09", "07:40"), enabled: true, level: 5 }] }, c, 2);
    assert.match(lvl.invalid ?? "", /강도/);
  });
});

// ───────── 모호 메모 · 지난 시각 순서 (실험실 stub.test.ts 분석 2 · 검수 2차) ─────────

describe("모호 메모 · 지난 시각 순서 · 겹침 거절", () => {
  it("분석 2: 날짜 · 시각이 다 있으면 지난 시각 검사가 모호 메모보다 먼저 · 같은 거절은 T2 흔들림으로 다시 안 냄", () => {
    const p = (over: Partial<XAppt>) => fast({ appointments: [study({ date: "2026-10-08", time: "19:00", ...over })] });
    const past = run(ctx(), [
      p({ unclear: "이미 지난 일정, 저장 동의 확인 전" }),
      p({ repeat: "NONE", unclear: "기록용 저장 요청" }),
      p({ repeat: "NONE", save: "CONFIRMED" }), // '그래도 저장해줘' — 다시 알림
      p({ save: "UNCONFIRMED", unclear: "저장 안 됨" }), // T2가 되돌아감 — 다시 안 냄 (040)
      p({ time: "20:00", save: "DECLINED" }), // 사용자가 거절 — 알릴 것 없음
    ]);
    assert.deepEqual(past.events.map((e) => [e.rejected.map((r) => r.reason), e.clarify.length]), [[["PAST_TIME"], 0], [[], 0], [["PAST_TIME"], 0], [[], 0], [[], 0]]);
    assert.equal(past.state.appointments.length, 1);
    assert.deepEqual(past.state.cards, []);
  });

  it("분석 2: 다 채워졌는데 모호 메모만 붙은 일정은 되묻지 않고 카드 — 물어본 카드의 확인(응)이면 강조", () => {
    const vague = run(ctx(), [fast({ appointments: [study({ unclear: "알람 종류는 말하지 않음" })] }), fast({ appointments: [study({ save: "CONFIRMED", unclear: "사용자가 확인함" })] })]);
    assert.deepEqual(vague.events[0]?.clarify, []);
    assert.deepEqual(vague.state.cards.map((c) => [c.id, c.status, c.highlight]), [["c1", "NEEDS_ESTIMATE", true]]);
    assert.equal(vague.state.cards.length, 1, "물어본 c#을 이어 씀");
    // 물어본 적 없이 처음부터 CONFIRMED + 메모여도 카드 하나 (저장 아님)
    const direct = run(ctx(), [fast({ appointments: [study({ save: "CONFIRMED", unclear: "'여섯시반'을 18:30으로 봄" })] })]);
    assert.deepEqual(direct.events[0]?.applied, []);
    assert.deepEqual(direct.state.cards.map((c) => c.id), ["c1"]);
    // 기존 약속: 바뀌는 칸이 없으면 메모(알람 얘기 등)가 있어도 아무것도 안 냄 (030)
    const same = study({ ref: "a1", title: "알고리즘 수업", time: "10:00", place: "공학관", save: "CONFIRMED", unclear: "기상 알람이 늦다는 말" });
    assert.ok(isEmpty(run(ctx(), [fast({ appointments: [same] })]).events[0] as ServerEvent));
    // 기존 약속 변경 + 메모: 변경 카드 → 확인(응)이어도 메모가 남아도 같은 카드 (test-019)
    const move = (save: XAppt["save"], unclear: string): XAppt => study({ ref: "a1", title: "알고리즘 수업", time: "11:00", place: null, save, unclear });
    const chg = run(ctx(), [fast({ appointments: [move("UNCONFIRMED", "'열한시'를 11:00으로 봄")] }), fast({ appointments: [move("CONFIRMED", "사용자가 확인함")] })]);
    assert.deepEqual(chg.events[0]?.pending.map((p) => p.summary), ["변경: 10/9(금) 11:00 알고리즘 수업 · 공학관 · 카드의 [일정 열기]로"]);
    assert.deepEqual(chg.events[1]?.pending.map((p) => p.id), ["c1"]);
    assert.equal(chg.state.cards.length, 1);
  });

  it("검수 2차: 같은 분 직접 알람을 사용자가 거절(DECLINED)하면 겹침을 알리지 않음", () => {
    const d = ctx({ tomorrow: [], alarms: [al("al1", "DEPARTURE", "07:00", "NORMAL", { appointment_ref: null })] });
    const r = run(d, [fast({ alarm_changes: [alarm({ time: "07:00", save: "UNCONFIRMED" })] }), fast({ alarm_changes: [alarm({ time: "07:00", save: "DECLINED" })] })]);
    assert.deepEqual(r.events[0]?.conflicts, ["10/9(금) 07:00 기상 알람 안 만듦 — 같은 시각 출발 알람이 이미 있음"]);
    assert.equal(r.events[1]?.conflicts, undefined);
    assert.ok(isEmpty(r.events[1] as ServerEvent));
  });

  it("분석 3: 알람 변경 요청이 지금 값 그대로면(AI가 전한 값을 T2가 되받아 적음) 다시 적용하지 않음", () => {
    const echo = run(ctx(), [fast({ alarm_changes: [alarm({ time: "08:00" }), alarm({ type: "PREPARE", time: "08:10" })] })]);
    assert.ok(isEmpty(echo.events[0] as ServerEvent));
    assert.deepEqual(echo.state.cards, []);
    // 시각은 지금 값과 같고 강도만 다르면 강도만 바꿈
    const lv = run(ctx(), [fast({ alarm_changes: [alarm({ time: "08:00", intensity: "STRONG" })] })]);
    assert.equal(lv.state.cards[0]?.summary, "10/9(금) 기상 알람 강도 강하게");
    assert.equal(lv.state.cards[0]?.edit?.times, undefined);
  });

  it("분석 1: 되물을 것은 T2 unclear 원문이 아니라 빈 칸(날짜 · 시각 · 장소)으로 만든 서버 문구 — 장소가 비면 ' · 장소'", () => {
    const { events } = run(ctx(), [fast({ appointments: [study({ time: null, place: null, unclear: "'점심 먹고' 오후 18:30?" })] })]);
    assert.deepEqual(events[0]?.clarify, ["'스터디'의 정확한 시각 · 장소"]);
    assert.ok(!events[0]?.clarify[0]?.includes("점심"));
  });
});

// ───────── 리뷰 #261: 입력 모양 · 요약 검사 보강 · 합치기 ─────────

describe("입력 모양이 이상하면 던지지 않고 { ok: false, reason } (리뷰 #261)", () => {
  const start = () => {
    const c = ctx({ tomorrow: [] });
    return { c, s: applyFast(initTurnState(c), fast({ appointments: [study({ title: "캡스톤 발표", time: "10:00", place: "강남역" })] }), c, 1).state };
  };

  it("results가 객체가 아니거나 cards · fixes가 배열이 아니거나 원소가 id 없는 객체면 거절", () => {
    const { c, s } = start();
    for (const bad of [null, "x", [], { cards: "x" }, { fixes: 3 }, { cards: [null] }, { cards: [{ status: "READY" }] }, { fixes: [{ ok: true }] }, { cards: [1] }]) {
      const r = applyTaskResultsRaw(s, bad as never, c, 1);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match((r as { reason: string }).reason, /results/);
    }
    // 거절은 상태를 안 바꿈 — 정상 입력은 그대로 처리
    assert.equal(applyTaskResultsRaw(s, { cards: [ready("c1", "07:40")], fixes: [] }, c, 1).ok, true);
    assert.equal(applyTaskResultsRaw(s, {} as never, c, 1).ok, true, "cards · fixes가 없는 빈 results는 받음");
  });

  it("요약의 알람 원소가 null이면 그 카드만 FAILED (던지지 않음)", () => {
    const { c, s } = start();
    const t = applyTaskResults(s, { cards: [{ id: "c1", status: "READY", estimate: { alarms: [null as never], level: 2, with_wake: true } }], fixes: [] }, c, 1);
    assert.equal(card(t.state, "c1").status, "FAILED");
    assert.match(t.invalid["c1"] ?? "", /객체가 아님/);
    const noEst = applyTaskResults(s, { cards: [{ id: "c1", status: "READY", estimate: "x" as never }], fixes: [] }, c, 1);
    assert.ok(noEst.invalid["c1"]);
  });

  it("card_action: 모양이 이상하면 거절, alarms 원소가 null이면 일정은 저장 처리하고 그 알람만 안 씀", () => {
    const { c, s } = start();
    const r0 = applyTaskResults(s, { cards: [ready("c1", "07:40")], fixes: [] }, c, 1).state;
    for (const bad of [null, "x", {}, { id: "c1" }, { id: "c1", action: "SAVE" }, { id: 1, action: "SAVED" }, { id: "c1", action: "SAVED", alarms: "x" }]) {
      const r = applyCardActionRaw(r0, bad as never, c, 2);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match((r as { reason: string }).reason, /card_action/);
    }
    const ok = applyCardAction(r0, { id: "c1", action: "SAVED", appointment_id: "u1", alarms: [null as never] }, c, 2);
    assert.equal(ok.card?.status, "SAVED");
    assert.match(ok.invalid ?? "", /객체가 아님/);
    assert.deepEqual(ok.event.alarms, []);
    assert.equal(ok.state.alarms.length, 0);
  });
});

describe("앱 요약 검사 보강 (리뷰 #261)", () => {
  it("약속이 없는 카드(ALARM_NEW)의 알람은 지금부터 48시간 안, 카드가 요청한 시각과 같아야 함", () => {
    const c = ctx({ tomorrow: [] });
    const r = applyFast(initTurnState(c), fast({ alarm_changes: [alarm({ time: "07:00" })] }), c, 1);
    const save = (alarms: CardAction["alarms"]) => applyCardAction(r.state, { id: "c1", action: "SAVED", appointment_id: "x", alarms }, c, 2);
    const good = save([{ kind: "WAKE", at: iso("2026-10-09", "07:00"), enabled: true, level: null }]);
    assert.equal(good.invalid, null);
    assert.deepEqual(good.event.alarms.map((a) => a.time), ["07:00"]);
    // 요청한 7시가 아닌 시각 → 안 씀, 서버가 만든 요청 시각(edit.at)으로 저장 처리
    const diff = save([{ kind: "WAKE", at: iso("2026-10-09", "09:00"), enabled: true, level: null }]);
    assert.match(diff.invalid ?? "", /요청한 시각과 다름/);
    assert.deepEqual(diff.event.alarms.map((a) => a.time), ["07:00"]);
    // 기상이 아닌 종류
    assert.match(save([{ kind: "PREPARE", at: iso("2026-10-09", "07:00"), enabled: true, level: null }]).invalid ?? "", /다른 알람 종류/);
    // 48시간 밖
    assert.match(save([{ kind: "WAKE", at: iso("2026-10-12", "07:00"), enabled: true, level: null }]).invalid ?? "", /48시간 밖/);
  });

  it("ALARM_EDIT: 앱이 계산한 알람 시각이 카드의 edit.times와 다르면 처리 결과로 쓰지 않음 (미리 보기 · 저장 둘 다)", () => {
    const c = ctx();
    const r = applyFast(initTurnState(c), fast({ alarm_changes: [alarm({ time: "08:30" })] }), c, 1);
    const wrong = applyTaskResults(r.state, { cards: [ready("c1", "08:40")], fixes: [] }, c, 1);
    assert.equal(card(wrong.state, "c1").status, "FAILED");
    assert.match(wrong.invalid["c1"] ?? "", /요청한 시각과 다름/);
    assert.deepEqual(wrong.event.pending, []);
    const right = applyTaskResults(r.state, { cards: [ready("c1", "08:30")], fixes: [] }, c, 1);
    assert.equal(card(right.state, "c1").status, "READY");
    // 준비 · 출발은 요청 칸이 아니라 앱 계산 그대로
    const saved = applyCardAction(right.state, { id: "c1", action: "SAVED", alarms: [{ kind: "WAKE", at: iso("2026-10-09", "08:45"), enabled: true, level: null }] }, c, 2);
    assert.match(saved.invalid ?? "", /요청한 시각과 다름/);
    assert.equal(saved.state.alarms.find((a) => a.ref === "al1")?.time, "08:00", "다른 시각은 반영 안 함");
    const fine = applyCardAction(right.state, { id: "c1", action: "SAVED", alarms: [{ kind: "WAKE", at: iso("2026-10-09", "08:30"), enabled: true, level: null }, { kind: "PREPARE", at: iso("2026-10-09", "08:50"), enabled: true, level: null }] }, c, 2);
    assert.equal(fine.invalid, null);
  });

  it("FAILED의 앱 문구는 한 줄 80자까지 (줄바꿈 제거, 빈 문구는 기본 문구)", () => {
    const c = ctx({ tomorrow: [] });
    const s = applyFast(initTurnState(c), fast({ appointments: [study({ title: "캡스톤 발표", time: "10:00", place: "강남역" })] }), c, 1).state;
    const long = `기상이 준비 시작보다 늦을 수 없어요\n${"가".repeat(200)}\r\n끝`;
    const t = applyTaskResults(s, { cards: [{ id: "c1", status: "FAILED", error: long }], fixes: [] }, c, 1);
    const msg = t.event.clarify[0] as string;
    assert.equal([...msg].length, 80);
    assert.ok(!/[\r\n]/.test(msg));
    assert.ok(msg.startsWith("기상이 준비 시작보다 늦을 수 없어요 가가"));
    assert.equal(card(t.state, "c1").error, msg);
    const blank = applyTaskResults(s, { cards: [{ id: "c1", status: "FAILED", error: " \n " }], fixes: [] }, c, 1);
    assert.deepEqual(blank.event.clarify, ["'캡스톤 발표' 알람 계산"]);
  });
});

describe("거절 순서 · 준비 가감과 합치기 (리뷰 #261)", () => {
  it("DECLINED는 약속 없는 비기상 알람의 NOT_FOUND 거절보다 먼저 — 거절한 건 알릴 것 없음", () => {
    const c = ctx();
    const dep = (save: "UNCONFIRMED" | "DECLINED") => alarm({ type: "DEPARTURE", appointment_ref: null, date: "2026-10-10", time: "08:00", save });
    assert.deepEqual(run(c, [fast({ alarm_changes: [dep("UNCONFIRMED")] })]).events[0]?.rejected.map((r) => r.reason), ["NOT_FOUND"]);
    assert.ok(isEmpty(run(c, [fast({ alarm_changes: [dep("DECLINED")] })]).events[0] as ServerEvent));
  });

  it("실험실 test-015: 같은 턴의 준비시간 가감으로 이미 그 시각이 되는 기상 · 준비 알람 변경은 카드로 만들지 않음", () => {
    const c = ctx(); // 내일 기상 08:00 · 준비 08:10
    const r = run(c, [
      fast({ prep_adjustment: { direction: "MORE", minutes: 10 } }),
      fast({ prep_adjustment: { direction: "MORE", minutes: 15 }, alarm_changes: [alarm({ time: "07:45", save: "UNCONFIRMED" }), alarm({ type: "PREPARE", time: "07:55", save: "UNCONFIRMED" })] }),
      fast({ prep_adjustment: { direction: "MORE", minutes: 15 }, alarm_changes: [alarm({ time: "07:45" }), alarm({ type: "PREPARE", time: "07:55" })] }),
    ]);
    assert.deepEqual(r.state.cards.map((x) => [x.id, x.kind, x.summary, x.edit?.prepare_delta]), [["c1", "ALARM_EDIT", "내일만 준비시간 +15분", 15]]);
    assert.ok(isEmpty(r.events[1] as ServerEvent));
    assert.ok(isEmpty(r.events[2] as ServerEvent));
    assert.deepEqual(Object.keys(r.state.pending), ["c1"]);
    // 값이 다른 진짜 요청은 그대로 카드
    const real = run(c, [fast({ prep_adjustment: { direction: "MORE", minutes: 15 }, alarm_changes: [alarm({ time: "07:30", save: "UNCONFIRMED" })] })]);
    assert.deepEqual(real.state.cards.map((x) => [x.id, x.summary]), [["c1", "10/9(금) 기상 알람 07:30으로"], ["c2", "내일만 준비시간 +15분"]]);
    // 준비 가감이 없으면 같은 시각 변경도 그냥 카드
    assert.equal(run(c, [fast({ alarm_changes: [alarm({ time: "07:45" })] })]).state.cards.length, 1);
    // 가감을 거절(DECLINED)한 턴이면 합치지 않음
    assert.equal(run(c, [fast({ prep_adjustment: { direction: "MORE", minutes: 15, save: "DECLINED" }, alarm_changes: [alarm({ time: "07:45" })] })]).state.cards.filter((x) => x.status !== "REJECTED").length, 1);
  });
});

describe("분 경계 · 상태 왕복 (리뷰 #261)", () => {
  it("23:59 세션: 23:58 약속은 지남 · 23:59와 자정(00:00)은 받음 (실험실 stub.test.ts 경계 사례)", () => {
    const late = ctx({ now: "2026-10-08T23:59:00+09:00" });
    const r = run(late, [fast({
      appointments: [
        study({ title: "야식", date: "2026-10-08", time: "23:58", place: null }),
        study({ title: "통화", date: "2026-10-08", time: "23:59", place: null }),
        study({ title: "게임", date: "2026-10-09", time: "00:00", place: null }),
      ],
    })]);
    assert.deepEqual(r.events[0]?.rejected, [{ target: "10/8(목) 23:58 야식", reason: "PAST_TIME" }]);
    // 한 번의 요청에서 새 일정 카드는 가장 이른 하나만 (2026-11-19 팀 결정) — 00:00 게임은 이번에 만들지 않고 알림
    assert.deepEqual(r.state.cards.map((x) => [x.id, x.summary]), [["c1", "10/8(목) 23:59 통화"]]);
    assert.deepEqual(r.events[0]?.conflicts, ["우선 10/8(목) 23:59 '통화' 일정부터 등록 — 10/9(금) 00:00 '게임'은 이번에 만들지 않음"]);
    // 자정(00:00)도 지난 시각이 아님 — 그 일정만 말하면 카드
    const midnight = run(late, [fast({ appointments: [study({ title: "게임", date: "2026-10-09", time: "00:00", place: null })] })]);
    assert.deepEqual(midnight.state.cards.map((x) => x.summary), ["10/9(금) 00:00 게임"]);
  });

  it("자정 뒤 03:59 대화(기준일 전날): 03:58은 지남 · 04:00은 받음, 날짜 없는 알람 변경은 '내일'(10/9) 아침 알람", () => {
    const dawn = ctx({ now: "2026-10-09T03:59:00+09:00" });
    assert.equal(dawn.session.record_date, "2026-10-08");
    const r = run(dawn, [fast({ appointments: [study({ time: "03:58" }), study({ title: "운동", time: "04:00", place: null })] })]);
    assert.deepEqual(r.events[0]?.rejected.map((x) => x.target), ["10/9(금) 03:58 스터디 · 학교 도서관"]);
    assert.deepEqual(r.state.cards.map((x) => x.summary), ["10/9(금) 04:00 운동"]);
    const w = run(dawn, [fast({ alarm_changes: [alarm({ date: null, time: "07:30" })] })]);
    assert.equal(w.state.cards[0]?.summary, "10/9(금) 기상 알람 07:30으로");
  });

  it("TurnState JSON 왕복: 정정(fixes) · 기다리는 앱 일(awaiting) 든 상태도 같은 결과", () => {
    const c = ctx();
    const r = applyFast(initTurnState(c), fast({
      appointments: [study()], fact_feedback: [{ fact_id: "f4", status: "CORRECTED", value_time: "10:20", approx: false }],
    }), c, 1);
    assert.ok(r.state.fixes.length > 0 && r.state.awaiting !== null);
    const revived = JSON.parse(JSON.stringify(r.state)) as TurnState;
    assert.deepEqual(revived, r.state);
    const results: TaskResults = { cards: [ready("c1", "08:00", { depart: "13:00", with_wake: false })], fixes: [{ id: "x1", ok: true }] };
    assert.deepEqual(applyTaskResultsRaw(revived, results, c, 1), applyTaskResultsRaw(r.state, results, c, 1));
  });

  it("TurnState JSON 왕복: 위기(crisis) 이벤트 · 미룬 정정(PENDING)이 든 상태도 같은 결과", () => {
    const c = ctx();
    const r = applyFast(initTurnState(c), fast({
      appointments: [study()], fact_feedback: [{ fact_id: "f4", status: "CORRECTED", value_time: "10:20", approx: false }], safety_flag: true,
    }), c, 1);
    assert.equal(r.event.crisis, true);
    assert.equal(r.state.fixes[0]?.status, "PENDING");
    const revived = JSON.parse(JSON.stringify(r.state)) as TurnState;
    assert.deepEqual(revived, r.state);
    const next = fast({ appointments: [study()], safety_flag: true });
    assert.deepEqual(applyFast(revived, next, c, 2), applyFast(r.state, next, c, 2));
    assert.equal(applyFast(revived, next, c, 2).event.crisis, true, "새 위험 말에는 다시 안내");
  });
});

// ───────── 불변 · 결정성 ─────────

describe("불변 · 결정성", () => {
  it("applyFast · applyTaskResults · applyCardAction은 입력 state를 바꾸지 않음", () => {
    const c = ctx({ tomorrow: [] });
    const s0 = initTurnState(c);
    const snap = JSON.stringify(s0);
    const r = applyFast(s0, fast({ appointments: [study({ save: "CONFIRMED" })], prep_adjustment: { direction: "MORE", minutes: null }, fact_feedback: [{ fact_id: "f3", status: "DENIED", value_time: null, approx: false }] }), c, 1);
    assert.equal(JSON.stringify(s0), snap);
    const s1 = JSON.stringify(r.state);
    const t = applyTaskResults(r.state, { cards: [ready("c1", "07:40", { depart: "13:00" })], fixes: [{ id: "x1", ok: true }] }, c, 1);
    assert.equal(JSON.stringify(r.state), s1);
    const s2 = JSON.stringify(t.state);
    applyCardAction(t.state, { id: "c1", action: "SAVED", appointment_id: "u", alarms: [] }, c, 2);
    assert.equal(JSON.stringify(t.state), s2);
  });

  it("같은 입력은 같은 결과", () => {
    const c = ctx();
    const f = fast({ appointments: [study()], alarm_changes: [alarm({ time: "08:30" })], fact_feedback: [{ fact_id: "f4", status: "CORRECTED", value_time: "10:20", approx: false }] });
    assert.deepEqual(applyFast(initTurnState(c), f, c, 1), applyFast(initTurnState(c), f, c, 1));
  });

  it("상태는 JSON으로 저장했다 읽어도 같은 결과 (jsonb에 그대로 담김)", () => {
    const c = ctx({ tomorrow: [] });
    const r = applyFast(initTurnState(c), fast({ appointments: [study()] }), c, 1);
    const revived = JSON.parse(JSON.stringify(r.state)) as TurnState;
    assert.deepEqual(applyTaskResults(revived, { cards: [ready("c1", "07:40", { depart: "13:00" })], fixes: [] }, c, 1), applyTaskResults(r.state, { cards: [ready("c1", "07:40", { depart: "13:00" })], fixes: [] }, c, 1));
  });
});

// ───────── 빠른 추출 펼치기 · 처리 결과 분류 (실험실 e2.test.ts) ─────────

const ev = (after_turn: number, over: Partial<ServerEvent> = {}): ServerEvent => ({ after_turn, applied: [], pending: [], rejected: [], clarify: [], alarms: [], ...over });

describe("expandFast · needKinds · eventAt (실험실 e2.test.ts)", () => {
  it("expandFast: 안 맡은 칸은 비움", () => {
    const f: FastExtract = { appointments: [], alarm_changes: [], fact_feedback: [{ fact_id: "f1", status: "CONFIRMED", value_time: null, approx: false }], prep_adjustment: null, safety_flag: false };
    const x = expandFast(f);
    assert.deepEqual([x.todos, x.reason_tags, x.importance_updates], [[], [], []]);
    assert.deepEqual(x.daily_record, { sleep_time: null, sleep_satisfaction: null, condition_note: null });
    assert.equal(x.fact_feedback.length, 1);
    assert.equal(x.schema_version, "2.0-lab.0");
  });

  it("needKinds: 처리 결과에서 T1이 바로 알아야 할 종류", () => {
    assert.deepEqual(needKinds(undefined), []);
    assert.deepEqual(needKinds(ev(1)), []);
    assert.deepEqual(needKinds(ev(1, { applied: ["x"], pending: [{ id: "c1", kind: "APPOINTMENT", summary: "s" }], clarify: ["q"], conflicts: ["c"] })), ["saved", "pending", "clarify", "conflict"]);
    assert.deepEqual(needKinds(ev(2, { rejected: [{ target: "t", reason: "PAST_TIME" }], crisis: true })), ["rejected", "crisis"]);
    assert.deepEqual(needKinds(ev(3, { alarms: [al("al1", "WAKE", "07:40", "STRONG")] })), ["alarm"]);
    assert.equal(eventAt([ev(1), ev(2, { applied: ["a"] })], 2)?.applied[0], "a");
    assert.equal(eventAt([ev(1)], 5), undefined);
  });

  it("처리할 게 없는 턴 = needKinds 빔 (미리 부른 T1 답을 씀)", () => {
    const r = applyFast(initTurnState(ctx()), fast(), ctx(), 1);
    assert.deepEqual(needKinds(r.event), []);
    assert.equal(r.tasks, false);
    assert.deepEqual([r.cards, r.fixes], [[], []]);
  });
});

// ───────── 서버 질문 고르기 (설계 메모 4.3) ─────────

describe("pickServerQuestion — PREP_CHECK 하나, 질문 예산", () => {
  /** 내일 10:00 캡스톤 발표(HIGH), 자동 기상 07:40 */
  const hot = (over: { importance?: Appointment["importance"]; title?: string; time_source?: AlarmPlan["time_source"]; wake?: string } = {}): Context =>
    ctx({
      tomorrow: [appt({ ref: "a2", title: over.title ?? "캡스톤 발표", time: "10:00", importance: over.importance ?? "HIGH", place: "강남역" })],
      alarms: [al("al1", "WAKE", over.wake ?? "07:40", "STRONG", { appointment_ref: "a2", ...(over.time_source ? { time_source: over.time_source } : {}) })],
    });
  const none: QuestionHistory = { askedInConversation: false, recent: [] };
  const KEY = questionSubjectKey("PREP_CHECK", { date: "2026-10-09", title: "캡스톤 발표" });

  it("중요도 HIGH · 자동 기상 · 기상 − 10분이 아직 앞이면 물음 — 글 · 대상 · 키", () => {
    const q = pickServerQuestion(hot(), none, NOW);
    assert.deepEqual(q?.question, { id: "q1", kind: "PREP_CHECK", text: "내일 10:00 캡스톤 발표 준비가 평소보다 더 걸릴 것 같아요?", target_ref: "a2", options: [] });
    assert.equal(q?.subject_key, KEY);
    assert.equal(KEY, "PREP_CHECK:2026-10-09|캡스톤발표");
  });

  it("중요도 칸이 비어도 제목 키워드(발표 · 시험 · 면접 …)가 HIGH면 물음, NORMAL 키워드(수업)는 안 물음", () => {
    assert.ok(pickServerQuestion(hot({ importance: null }), none, NOW));
    assert.ok(pickServerQuestion(hot({ importance: null, title: "기말 시험" }), none, NOW));
    assert.equal(pickServerQuestion(hot({ importance: "NORMAL", title: "자료구조 수업" }), none, NOW), null);
    assert.equal(pickServerQuestion(hot({ importance: "LOW", title: "스터디" }), none, NOW), null);
  });

  it("직접 고른 기상(time_source MANUAL)은 준비를 늘려도 안 바뀌어 안 물음", () => {
    assert.equal(pickServerQuestion(hot({ time_source: "MANUAL" }), none, NOW), null);
    assert.ok(pickServerQuestion(hot({ time_source: "AUTO" }), none, NOW));
  });

  it("기상 − 10분이 지금 이전이면 안 물음 (바뀐 기상이 이미 지난 시각)", () => {
    const c = hot({ wake: "07:40" });
    assert.ok(pickServerQuestion(c, none, "2026-10-09T07:29:00+09:00"));
    assert.equal(pickServerQuestion(c, none, "2026-10-09T07:30:00+09:00"), null);
    assert.equal(pickServerQuestion(c, none, "2026-10-09T07:35:00+09:00"), null);
  });

  it("기상 기준 일정만 대상: 켜진 기상 알람이 없거나 내일 일정이 없으면 안 물음, 가장 이른 기상의 일정이 대상", () => {
    assert.equal(pickServerQuestion(ctx({ tomorrow: [] }), none, NOW), null);
    const off = hot();
    off.tomorrow.alarms[0]!.enabled = false;
    assert.equal(pickServerQuestion(off, none, NOW), null);
    const two = ctx({
      tomorrow: [appt({ ref: "a1", title: "스터디", time: "09:00", importance: "LOW" }), appt({ ref: "a2", title: "캡스톤 발표", time: "14:00", importance: "HIGH" })],
      alarms: [al("al1", "WAKE", "07:00", "NORMAL"), al("al2", "WAKE", "11:00", "STRONG", { appointment_ref: "a2" })],
    });
    assert.equal(pickServerQuestion(two, none, NOW), null, "기상이 가장 이른 일정(스터디)이 대상이고 중요도가 낮음");
  });

  it("예산: 이번 대화에서 이미 물었으면 안 물음", () => {
    assert.equal(pickServerQuestion(hot(), { askedInConversation: true, recent: [] }, NOW), null);
  });

  it("예산: 하루 1개 — 오늘(서울) 이미 한 질문이 있으면 안 물음, 어제 것은 셈에 안 듦", () => {
    const today = { kind: "PREP_CHECK" as const, subject_key: "x", asked_at: "2026-10-08T09:00:00+09:00" };
    assert.equal(pickServerQuestion(hot(), { askedInConversation: false, recent: [today] }, NOW), null);
    assert.ok(pickServerQuestion(hot(), { askedInConversation: false, recent: [{ ...today, asked_at: "2026-10-07T23:59:00+09:00" }] }, NOW));
    // 원탭 칩 · 카드의 질문도 같은 예산 (헤드 H2 A 공용)
    assert.equal(pickServerQuestion(hot(), { askedInConversation: false, recent: [{ ...today, kind: "CAUSE" }] }, NOW), null);
  });

  it("예산: 하루 = 대화 기준일(같은 밤) — 23:50에 물은 뒤 00:20 같은 밤 대화에서 또 못 묻고, 다음 기준일엔 물음 (헤드 10/30)", () => {
    const asked = { kind: "PREP_CHECK" as const, subject_key: "x", asked_at: "2026-10-08T23:50:00+09:00" };
    const tmr = (day: string, now: string, review: string): Context =>
      ctx({ now, review, tomorrow: [appt({ ref: "a2", title: "캡스톤 발표", date: day, time: "10:00", importance: "HIGH", place: "강남역" })], alarms: [al("al1", "WAKE", "07:40", "STRONG", { appointment_ref: "a2", date: day })] });
    // 10/9 00:20에 연 대화 — 달력은 10/9지만 아직 안 잔 밤이라 대화 기준일(돌아볼 날)은 10/8
    const midnight = tmr("2026-10-09", "2026-10-09T00:20:00+09:00", "2026-10-08");
    assert.equal(pickServerQuestion(midnight, { askedInConversation: false, recent: [asked] }, midnight.session.now), null, "같은 밤이라 오늘 몫을 이미 씀");
    assert.ok(pickServerQuestion(midnight, { askedInConversation: false, recent: [{ ...asked, asked_at: "2026-10-07T23:50:00+09:00" }] }, midnight.session.now), "그 앞 기준일에 물은 것은 셈에 안 듦");
    // 다음 기준일(돌아볼 날 10/9, 10/9 저녁 대화)에는 새로 물을 수 있음
    const next = tmr("2026-10-10", "2026-10-09T22:30:00+09:00", "2026-10-09");
    assert.ok(pickServerQuestion(next, { askedInConversation: false, recent: [asked] }, next.session.now));
  });

  it("예산: 7일 3개 — 일주일 안에 3개를 물었으면 안 물음, 8일 전 것은 셈에 안 듦", () => {
    const at = (d: string): QuestionHistory["recent"][number] => ({ kind: "PREP_CHECK", subject_key: `k${d}`, asked_at: `2026-10-${d}T20:00:00+09:00` });
    assert.equal(pickServerQuestion(hot(), { askedInConversation: false, recent: [at("02"), at("04"), at("06")] }, NOW), null);
    assert.ok(pickServerQuestion(hot(), { askedInConversation: false, recent: [at("02"), at("04")] }, NOW));
    assert.ok(pickServerQuestion(hot(), { askedInConversation: false, recent: [at("01"), at("04"), at("06")] }, NOW), "10/1 20:00은 7일을 넘음");
  });

  it("예산: 같은 일정(subject_key)은 24시간 안에 다시 안 물음, 25시간 전 것은 괜찮음", () => {
    const q = (asked_at: string): QuestionHistory => ({ askedInConversation: false, recent: [{ kind: "PREP_CHECK", subject_key: KEY, asked_at }] });
    // 하루 1개 예산에 안 걸리게 어제 밤 / 그저께 밤으로 시험 (지금은 10/8 22:30)
    assert.equal(pickServerQuestion(hot(), q("2026-10-07T23:00:00+09:00"), NOW), null, "23시간 30분 전");
    assert.ok(pickServerQuestion(hot(), q("2026-10-07T22:00:00+09:00"), NOW), "24시간 30분 전");
    // 다른 일정 키는 상관없음
    assert.ok(pickServerQuestion(hot(), { askedInConversation: false, recent: [{ kind: "PREP_CHECK", subject_key: "PREP_CHECK:2026-10-09|다른일정", asked_at: "2026-10-07T23:00:00+09:00" }] }, NOW));
  });

  it("질문은 하나뿐이고 화면(viewQuestion) 글에 들어감", () => {
    const c = hot();
    const q = pickServerQuestion(c, none, NOW)!.question;
    c.question = q;
    assert.equal(c.question.kind, "PREP_CHECK");
  });
});

describe("알람 근거 (basis) — 앱이 준 값을 검사해 맞을 때만 처리 결과 줄에 붙임", () => {
  const wake = isoToLocal(iso("2026-10-09", "07:40"));
  const appt = isoToLocal(iso("2026-10-09", "10:00")); // 기상 → 약속 140분
  const good = { travel_minutes: 50, prepare_minutes: 70, buffer_minutes: 20 };

  it("checkBasis: 합이 맞으면(±1분) 채택, 합이 다르거나 범위 밖 · 정수 아님 · 필드 없음 · 모양 이상이면 null", () => {
    assert.deepEqual(checkBasis(good, wake, appt), good);
    assert.deepEqual(checkBasis({ ...good, buffer_minutes: 21 }, wake, appt), { ...good, buffer_minutes: 21 }); // +1분은 반올림
    assert.deepEqual(checkBasis({ ...good, buffer_minutes: 19 }, wake, appt), { ...good, buffer_minutes: 19 }); // −1분도
    assert.equal(checkBasis({ ...good, buffer_minutes: 22 }, wake, appt), null); // 합이 안 맞음
    assert.equal(checkBasis({ travel_minutes: 700, prepare_minutes: -560, buffer_minutes: 0 }, wake, appt), null); // 범위 밖
    assert.equal(checkBasis({ ...good, travel_minutes: 50.5, buffer_minutes: 19.5 }, wake, appt), null); // 정수 아님
    assert.equal(checkBasis({ ...good, travel_minutes: "50" }, wake, appt), null);
    assert.equal(checkBasis({ travel_minutes: 50, prepare_minutes: 70 }, wake, appt), null); // 필드 없음
    assert.equal(checkBasis(undefined, wake, appt), null);
    assert.equal(checkBasis(null, wake, appt), null);
    assert.equal(checkBasis([good], wake, appt), null);
    assert.equal(checkBasis(good, null, appt), null);
    assert.equal(checkBasis(good, wake, null), null);
  });

  const start = () => {
    const c = ctx({ tomorrow: [] });
    const cap = study({ title: "캡스톤 발표", time: "10:00", place: "강남역" });
    return { c, s: applyFast(initTurnState(c), fast({ appointments: [cap] }), c, 1).state };
  };
  const withBasis = (basis: unknown): TaskResults => {
    const r = ready("c1", "07:40");
    return { cards: [{ ...r, estimate: { ...(r.estimate as NonNullable<typeof r.estimate>), basis } }], fixes: [] };
  };

  it("맞는 근거는 확인 필요 줄에 붙고 카드 요약(digest)에 남음", () => {
    const { c, s } = start();
    const t = applyTaskResults(s, withBasis(good), c, 1);
    assert.equal(
      t.event.pending[0]!.summary,
      "10/9(금) 10:00 캡스톤 발표 · 강남역 · 중요도 매우 중요 · 알람 기상 07:40 강하게 · 근거 기상 07:40 = 약속 10:00 − 이동 50분 − 준비 70분 − 여유 20분 · 카드의 [저장]으로 저장",
    );
    assert.deepEqual(card(t.state, "c1").digest?.basis, good);
    console.log("근거 줄 예:", t.event.pending[0]!.summary);
  });

  it("합이 안 맞는 근거 · basis 없음(옛 앱)은 근거 줄 없이 기존 그대로", () => {
    const plain = "10/9(금) 10:00 캡스톤 발표 · 강남역 · 중요도 매우 중요 · 알람 기상 07:40 강하게 · 카드의 [저장]으로 저장";
    for (const basis of [{ ...good, buffer_minutes: 30 }, undefined, null, "x", { travel_minutes: 50 }]) {
      const { c, s } = start();
      const t = applyTaskResults(s, withBasis(basis), c, 1);
      assert.equal(t.event.pending[0]!.summary, plain);
      assert.equal(card(t.state, "c1").digest?.basis, undefined);
    }
  });
});

describe("prepAsked — 준비시간 변경을 사용자가 청했는지 (11/8 음성: 지난 일 + 목표를 +10분 요청으로 읽음)", () => {
  const u = (text: string) => ({ role: "user", text });
  const ai = (text: string) => ({ role: "ai", text });
  it("지난 일 · 목표 · 이유 · 다짐만 있으면 아님", () => {
    for (const t of [
      "오늘 아침에 알람을 두 번 미뤘어. 준비하는데 평소보다 15분 더 걸렸고 내일부턴 조금 더 일찍 일어나고 싶어.",
      "준비하는 데 오래 걸렸어",
      "내일은 여유 있게 해봐야지",
      "일찍 일어나고 싶어",
    ]) assert.equal(prepAsked([u(t)]), false, t);
  });
  it("바꿔 달라는 말 · 부탁 · 앞으로의 예상이면 청함", () => {
    for (const t of ["내일 준비시간을 15분 늘려줘", "준비 시간 10분만 줄여 줘", "준비 시간 좀 더 주세요", "내일은 준비가 더 걸릴 것 같아", "준비시간 원래대로 해", "내일 아침 10분 더 여유 있게 해줘"]) {
      assert.equal(prepAsked([u(t)]), true, t);
    }
  });
  it("코치가 준비시간을 물은 바로 다음 말은 답 ('응' · '그 정도면 돼')", () => {
    assert.equal(prepAsked([ai("내일 준비시간을 10분 더 늘려 드릴까요?"), u("응")]), true);
    assert.equal(prepAsked([ai("오늘 하루 어땠어요?"), u("응")]), false);
    assert.equal(prepAsked([ai("내일 준비시간을 늘려 드릴까요?"), u("아니"), ai("알겠어요."), u("잘 자")]), true); // 답한 말이 있으면 대화 전체로는 청함(방향은 모델 · DECLINED가 정함)
  });
});

describe("nearTitle — 같은 일정 이름(글자 흔들림 한 글자까지)", () => {
  it("한 글자 차이 · 띄어쓰기 · 포함은 같음, 다른 이름 · 한 글자 이름은 다름", () => {
    assert.equal(nearTitle("스터디", "스터더"), true); // 11/9 웹 시험
    assert.equal(nearTitle("도서관 스터디", "도서관스터디"), true);
    assert.equal(nearTitle("스터디", "스터디 모임"), true); // titleMatch(포함)
    assert.equal(nearTitle("팀플 회의", "팀플회으"), true);
    assert.equal(nearTitle("스터디", "치과"), false);
    assert.equal(nearTitle("스터디", "스케줄"), false); // 두 글자 차이
    assert.equal(nearTitle("밥", "빵"), false); // 한 글자 이름은 비교 안 함
  });
});

// ───────── 첫 일정 하나 · 나가기 전 할 일 → 기상 확인 (2026-11-19 팀 결정) ─────────
//   일정 = 13:00 수업(학교). 앱 계산: 기상 11:20 · 준비 11:40 · 출발 12:10
describe("첫 일정 하나만 · 할 일이 있으면 기상 시각만 확인", () => {
  const lecture = (over: Partial<XAppt> = {}): XAppt => study({ title: "수업", time: "13:00", place: "학교", ...over });
  const hospital = (over: Partial<XAppt> = {}): XAppt => study({ title: "병원", time: "17:00", place: "병원", ...over });
  const est = (id: string, wake: string, prepare = "11:40", depart = "12:10"): TaskResults["cards"][number] => ({
    id, status: "READY",
    estimate: {
      alarms: [
        { kind: "WAKE", at: iso("2026-10-09", wake), enabled: true }, { kind: "PREPARE", at: iso("2026-10-09", prepare), enabled: true },
        { kind: "DEPARTURE", at: iso("2026-10-09", depart), enabled: true },
      ],
      level: 1, with_wake: true,
    },
  });
  const results = (state: TurnState, c: TaskResults["cards"][number], turn: number) => applyTaskResults(state, { cards: [c], fixes: [] }, ctx(), turn);
  const QUESTION = "'수업' 기상 알람이 11:20으로 계산됨 — 나가기 전 할 일(과제)이 있다고 했으니 이 시각에 일어날지, 몇 시에 일어날지";

  it("A. 할 일이 없으면 기존대로: 카드 하나, 계산 뒤 저장 확인 줄 · 기상 질문 없음", () => {
    const r = run(ctx(), [fast({ appointments: [lecture()] })]);
    assert.deepEqual(r.state.cards.map((c) => [c.id, c.summary, c.pre_task]), [["c1", "10/9(금) 13:00 수업 · 학교", undefined]]);
    const t = results(r.state, est("c1", "11:20"), 1);
    assert.deepEqual(t.event.pending.map((p) => p.id), ["c1"]);
    assert.deepEqual(t.event.clarify, []);
  });

  it("B. 할 일 → 계산된 기상(11:20)을 묻고 저장 확인을 미룸 → '9시 30분' 답이면 기상만 09:30 → 그때 저장 확인, 카드는 하나", () => {
    const r1 = run(ctx(), [fast({ appointments: [lecture()], pre_tasks: [{ title: "과제" }] })]);
    assert.deepEqual(card(r1.state, "c1").pre_task, { title: "과제", wake: "ASK", time: null });
    const t1 = results(r1.state, est("c1", "11:20"), 1);
    assert.deepEqual(t1.event.pending, []); // 기상 답 전엔 저장을 권하지 않음
    assert.deepEqual(t1.event.clarify, [QUESTION]);
    const r2 = applyFast(t1.state, fast({ appointments: [lecture()], pre_tasks: [{ title: "과제" }], wake_reply: { choice: "TIME", time: "09:30" } }), ctx(), 2);
    const c = card(r2.state, "c1");
    assert.deepEqual([c.pre_task, c.status, c.edit?.times], [{ title: "과제", wake: "SET", time: "09:30" }, "NEEDS_ESTIMATE", { WAKE: iso("2026-10-09", "09:30") }]);
    assert.equal(r2.tasks, true);
    const t2 = results(r2.state, est("c1", "09:30"), 2);
    assert.deepEqual(t2.event.pending.map((p) => p.id), ["c1"]);
    assert.match(t2.event.pending[0]?.summary ?? "", /나가기 전 할 일: 과제 · 기상은 사용자가 정한 시각, 준비 · 출발은 그대로/);
    assert.equal(t2.state.cards.filter((x) => x.kind === "APPT_NEW").length, 1);
  });

  it("C. '그대로 일어날게'면 기상 변경 없이 저장 확인 (다시 계산 안 함)", () => {
    const r1 = run(ctx(), [fast({ appointments: [lecture()], pre_tasks: [{ title: "과제" }] })]);
    const t1 = results(r1.state, est("c1", "11:20"), 1);
    const r2 = applyFast(t1.state, fast({ appointments: [lecture()], pre_tasks: [{ title: "과제" }], wake_reply: { choice: "KEEP", time: "" } }), ctx(), 2);
    const c = card(r2.state, "c1");
    assert.deepEqual([c.pre_task?.wake, c.status, c.edit], ["KEEP", "READY", null]);
    assert.deepEqual(r2.event.pending.map((p) => p.id), ["c1"]);
  });

  it("D. 13시 수업 + 17시 병원(말한 순서와 상관없이): 시각이 이른 수업 카드 하나만, 병원은 알림만 — 다음 말에 다시 뽑혀도 안 만듦", () => {
    const r = run(ctx(), [fast({ appointments: [hospital(), lecture()] }), fast({ appointments: [hospital(), lecture()] })]);
    assert.deepEqual(r.state.cards.map((c) => c.summary), ["10/9(금) 13:00 수업 · 학교"]);
    assert.deepEqual(r.events[0]?.conflicts, ["우선 10/9(금) 13:00 '수업' 일정부터 등록 — 10/9(금) 17:00 '병원'은 이번에 만들지 않음"]);
    assert.equal(card(r.state, "c1").turn, 1);
    // 사용자가 병원도 저장해 달라고 하면(CONFIRMED) 그때 카드
    const r3 = applyFast(r.state, fast({ appointments: [hospital({ save: "CONFIRMED" }), lecture()] }), ctx(), 3);
    assert.deepEqual(r3.state.cards.map((c) => [c.summary, c.turn]), [["10/9(금) 13:00 수업 · 학교", 1], ["10/9(금) 17:00 병원 · 병원", 3]]);
  });

  it("D2. 같은 시각 일정이 둘이면 카드를 만들지 않고 어느 것부터인지 물음", () => {
    const r = run(ctx(), [fast({ appointments: [lecture(), lecture({ title: "면담", place: "연구실" })] })]);
    assert.deepEqual(r.state.cards, []);
    assert.deepEqual(r.events[0]?.clarify, ["같은 시각(10/9(금) 13:00)의 일정 '수업' · '면담' 중 어느 일정부터 등록할지"]);
  });

  it("E. 10~11시 집 온라인 회의(할 일) + 13시 수업: 수업 카드 하나, 회의는 카드가 아니라 기상 확인 계기", () => {
    const r = run(ctx(), [fast({ appointments: [lecture()], pre_tasks: [{ title: "온라인 회의" }] })]);
    assert.deepEqual(r.state.cards.map((c) => [c.kind, c.summary, c.pre_task?.title]), [["APPT_NEW", "10/9(금) 13:00 수업 · 학교", "온라인 회의"]]);
    const t = results(r.state, est("c1", "11:20"), 1);
    assert.match(t.event.clarify[0] ?? "", /11:20으로 계산됨 — 나가기 전 할 일\(온라인 회의\)/);
  });

  it("F. '좀 일찍 일어날게'(시각 없음)는 정확한 시각을 다시 물음 — 임의로 당기지 않음", () => {
    const r1 = run(ctx(), [fast({ appointments: [lecture()], pre_tasks: [{ title: "과제" }] })]);
    const t1 = results(r1.state, est("c1", "11:20"), 1);
    const r2 = applyFast(t1.state, fast({ appointments: [lecture()], pre_tasks: [{ title: "과제" }], wake_reply: { choice: "VAGUE", time: "" } }), ctx(), 2);
    const c = card(r2.state, "c1");
    assert.deepEqual([c.pre_task?.wake, c.edit, c.status], ["ASK", null, "READY"]);
    assert.deepEqual(r2.event.clarify, ["'수업' 날 몇 시에 일어날지 (정확한 시각)"]);
    assert.deepEqual(r2.event.pending, []);
  });

  it("G. 준비 알람(11:40)보다 늦은 기상(12:00)은 받지 않고 다시 물음 — 카드 시각은 그대로", () => {
    const r1 = run(ctx(), [fast({ appointments: [lecture()], pre_tasks: [{ title: "과제" }] })]);
    const t1 = results(r1.state, est("c1", "11:20"), 1);
    const r2 = applyFast(t1.state, fast({ appointments: [lecture()], pre_tasks: [{ title: "과제" }], wake_reply: { choice: "TIME", time: "12:00" } }), ctx(), 2);
    const c = card(r2.state, "c1");
    assert.deepEqual([c.pre_task?.wake, c.edit, c.status], ["ASK", null, "READY"]);
    assert.deepEqual(r2.event.clarify, ["기상 12:00이 준비 알람 11:40보다 늦어요 — 11:40 전에 일어날 시각"]);
  });

  it("처음부터 '회의 있으니 9시 30분에 깨워줘': 다시 묻지 않고 그 시각으로 계산 — 알람 변경으로 적혀 와도 따로 기상 알람 카드를 만들지 않음", () => {
    const told = run(ctx(), [fast({ appointments: [lecture()], pre_tasks: [{ title: "회의" }], wake_reply: { choice: "TIME", time: "09:30" } })]);
    const asAlarm = run(ctx(), [fast({ appointments: [lecture()], pre_tasks: [{ title: "회의" }], alarm_changes: [alarm({ time: "09:30" })] })]);
    for (const r of [told, asAlarm]) {
      assert.deepEqual(r.state.cards.map((c) => [c.kind, c.pre_task, c.edit?.times]), [["APPT_NEW", { title: "회의", wake: "SET", time: "09:30" }, { WAKE: iso("2026-10-09", "09:30") }]]);
      const t = results(r.state, est("c1", "09:30"), 1);
      assert.deepEqual([t.event.pending.map((p) => p.id), t.event.clarify], [["c1"], []]);
    }
  });

  it("할 일 없이 '9시 30분에 깨워줘'는 기존대로 (있는 기상 알람 고침 카드 — 새 일정 카드의 기상으로 가져가지 않음)", () => {
    const r = run(ctx(), [fast({ appointments: [lecture()], alarm_changes: [alarm({ time: "09:30" })] })]);
    assert.deepEqual(r.state.cards.map((c) => [c.kind, c.pre_task]), [["APPT_NEW", undefined], ["ALARM_EDIT", undefined]]);
  });

  it("기존 규칙상 이 일정에 기상 알람이 없으면(앱 계산에 기상 없음) 물을 기상이 없으니 새 기상을 만들지 않고 저장 확인으로", () => {
    const r1 = run(ctx(), [fast({ appointments: [lecture()], pre_tasks: [{ title: "과제" }] })]);
    const noWake = est("c1", "11:20");
    (noWake.estimate as { alarms: { kind: string }[] }).alarms = (noWake.estimate as { alarms: { kind: string }[] }).alarms.filter((a) => a.kind !== "WAKE");
    const t = results(r1.state, noWake, 1);
    assert.deepEqual([t.event.pending.map((p) => p.id), t.event.clarify, card(t.state, "c1").pre_task?.wake], [["c1"], [], "KEEP"]);
  });
});
