// view.ts 시험 — 실험실 tests/view.test.ts 이식 (같은 입력 같은 답). view.v4 → v5(설계 메모 4.1 · 4.2).
// 바뀐 곳: VIEW_VERSION · 확인할 기록 서버 규칙(fill 끔) · 날짜 블록 자정 줄. common.ts 몫(eventsForView · allowedNumbers)은 guards.test.ts로,
//   linkPending(시뮬레이터)은 뺐다.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Context, Fact, ServerEvent } from "./types.ts";
import { datesFor, sampleContext } from "./testing.ts";
import {
  CRISIS_DONE_LINE, CRISIS_NOW_LINE, FIXABLE_FACT_KINDS, SERVER_CONFIRM_OPTS, VIEW_VERSION, contextVars, pickConfirmFacts, spokenTime, spokenizeTimes,
  viewAppointments, viewConfirmFacts, viewContext, viewDates, viewEvents, viewFacts,
} from "./view.ts";
import { findTimeMentions } from "./ko.ts";

const toMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

const fact = (id: string, kind: Fact["kind"], over: Partial<Fact> = {}): Fact => ({
  id, kind, time: "09:00", minutes: null, appointment_ref: null, source: "AUTO", confirmed: false, text: "", ...over,
});
const event = (after_turn: number, over: Partial<ServerEvent> = {}): ServerEvent => ({
  after_turn, applied: [], pending: [], rejected: [], clarify: [], alarms: [], ...over,
});
const block = (out: string, head: string): string => out.split(`### ${head}\n`)[1]!.split("\n\n")[0]!;

describe("view.v5 문구", () => {
  it("버전 · 어젯밤 취침 · 준비가 예상보다 N분 더 걸림", () => {
    assert.equal(VIEW_VERSION, "view.v5");
    const ctx = sampleContext("AFTER_WAKE");
    assert.ok(viewFacts(ctx).includes("[f1] 어젯밤 취침 00:40 (자동)"));
    ctx.today.facts = [fact("f1", "PREP_OVER", { time: null, minutes: 15 }), fact("f2", "PREP_OVER", { time: null })];
    assert.equal(viewFacts(ctx), "[f1] 준비가 예상보다 15분 더 걸림 (자동)\n[f2] 준비가 예상보다 더 걸림 (자동)");
  });

  it("지금보다 이른 일정에 '지남' — 기상 후(늦잠) · 자기 전 오늘 일정 모두, 같은 분은 안 지남", () => {
    const aw = sampleContext("AFTER_WAKE");
    aw.session.now = "2026-10-09T10:42:00+09:00"; // 10:00 발표보다 늦게 일어남 (069)
    const day = block(viewContext(aw), "오늘 일정").split("\n");
    assert.ok(day[0]!.startsWith("[a1] 10-09(금) 10:00 캡스톤 발표 · 지남 · 장소 강남"), day[0]);
    assert.ok(!day[1]!.includes("지남"), day[1]);
    const exact = viewAppointments(aw.today.appointments, "오늘 일정", "2026-10-09T10:00:00+09:00");
    assert.ok(!exact.split("\n")[0]!.includes("지남"));
    // now 없이 부르면 표시 없음 (일기 입력 등)
    assert.ok(!viewAppointments(aw.today.appointments, "오늘 일정").includes("지남"));
    const bs = viewContext(sampleContext("BEFORE_SLEEP"));
    assert.match(bs, /오늘 일정:\n\[a1\] 10-08\(목\) 10:00 데이터구조 · 지남 · /);
    assert.ok(!block(bs, "내일 일정").includes("지남"));
  });
});

describe("처리 결과 — 새 알람 · 바뀐 알람 · 겹침 · 위기 안내", () => {
  const nu = { ref: "al20", owner: "u0", type: "DEPARTURE" as const, date: "2026-10-09", time: "13:00", intensity: "NORMAL" as const, appointment_ref: "a4", enabled: true };

  it("change 칸으로 '새 알람' · '바뀐 알람'을 가르고, 칸이 없는 옛 결과는 컨텍스트에 없던 al#이면 새 알람", () => {
    const ctx = sampleContext("BEFORE_SLEEP");
    ctx.events = [event(1, { alarms: [{ ...nu, change: "NEW" }, { ...ctx.tomorrow.alarms[0]!, time: "07:20", change: "CHANGED" }] })];
    const out = viewEvents(ctx);
    assert.ok(out.includes("- 새 알람: [al20] 출발 10-09(금) 13:00 · 보통(NORMAL) · a4 기준"), out);
    assert.ok(out.includes("- 바뀐 알람: [al1] 기상 10-09(금) 07:20"), out);
    // 옛 결과(칸 없음): 처음 보는 al# → 새 알람, 다음 결과에서 다시 바뀌면 바뀐 알람
    ctx.events = [event(1, { alarms: [nu] }), event(2, { alarms: [{ ...nu, time: "12:50" }] })];
    const old = viewEvents(ctx);
    assert.ok(old.includes("사용자 말 1 뒤:\n- 새 알람: [al20]"), old);
    assert.ok(old.includes("사용자 말 2 뒤:\n- 바뀐 알람: [al20]"), old);
    // 알람 블록: 컨텍스트에 없던 알람은 '새로 생김'
    assert.ok(block(viewContext(ctx), "내일 알람").includes("[al20] 출발 12:50 · 보통(NORMAL) · a4 기준 · 새로 생김(사용자 말 2 뒤)"));
  });

  it("겹침 줄 · 위기 안내는 가장 최근 결과에서만 '이번 답에서', 앞 결과는 '이미 함'", () => {
    const ctx = sampleContext("BEFORE_SLEEP", { events: false });
    ctx.events = [event(1, { crisis: true, conflicts: ["10/9(금) 14:00 스터디의 출발 알람(13:00) 안 만듦 — 13:00 색채학 일정 시간과 겹침"] })];
    const now = viewEvents(ctx);
    assert.equal(now, [
      "사용자 말 1 뒤:",
      CRISIS_NOW_LINE,
      "- 겹침: 10/9(금) 14:00 스터디의 출발 알람(13:00) 안 만듦 — 13:00 색채학 일정 시간과 겹침",
    ].join("\n"));
    ctx.events.push(event(2));
    const later = viewEvents(ctx);
    assert.ok(later.includes(`사용자 말 1 뒤:\n${CRISIS_DONE_LINE}`), later);
    assert.ok(!later.includes(CRISIS_NOW_LINE));
    // 칸이 없으면(기본) 줄도 없음
    assert.ok(!viewEvents(sampleContext("BEFORE_SLEEP")).includes("위기"));
  });
});

describe("확인할 기록 (서버가 고름)", () => {
  it("자동 · 미확인 출발 · 도착 먼저, 확인됨 · 파생(지각 · 준비 초과) 빼고 서버 순서로", () => {
    // 미루기(자동) · 기상(원탭 확인됨) · 출발(자동) · 도착(자동) · 지각 · 준비 초과
    assert.deepEqual(pickConfirmFacts(sampleContext("BEFORE_SLEEP")), ["f3", "f4"]);
  });

  it("출발 · 도착 · 기상이 많으면 3개까지(출발 · 도착 우선), 모자라면 다른 기록으로 2개까지 채움", () => {
    const ctx = sampleContext("BEFORE_SLEEP");
    ctx.today.facts = [fact("f1", "SLEEP"), fact("f2", "WAKE"), fact("f3", "DEPART"), fact("f4", "ARRIVE"), fact("f5", "DEPART")];
    // E2(10/10): 자동 · 미확인 기상은 늘 들어감 — 출발 · 도착이 먼저여도 기상이 밀려나지 않음 (기상 1 + 출발 · 도착 2)
    assert.deepEqual(pickConfirmFacts(ctx), ["f2", "f3", "f4"]);
    ctx.today.facts = [fact("f1", "SLEEP"), fact("f2", "WAKE"), fact("f3", "SNOOZE", { time: null, minutes: 2 })];
    assert.deepEqual(pickConfirmFacts(ctx), ["f1", "f2"]);
    ctx.today.facts = [fact("f1", "ROUTINE_DONE", { source: "ONE_TAP" }), fact("f2", "SLEEP"), fact("f3", "LATE", { minutes: 10 })];
    assert.deepEqual(pickConfirmFacts(ctx), ["f1", "f2"]);
    ctx.today.facts = [fact("f1", "WAKE", { confirmed: true }), fact("f2", "PREP_OVER", { minutes: 12 })];
    assert.deepEqual(pickConfirmFacts(ctx), []);
    assert.equal(viewConfirmFacts([]), "확인할 기록(서버가 고름): 없음");
  });

  it("E2: 자동 · 미확인 기상은 늘 목록에 — 출발 · 도착이 많아도 기상 1 + 앞선 출발 · 도착 2, 확인됨 · 원탭 기상은 안 넣음", () => {
    const ctx = sampleContext("BEFORE_SLEEP");
    // 출발 3 + 도착 1 + 기상 1: 예전엔 [출발 3개], 이제 기상 + 앞선 출발 둘
    ctx.today.facts = [fact("f1", "WAKE"), fact("f2", "DEPART"), fact("f3", "DEPART"), fact("f4", "DEPART"), fact("f5", "ARRIVE")];
    assert.deepEqual(pickConfirmFacts(ctx), ["f1", "f2", "f3"]);
    // 기상이 뒤에 있어도 들어감 (서버 순서로 돌려줌)
    ctx.today.facts = [fact("f1", "DEPART"), fact("f2", "ARRIVE"), fact("f3", "DEPART"), fact("f4", "WAKE", { time: "07:02" })];
    assert.deepEqual(pickConfirmFacts(ctx), ["f1", "f2", "f4"]);
    // 기상이 둘이면 첫 번째만 보장하고 나머지는 남는 자리에서 경쟁
    ctx.today.facts = [fact("f1", "WAKE"), fact("f2", "WAKE"), fact("f3", "DEPART")];
    assert.deepEqual(pickConfirmFacts(ctx), ["f1", "f2", "f3"]);
    // 확인됨 · 원탭(자동 아님) 기상은 보장 대상이 아님
    ctx.today.facts = [fact("f1", "WAKE", { confirmed: true }), fact("f2", "DEPART"), fact("f3", "ARRIVE"), fact("f4", "DEPART")];
    assert.deepEqual(pickConfirmFacts(ctx), ["f2", "f3", "f4"]);
    ctx.today.facts = [fact("f1", "WAKE", { source: "ONE_TAP" }), fact("f2", "DEPART"), fact("f3", "ARRIVE"), fact("f4", "DEPART")];
    assert.deepEqual(pickConfirmFacts(ctx), ["f2", "f3", "f4"]);
    // 기상이 없거나 하나뿐인 날은 예전과 같음
    ctx.today.facts = [fact("f1", "DEPART"), fact("f2", "ARRIVE")];
    assert.deepEqual(pickConfirmFacts(ctx), ["f1", "f2"]);
    ctx.today.facts = [fact("f1", "SLEEP"), fact("f2", "WAKE")];
    assert.deepEqual(pickConfirmFacts(ctx), ["f1", "f2"]);
  });

  it("viewContext 선택 confirmFacts — 켜면 '오늘 기록' 끝에 한 줄, 기본은 그대로", () => {
    const ctx = sampleContext("BEFORE_SLEEP");
    const base = viewContext(ctx);
    assert.ok(!base.includes("확인할 기록"));
    assert.equal(viewContext(ctx, {}), base);
    const on = block(viewContext(ctx, { confirmFacts: true }), "오늘 기록").split("\n");
    assert.equal(on[6], "확인할 기록(서버가 고름): f3 · f4");
    assert.equal(on[7], "오늘 일정:");
    assert.ok(viewContext(ctx, { confirmFacts: ["f4"] }).includes("확인할 기록(서버가 고름): f4\n"));
    // 템플릿 칸은 늘 채움, {{context}}는 선택을 따름
    const v = contextVars(ctx);
    assert.equal(v.confirm_facts, "확인할 기록(서버가 고름): f3 · f4");
    assert.equal(v.context, base);
    assert.ok(String(contextVars(ctx, { confirmFacts: true }).context).includes("확인할 기록"));
  });
});

describe("spokenTimes — 서버가 시각을 말로 바꿔 넘김 (E1)", () => {
  it("spokenTime: 밤 12시 · 새벽 · 오전 · 낮 12시 · 오후, 분 0이면 생략", () => {
    const cases: [string, string][] = [
      ["00:00", "밤 12시"], ["00:30", "밤 12시 30분"], ["01:05", "새벽 1시 5분"], ["05:59", "새벽 5시 59분"], ["06:00", "오전 6시"],
      ["09:00", "오전 9시"], ["11:59", "오전 11시 59분"], ["12:00", "낮 12시"], ["12:20", "낮 12시 20분"], ["13:00", "오후 1시"],
      ["18:30", "오후 6시 30분"], ["23:50", "오후 11시 50분"],
    ];
    for (const [hm, want] of cases) assert.equal(spokenTime(Number(hm.slice(0, 2)), Number(hm.slice(3))), want, hm);
    assert.throws(() => spokenTime(24, 0), /없는 시각/);
    assert.throws(() => spokenTime(7, 60), /없는 시각/);
  });

  it("spokenizeTimes ↔ ko.ts 읽기: 모든 HH:MM이 말로 바뀐 뒤 다시 읽으면 같은 시각", () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 5, 30, 59]) {
        const hm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        const spoken = spokenizeTimes(`출발 ${hm} 예정`);
        assert.ok(!/\d:\d/.test(spoken), spoken);
        const back = findTimeMentions(spoken).filter((x) => x.kind === "clock");
        assert.equal(back.length, 1, spoken);
        assert.deepEqual(back[0]!.candidates, [toMinutes(hm)], `${hm} → ${spoken}`);
      }
    }
  });

  it("spokenizeTimes: 초 붙은 시각 · 한 자리 분 · 날짜는 그대로", () => {
    assert.equal(spokenizeTimes("10:30:15"), "10:30:15");
    assert.equal(spokenizeTimes("3:1 득점"), "3:1 득점");
    assert.equal(spokenizeTimes("2026-10-09(금) 07:40"), "2026-10-09(금) 오전 7시 40분");
    assert.equal(spokenizeTimes("[f2] 출발 20:10 (자동)"), "[f2] 출발 오후 8시 10분 (자동)");
  });

  it("viewContext 선택 spokenTimes — 기본은 그대로, 켜면 사실 · 일정 · 알람 · 날짜 · 처리 결과의 시각이 모두 말로", () => {
    const ctx = sampleContext("BEFORE_SLEEP");
    ctx.events = [event(1, { applied: ["기상 시각 07:35으로 정정"] })];
    const base = viewContext(ctx);
    assert.equal(viewContext(ctx, { spokenTimes: false }), base);
    assert.equal(viewContext(ctx, {}), base);
    const on = viewContext(ctx, { spokenTimes: true, confirmFacts: true });
    assert.ok(!/\d{1,2}:\d{2}/.test(on), on);
    assert.ok(on.includes("기상 시각 오전 7시 35분으로 정정"));
    assert.ok(on.includes("확인할 기록(서버가 고름): f3 · f4")); // 다른 선택과 같이 써도 됨
    assert.ok(/\[f\d\] .*(오전|오후|낮|밤|새벽) \d+시/.test(on));
    // 시각만 바뀌고 줄 수는 그대로
    assert.equal(on.split("\n").length, viewContext(ctx, { confirmFacts: true }).split("\n").length);
    // 템플릿 칸도 같은 말씨
    const v = contextVars(ctx, { spokenTimes: true });
    assert.ok(!/\d{1,2}:\d{2}/.test(String(v.facts)) && !/\d{1,2}:\d{2}/.test(String(v.events)) && !/\d{1,2}:\d{2}/.test(String(v.now_local)));
    assert.ok(/\d{1,2}:\d{2}/.test(String(contextVars(ctx).facts)));
  });
});

describe("보기 입력 모양", () => {
  it("선택을 안 주면 전체 글은 결정적 · 입력을 바꾸지 않음", () => {
    const ctx: Context = sampleContext("BEFORE_SLEEP");
    const before = structuredClone(ctx);
    assert.equal(viewContext(ctx), viewContext(structuredClone(ctx)));
    viewContext(ctx, { confirmFacts: true });
    assert.deepEqual(ctx, before);
  });
});

describe("확인할 기록 — 서버 규칙 (설계 메모 4.2)", () => {
  const srv = (ctx: Context): string[] => pickConfirmFacts(ctx, SERVER_CONFIRM_OPTS);

  it("채우기 없음: 자동 값이 모자라도 취침 · 미루기 · 루틴으로 채우지 않음 (실험실 규칙과 다름)", () => {
    const ctx = sampleContext("BEFORE_SLEEP");
    ctx.today.facts = [fact("f1", "SLEEP"), fact("f2", "WAKE"), fact("f3", "SNOOZE", { time: null, minutes: 2 })];
    assert.deepEqual(pickConfirmFacts(ctx), ["f1", "f2"]); // 실험실 규칙(채움)은 그대로
    assert.deepEqual(srv(ctx), ["f2"]); // 서버: 기상만
    ctx.today.facts = [fact("f1", "ROUTINE_DONE", { source: "ONE_TAP" }), fact("f2", "SLEEP"), fact("f3", "LATE", { minutes: 10 })];
    assert.deepEqual(srv(ctx), []);
  });

  it("자동 감지 값만: 원탭 · 직접 · 대화로 받은 값(confirmed)은 안 읽음", () => {
    const ctx = sampleContext("BEFORE_SLEEP");
    ctx.today.facts = [
      fact("f1", "WAKE", { source: "ONE_TAP", confirmed: true }),
      fact("f2", "DEPART", { source: "MANUAL", confirmed: true }),
      fact("f3", "DEPART", { source: "AUTO" }),
      fact("f4", "ARRIVE", { source: "ONE_TAP" }), // 출처만 원탭이고 confirmed가 아니어도 자동 아님
    ];
    assert.deepEqual(srv(ctx), ["f3"]);
  });

  it("기상 1 + 출발 · 도착 2, 3개 상한 — 취침 · 미루기는 아예 안 넣음", () => {
    const ctx = sampleContext("BEFORE_SLEEP");
    ctx.today.facts = [
      fact("f1", "SLEEP"), fact("f2", "SNOOZE", { time: null, minutes: 3 }), fact("f3", "WAKE", { time: "08:12" }),
      fact("f4", "DEPART", { time: "07:45", earlier: true, text: "잠깐 나갔다 들어옴" }), fact("f5", "DEPART", { time: "08:40" }), fact("f6", "ARRIVE", { time: "10:07" }),
      fact("f7", "LATE", { time: null, minutes: 7 }),
    ];
    assert.deepEqual(srv(ctx), ["f3", "f4", "f5"]);
    assert.deepEqual(FIXABLE_FACT_KINDS, ["DEPART", "ARRIVE"]);
  });

  it("지각 NULL = 지각 아님: 사실에 LATE가 없으면 지각 줄도 확인할 기록도 없다", () => {
    const ctx = sampleContext("BEFORE_SLEEP");
    ctx.today.facts = [fact("f1", "WAKE"), fact("f2", "ARRIVE", { time: "10:07" })]; // is_late NULL → context-core가 LATE 사실을 안 만듦
    assert.ok(!viewFacts(ctx).includes("지각"));
    assert.deepEqual(srv(ctx), ["f1", "f2"]);
  });

  it("viewContext confirmFacts: true는 서버 규칙으로 고름 (채우기 없음)", () => {
    const ctx = sampleContext("BEFORE_SLEEP");
    ctx.today.facts = [fact("f1", "SLEEP"), fact("f2", "WAKE")];
    const out = block(viewContext(ctx, { confirmFacts: true }), "오늘 기록");
    assert.ok(out.includes("확인할 기록(서버가 고름): f2\n") || out.endsWith("확인할 기록(서버가 고름): f2"), out);
    assert.equal(contextVars(ctx).confirm_facts, "확인할 기록(서버가 고름): f2");
  });
});

describe("날짜 블록 — 0시 경계와 자정 뒤 대화 (설계 메모 4.1 · 헤드 H1)", () => {
  /** 기준일이 review인 BEFORE_SLEEP 컨텍스트, 지금만 바꿈 */
  const at = (now: string, review: string): Context => {
    const ctx = sampleContext("BEFORE_SLEEP", { events: false });
    ctx.session.now = now;
    ctx.session.record_date = review;
    ctx.dates = datesFor(review);
    return ctx;
  };

  it("23:50 대화: 기록 날짜 = 달력 오늘이라 자정 줄 없음", () => {
    const out = viewDates(at("2026-10-08T23:50:00+09:00", "2026-10-08"));
    assert.ok(out.startsWith("지금: 10월 8일(목) 23:50 · 기록 날짜 2026-10-08 · 자기 전 대화\n오늘 2026-10-08(목) · 내일 2026-10-09(금)"), out);
    assert.ok(!out.includes("자정이 지났지만"));
  });

  it("00:30 대화(오늘 기상 기록 없음 → 전날이 '오늘'): 자정 줄이 둘째 줄에 붙고 04:00 글자는 없음", () => {
    const out = viewDates(at("2026-10-09T00:30:00+09:00", "2026-10-08"));
    const lines = out.split("\n");
    assert.equal(lines[0], "지금: 10월 9일(금) 00:30 · 기록 날짜 2026-10-08 · 자기 전 대화");
    assert.equal(
      lines[1],
      "자정이 지났지만 잠들기 전이라 '오늘'은 2026-10-08(목) · '내일'은 2026-10-09(금)로 셈 · 이때 말하는 '오늘'이 2026-10-08(목)인지 2026-10-09(금)인지는 확인 필요",
    );
    assert.ok(lines[2]!.startsWith("오늘 2026-10-08(목) · 내일 2026-10-09(금) · 모레 2026-10-10(토)"));
    assert.ok(!out.includes("04:00"));
    assert.equal(contextVars(at("2026-10-09T00:30:00+09:00", "2026-10-08")).is_late_night, true);
    assert.equal(contextVars(at("2026-10-08T23:50:00+09:00", "2026-10-08")).is_late_night, false);
  });

  it("04:00 이후여도 기준일이 전날이면(아직 안 잠) 자정 줄이 계속 붙음 — 04:00 상수 없음", () => {
    const out = viewDates(at("2026-10-09T05:10:00+09:00", "2026-10-08"));
    assert.ok(out.includes("자정이 지났지만 잠들기 전이라"), out);
  });

  it("일요일 밤 → 월요일 00:30: '이번 주'도 확인 필요 줄", () => {
    const out = viewDates(at("2026-10-12T00:30:00+09:00", "2026-10-11"));
    assert.ok(out.includes("달력으로는 이미 월요일이라 '이번 주'·'다음 주'가 어느 주인지도 확인 필요"), out);
  });

  it("기록 날짜가 달력 오늘 · 어제 밖이면 에러, 날짜표가 어긋나도 에러", () => {
    assert.throws(() => viewDates(at("2026-10-10T09:00:00+09:00", "2026-10-08")), /달력 오늘 · 어제가 아님/);
    assert.throws(() => viewDates(at("2026-10-08T09:00:00+09:00", "2026-10-09")), /달력 오늘 · 어제가 아님/); // 미래
    const ctx = at("2026-10-09T00:30:00+09:00", "2026-10-08");
    ctx.dates.tomorrow = "2026-10-10";
    assert.throws(() => viewDates(ctx), /dates\.tomorrow/);
  });

  it("자정 뒤 대화에서도 오늘 · 내일 일정 표 · 알람 표는 기준일 기준 (viewContext 전체가 에러 없이 나옴)", () => {
    const ctx = sampleContext("BEFORE_SLEEP", { midnight: true });
    const out = viewContext(ctx, { confirmFacts: true });
    assert.ok(out.includes("### 내일 일정\n[a2] 10-09(금) 10:00 캡스톤 발표"), out);
    assert.ok(out.includes("자정이 지났지만"));
  });
});
