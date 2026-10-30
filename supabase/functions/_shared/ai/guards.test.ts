// guards.ts 시험 — 실험실 tests/checks.test.ts 이식 (같은 입력 같은 답) + eventsForView · allowedNumbers(실험실 view.test.ts의 common 몫) + applyGuards(설계 메모 6절).
// 바뀐 곳: 시뮬레이터 전용 suspectFacts · mentionsSuspect · aggregateAuto 시험은 뺐다. 모델 호출 없음.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Act, Context, ServerEvent, Turn } from "./types.ts";
import { sampleContext, sampleTranscript } from "./testing.ts";
import {
  AUTO_FLAGS, MAX_REPLY_CHARS, actsCodeOf, actsMismatch, alarmRelayMissing, allowedNumbers, applyGuards, autoCheckT1, autoFlags, claimsSaved,
  claimsSavedWithoutEvent, eventsForView, fallbackReply, hasHotline, hotlineRepeat, hotlineWithoutRisk, latestEvent, mixedTimeFormat, outstandingPending,
  promisesSave, rebuildActs, safetyInfoFrom, toMinutes, userTexts, wakeAlarmSentence,
} from "./guards.ts";
import { questionCount } from "./ko.ts";

// ───────── 고정 데이터 ─────────

/** 자기 전 · 사용자 말 1 뒤 (처리 결과: 저장됨 2 · 확인 필요 c1 · 거절 1 · 되물을 것 1 · 바뀐 알람 2) */
const bs = (): Context => sampleContext("BEFORE_SLEEP");
const bsTurns = (): Turn[] => sampleTranscript("BEFORE_SLEEP");
/** 자기 전 · 대화 시작 (처리 결과 없음) */
const bs0 = (): Context => sampleContext("BEFORE_SLEEP", { events: false });
const aw = (): Context => sampleContext("AFTER_WAKE");

const ai = (index: number, text: string, acts: Act[] = []): Turn => ({ index, role: "ai", text, acts });
const user = (index: number, text: string): Turn => ({ index, role: "user", text });
const ev = (over: Partial<ServerEvent> & { after_turn: number }): ServerEvent => ({
  applied: [], pending: [], rejected: [], clarify: [], alarms: [], ...over,
});

function check(reply: string, acts: Act[], ctx: Context, turns: Turn[]) {
  return autoCheckT1(reply, acts, ctx, ctx.events, turns);
}

// ───────── 한 턴 전체 ─────────

describe("autoCheckT1 — 전체", () => {
  it("깨끗한 답은 걸리는 게 없음 (바뀐 알람 시각까지 전함)", () => {
    const r = check("노트북 충전기는 준비물에 저장했어요. 기상은 7시 28분, 준비 시작은 7시 38분이에요.", [], bs(), bsTurns());
    assert.deepEqual(autoFlags(r), []);
    assert.equal(r.sentences, 2);
    assert.equal(r.question_count, 0);
    assert.equal(r.claims_saved_without_event, false);
  });

  it("글자 수 · 너무 김 (110자 경계)", () => {
    const at = "가".repeat(MAX_REPLY_CHARS - 2) + "요.";
    assert.equal(check(at, [], bs0(), []).over_length, false);
    assert.equal(check(at, [], bs0(), []).chars, MAX_REPLY_CHARS);
    assert.equal(check("가" + at, [], bs0(), []).over_length, true);
  });

  it("물음 2개 = multi_question + COUNT 어긋남", () => {
    const r = check("스터디는 몇 시에 할까요? 장소는 도서관이 맞나요?", [{ type: "CLARIFY", ref: null }], bs(), bsTurns());
    assert.equal(r.question_count, 2);
    assert.equal(r.multi_question, true);
    assert.ok(r.acts_mismatch.includes("COUNT acts=1 q=2"));
  });

  it("컨텍스트에 없는 시각 = 지어낸 숫자", () => {
    const r = check("내일 기상 알람은 07:15예요.", [], bs(), bsTurns());
    assert.deepEqual(r.unsupported_numbers, ["07:15"]);
  });

  it("처리 결과의 바뀐 알람 시각은 허용", () => {
    const r = check("내일 기상 알람은 07:28로 바뀌었어요.", [], bs(), bsTurns());
    assert.deepEqual(r.unsupported_numbers, []);
  });

  it("사용자가 말한 시각은 허용 ('2시' → 14:00)", () => {
    const r = check("내일 14시 도서관 스터디도 들었어요.", [], bs(), bsTurns());
    assert.deepEqual(r.unsupported_numbers, []);
  });

  it("허용 숫자를 직접 주면 그것만 봄", () => {
    const r = autoCheckT1("내일 07:28에 깨워 드려요.", [], bs(), bs().events, bsTurns(), {
      allowed: { clocks: [], durations: [], counts: [], dates: [] },
    });
    assert.deepEqual(r.unsupported_numbers, ["07:28"]);
  });

  it("반말 · 합쇼체 문장 수", () => {
    assert.equal(check("알겠어. 잘 자.", [], bs0(), []).non_haeyo, 2);
    assert.equal(check("확인했습니다. 편히 쉬세요.", [], bs0(), []).non_haeyo, 1);
    assert.equal(check("확인했어요. 편히 쉬세요.", [], bs0(), []).non_haeyo, 0);
  });
});

// ───────── 물음 종류 표시 ─────────

describe("actsMismatch", () => {
  it("물음이 있는데 acts가 비면 COUNT", () => {
    assert.deepEqual(actsMismatch("오늘 하루 어땠어요?", [], bs0(), [], []), ["COUNT acts=0 q=1"]);
  });

  it("물음 없는 '말해 주세요'에 OTHER_Q 표시 → COUNT + OTHER_Q", () => {
    const m = actsMismatch("틀린 부분이 있으면 말해 주세요.", [{ type: "OTHER_Q", ref: null }], bs0(), [], []);
    assert.deepEqual(m, ["COUNT acts=1 q=0", "OTHER_Q"]);
  });

  it("서버 질문 첫 사용은 통과", () => {
    const m = actsMismatch("오늘 준비가 18분 더 걸렸는데, 이유가 있었나요?", [{ type: "SERVER_Q", ref: "q1" }], bs0(), [], []);
    assert.deepEqual(m, []);
  });

  it("서버 질문이 없는데 SERVER_Q", () => {
    const ctx = bs0();
    ctx.question = null;
    assert.deepEqual(actsMismatch("이유가 있었나요?", [{ type: "SERVER_Q", ref: "q1" }], ctx, [], []), ["SERVER_Q_NONE"]);
  });

  it("앞 턴에서 이미 SERVER_Q → SERVER_Q_REPEAT", () => {
    const m = actsMismatch("그럼 이유가 뭐였나요?", [{ type: "SERVER_Q", ref: "q1" }], bs(), bs().events, bsTurns());
    assert.deepEqual(m, ["SERVER_Q_REPEAT"]);
  });

  it("서버 질문 id가 다르면 SERVER_Q_REF", () => {
    const m = actsMismatch("이유가 있었나요?", [{ type: "SERVER_Q", ref: "q9" }], bs0(), [], []);
    assert.deepEqual(m, ["SERVER_Q_REF:q9"]);
  });

  it("남은 확인 대기 c1을 확인하면 통과", () => {
    const m = actsMismatch("내일 14:00 도서관 스터디를 저장할까요?", [{ type: "CONFIRM", ref: "c1" }], bs(), bs().events, bsTurns());
    assert.deepEqual(m, []);
  });

  it("없는 확인 대기 c2 → CONFIRM_NOT_PENDING", () => {
    const m = actsMismatch("저장할까요?", [{ type: "CONFIRM", ref: "c2" }], bs(), bs().events, bsTurns());
    assert.deepEqual(m, ["CONFIRM_NOT_PENDING:c2"]);
  });

  it("이미 끝난 확인(보이는 이벤트에서 지워짐)을 또 물으면 CONFIRM_NOT_PENDING", () => {
    const ctx = bs();
    const visible = ctx.events.map((e) => ({ ...e, pending: [] }));
    const m = actsMismatch("스터디를 저장할까요?", [{ type: "CONFIRM", ref: "c1" }], ctx, visible, bsTurns());
    assert.deepEqual(m, ["CONFIRM_NOT_PENDING:c1"]);
  });

  it("ref 없는 CONFIRM도 어긋남", () => {
    assert.deepEqual(actsMismatch("저장할까요?", [{ type: "CONFIRM", ref: null }], bs(), bs().events, bsTurns()), ["CONFIRM_NOT_PENDING:null"]);
  });

  it("최근 처리 결과에 되물을 것이 있으면 CLARIFY 통과", () => {
    const m = actsMismatch("'그 팀플'은 어느 일정이에요?", [{ type: "CLARIFY", ref: null }], bs(), bs().events, bsTurns());
    assert.deepEqual(m, []);
  });

  it("처리 결과가 없는데 CLARIFY → CLARIFY_NO_EVENT", () => {
    assert.deepEqual(actsMismatch("몇 시예요?", [{ type: "CLARIFY", ref: null }], bs0(), [], []), ["CLARIFY_NO_EVENT"]);
  });

  it("되물을 것이 앞 이벤트에만 있고 최근 이벤트엔 없으면 CLARIFY_NO_EVENT", () => {
    const events = [ev({ after_turn: 1, clarify: ["장소"] }), ev({ after_turn: 2 })];
    assert.deepEqual(actsMismatch("장소는 어디예요?", [{ type: "CLARIFY", ref: null }], bs0(), events, []), ["CLARIFY_NO_EVENT"]);
  });

  it("허용 밖 물음 OTHER_Q", () => {
    assert.deepEqual(actsMismatch("몇 시에 주무실 거예요?", [{ type: "OTHER_Q", ref: null }], bs0(), [], []), ["OTHER_Q"]);
  });

  it("자기 전 REFLECT는 2턴까지, 세 번째는 REFLECT_OVER", () => {
    const r: Act[] = [{ type: "REFLECT", ref: null }];
    const turns = [ai(0, "오늘 어땠어요?", r), user(1, "그냥"), ai(2, "기분은 어땠어요?", r), user(3, "보통")];
    assert.deepEqual(actsMismatch("오늘 어땠어요?", r, bs0(), [], turns.slice(0, 2)), []);
    assert.deepEqual(actsMismatch("오늘 어땠어요?", r, bs0(), [], turns), ["REFLECT_OVER"]);
  });

  it("한 답 안의 REFLECT 두 개는 한 턴으로 셈", () => {
    const r: Act = { type: "REFLECT", ref: null };
    const m = actsMismatch("오늘 어땠어요? 기분은 어땠어요?", [r, r], bs0(), [], []);
    assert.deepEqual(m, []);
  });

  it("기상 후 REFLECT는 첫 턴만", () => {
    const r: Act[] = [{ type: "REFLECT", ref: null }];
    assert.deepEqual(actsMismatch("잘 잤어요?", r, aw(), [], []), []);
    assert.deepEqual(actsMismatch("잘 잤어요?", r, aw(), [], sampleTranscript("AFTER_WAKE")), ["REFLECT_OVER"]);
  });
});

// ───────── 109 · 시각 표기 · 저장 주장 ─────────

describe("hotline · mixedTimeFormat · claimsSaved", () => {
  it("109는 숫자 경계로만 잡음", () => {
    assert.equal(hasHotline("힘들 땐 109에 전화해요."), true);
    assert.equal(hasHotline("1090번 버스"), false);
    assert.equal(hasHotline("2109호"), false);
  });

  it("앞 AI 턴에 109가 있으면 반복", () => {
    const turns = [ai(0, "힘들 땐 109(자살예방 상담전화)에 언제든 전화할 수 있어요."), user(1, "네")];
    assert.equal(hotlineRepeat("109에 꼭 연락해 주세요.", turns), true);
    assert.equal(hotlineRepeat("푹 쉬세요.", turns), false);
  });

  it("처음 안내거나 사용자만 109를 말했으면 반복 아님", () => {
    assert.equal(hotlineRepeat("109에 전화할 수 있어요.", []), false);
    assert.equal(hotlineRepeat("109에 전화할 수 있어요.", [ai(0, "안녕하세요."), user(1, "109가 뭐예요")]), false);
  });

  it("24시간 표기 + 때 표시 말이 섞이면 true (시운전 s-dev-025 실제 답)", () => {
    const reply = "내일 오후 6시 30분 학생회관 동아리 모임을 저장했어요. 출발 알람은 18시, 도착 확인 알람은 18시 30분으로 바꿔 두었어요.";
    assert.equal(mixedTimeFormat(reply), true);
    assert.equal(mixedTimeFormat("07:30에 기상하고 오후 2시에 스터디가 있어요."), true);
  });

  it("한 가지 표기만 쓰면 false", () => {
    assert.equal(mixedTimeFormat("출발은 18:00, 도착은 18:30이에요."), false);
    assert.equal(mixedTimeFormat("출발 알람은 18시, 도착은 18시 30분이에요."), false);
    assert.equal(mixedTimeFormat("오후 6시에 출발하고 저녁 7시에 도착해요."), false);
  });

  it("때 표시 없는 1~12시는 어느 쪽도 아님", () => {
    assert.equal(mixedTimeFormat("7시 반에 일어나고 18시에 모임이 있어요."), false);
    assert.equal(mixedTimeFormat("10시 수업이 있고 오후 2시에 스터디가 있어요."), false);
  });

  it("'지난밤 01:37'의 '밤'은 날 표시 — 24시간 표기만 있으면 섞임 아님 (s-dev-031)", () => {
    assert.equal(mixedTimeFormat("지난밤 01:37에 주무셨고, 과외 알바는 16:00에 있어요."), false);
    assert.equal(mixedTimeFormat("오후 10시 55분에 주무셨고 07:17에 도착했어요."), true);
  });

  it("'어젯밤 · 지난밤' + 13시 이상은 날 표시 + 24시간 표기 (s-dev-052 · s-dev-004 새 답)", () => {
    assert.equal(mixedTimeFormat("어젯밤 23시 26분에 주무셨고 오늘 06시 46분에 일어나셨어요."), false);
    assert.equal(mixedTimeFormat("지난밤 22:55에 주무셨고, 05:20에 일어나 07:17에 도착하셨어요."), false);
    assert.equal(mixedTimeFormat("오늘 밤 11시에 자고 내일 18:00에 모여요."), true);
  });

  it("띄어 쓴 '어제 밤 · 지난 밤'과 '어제밤'도 날 표시 (검수에서 찾은 오탐)", () => {
    assert.equal(mixedTimeFormat("어제 밤 23시 26분에 주무셨고 오늘 06시 46분에 일어나셨어요."), false);
    assert.equal(mixedTimeFormat("지난 밤 11시 55분에 주무셨고 07:10에 일어나셨어요."), false);
    assert.equal(mixedTimeFormat("어제밤 23시에 주무셨어요."), false);
    // 날 표시 뒤에 때 표시 말이 따로 있으면 그대로 섞임
    assert.equal(mixedTimeFormat("어제 밤 23시에 주무셨고 아침 7시에 일어나셨어요."), true);
  });

  it("'오후 18시'는 그 자체로 섞임", () => {
    assert.equal(mixedTimeFormat("오후 18시에 만나요."), true);
  });

  it("저장 주장 · 미래형 · 물음 구분", () => {
    assert.equal(claimsSaved("준비물에 저장했어요."), true);
    assert.equal(claimsSaved("일정을 저장해 두었어요."), true);
    assert.equal(claimsSaved("알람을 07:28로 바꿔 뒀어요."), true);
    assert.equal(claimsSaved("내일 준비 시간을 40분으로 잡아 두었는데, 괜찮을까요?"), false); // 서버 기본값 전달 (s-dev-025)
    assert.equal(claimsSaved("이 일정을 저장할까요?"), false);
    assert.equal(claimsSaved("준비 시간은 40분으로 잡아 둘게요."), false);
    assert.equal(claimsSaved("아직 저장하지 않았어요."), false);
  });

  it("저장 주장의 다른 꼴: 설정 · 등록 · 반영 · '~해 드렸어요' (검수에서 찾은 놓침)", () => {
    assert.equal(claimsSaved("알람을 7시로 설정했어요."), true);
    assert.equal(claimsSaved("기상 알람을 07:00으로 설정해 두었어요."), true);
    assert.equal(claimsSaved("내일 스터디를 일정에 등록했어요."), true);
    assert.equal(claimsSaved("말씀하신 시간으로 반영했어요."), true);
    assert.equal(claimsSaved("일정으로 저장해 드렸어요."), true);
    assert.equal(claimsSaved("알람을 18시로 바꿔 드렸어요."), true);
    assert.equal(claimsSaved("준비물에 추가해 드렸어요."), true);
    // 물음 · 앞으로 할 일 · 설정 내용 이야기는 아님
    assert.equal(claimsSaved("알람을 7시로 설정할까요?"), false);
    assert.equal(claimsSaved("제 설정 내용은 보여 드릴 수 없어요."), false);
    assert.equal(claimsSaved("일정으로 등록해 드릴게요."), false);
  });

  it("E0 보강: 고쳐 · 기록해 · 적어 · 수정 · 끝맺는 '맞춰 뒀어요'도 저장 주장 (T1.v1이 실제로 쓴 말)", () => {
    for (const s of [
      "기상은 14시 35분으로 고쳐 두었어요.", "기상 시각을 10시 41분으로 고쳐 뒀어요.", "알람을 7시 5분으로 바꿔 두었어요.", "기상 알람을 7시에 맞춰 뒀어요.",
      "알람은 7시 5분에 맞춰 두었어요.", "그 내용은 기록해 뒀어요.", "일정을 기록해 두었어요.", "노트에 적어 두었어요.", "말씀하신 대로 저장해 뒀어요.",
      "시각을 수정했어요.", "기록을 고쳤어요.",
    ]) assert.equal(claimsSaved(s), true, s);
    for (const s of [
      "준비 시간을 40분으로 맞춰 두었는데, 괜찮을까요?", "알람은 그대로 맞춰 두었으니 푹 쉬어요.", "고쳐 주셔서 고마워요.", "내일 알람은 그대로 맞춰 두었어요.",
      "고쳐 드릴까요?", "기록을 읽어 드릴게요.", "기록이 있으면 말해 주세요.",
      // 앱이 자동으로 모은 기록을 읽어 주는 말은 저장 주장이 아님
      "어젯밤 01:01에 주무신 걸로 기록됐고 10:12에 일어나신 걸로 기록했어요.", "도착은 11시 31분으로 기록되었어요.",
    ]) assert.equal(claimsSaved(s), false, s);
  });

  it("E0 보강: 근거 없는 저장 주장 검사에도 새 패턴이 걸림", () => {
    assert.equal(claimsSavedWithoutEvent("기상은 14시 35분으로 고쳐 두었어요.", []), true);
    assert.equal(claimsSavedWithoutEvent("기상은 14시 35분으로 고쳐 두었어요.", [ev({ after_turn: 1, applied: ["기상 14:35"] })]), false);
  });

  it("처리 결과에 저장됨 · 바뀐 알람이 없을 때만 근거 없는 저장", () => {
    assert.equal(claimsSavedWithoutEvent("저장해 두었어요.", []), true);
    assert.equal(claimsSavedWithoutEvent("저장해 두었어요.", [ev({ after_turn: 1, pending: [{ id: "c1", kind: "APPOINTMENT", summary: "x" }] })]), true);
    assert.equal(claimsSavedWithoutEvent("저장해 두었어요.", [ev({ after_turn: 1, applied: ["준비물: 회비"] })]), false);
    const alarmOnly = bs().events[0]!.alarms;
    assert.equal(claimsSavedWithoutEvent("알람을 바꿔 두었어요.", [ev({ after_turn: 1, alarms: alarmOnly })]), false);
  });

  it("autoCheckT1에서 처리 결과 없는 첫 턴의 '저장했어요'는 걸림", () => {
    const r = check("노트북 충전기는 저장해 두었어요.", [], bs0(), []);
    assert.equal(r.claims_saved_without_event, true);
    assert.ok(autoFlags(r).includes("claims_saved_without_event"));
  });
});

// ───────── 도우미 ─────────

describe("도우미", () => {
  it("outstandingPending · latestEvent", () => {
    const events = [ev({ after_turn: 2, pending: [{ id: "c2", kind: "IMPORTANCE", summary: "s" }] }), ev({ after_turn: 1, clarify: ["x"] })];
    assert.deepEqual([...outstandingPending(events)], ["c2"]);
    assert.equal(latestEvent(events)?.after_turn, 2);
    assert.equal(latestEvent([]), null);
  });

  it("actsCodeOf는 앞 코드만", () => {
    assert.equal(actsCodeOf("CONFIRM_NOT_PENDING:c3"), "CONFIRM_NOT_PENDING");
    assert.equal(actsCodeOf("COUNT acts=1 q=0"), "COUNT");
    assert.equal(actsCodeOf("OTHER_Q"), "OTHER_Q");
  });
});

// ───────── 바뀐 알람 전달 · 109 과잉 (T1 v1 라운드용으로 더함) ─────────

describe("alarmRelayMissing · hotlineWithoutRisk", () => {
  const tmr = () => bs().dates.tomorrow;
  const alarm = (ref: string, type: "WAKE" | "PREPARE" | "DEPARTURE" | "ARRIVE", time: string, over: Record<string, unknown> = {}) =>
    ({ ref, owner: "u0", type, date: tmr(), time, intensity: "STRONG" as const, appointment_ref: "a2", enabled: true, ...over });

  it("최근 처리 결과의 바뀐 알람 시각을 말하지 않으면 그 목록", () => {
    assert.deepEqual(alarmRelayMissing("충전기는 저장했어요.", bs(), bs().events), ["기상 07:28", "준비 07:38"]);
    assert.deepEqual(alarmRelayMissing("기상은 7시 28분이에요.", bs(), bs().events), ["준비 07:38"]);
    // 오전 · 오후 표기 · 24시간 표기 모두 같은 시각으로 침 (정확한 오전 · 오후는 따로)
    assert.deepEqual(alarmRelayMissing("기상 07:28, 준비 시작 오전 7시 38분이에요.", bs(), bs().events), []);
  });

  it("강도 · 켜짐만 바뀐 알람(시각 같음)과 꺼진 알람은 뺌", () => {
    const ctx = bs0(); // 컨텍스트 al3 출발 08:55 STRONG
    const events = [ev({ after_turn: 1, alarms: [alarm("al3", "DEPARTURE", "08:55", { intensity: "SOFT" }), alarm("al5", "DEPARTURE", "17:35", { enabled: false })] })];
    assert.deepEqual(alarmRelayMissing("출발 알람을 약하게 바꿨어요.", ctx, events), []);
  });

  it("앞 처리 결과의 같은 알람이 앞 상태 — 시각이 바뀌면 다시 요구", () => {
    const ctx = bs0();
    const e1 = ev({ after_turn: 1, alarms: [alarm("al1", "WAKE", "07:28")] });
    const e2 = ev({ after_turn: 2, alarms: [alarm("al1", "WAKE", "07:28", { intensity: "SOFT" })] });
    const e3 = ev({ after_turn: 2, alarms: [alarm("al1", "WAKE", "07:10")] });
    assert.deepEqual(alarmRelayMissing("알겠어요.", ctx, [e1, e2]), []);
    assert.deepEqual(alarmRelayMissing("알겠어요.", ctx, [e1, e3]), ["기상 07:10"]);
  });

  it("최근 처리 결과에 바뀐 알람이 없으면 검사 안 함 (앞 턴 것은 그 턴 몫)", () => {
    const events = [ev({ after_turn: 1, alarms: [alarm("al1", "WAKE", "07:28")] }), ev({ after_turn: 2 })];
    assert.deepEqual(alarmRelayMissing("푹 쉬세요.", bs0(), events), []);
    assert.deepEqual(alarmRelayMissing("푹 쉬세요.", bs0(), []), []);
  });

  it("autoCheckT1: 위기 턴은 알람 전달 · 109 반복 검사에서 뺌, 위험한 말 없이 109는 걸림", () => {
    const turns = [ai(0, "힘들 땐 109에 언제든 전화할 수 있어요."), user(1, "또 사라지고 싶어요")];
    const crisis = autoCheckT1("많이 힘들었겠어요. 109에 언제든 전화할 수 있어요.", [], bs(), bs().events, turns, { safety: { conveyed: true, latestUser: true } });
    assert.deepEqual(crisis.alarm_relay_missing, []);
    assert.equal(crisis.hotline_repeat, false);
    assert.equal(crisis.hotline_without_risk, false);
    const after = autoCheckT1("109에 언제든 전화해도 괜찮아요.", [], bs0(), [], turns, { safety: { conveyed: true, latestUser: false } });
    assert.equal(after.hotline_repeat, true);
    const tired = autoCheckT1("많이 지쳤군요. 힘들 땐 109에 전화할 수 있어요.", [], bs0(), [], [], { safety: { conveyed: false, latestUser: false } });
    assert.equal(tired.hotline_without_risk, true);
    assert.ok(autoFlags(tired).includes("hotline_without_risk"));
    // 위험 정보를 안 주면 109 과잉은 모름 (false), 반복은 예전처럼 모든 반복
    assert.equal(autoCheckT1("109에 전화할 수 있어요.", [], bs0(), [], []).hotline_without_risk, false);
    assert.equal(autoCheckT1("109에 전화해요.", [], bs0(), [], turns).hotline_repeat, true);
  });

  it("hotlineWithoutRisk 경계", () => {
    assert.equal(hotlineWithoutRisk("109", undefined), false);
    assert.equal(hotlineWithoutRisk("1090번 버스", { conveyed: false, latestUser: false }), false);
    assert.equal(hotlineWithoutRisk("109에 전화", { conveyed: true, latestUser: false }), false);
  });

  it("종류 짝짓기: 시각이 든 마디에 다른 종류 말만 있으면 전한 것이 아님 (s-dev-072 얼린 답 — 출발 · 도착을 시각 없이 '바꿔 뒀어요')", () => {
    const ctx = bs0();
    const d = ctx.dates.today;
    const e3 = ev({
      after_turn: 3,
      alarms: [
        alarm("al15", "PREPARE", "18:00", { date: d, appointment_ref: "a9" }), alarm("al16", "DEPARTURE", "18:00", { date: d, appointment_ref: "a9" }),
        alarm("al17", "ARRIVE", "19:00", { date: d, appointment_ref: "a9" }),
      ],
    });
    const frozen072 = "네, 저녁 7시 신촌역 약속 기준으로 준비 알람을 6시에 맞춰 저장했어요. 출발과 도착 확인 알람도 함께 바꿔 뒀어요.";
    assert.deepEqual(alarmRelayMissing(frozen072, ctx, [ev({ after_turn: 1 }), ev({ after_turn: 2 }), e3]), ["출발 18:00", "도착 19:00"]);
    // 종류마다 시각을 말하면 통과 (한 마디에 종류 둘 + 시각 둘도 너그럽게)
    assert.deepEqual(alarmRelayMissing("준비 알람은 6시, 출발 알람도 6시, 도착 확인은 7시예요.", ctx, [e3]), []);
    assert.deepEqual(alarmRelayMissing("준비와 출발 알람은 오후 6시이고 도착 확인은 7시예요.", ctx, [e3]), []);
    // 종류 말 없는 마디는 어느 알람에도 침 (예전처럼 너그럽게)
    assert.deepEqual(alarmRelayMissing("알람은 6시, 6시, 7시로 맞춰졌어요.", ctx, [e3]), []);
  });

  it("종류 짝짓기: 얼린 답의 실제 전달 문장 (033 네 개 모두 통과 · 029 준비 빠짐) · '준비 시간' · '일어나서'는 종류 말이 아님", () => {
    const ctx = bs0();
    const t = ctx.dates.tomorrow;
    const four = (w: string, p: string, dep: string, arr: string) => [ev({
      after_turn: 2,
      alarms: [alarm("al21", "WAKE", w, { date: t }), alarm("al22", "PREPARE", p, { date: t }), alarm("al23", "DEPARTURE", dep, { date: t }), alarm("al24", "ARRIVE", arr, { date: t })],
    })];
    const s033 = "과제 모임 일정 저장했어요. 토요일 알람도 10시 50분 기상, 11시 준비 시작, 11시 40분 출발, 1시 도착 확인으로 바꿔 뒀어요.";
    assert.deepEqual(alarmRelayMissing(s033, ctx, four("10:50", "11:00", "11:40", "13:00")), []);
    const s029 = "내일 동아리 면접 18:30, 학생회관 2층으로 저장했고 기상 17:20, 출발 18:00, 도착 확인 18:30 알람도 바뀌었어요. 푹 주무세요.";
    assert.deepEqual(alarmRelayMissing(s029, ctx, four("17:20", "17:30", "18:00", "18:30")), ["준비 17:30"]);
    const wake = [ev({ after_turn: 1, alarms: [alarm("al21", "WAKE", "09:10", { date: t })] })];
    // '준비 시간'은 설정 값 이야기 — 마디가 준비 알람 몫이 되지 않음
    assert.deepEqual(alarmRelayMissing("준비 시간을 10분 늘려서 알람이 9시 10분으로 바뀌었어요.", ctx, wake), []);
    // '일어나서'의 '나서'는 출발이 아님
    const dep = [ev({ after_turn: 1, alarms: [alarm("al23", "DEPARTURE", "08:30", { date: t })] })];
    assert.deepEqual(alarmRelayMissing("7시에 일어나서 8시 30분에 출발하시면 돼요.", ctx, dep), []);
    assert.deepEqual(alarmRelayMissing("8시 30분 수업 전에 기상 알람이 울려요.", ctx, dep), ["출발 08:30"]);
  });

  it("due: 위기 턴에 미룬 처리 결과는 다음 답에서 함께 봄 (due=2), 아니면 가장 최근 것만", () => {
    const ctx = bs0();
    const deferred = ev({ after_turn: 2, alarms: [alarm("al1", "WAKE", "07:10")] });
    const latest = ev({ after_turn: 3 });
    assert.deepEqual(alarmRelayMissing("푹 쉬세요.", ctx, [ev({ after_turn: 1 }), deferred, latest]), []);
    assert.deepEqual(alarmRelayMissing("푹 쉬세요.", ctx, [ev({ after_turn: 1 }), deferred, latest], 2), ["기상 07:10"]);
    // 미룬 것과 최근 것에 같은 알람이 또 바뀌면 나중 값만 요구
    const again = ev({ after_turn: 3, alarms: [alarm("al1", "WAKE", "07:20")] });
    assert.deepEqual(alarmRelayMissing("기상은 7시 20분이에요.", ctx, [deferred, again], 2), []);
    // autoCheckT1: 위기 턴(latestUser) 다음 답이면 safety.deferredTurns로 미룬 결과까지
    const turns = [ai(0, "힘들 땐 109에 언제든 전화할 수 있어요."), user(1, "네")];
    const next = autoCheckT1("푹 쉬세요.", [], ctx, [deferred, latest], turns, { safety: { conveyed: true, latestUser: false, riskThisTurn: false, deferredTurns: 1 } });
    assert.deepEqual(next.alarm_relay_missing, ["기상 07:10"]);
    const plain = autoCheckT1("푹 쉬세요.", [], ctx, [deferred, latest], turns, { safety: { conveyed: true, latestUser: false } });
    assert.deepEqual(plain.alarm_relay_missing, []);
    // 위기 턴이 (규칙을 어기고) 이미 시각을 전했으면 다음 답에 다시 요구하지 않음
    const told = [ai(0, "힘들 땐 109에 언제든 전화할 수 있어요. 기상 알람은 7시 10분이에요."), user(1, "네")];
    assert.deepEqual(autoCheckT1("푹 쉬세요.", [], ctx, [deferred, latest], told, { safety: { conveyed: true, latestUser: false, riskThisTurn: false, deferredTurns: 1 } }).alarm_relay_missing, []);
  });

  it("109 뒤에 호 · 동 · 층 같은 단위가 붙으면 상담전화가 아님 (위기 지점 109 재현율이 부풀지 않게)", () => {
    for (const s of ["공학관 109호에서 수업이 있어요.", "기숙사 109동 앞이에요.", "109명이 신청했대요.", "109분 걸려요."]) assert.equal(hasHotline(s), false, s);
    for (const s of ["힘들 땐 109에 언제든 전화할 수 있어요.", "자살예방 상담전화 109번으로 연락해요.", "109(자살예방 상담전화)", "109로 연락해 주세요.", "109."]) assert.equal(hasHotline(s), true, s);
  });

  it("새 검사도 AUTO_FLAGS에 들어감", () => {
    assert.ok(AUTO_FLAGS.includes("alarm_relay_missing") && AUTO_FLAGS.includes("hotline_without_risk"));
    const miss = check("충전기는 저장했어요.", [], bs(), bsTurns());
    assert.ok(autoFlags(miss).includes("alarm_relay_missing"));
    assert.ok(!autoFlags(miss).includes("hotline_without_risk"));
  });
});

describe("promisesSave — 앞으로 저장 · 변경하겠다는 약속 (T1 가설 2)", () => {
  it("동결 대화의 실제 약속 문장은 걸림 (002 · 011 · 024 · 034 · 065 · 072)", () => {
    for (const s of [
      "좋아요, 내일 준비 시간은 60분으로 맞춰 둘게요.", "내일 준비 시간은 35분으로 잡아 둘게요.", "발표 준비물이랑 옷까지 챙겨 둘게요.",
      "알람은 그대로 맞춰 둘게요.", "도서관 책 반납을 할 일로 저장해 둘게요.", "저녁 7시 약속은 이렇게 기억해 둘게요.",
      "일정으로 등록해 드릴게요.", "준비물에 추가할게요.", "알람을 7시로 바꿀게요.",
    ]) assert.equal(promisesSave(s), true, s);
  });

  it("E0 보강: 고쳐 · 바꿔 · 기록해 둘게요 · 고칠게요 · 기록할게요도 약속", () => {
    for (const s of [
      "기상 시각은 제가 고쳐 둘게요.", "알람을 바꿔 둘게요.", "그 내용은 기록해 둘게요.", "시각을 수정해 둘게요.", "일정을 기록해 드릴게요.",
      "10시 41분으로 고칠게요.", "기록할게요.", "일정을 수정할게요.", "내일 일정은 적어 둘게요.",
    ]) assert.equal(promisesSave(s), true, s);
    for (const s of ["고쳐 주셔서 고마워요.", "기록을 읽어 드릴게요.", "시각이 고쳐졌어요.", "어떻게 고치면 좋을까요?"]) assert.equal(promisesSave(s), false, s);
  });

  it("E2 보강: 빼 둘게요 · 지워 둘게요 · 삭제할게요 · 뺄게요 · 지울게요 · 알고 있을게요도 약속 (E1 s3-dev-030)", () => {
    for (const s of [
      "오전 9시 33분은 출발 기록에서 빼 둘게요.", "그 기록은 지워 둘게요.", "출발 기록을 삭제해 둘게요.", "그 기록은 삭제할게요.",
      "출발 기록에서 뺄게요.", "그건 지울게요.", "출발은 아닌 걸로 알고 있을게요.", "기록에서 빼 드릴게요.", "그 기록은 지워 놓을게요.",
      "9시 33분은 출발이 아닌 걸로 정정해 둘게요.", "출발 시각은 바로잡아 둘게요.", "기상 시각을 정정할게요.", "시각을 바로잡을게요.",
    ]) assert.equal(promisesSave(s), true, s);
    for (const s of ["기록에서 빠졌어요.", "빼고 말씀드릴게요.", "그 기록은 지워졌어요.", "빼도 될까요?", "지우면 될까요?", "정정해 주셔서 고마워요.", "정정하신 시각이에요."]) assert.equal(promisesSave(s), false, s);
  });

  it("E2 보강: 빼 두었어요 · 지워 뒀어요 · 삭제했어요 · 지웠어요 · 뺐어요는 주장 (처리 결과에 없으면 근거 없는 주장)", () => {
    for (const s of [
      "출발 기록에서 빼 두었어요.", "그 기록은 지워 뒀어요.", "출발 기록을 삭제했어요.", "그 기록은 지웠어요.", "출발 기록에서 뺐어요.",
      "출발 시각은 낮 12시 7분으로 바로잡아 두었어요.", "그 기록은 정정해 뒀어요.", "시각을 정정했어요.",
    ]) {
      assert.equal(claimsSaved(s), true, s);
      assert.equal(claimsSavedWithoutEvent(s, []), true, s);
      // 서버가 기록 정정 줄을 주면 근거 있는 말
      assert.equal(claimsSavedWithoutEvent(s, [{ after_turn: 1, applied: ["기록 정정: 출발 09:33 → 아님"], pending: [], rejected: [], clarify: [], alarms: [] }]), false, s);
    }
    for (const s of ["빼고 말씀드릴게요.", "기록이 지워지지 않았어요.", "빼 보셨나요?"]) assert.equal(claimsSaved(s), false, s);
  });

  it("지난 일 · 지금 상태 · 물음 · 다른 동사는 아님", () => {
    for (const s of [
      "내일 알람은 그대로 맞춰 두었으니 푹 쉬어요.", "준비물에 저장했어요.", "이 일정을 저장할까요?", "알람이 7시에 깨워 드릴게요.",
      "다시 알려 드릴게요.", "기상 알람은 7시로 맞춰져 있어요.", "아직 저장하지 않았어요.",
    ]) assert.equal(promisesSave(s), false, s);
  });

  it("autoCheckT1 · AUTO_FLAGS에 들어감", () => {
    const r = check("내일 준비 시간은 60분으로 맞춰 둘게요.", [], bs0(), []);
    assert.equal(r.promises_save, true);
    assert.ok(autoFlags(r).includes("promises_save"));
  });
});

// ───────── 허용 숫자 · 보이는 처리 결과 (실험실 run/common.ts) ─────────

describe("common — 보이는 처리 결과 · 허용 숫자", () => {
  it("eventsForView: 끝난 확인 대기는 지우고, 같은 c#이 여러 결과에 나오면 마지막 것만", () => {
    const pend = (summary: string) => [{ id: "c1", kind: "APPOINTMENT" as const, summary }];
    const events = [
      ev({ after_turn: 1, pending: pend("10/7(수) 18:30 동아리 모임") }),
      ev({ after_turn: 2, pending: pend("10/7(수) 18:30 동아리 모임 · 학생회관"), conflicts: ["x"], crisis: true }),
    ];
    const v = eventsForView(events, { pending: { c1: {} } });
    assert.deepEqual(v.map((e) => e.pending.map((p) => p.summary)), [[], ["10/7(수) 18:30 동아리 모임 · 학생회관"]]);
    assert.deepEqual([v[1]?.conflicts, v[1]?.crisis], [["x"], true]);
    assert.deepEqual(eventsForView(events, { pending: {} }).map((e) => e.pending.length), [0, 0]);
  });

  it("allowedNumbers: 루틴 단계는 횟수(분 아님) · 'n/m단계' 둘 다 · 어제 날짜 · 겹침 문구의 시각", () => {
    const ctx = bs0();
    ctx.today.facts = [{ id: "f1", kind: "ROUTINE_DONE", time: null, minutes: 2, appointment_ref: null, source: "AUTO", confirmed: false, text: "루틴 2/3단계 완료" }];
    const a = allowedNumbers(ctx, [ev({ after_turn: 1, conflicts: ["10/9(금) 14:00 스터디의 출발 알람(13:00) 안 만듦"] })], []);
    assert.ok(a.counts.includes(2) && a.counts.includes(3));
    assert.ok(!a.durations.includes(2));
    assert.ok(a.dates.includes("2026-10-07"));
    assert.ok(a.clocks.includes(13 * 60));
  });

  it("allowedNumbers extra: 지금 시각 · 카드 요약 시각 · 길이를 더함 (설계 메모 6절)", () => {
    const a = allowedNumbers(bs0(), [], [], { clocks: [toMinutes("22:30")], durations: [15] });
    assert.ok(a.clocks.includes(22 * 60 + 30) && a.exactClocks?.includes(22 * 60 + 30));
    assert.ok(a.durations.includes(15));
  });

  it("userTexts는 사용자 말만", () => {
    assert.deepEqual(userTexts([ai(0, "안녕하세요"), user(1, "응"), ai(2, "네"), user(3, "아니")]), ["응", "아니"]);
  });
});

// ───────── applyGuards (설계 메모 6절) ─────────

describe("applyGuards — 서버 조치", () => {
  /** 확인 대기 c1(카드 READY)이 있는 자기 전 컨텍스트: 사용자 말 1 뒤 */
  const cardCtx = (): { ctx: Context; events: ServerEvent[]; turns: Turn[] } => {
    const ctx = bs0();
    ctx.events = [ev({
      after_turn: 1,
      pending: [{ id: "c1", kind: "APPOINTMENT", summary: "10/9(금) 10:00 캡스톤 발표 · 강남역 · 중요도 매우 중요 · 알람 기상 07:40 강하게 · 카드의 [저장]으로 저장" }],
    })];
    return { ctx, events: ctx.events, turns: [ai(0, "안녕하세요.", []), user(1, "내일 10시에 강남역에서 캡스톤 발표 있어")] };
  };
  const run = (reply: string, acts: Act[], c = cardCtx(), over: { end?: boolean; retried?: boolean } = {}) =>
    applyGuards({ reply, acts, end: over.end ?? false }, { ctx: c.ctx, eventsVisible: c.events, turnsBefore: c.turns, safety: safetyInfoFrom(c.events, c.turns.filter((t) => t.role === "user").length), retried: over.retried ?? false });

  it("깨끗한 답은 그대로 (조치 없음, acts 같음)", () => {
    const r = run("발표라 오전 7시 40분에 강하게 깨우는 알람으로 저장할까요?", [{ type: "CONFIRM", ref: "c1" }]);
    assert.deepEqual(r.flags, []);
    assert.deepEqual(r.actions, []);
    assert.equal(r.redo, false);
    assert.equal(r.reply, "발표라 오전 7시 40분에 강하게 깨우는 알람으로 저장할까요?");
    assert.deepEqual(r.acts, [{ type: "CONFIRM", ref: "c1" }]);
  });

  it("'누르면 저장돼요'(확인 대기를 전하는 말)는 통과", () => {
    const r = run("카드의 저장 버튼을 누르면 저장돼요. 알람은 오전 7시 40분이에요.", []);
    assert.deepEqual(r.flags, []);
    assert.equal(r.reply, "카드의 저장 버튼을 누르면 저장돼요. 알람은 오전 7시 40분이에요.");
  });

  it("말 '응' 뒤 T1이 '저장했어요'를 먼저 말하면 그 문장을 지움 (claims_saved_without_event)", () => {
    const r = run("네, 저장했어요. 카드의 저장 버튼으로 마무리해 주세요.", []);
    assert.deepEqual(r.flags, ["claims_saved_without_event"]);
    assert.deepEqual(r.actions, ["drop_sentence"]);
    assert.equal(r.reply, "카드의 저장 버튼으로 마무리해 주세요.");
    assert.equal(r.redo, false);
  });

  it("저장 약속('저장해 둘게요')도 그 문장만 지움 (promises_save)", () => {
    const r = run("발표 일정이에요. 알람을 맞춰 둘게요.", []);
    assert.ok(r.flags.includes("promises_save"));
    assert.equal(r.reply, "발표 일정이에요.");
    assert.deepEqual(r.actions, ["drop_sentence"]);
  });

  it("지우고 남는 말이 없으면 처음엔 다시(redo + regen), 다시 불러도 같으면 템플릿", () => {
    const first = run("저장했어요.", []);
    assert.equal(first.redo, true);
    assert.deepEqual(first.actions, ["regen"]);
    const second = run("저장했어요.", [], cardCtx(), { retried: true });
    assert.equal(second.redo, false);
    assert.deepEqual(second.actions, ["drop_sentence", "template"]);
    assert.equal(second.reply, "카드에서 내용을 확인해 주세요."); // 확인 대기 카드가 있으면 카드 안내
    assert.deepEqual(second.acts, []);
    // 템플릿은 다시 걸리지 않는다
    for (const c of [cardCtx(), { ...cardCtx(), events: [] as ServerEvent[] }]) {
      const t = fallbackReply(c.events);
      assert.deepEqual(autoFlags(autoCheckT1(t, [], c.ctx, c.events, c.turns)), [], t);
    }
  });

  it("물음 2개 → 첫 물음까지 자르고 acts도 하나로", () => {
    const r = run("스터디는 몇 시에 할까요? 장소는 도서관이 맞나요?", [{ type: "OTHER_Q", ref: null }, { type: "OTHER_Q", ref: null }]);
    assert.ok(r.flags.includes("multi_question"));
    assert.equal(r.reply, "스터디는 몇 시에 할까요?");
    assert.deepEqual(r.actions, ["cut_question", "rebuild_acts"]);
    assert.equal(r.acts.length, 1);
  });

  it("acts 어긋남: 서버가 다시 만듦 — 물음이 없는데 SERVER_Q, ref가 다른 SERVER_Q, 없는 c#", () => {
    const c = cardCtx();
    c.ctx.question = { id: "q1", kind: "PREP_CHECK", text: "준비가 더 걸릴까요?", target_ref: "a1", options: [] };
    const none = run("알겠어요.", [{ type: "SERVER_Q", ref: "q1" }], c);
    assert.deepEqual(none.acts, []);
    assert.ok(none.actions.includes("rebuild_acts"));
    const wrongRef = run("내일 준비가 평소보다 더 걸릴 것 같아요?", [{ type: "SERVER_Q", ref: "q9" }], c);
    assert.deepEqual(wrongRef.acts, [{ type: "SERVER_Q", ref: "q1" }]);
    const ghost = run("저장할까요?", [{ type: "CONFIRM", ref: "c7" }], c);
    assert.deepEqual(ghost.acts, [{ type: "OTHER_Q", ref: null }]); // 모르는 c#는 허용 밖 물음으로 센다
    assert.ok(ghost.flags.includes("acts_mismatch"));
  });

  it("rebuildActs: 규칙에 맞는 모델 acts는 그대로, 부족하면 OTHER_Q로 채움, 물음이 없으면 빈 목록", () => {
    const c = cardCtx();
    assert.deepEqual(rebuildActs("저장할까요?", [{ type: "CONFIRM", ref: "c1" }], c.ctx, c.events, c.turns), [{ type: "CONFIRM", ref: "c1" }]);
    assert.deepEqual(rebuildActs("저장할까요?", [], c.ctx, c.events, c.turns), [{ type: "OTHER_Q", ref: null }]);
    assert.deepEqual(rebuildActs("저장했어요.", [{ type: "CONFIRM", ref: "c1" }], c.ctx, c.events, c.turns), []);
    assert.equal(questionCount("저장할까요?"), 1);
  });

  it("바뀐 기상 알람 시각을 안 말하면 서버 문장을 덧붙임 — 물음이 마지막이면 그 앞에", () => {
    const c = cardCtx();
    c.events = [ev({
      after_turn: 1,
      applied: ["일정 저장: 10/9(금) 10:00 캡스톤 발표 · 강남역"],
      alarms: [{ ref: "al9", owner: "u0", type: "WAKE", date: "2026-10-09", time: "07:40", intensity: "STRONG", appointment_ref: "a9", enabled: true, change: "NEW" }],
    })];
    c.ctx.events = c.events;
    const r = run("일정은 저장했어요.", [], c);
    assert.ok(r.flags.includes("alarm_relay_missing"));
    assert.equal(r.reply, "일정은 저장했어요. 기상 알람은 오전 7시 40분이에요.");
    assert.deepEqual(r.actions, ["append_alarm"]);
    const q = run("일정은 저장했어요. 오늘은 어떠셨어요?", [{ type: "REFLECT", ref: null }], c);
    assert.equal(q.reply, "일정은 저장했어요. 기상 알람은 오전 7시 40분이에요. 오늘은 어떠셨어요?");
    assert.deepEqual(q.acts, [{ type: "REFLECT", ref: null }]);
    // 이미 전했으면 덧붙이지 않음
    const done = run("일정은 저장했어요. 내일 기상은 오전 7시 40분이에요.", [], c);
    assert.deepEqual(done.actions, []);
    assert.equal(wakeAlarmSentence("07:00"), "기상 알람은 오전 7시예요.");
    assert.equal(wakeAlarmSentence("00:30"), "기상 알람은 밤 12시 30분이에요.");
  });

  it("위기 턴(latestUser)에는 알람 문장을 덧붙이지 않음", () => {
    const c = cardCtx();
    c.events = [ev({ after_turn: 1, crisis: true, alarms: [{ ref: "al9", owner: "u0", type: "WAKE", date: "2026-10-09", time: "07:40", intensity: "STRONG", appointment_ref: "a9", enabled: true, change: "NEW" }] })];
    c.ctx.events = c.events;
    const safety = safetyInfoFrom(c.events, 1);
    assert.deepEqual(safety, { conveyed: true, latestUser: true, riskThisTurn: true, deferredTurns: 0 });
    const r = applyGuards({ reply: "많이 힘드셨겠어요. 109에 전화해 볼 수 있어요.", acts: [], end: false }, { ctx: c.ctx, eventsVisible: c.events, turnsBefore: c.turns, safety });
    assert.deepEqual(r.actions, []);
    assert.ok(r.reply.includes("109"));
  });

  it("109: 위험 표시 없이 109면 그 문장을 지움 (hotline_without_risk), 위기 다음 턴에 또 109면 반복으로 지움", () => {
    const c = cardCtx();
    const noRisk = applyGuards({ reply: "피곤하셨겠어요. 109에 전화해 보세요.", acts: [], end: false }, {
      ctx: c.ctx, eventsVisible: c.events, turnsBefore: c.turns, safety: safetyInfoFrom(c.events, 1),
    });
    assert.ok(noRisk.flags.includes("hotline_without_risk"));
    assert.equal(noRisk.reply, "피곤하셨겠어요.");
    const turns = [...c.turns, ai(2, "109에 전화해 볼 수 있어요."), user(3, "괜찮아요")];
    const evs = [ev({ after_turn: 1, crisis: true }), ev({ after_turn: 3 })];
    const again = applyGuards({ reply: "다시 말씀드리면 109가 있어요. 내일 일정은 그대로예요.", acts: [], end: false }, {
      ctx: c.ctx, eventsVisible: evs, turnsBefore: turns, safety: safetyInfoFrom(evs, 2),
    });
    assert.ok(again.flags.includes("hotline_repeat"));
    assert.equal(again.reply, "내일 일정은 그대로예요.");
    assert.deepEqual(safetyInfoFrom(evs, 2), { conveyed: true, latestUser: false, riskThisTurn: false, deferredTurns: 1 });
    assert.deepEqual(safetyInfoFrom([], 3), { conveyed: false, latestUser: false, riskThisTurn: false, deferredTurns: 0 });
  });

  it("109 (헤드 10/30 B안): 위기 말이 두 턴 이어지면 두 턴 다 109 통과, 위기 말 한 번 뒤 평범한 말에는 109를 되풀이하지 않음(지움)", () => {
    const c = cardCtx();
    const hotline = "많이 힘드셨겠어요. 힘들 땐 109(자살예방 상담전화)에 언제든 전화할 수 있어요.";
    // 사용자 말 1 · 2 모두 위험 표시가 켜진 턴 — 서버가 둘째 턴에도 위기 안내 필요 줄을 넘김(crisis 이벤트가 두 턴 모두)
    const evs = [ev({ after_turn: 1, crisis: true }), ev({ after_turn: 2, crisis: true })];
    const turns2 = [...c.turns, ai(2, hotline), user(3, "계속 힘들어")];
    const second = applyGuards({ reply: hotline, acts: [], end: false }, { ctx: c.ctx, eventsVisible: evs, turnsBefore: turns2, safety: safetyInfoFrom(evs, 2) });
    assert.equal(safetyInfoFrom(evs, 2).riskThisTurn, true);
    assert.deepEqual(second.flags, [], "위기가 이어지는 둘째 턴의 109는 되풀이가 아님");
    assert.equal(second.reply, hotline);
    // 위기 말 한 번(사용자 말 1) 뒤 평범한 말(2): 위험 판단이 꺼져 있고 이미 안내했으니 109 문장은 지움
    const once = [ev({ after_turn: 1, crisis: true }), ev({ after_turn: 2 })];
    const plain = applyGuards({ reply: `푹 쉬어요. ${hotline}`, acts: [], end: false }, { ctx: c.ctx, eventsVisible: once, turnsBefore: turns2, safety: safetyInfoFrom(once, 2) });
    assert.equal(safetyInfoFrom(once, 2).riskThisTurn, false);
    assert.ok(plain.flags.includes("hotline_repeat"));
    assert.equal(plain.reply, "푹 쉬어요. 많이 힘드셨겠어요."); // 109가 든 문장만 지움
    assert.ok(plain.actions.includes("drop_sentence"));
    // riskThisTurn 칸이 없는 옛 SafetyInfo는 latestUser를 따름
    const legacy = applyGuards({ reply: hotline, acts: [], end: false }, { ctx: c.ctx, eventsVisible: evs, turnsBefore: turns2, safety: { conveyed: true, latestUser: true } });
    assert.deepEqual(legacy.flags, []);
  });

  it("109 (헤드 10/30): 이 턴 위험 판단이 '모름'(riskUnknown)이면 이미 안내한 대화에서도 · 안내 전에도 모델의 109를 지우지 않음", () => {
    const c = cardCtx();
    const hotline = "많이 힘드셨겠어요. 힘들 땐 109(자살예방 상담전화)에 언제든 전화할 수 있어요.";
    const turns2 = [...c.turns, ai(2, hotline), user(3, "아무것도 하기 싫어")];
    // 모름 표시는 safetyInfoFrom이 이벤트(risk_unknown)에서 채움 — 꺼짐(riskThisTurn=false)과 구분
    const unknownEvs = [ev({ after_turn: 1, crisis: true }), ev({ after_turn: 2, risk_unknown: true })];
    const safety = safetyInfoFrom(unknownEvs, 2);
    assert.deepEqual(safety, { conveyed: true, latestUser: false, riskThisTurn: false, deferredTurns: 1, riskUnknown: true });
    const repeat = applyGuards({ reply: `푹 쉬어요. ${hotline}`, acts: [], end: false }, { ctx: c.ctx, eventsVisible: unknownEvs, turnsBefore: turns2, safety });
    assert.ok(!repeat.flags.includes("hotline_repeat"));
    assert.equal(repeat.reply, `푹 쉬어요. ${hotline}`);
    // 안내한 적 없는 대화에서도 hotline_without_risk로 안 지움 (모름 = 안전 쪽)
    const before = [ev({ after_turn: 1, risk_unknown: true })];
    const none = applyGuards({ reply: hotline, acts: [], end: false }, { ctx: c.ctx, eventsVisible: before, turnsBefore: c.turns, safety: safetyInfoFrom(before, 1) });
    assert.ok(!none.flags.includes("hotline_without_risk"));
    assert.equal(none.reply, hotline);
    // 모름 표시가 없으면 기존대로 지움 · 위기 턴이면 모름 칸은 안 붙음
    assert.equal(safetyInfoFrom([ev({ after_turn: 1, crisis: true }), ev({ after_turn: 2 })], 2).riskUnknown, undefined);
    assert.equal(safetyInfoFrom([ev({ after_turn: 1, crisis: true, risk_unknown: true })], 1).riskUnknown, undefined);
  });

  it("지어낸 숫자: 처음엔 다시, 또 걸리면 그 숫자가 든 문장만 지움 — 지금 시각 · 카드 요약 시각은 허용", () => {
    const c = cardCtx();
    const first = run("내일 기상 알람은 오전 6시 15분이에요. 카드를 확인해 주세요.", []);
    assert.ok(first.flags.includes("unsupported_numbers"));
    assert.equal(first.redo, true);
    const second = run("내일 기상 알람은 오전 6시 15분이에요. 카드를 확인해 주세요.", [], c, { retried: true });
    assert.equal(second.reply, "카드를 확인해 주세요.");
    assert.deepEqual(second.actions, ["drop_sentence"]);
    // 지금 시각(22:30)은 허용
    assert.deepEqual(run("지금 오후 10시 30분이니 일찍 주무세요.", []).flags, []);
    // 카드 요약에만 있는 시각(06:50)은 cardSummaries로 허용
    const text = "카드 시간은 오전 6시 50분이에요.";
    const noSummary = applyGuards({ reply: text, acts: [], end: false }, { ctx: c.ctx, eventsVisible: c.events, turnsBefore: c.turns, safety: safetyInfoFrom(c.events, 1) });
    assert.ok(noSummary.flags.includes("unsupported_numbers"));
    const withSummary = applyGuards({ reply: text, acts: [], end: false }, { ctx: c.ctx, eventsVisible: c.events, turnsBefore: c.turns, safety: safetyInfoFrom(c.events, 1), cardSummaries: ["10/9(금) 10:00 발표 · 알람 기상 06:50"] });
    assert.deepEqual(withSummary.flags, []);
  });

  it("시각 표기 섞임: HH:MM을 말로 바꿈 (mixed_time_format)", () => {
    const c = cardCtx();
    const r = applyGuards({ reply: "오전 10시 발표고 알람은 07:40이에요.", acts: [], end: false }, {
      ctx: c.ctx, eventsVisible: c.events, turnsBefore: c.turns, safety: safetyInfoFrom(c.events, 1), cardSummaries: [c.events[0]!.pending[0]!.summary],
    });
    assert.ok(r.flags.includes("mixed_time_format"));
    assert.equal(r.reply, "오전 10시 발표고 알람은 오전 7시 40분이에요.");
    assert.deepEqual(r.actions, ["spoken_times"]);
  });

  it("해요체 아님 · 너무 김은 기록만 (지침 21)", () => {
    const r = run("알겠어. 잘 자.", []);
    assert.ok(r.flags.includes("non_haeyo"));
    assert.deepEqual(r.actions, []);
    assert.equal(r.reply, "알겠어. 잘 자.");
  });

  it("서버 질문이 남았는데 end면 end를 거둠 (지침 19a), 이미 물었거나 질문이 없으면 그대로", () => {
    const c = cardCtx();
    c.ctx.question = { id: "q1", kind: "PREP_CHECK", text: "준비가 더 걸릴까요?", target_ref: "a1", options: [] };
    const r = run("그럼 푹 쉬세요.", [], c, { end: true });
    assert.equal(r.end, false);
    assert.deepEqual(r.actions, ["retract_end"]);
    const asked = { ...c, turns: [ai(0, "준비가 더 걸릴까요?", [{ type: "SERVER_Q", ref: "q1" }]), user(1, "아니")] };
    assert.equal(run("그럼 푹 쉬세요.", [], asked, { end: true }).end, true);
    const noQ = cardCtx();
    noQ.ctx.question = null;
    assert.equal(run("그럼 푹 쉬세요.", [], noQ, { end: true }).end, true);
  });

  it("같은 입력 같은 답 · 입력을 바꾸지 않음", () => {
    const c = cardCtx();
    const before = structuredClone(c);
    const a = run("네, 저장했어요. 카드의 저장 버튼으로 마무리해 주세요.", [], c);
    const b = run("네, 저장했어요. 카드의 저장 버튼으로 마무리해 주세요.", [], c);
    assert.deepEqual(a, b);
    assert.deepEqual(c, before);
  });
});

// ───────── 리뷰 #261: 저장 주장 · 약속 보강 / 덧붙임 뒤 시각 표기 ─────────

describe("저장 주장 · 약속 패턴 보강 (리뷰 #261)", () => {
  it("저장 주장: 맞췄 · 띄어 쓴 했 · 상태로 말하는 되어 있어요 · 이 됐어요 · 넣었 · 변경 완료 · 바꾸어 두었 · 수정 · 반영 · 조정", () => {
    for (const s of [
      "알람을 7시로 맞췄어요.", "저장 했어요.", "저장되어 있어요.", "저장이 됐어요.", "저장돼 있어요.", "설정되어 있어요.", "7시 40분으로 넣었어요.",
      "변경 완료했어요.", "바꾸어 두었어요.", "수정 했어요.", "반영 했어요.", "조정했어요.",
      // 같은 뜻의 이웃 꼴
      "저장이 되어 있어요.", "저장이 돼 있어요.", "변경 완료됐어요.", "바꿔 뒀어요.", "저장 됐어요.", "설정 되었어요.",
    ]) assert.equal(claimsSaved(s), true, s);
  });

  it("저장 주장이 아닌 것: 확인 대기를 전하는 '저장돼요' · 물음 · 지금 있던 알람 이야기", () => {
    for (const s of [
      "카드의 저장 버튼을 누르면 저장돼요.", "누르면 저장돼요.", "저장 버튼을 누르시면 일정이 저장돼요.", "저장할까요?", "카드의 [저장]으로 저장할 수 있어요.",
      "그대로 맞춰 두었어요.",
      "충전기를 가방에 넣었나요?", "기상은 오전 7시 40분이에요.",
    ]) assert.equal(claimsSaved(s), false, s);
  });

  it("저장 약속: 저장하겠어요 · 저장하겠습니다 · 바꾸겠어요 · 맞출게요 · 바꿔 줄게요 · 저장 할게요 · 조정할게요 · 처리해 둘게요", () => {
    for (const s of [
      "저장하겠어요.", "저장하겠습니다.", "바꾸겠어요.", "7시로 맞출게요.", "바꿔 줄게요.", "저장 할게요.", "조정할게요.", "처리해 둘게요.",
      "알람을 맞추겠어요.", "고쳐 줄게요.", "변경하겠습니다.", "조정 할게요.",
    ]) assert.equal(promisesSave(s), true, s);
  });

  it("저장 약속이 아닌 것: 물음 · 지난 일 · 확인 대기를 전하는 말", () => {
    for (const s of ["저장할까요?", "바꿀까요?", "누르면 저장돼요.", "카드의 [저장]을 눌러 주세요.", "맞춰 두었으니 걱정 마세요.", "처리 결과가 있어요."]) {
      assert.equal(promisesSave(s), false, s);
    }
  });

  it("applyGuards: 보강한 말도 문장째 지움 (처리 결과 없는 턴)", () => {
    const base = bs0();
    const r = applyGuards({ reply: "알람을 맞췄어요. 내일 일정도 확인해 주세요.", acts: [], end: false }, {
      ctx: base, eventsVisible: [], turnsBefore: [], safety: safetyInfoFrom([], 0),
    });
    assert.ok(r.flags.includes("claims_saved_without_event"));
    assert.equal(r.reply, "내일 일정도 확인해 주세요.");
    const p = applyGuards({ reply: "일정을 확인했어요. 알람은 제가 조정할게요.", acts: [], end: false }, {
      ctx: base, eventsVisible: [], turnsBefore: [], safety: safetyInfoFrom([], 0),
    });
    assert.ok(p.flags.includes("promises_save"));
    assert.equal(p.reply, "일정을 확인했어요.");
  });

  it("덧붙인 '기상 알람은 …' 문장 때문에 새로 시각 표기가 섞이면 다시 검사해 HH:MM을 말로 바꿈", () => {
    const ctx = bs0();
    const events = [ev({
      after_turn: 1,
      alarms: [{ ref: "al9", owner: "u0", type: "WAKE", date: "2026-10-09", time: "07:40", intensity: "STRONG", appointment_ref: "a1", enabled: true, change: "NEW" }],
    })];
    const r = applyGuards({ reply: "내일 일정은 10:00에 있어요.", acts: [], end: false }, {
      ctx, eventsVisible: events, turnsBefore: [user(0, "응")], safety: safetyInfoFrom(events, 1),
    });
    assert.ok(r.actions.includes("append_alarm"));
    assert.ok(r.actions.includes("spoken_times"), r.actions.join());
    assert.ok(!r.reply.includes("10:00"), r.reply);
    assert.equal(r.reply, "내일 일정은 오전 10시에 있어요. 기상 알람은 오전 7시 40분이에요.");
    // 원래 flags에는 안 걸렸던 것 (덧붙이기 전 답은 한 가지 표기)
    assert.ok(!r.flags.includes("mixed_time_format"));
  });
});
