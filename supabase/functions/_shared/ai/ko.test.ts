// ko.ts 단위 테스트 — 실험실 tests/ko.test.ts 이식 (같은 입력 같은 답). 받아쓰기형(띄어쓰기 · 문장부호 없음) · 오타 · 줄임말 포함.
// 바뀐 곳(설계 메모 4.1 · 7절): 04:00 경계(recordDateOf)와 titleSimilarity · normalizeTitle(채점용) 시험은 뺐고,
//   상대 날짜 모호 검사는 현재 시각 대신 달력 오늘(calendarToday)을 넘긴다 — 아래 calOf로 옛 사례의 now를 달력 오늘로 바꿔 같은 사례를 그대로 시험.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "./types.ts";
import {
  addDays, clockToHHMM, findTimeMentions, hhmmToMinutes, isQuestion, parseKoreanNumber,
  questionCount, resolveClock, resolveRelativeDate, sentenceStyle, splitSentences, styleReport,
  unsupportedNumbers, seoulLocal, APPOINTMENT_PM_HOURS,
  ampmExact, clockForms, exactClocksIn, fractionsIn, midBanmalClause, timeFormatReport,
} from "./ko.ts";
import type { ClockMention, CountMention, DateMention, DurationMention, OtherMention, TimeMention } from "./ko.ts";

// 2026-10-08(목) 기준 날짜표
const DATES: Context["dates"] = {
  today: "2026-10-08",
  tomorrow: "2026-10-09",
  day_after: "2026-10-10",
  weekday_today: "THU",
  this_week: { MON: "2026-10-05", TUE: "2026-10-06", WED: "2026-10-07", THU: "2026-10-08", FRI: "2026-10-09", SAT: "2026-10-10", SUN: "2026-10-11" },
  next_week: { MON: "2026-10-12", TUE: "2026-10-13", WED: "2026-10-14", THU: "2026-10-15", FRI: "2026-10-16", SAT: "2026-10-17", SUN: "2026-10-18" },
};

const hm = (s: string): number => hhmmToMinutes(s)!;
function only<K extends TimeMention["kind"]>(text: string, kind: K): Extract<TimeMention, { kind: K }>[] {
  return findTimeMentions(text).filter((m): m is Extract<TimeMention, { kind: K }> => m.kind === kind);
}
const clock = (text: string): ClockMention => {
  const c = only(text, "clock");
  assert.equal(c.length, 1, `시각 1개여야 함: ${text} → ${JSON.stringify(findTimeMentions(text))}`);
  return c[0];
};
const dur = (text: string): DurationMention => {
  const d = only(text, "duration");
  assert.equal(d.length, 1, `길이 1개여야 함: ${text} → ${JSON.stringify(findTimeMentions(text))}`);
  return d[0];
};
const date = (text: string): DateMention => {
  const d = only(text, "date");
  assert.equal(d.length, 1, `날짜 1개여야 함: ${text} → ${JSON.stringify(findTimeMentions(text))}`);
  return d[0];
};

// ───────── parseKoreanNumber ─────────

const NUMBERS: [string, number | null][] = [
  ["7", 7], ["15", 15], ["１２", 12], ["1.5", 1.5],
  ["일", 1], ["십", 10], ["십오", 15], ["이십오", 25], ["삼십", 30], ["백", 100], ["백이십", 120], ["오", 5],
  ["한", 1], ["하나", 1], ["두", 2], ["둘", 2], ["세", 3], ["셋", 3], ["네", 4], ["넷", 4], ["다섯", 5], ["여섯", 6],
  ["일곱", 7], ["여덟", 8], ["아홉", 9], ["열", 10], ["열한", 11], ["열두", 12], ["열 두", 12], ["스물", 20], ["스무", 20],
  ["스물셋", 23], ["서른", 30], ["마흔", 40],
  ["", null], ["사과", null], ["십십", null], ["이삼", null], ["두시", null],
];
for (const [s, want] of NUMBERS) {
  test(`parseKoreanNumber(${JSON.stringify(s)}) = ${want}`, () => assert.equal(parseKoreanNumber(s), want));
}

// ───────── clockToHHMM · hhmmToMinutes ─────────

test("clockToHHMM: 자릿수 · 하루 넘김 · 음수", () => {
  assert.equal(clockToHHMM(450), "07:30");
  assert.equal(clockToHHMM(0), "00:00");
  assert.equal(clockToHHMM(1439), "23:59");
  assert.equal(clockToHHMM(1440 + 65), "01:05");
  assert.equal(clockToHHMM(-30), "23:30");
});

test("hhmmToMinutes: 정상 · 한 자리 시 · 잘못된 형식", () => {
  assert.equal(hhmmToMinutes("07:40"), 460);
  assert.equal(hhmmToMinutes("7:40"), 460);
  assert.equal(hhmmToMinutes("24:00"), 1440);
  assert.equal(hhmmToMinutes("24:30"), null);
  assert.equal(hhmmToMinutes("12:60"), null);
  assert.equal(hhmmToMinutes("7시"), null);
});

// ───────── 시각 ─────────

// [글, 기대 분, 모호?, 때 표시]
const CLOCKS: [string, number, boolean, string | null][] = [
  ["7시 반", hm("07:30"), true, null],
  ["7시반", hm("07:30"), true, null],
  ["일곱 시 반", hm("07:30"), true, null],
  ["일곱시반", hm("07:30"), true, null],
  ["7시30분", hm("07:30"), true, null],
  ["오후 2시", hm("14:00"), false, "오후"],
  ["오후2시", hm("14:00"), false, "오후"],
  ["14시", hm("14:00"), false, null],
  ["14:00", hm("14:00"), false, null],
  ["07:30", hm("07:30"), false, null],
  ["7:30", hm("07:30"), true, null],
  ["2시 15분", hm("02:15"), true, null],
  ["두시 십오분", hm("02:15"), true, null],
  ["두 시 삼십 분", hm("02:30"), true, null],
  ["새벽 1시", hm("01:00"), false, "새벽"],
  ["새벽 3시 반", hm("03:30"), false, "새벽"],
  ["밤 12시 반", hm("00:30"), false, "밤"],
  ["밤 11시", hm("23:00"), false, "밤"],
  ["밤 1시", hm("01:00"), false, "밤"],
  ["아침 8시", hm("08:00"), false, "아침"],
  ["저녁 6시", hm("18:00"), false, "저녁"],
  ["낮 12시", hm("12:00"), false, "낮"],
  ["낮 3시", hm("15:00"), false, "낮"],
  ["점심 1시", hm("13:00"), false, "점심"],
  ["오전 12시", hm("00:00"), false, "오전"],
  ["오후 12시 반", hm("12:30"), false, "오후"],
  ["정오", hm("12:00"), false, "정오"],
  ["자정", hm("00:00"), false, "자정"],
  ["열두시 반", hm("12:30"), true, null],
  ["열한시", hm("11:00"), true, null],
  ["네 시에 봐", hm("04:00"), true, null],
  ["아침 여덟시", hm("08:00"), false, "아침"],
  ["오후 14시", hm("14:00"), false, "오후"],
  ["0시 10분", hm("00:10"), false, null],
];
for (const [text, value, amb, period] of CLOCKS) {
  test(`시각: ${text} → ${clockToHHMM(value)}${amb ? " (모호)" : ""}`, () => {
    const c = clock(text);
    assert.equal(c.value, value);
    assert.equal(c.hour12Ambiguous, amb);
    assert.equal(c.period, period);
  });
}

test("시각: 모호하면 후보 2개(오전 · 오후), 12시는 낮 12시 · 자정", () => {
  assert.deepEqual(clock("7시").candidates, [hm("07:00"), hm("19:00")]);
  assert.deepEqual(clock("12시").candidates, [hm("12:00"), hm("00:00")]);
  assert.deepEqual(clock("오후 7시").candidates, [hm("19:00")]);
});

test("시각: 어림 · 관계 표시 (쯤 · 전 · 넘어서 · 까지 · 부터 · '한 7시')", () => {
  assert.equal(clock("8시쯤").approx, true);
  assert.equal(clock("7시 반쯤?").approx, true);
  assert.equal(clock("7시 반쯤?").value, hm("07:30"));
  assert.equal(clock("한 7시에 일어날 듯").approx, true);
  assert.equal(clock("9시 전").relation, "before");
  assert.equal(clock("9시 전에 도착").relation, "before");
  assert.equal(clock("9시 넘어서 잤어").relation, "after");
  assert.equal(clock("새벽 3시 반까지 과제함").relation, "until");
  assert.equal(clock("10시부터 수업").relation, "from");
  assert.equal(clock("2시 전화할게").relation, null);
  assert.equal(clock("7시").approx, false);
});

test("시각: 범위 '7~8시' · '오후 2~3시'는 두 시각", () => {
  const a = only("7~8시 사이", "clock");
  assert.deepEqual(a.map((c) => c.value), [hm("07:00"), hm("08:00")]);
  const b = only("오후 2~3시", "clock");
  assert.deepEqual(b.map((c) => c.value), [hm("14:00"), hm("15:00")]);
  assert.deepEqual(only("7시~8시", "clock").map((c) => c.value), [hm("07:00"), hm("08:00")]);
});

test("시각 vs 길이: '2시'는 시각, '2시간'은 길이", () => {
  assert.equal(only("2시", "clock").length, 1);
  assert.equal(only("2시", "duration").length, 0);
  assert.equal(only("2시간", "clock").length, 0);
  assert.equal(dur("2시간").value, 120);
  assert.equal(only("두시간반", "clock").length, 0);
  assert.equal(dur("두시간반").value, 150);
});

test("시각: 낱말 속 글자는 시각 아님 ('오시는 길' · '언제 오시나요' · '시험' · '시작')", () => {
  assert.deepEqual(findTimeMentions("오시는 길 알려 주세요"), []);
  assert.deepEqual(findTimeMentions("언제 오시나요"), []);
  assert.equal(only("두 시험 다 망함", "clock").length, 0);
  assert.equal(only("세 시작하자", "clock").length, 0);
});

// ───────── 길이 ─────────

// [글, 분, 방향, 어림]
const DURATIONS: [string, number, DurationMention["modifier"], boolean][] = [
  ["10분", 10, null, false],
  ["1시간 반", 90, null, false],
  ["1시간반", 90, null, false],
  ["한 시간", 60, null, false],
  ["한시간", 60, null, false],
  ["30분 정도", 30, null, true],
  ["45분쯤 걸려", 45, null, true],
  ["20분 더", 20, "more", false],
  ["20분이 더 걸렸어", 20, "more", false],
  ["5분만 더", 5, "more", false],
  ["10분 덜 걸림", 10, "less", false],
  ["15분 일찍", 15, "earlier", false],
  ["10분 늦게", 10, "later", false],
  ["30분 전에 깨워줘", 30, "before", false],
  ["10분 뒤에 다시", 10, "after", false],
  ["2시간 30분", 150, null, false],
  ["1.5시간", 90, null, false],
  ["반시간", 30, null, false],
  ["삼십분", 30, null, false],
  ["십오 분", 15, null, false],
  ["세시간", 180, null, false],
  ["한 10분", 10, null, true],
];
for (const [text, value, mod, approx] of DURATIONS) {
  test(`길이: ${text} → ${value}분${mod ? ` (${mod})` : ""}`, () => {
    const d = dur(text);
    assert.equal(d.value, value);
    assert.equal(d.modifier, mod);
    assert.equal(d.approx, approx);
  });
}

test("길이 목록: 미루기 '5/10/15분' → 5 · 10 · 15", () => {
  assert.deepEqual(only("미루기 5/10/15분", "duration").map((d) => d.value), [5, 10, 15]);
  assert.deepEqual(only("5, 10, 15분 중에 골라요", "duration").map((d) => d.value), [5, 10, 15]);
  assert.equal(only("미루기 5/10/15분", "other").length, 0);
});

test("길이 범위: '10~15분' · '한두 시간'", () => {
  assert.deepEqual(dur("10~15분").range, [10, 15]);
  assert.equal(dur("10~15분").value, 10);
  assert.deepEqual(dur("한두 시간").range, [60, 120]);
});

test("길이: '이분' · '구분' · '사분' 같은 낱말과 '모두 시간'은 숫자 아님", () => {
  assert.deepEqual(findTimeMentions("이분이 누구야"), []);
  assert.deepEqual(findTimeMentions("구분해서 적어 줘"), []);
  assert.deepEqual(findTimeMentions("모두 시간이 없어"), []);
  assert.deepEqual(findTimeMentions("또한 시간 맞추기 어려움"), []);
  assert.deepEqual(findTimeMentions("모두 번갈아 가면서"), []);
  assert.deepEqual(findTimeMentions("우리 동네 번화가"), []);
  assert.deepEqual(findTimeMentions("관한 번역 과제"), []);
  assert.deepEqual(findTimeMentions("한 시도 못 쉬었어"), []);
  assert.deepEqual(findTimeMentions("한시름 놓았어"), []);
  assert.deepEqual(findTimeMentions("한시라도 빨리"), []);
  assert.deepEqual(findTimeMentions("네 시간 괜찮아요"), []);
  assert.equal(dur("가는 데 네 시간 걸려요").value, 240);
  assert.equal(clock("1시도 괜찮아").value, hm("01:00"));
  assert.equal(only("10분의 1", "duration").length, 0);
});

// ───────── 횟수 · 구조 숫자 ─────────

test("횟수: '2번' · '세 번' · '두 번' · '두번' · '2회' · '스무 번' · '두세 번'", () => {
  assert.equal(only("알람 2번 울렸어", "count")[0].value, 2);
  assert.equal(only("세 번 미뤘어", "count")[0].value, 3);
  assert.equal(only("두 번", "count")[0].value, 2);
  assert.equal(only("두번 껐어", "count")[0].value, 2);
  assert.equal(only("2회", "count")[0].value, 2);
  assert.equal(only("스무 번", "count")[0].value, 20);
  assert.deepEqual(only("두세 번", "count")[0].range, [2, 3]);
  assert.equal(only("한 번 더 확인해 주세요", "count")[0].native, true);
});

const OTHERS: [string, string][] = [
  ["1번 출구", "번"], ["2호선", "호선"], ["3학년", "학년"], ["5층", "층"], ["1단계", "단계"],
  ["첫 번째", "번째"], ["두 번째 알람", "번째"], ["2번째", "번째"], ["둘째", "번째"], ["3교시", "교시"],
  ["10월", "월"], ["알람 3개", "개"], ["2일차 엠티", "일"], ["3일 전", "일"],
];
for (const [text, unit] of OTHERS) {
  test(`구조 숫자: ${text} → other(${unit})`, () => {
    const ms = findTimeMentions(text);
    assert.equal(ms.length, 1, JSON.stringify(ms));
    assert.equal(ms[0].kind, "other");
    assert.equal((ms[0] as Extract<TimeMention, { kind: "other" }>).unit, unit);
  });
}

test("횟수 아님: '회의 2개' · '2회의' · '세 번째' · '2번 버스'", () => {
  assert.equal(only("회의 2개", "count").length, 0);
  assert.equal(only("2회의 남음", "count").length, 0);
  assert.equal(only("세 번째", "count").length, 0);
  assert.equal(only("2번 버스 탐", "count").length, 0);
});

// ───────── 날짜 ─────────

test("날짜: 상대 (오늘 · 내일 · 낼 · 모레 · 내일모레 · 낼모레 · 어제 · 어젯밤)", () => {
  assert.deepEqual(date("오늘").value, { type: "relative", key: "today" });
  assert.deepEqual(date("내일").value, { type: "relative", key: "tomorrow" });
  assert.deepEqual(date("낼").value, { type: "relative", key: "tomorrow" });
  assert.deepEqual(date("낼은 쉼").value, { type: "relative", key: "tomorrow" });
  assert.deepEqual(date("모레").value, { type: "relative", key: "day_after" });
  assert.deepEqual(date("내일모레 시험").value, { type: "relative", key: "day_after" });
  assert.deepEqual(date("낼모레").value, { type: "relative", key: "day_after" });
  assert.deepEqual(date("어제").value, { type: "relative", key: "yesterday" });
  assert.deepEqual(date("어젯밤 2시에 잤어").value, { type: "relative", key: "last_night" }); // 10/9 — 지난밤 = 기록 날짜 전날 밤
  assert.deepEqual(date("어젯저녁").value, { type: "relative", key: "yesterday" });
  assert.equal(clock("어젯밤 2시에 잤어").value, hm("02:00"));
});

test("날짜: '낼'이 동사면 날짜 아님 ('과제 낼게' · '낼 사람' · '낼 수 있어')", () => {
  assert.equal(only("과제 낼게요", "date").length, 0);
  assert.equal(only("돈 낼 사람", "date").length, 0);
  assert.equal(only("오늘 안에 낼 수 있어", "date").length, 1); // '오늘'만
});

test("날짜: 요일 (다음 주 · 담주 · 이번 주 · 화욜 · 다음 화요일 · 다다음주)", () => {
  assert.deepEqual(date("다음 주 화요일").value, { type: "weekday", week: "next", weekday: "TUE", explicit: true });
  assert.deepEqual(date("담주 화욜").value, { type: "weekday", week: "next", weekday: "TUE", explicit: true });
  assert.deepEqual(date("이번 주 금요일").value, { type: "weekday", week: "this", weekday: "FRI", explicit: true });
  assert.deepEqual(date("토욜 1시").value, { type: "weekday", week: "this", weekday: "SAT", explicit: false });
  assert.deepEqual(date("다음 화요일").value, { type: "weekday", week: "next", weekday: "TUE", explicit: false });
  assert.deepEqual(date("다다음주 월요일").value, { type: "weekday", week: "after_next", weekday: "MON", explicit: true });
  assert.deepEqual(date("지난주 수요일").value, { type: "weekday", week: "last", weekday: "WED", explicit: true });
});

test("날짜: 절대 (10월 9일 · 9일 · 10/9 · 2026-10-09 · 9일까지)", () => {
  assert.deepEqual(date("10월 9일").value, { type: "absolute", year: null, month: 10, day: 9 });
  assert.deepEqual(date("10월9일").value, { type: "absolute", year: null, month: 10, day: 9 });
  assert.deepEqual(date("9일").value, { type: "absolute", year: null, month: null, day: 9 });
  assert.deepEqual(date("9일까지 제출").value, { type: "absolute", year: null, month: null, day: 9 });
  assert.deepEqual(date("10/9(금) 14:00 스터디").value, { type: "absolute", year: null, month: 10, day: 9 });
  assert.deepEqual(date("2026-10-09").value, { type: "absolute", year: 2026, month: 10, day: 9 });
  assert.equal(only("3일 동안", "date").length, 0);
  assert.equal(only("9일 전", "date").length, 0);
});

// ───────── 받아쓰기형 · 오타 · 줄임말 ─────────

test("받아쓰기형: '내일오후두시에도서관' → 내일 + 14:00", () => {
  const ms = findTimeMentions("내일오후두시에도서관");
  assert.equal(ms.length, 2);
  assert.deepEqual((ms[0] as DateMention).value, { type: "relative", key: "tomorrow" });
  assert.equal((ms[1] as ClockMention).value, hm("14:00"));
  assert.equal(ms[1].raw, "오후두시");
});

test("받아쓰기형: '모레아침일곱시반알람' · '다음주화요일세시' · '낼아침여덟시'", () => {
  assert.equal(clock("모레아침일곱시반알람").value, hm("07:30"));
  assert.deepEqual(date("모레아침일곱시반알람").value, { type: "relative", key: "day_after" });
  assert.equal(clock("다음주화요일세시").value, hm("03:00"));
  assert.deepEqual(date("다음주화요일세시").value, { type: "weekday", week: "next", weekday: "TUE", explicit: true });
  assert.equal(clock("낼아침여덟시").value, hm("08:00"));
});

test("받아쓰기형: '준비가이십분더걸렸어요' · '알람두번미뤘어'", () => {
  assert.equal(dur("준비가이십분더걸렸어요").value, 20);
  assert.equal(dur("준비가이십분더걸렸어요").modifier, "more");
  assert.equal(only("알람두번미뤘어", "count")[0].value, 2);
});

test("줄임말 · 오타: '낼 두시' · '7시 반쯤?' · '담주 화욜 3시' · '내일모래'", () => {
  assert.deepEqual(date("낼 두시").value, { type: "relative", key: "tomorrow" });
  assert.equal(clock("낼 두시").value, hm("02:00"));
  assert.equal(clock("낼 두시").hour12Ambiguous, true);
  assert.equal(clock("담주 화욜 3시").value, hm("03:00"));
  assert.deepEqual(date("내일모래").value, { type: "relative", key: "day_after" });
});

test("한 문장 여러 개: '내일 아침 7시 40분 알람, 준비 30분, 2번 울려줘'", () => {
  const ms = findTimeMentions("내일 아침 7시 40분 알람, 준비 30분, 2번 울려줘");
  assert.deepEqual(ms.map((m) => m.kind), ["date", "clock", "duration", "count"]);
  assert.equal((ms[1] as ClockMention).value, hm("07:40"));
});

test("위치: start · end · raw가 원문과 맞음", () => {
  const t = "음 내일 7시 반쯤?";
  for (const m of findTimeMentions(t)) assert.equal(t.slice(m.start, m.end), m.raw);
});

// ───────── resolveClock ─────────

test("resolveClock: 때 표시가 있으면 그대로", () => {
  const r = resolveClock(clock("오후 2시"), { defaultPeriod: "AM" });
  assert.equal(r.hhmm, "14:00");
  assert.equal(r.by, "explicit");
  assert.equal(r.ambiguous, false);
});

test("resolveClock: 옵션 없으면 쓴 그대로, AM · PM 강제", () => {
  assert.equal(resolveClock(clock("2시")).hhmm, "02:00");
  assert.equal(resolveClock(clock("2시")).by, "literal");
  assert.equal(resolveClock(clock("2시"), { defaultPeriod: "PM" }).hhmm, "14:00");
  assert.equal(resolveClock(clock("12시"), { defaultPeriod: "AM" }).hhmm, "00:00");
  assert.equal(resolveClock(clock("12시"), { defaultPeriod: "PM" }).hhmm, "12:00");
});

test("resolveClock: AUTO(약속용 1~7시 = 오후)는 옵션으로만", () => {
  assert.deepEqual([...APPOINTMENT_PM_HOURS], [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(resolveClock(clock("2시"), { defaultPeriod: "AUTO" }).hhmm, "14:00");
  assert.equal(resolveClock(clock("9시"), { defaultPeriod: "AUTO" }).hhmm, "09:00");
  assert.equal(resolveClock(clock("12시"), { defaultPeriod: "AUTO" }).hhmm, "12:00");
  assert.equal(resolveClock(clock("8시"), { defaultPeriod: "AUTO", pmHours: [8] }).hhmm, "20:00");
});

test("resolveClock: after(기준 시각) 뒤 가장 가까운 해석", () => {
  assert.equal(resolveClock(clock("7시"), { after: hm("22:30") }).hhmm, "07:00");
  assert.equal(resolveClock(clock("7시"), { after: hm("15:00") }).hhmm, "19:00");
  assert.equal(resolveClock(clock("12시 반"), { after: hm("23:00") }).hhmm, "00:30");
  assert.equal(resolveClock(clock("7시"), { after: hm("15:00") }).by, "after");
});

// ───────── resolveRelativeDate ─────────

/** 옛 사례의 now(ISO)를 달력 오늘로 — 설계 메모 4.1: 대화 기준일(DATES.today)과 달력 오늘이 다르면 '자정 뒤 대화' */
const calOf = (nowIso: string): string => seoulLocal(nowIso).date;

test("addDays: 달 · 해 넘김", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("resolveRelativeDate: 저녁(달력 오늘 = 기준일)에는 모호하지 않음", () => {
  const now = calOf("2026-10-08T22:30:00+09:00");
  assert.deepEqual(resolveRelativeDate(date("오늘"), DATES, now), { date: "2026-10-08", ambiguous: false, alternative: null });
  assert.equal(resolveRelativeDate(date("내일"), DATES, now).date, "2026-10-09");
  assert.equal(resolveRelativeDate(date("모레"), DATES, now).date, "2026-10-10");
  assert.equal(resolveRelativeDate(date("어제"), DATES, now).date, "2026-10-07");
});

test("resolveRelativeDate: 자정 뒤(달력 오늘 ≠ 기준일)의 '오늘' · '내일'은 모호 (다른 해석 = 달력 날짜)", () => {
  const now = calOf("2026-10-09T01:30:00+09:00"); // 기준일 10/8
  const t = resolveRelativeDate(date("오늘"), DATES, now);
  assert.equal(t.date, "2026-10-08");
  assert.equal(t.ambiguous, true);
  assert.equal(t.alternative, "2026-10-09");
  assert.ok(t.reason);
  const n = resolveRelativeDate(date("내일"), DATES, now);
  assert.equal(n.date, "2026-10-09");
  assert.equal(n.ambiguous, true);
  assert.equal(n.alternative, "2026-10-10");
  // 설계 메모 4.1: 04:00 검사는 없다 — 모호한지는 달력 오늘이 기준일과 다른지로만 정함 (기준일이 10/9로 넘어가면 같아져 모호하지 않음)
  assert.equal(resolveRelativeDate(date("내일"), { ...DATES, today: "2026-10-09", tomorrow: "2026-10-10", day_after: "2026-10-11" }, "2026-10-09").ambiguous, false);
  // 인자를 안 주면 어긋남이 없다고 봄
  assert.equal(resolveRelativeDate(date("내일"), DATES).ambiguous, false);
});

test("resolveRelativeDate: 요일", () => {
  assert.equal(resolveRelativeDate(date("다음 주 화요일"), DATES).date, "2026-10-13");
  assert.equal(resolveRelativeDate(date("담주 화욜"), DATES).ambiguous, false);
  assert.equal(resolveRelativeDate(date("이번 주 금요일"), DATES).date, "2026-10-09");
  assert.equal(resolveRelativeDate(date("이번 주 월요일"), DATES).date, "2026-10-05"); // 지났어도 명시면 그대로
  const bare = resolveRelativeDate(date("화요일"), DATES); // 목요일 기준, 이번 주 화요일은 지남
  assert.deepEqual([bare.date, bare.ambiguous, bare.alternative], ["2026-10-13", true, "2026-10-06"]);
  assert.deepEqual([resolveRelativeDate(date("토요일"), DATES).date, resolveRelativeDate(date("토요일"), DATES).ambiguous], ["2026-10-10", false]);
  const loose = resolveRelativeDate(date("다음 토요일"), DATES); // 이번 주 토요일일 수도
  assert.deepEqual([loose.date, loose.ambiguous, loose.alternative], ["2026-10-17", true, "2026-10-10"]);
  assert.equal(resolveRelativeDate(date("지난주 수요일"), DATES).date, "2026-09-30");
  assert.equal(resolveRelativeDate(date("다다음주 월요일"), DATES).date, "2026-10-19");
});

test("resolveRelativeDate: 절대 날짜 · 일만 · 없는 날짜 · 해 넘김", () => {
  assert.equal(resolveRelativeDate(date("10월 9일"), DATES).date, "2026-10-09");
  assert.equal(resolveRelativeDate(date("9일"), DATES).date, "2026-10-09");
  const past = resolveRelativeDate(date("3일"), DATES); // 이번 달 3일은 지남 → 다음 달
  assert.deepEqual([past.date, past.ambiguous, past.alternative], ["2026-11-03", true, "2026-10-03"]);
  assert.equal(resolveRelativeDate(date("2월 30일"), DATES).date, null);
  assert.equal(resolveRelativeDate(date("1월 3일"), DATES).date, "2027-01-03");
  assert.equal(resolveRelativeDate({ type: "absolute", year: 2026, month: 10, day: 12 }, DATES).date, "2026-10-12");
});

// ───────── splitSentences ─────────

test("splitSentences: 문장부호 · 줄바꿈 · ㅋㅋ · 이모지", () => {
  assert.deepEqual(splitSentences("오늘 수고했어요. 내일 7시 반에 깨워 드릴게요! 괜찮을까요?"), [
    "오늘 수고했어요.", "내일 7시 반에 깨워 드릴게요!", "괜찮을까요?",
  ]);
  assert.deepEqual(splitSentences("ㅋㅋㅋ 그래 낼 봐\n근데 9시까지 가야돼🙂 진짜 피곤함"), [
    "ㅋㅋㅋ 그래 낼 봐", "근데 9시까지 가야돼🙂", "진짜 피곤함",
  ]);
  assert.deepEqual(splitSentences("잘 자요😴😴 내일 봐요"), ["잘 자요😴😴", "내일 봐요"]);
});

test("splitSentences: 받아쓰기형 존댓말 끝에서 끊음, '필요 없어요'는 안 끊음", () => {
  assert.deepEqual(splitSentences("알겠어요 내일 봐요 ㅋㅋ 잘자"), ["알겠어요", "내일 봐요 ㅋㅋ", "잘자"]);
  assert.deepEqual(splitSentences("필요 없어요 그냥 잘게요"), ["필요 없어요", "그냥 잘게요"]);
  assert.deepEqual(splitSentences("확인했습니다 저장할까요"), ["확인했습니다", "저장할까요"]);
});

test("splitSentences: '1.5시간' · '7시~8시'는 안 끊고 물결 끝은 끊음, 내용 없는 조각은 앞에 붙임", () => {
  assert.deepEqual(splitSentences("1.5시간 걸려요. 7시~8시 사이에 출발해요~ 좋아요~~"), [
    "1.5시간 걸려요.", "7시~8시 사이에 출발해요~", "좋아요~~",
  ]);
  assert.deepEqual(splitSentences("진짜요\n??"), ["진짜요 ??"]);
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences("했어요.내일은 쉬어요."), ["했어요.", "내일은 쉬어요."]);
});

// ───────── sentenceStyle · styleReport ─────────

const STYLES: [string, ReturnType<typeof sentenceStyle>][] = [
  ["오늘 수고했어요.", "haeyo"], ["괜찮을까요?", "haeyo"], ["좋네요", "haeyo"], ["그렇죠?", "haeyo"],
  ["내일 봐요~", "haeyo"], ["몇 시예요?", "haeyo"], ["학생이에요", "haeyo"], ["알람 맞춰 주세요 🙏", "haeyo"],
  ["했어용 ㅎㅎ", "haeyo"], ["좋아염", "haeyo"], ["네", "haeyo"], ["넵!", "haeyo"], ["아뇨", "haeyo"],
  ["확인했습니다.", "hapsyo"], ["저장할까요? 아니면 저장합니까?", "hapsyo"], ["안녕히 주무십시오", "hapsyo"], ["감사합니다", "hapsyo"],
  ["잘 자", "banmal"], ["알았어", "banmal"], ["내일 봐!", "banmal"], ["뭐야?", "banmal"], ["피곤했겠다", "banmal"],
  ["그럼 내가 할게", "banmal"], ["갈래?", "banmal"], ["응", "banmal"], ["ㅇㅇ", "banmal"], ["ㅇㅋ", "banmal"],
  ["늦잠 잤거든", "banmal"], ["가야돼🙂", "banmal"], ["학교 가", "banmal"],
  ["진짜 피곤함", "unknown"], ["내일 영어", "unknown"], ["필요", "unknown"], ["대박", "unknown"], ["ㅋㅋㅋ", "unknown"],
  ["OK", "unknown"], ["기상 확인 08:12 (자동)", "unknown"], ["학교까지", "unknown"],
];
for (const [s, want] of STYLES) {
  test(`sentenceStyle(${JSON.stringify(s)}) = ${want}`, () => assert.equal(sentenceStyle(s), want));
}

test("styleReport: 해요체 섞임 · 반말 섞임 세기", () => {
  const r = styleReport("오늘 수고했어요. 내일 7시에 깨워 드릴게요! 근데 너 늦잠 잤지? 확인했습니다.");
  assert.deepEqual([r.sentences, r.haeyo, r.banmal, r.hapsyo, r.unknown], [4, 2, 1, 1, 0]);
  assert.equal(r.detail[2].style, "banmal");
  const e = styleReport("");
  assert.deepEqual([e.sentences, e.haeyo, e.hapsyo, e.banmal, e.unknown], [0, 0, 0, 0, 0]);
});

// ───────── questionCount · isQuestion ─────────

const QUESTIONS: [string, number][] = [
  ["오늘 준비가 18분 더 걸렸네요. 이유가 있었나요?", 1],
  ["오늘 준비가 18분 더 걸렸네요. 이유가 있었나요", 1], // 물음표 없어도 '나요'
  ["저장할까요? 내일 7시 반이에요. 괜찮으세요?", 2],
  ["오늘 어땠어요", 1],
  ["괜찮은가요 학교 가요", 1], // '학교 가요'는 물음 아님
  ["좋아요. 내일 봐요.", 0],
  ["그렇죠", 0], // '죠'는 물음표 있을 때만
  ["그렇죠?", 1],
  ["뭐야 진짜?? 대박", 1],
  ["내일 몇 시에 일어나요?", 1],
  ["준비 다 했니? 내일 갈까", 2],
  ["준비 다 했니 내일 갈까", 1], // 알려진 한계: 문장부호 없는 반말은 문장을 못 나눔 → 끝 낱말 기준 1
  ["확인했습니다. 저장합니까", 1],
  ["언니 왔어", 0],
  ["", 0],
];
for (const [t, n] of QUESTIONS) {
  test(`questionCount(${JSON.stringify(t)}) = ${n}`, () => assert.equal(questionCount(t), n));
}

test("isQuestion: 문장 하나", () => {
  assert.equal(isQuestion("할까요"), true);
  assert.equal(isQuestion("했어요"), false);
  assert.equal(isQuestion("아니"), false);
});

// ───────── unsupportedNumbers ─────────

const ALLOWED = {
  clocks: [hm("07:40"), hm("14:00"), hm("08:12")],
  durations: [18, 30],
  counts: [2],
  dates: ["2026-10-08", "2026-10-09"],
};
const flagged = (t: string, now?: string): string[] => unsupportedNumbers(t, ALLOWED, DATES, { calendarToday: now === undefined ? undefined : calOf(now) }).map((m) => m.raw);

test("unsupportedNumbers: 허용된 숫자만 쓰면 빈 목록 (표기만 달라도 통과)", () => {
  assert.deepEqual(flagged("오늘 기상 08:12, 준비가 18분 더 걸렸어요. 내일 7시 40분 알람이에요."), []);
  assert.deepEqual(flagged("내일 오후 두시 스터디 맞죠? 알람은 일곱 시 사십 분이에요"), []);
  assert.deepEqual(flagged("알람 두 번 미뤘어요. 30분 정도 준비하면 돼요"), []);
});

test("unsupportedNumbers: 때 표시 없는 2시는 14:00이 허용이면 통과, 오전 2시는 걸림", () => {
  assert.deepEqual(flagged("내일 2시 스터디"), []);
  assert.deepEqual(flagged("내일 오전 2시 스터디"), ["오전 2시"]);
});

test("unsupportedNumbers: 지어낸 시각 · 길이 · 횟수 · 날짜를 잡음", () => {
  assert.deepEqual(flagged("내일 7시 반에 깨워 드릴게요"), ["7시 반"]);
  assert.deepEqual(flagged("준비가 20분 더 걸렸네요"), ["20분 더"]);
  assert.deepEqual(flagged("알람 세 번 미뤘죠?"), ["세 번"]);
  assert.deepEqual(flagged("모레 발표 준비는요?"), ["모레"]);
  assert.deepEqual(flagged("10월 12일 시험 있죠"), ["10월 12일"]);
  assert.deepEqual(flagged("12일 시험 있죠"), ["12일"]);
  assert.deepEqual(flagged("다음 주 화요일 팀플"), ["다음 주 화요일"]);
});

test("unsupportedNumbers: 서수 · 구조 숫자 · 관용어 '한 번'은 안 걸림", () => {
  assert.deepEqual(flagged("첫 번째 알람은 1단계 소리로, 2호선 3번 출구에서 만나요"), []);
  assert.deepEqual(flagged("한 번 더 확인해 볼게요"), []);
  assert.deepEqual(flagged("다시 한번 말해 주세요"), []);
});

test("unsupportedNumbers: 허용 날짜 · 요일 · 새벽 상대 날짜", () => {
  assert.deepEqual(flagged("이번 주 금요일 스터디"), []); // 10/9 허용
  assert.deepEqual(flagged("9일 스터디"), []);
  assert.deepEqual(flagged("10/9 14:00"), []);
  // 01:30에 말한 '모레'(record 기준 10/10, 달력 기준 10/11) — 둘 다 허용 밖이라 걸림
  assert.deepEqual(flagged("모레 봐요", "2026-10-09T01:30:00+09:00"), ["모레"]);
  // 01:30에 말한 '어제'(10/7 또는 10/8) — 10/8이 허용이라 통과
  assert.deepEqual(flagged("어제 늦잠", "2026-10-09T01:30:00+09:00"), []);
  assert.deepEqual(flagged("어제 늦잠", "2026-10-08T22:00:00+09:00"), ["어제"]);
});

test("unsupportedNumbers: ctxDates 없으면 상대 날짜 · 요일은 안 검사, 묵시 허용 키 바꾸기", () => {
  assert.deepEqual(unsupportedNumbers("모레 다음 주 화요일", ALLOWED).map((m) => m.raw), []);
  const strict = unsupportedNumbers("오늘 내일", { ...ALLOWED, dates: [] }, DATES, { implicitDateKeys: [] });
  assert.deepEqual(strict.map((m) => m.raw), ["오늘", "내일"]);
});

test("unsupportedNumbers: 범위는 양 끝 모두 허용이어야 통과", () => {
  assert.deepEqual(unsupportedNumbers("18~30분", ALLOWED).map((m) => m.raw), []);
  assert.deepEqual(unsupportedNumbers("10~30분", ALLOWED).map((m) => m.raw), ["10~30분"]);
});

// ═════════ 적대적 검토 (10/9) — 찾은 버그를 막는 사례 ═════════

test("검토: '시' 뒤 낱말 때문에 시각을 놓치지 않음 ('7시인데' · '7시인가요?' · '두시인데' · '8시대' · STT '7시장소' · '7시청소')", () => {
  assert.equal(clock("알람 7시인데 일찍 일어나야 해").value, hm("07:00"));
  assert.equal(clock("7시인가요?").value, hm("07:00"));
  assert.equal(clock("내일오후두시인데").value, hm("14:00"));
  assert.equal(clock("8시대에 와").value, hm("08:00"));
  assert.equal(clock("7시장소는 도서관").value, hm("07:00"));
  assert.equal(clock("7시청소").value, hm("07:00"));
  assert.deepEqual(only("9시인지 10시인지 모르겠어", "clock").map((c) => c.value), [hm("09:00"), hm("10:00")]);
  // 지어낸 시각 검사도 이걸 잡아야 함
  assert.deepEqual(unsupportedNumbers("알람 7시인데요", ALLOWED).map((m) => m.raw), ["7시"]);
  // 고유어 '시' 낱말은 여전히 아님
  assert.equal(only("두 시험 다 망함", "clock").length, 0);
  assert.equal(only("1시간", "clock").length, 0);
  assert.equal(only("2시즌", "clock").length, 0);
});

test("검토: '만나요' · '일어나요' · '끝나요' · '짜증나요'는 물음 아님 ('나요' 의문형과 구분)", () => {
  for (const s of ["내일 만나요", "내일 아침에 도서관에서 만나요", "7시에 일어나요", "수업이 3시에 끝나요", "짜증나요", "생각이 나요",
    "시간이 지나요", "신나요", "기억나요", "화나요", "할 테니", "생각해 보니"]) {
    assert.equal(isQuestion(s), false, s);
  }
  for (const s of ["있나요", "하나요", "괜찮나요", "일어나나요", "만나나요", "가지나요", "만나요?", "몇 시에 끝나나요"]) {
    assert.equal(isQuestion(s), true, s);
  }
  assert.equal(questionCount("내일 도서관에서 만나요. 7시에 일어나요. 괜찮나요?"), 1);
  assert.equal(questionCount("푹 주무세요 내일 만나요"), 0);
});

test("검토: '5/10분'은 날짜가 아니라 길이 목록", () => {
  assert.equal(only("미루기 5/10분", "date").length, 0);
  assert.deepEqual(only("미루기 5/10분", "duration").map((d) => d.value), [5, 10]);
  assert.equal(only("1/2번", "date").length, 0);
  assert.deepEqual(date("10/9 스터디").value, { type: "absolute", year: null, month: 10, day: 9 });
});

test("검토: 시간 범위 '3~4시간' · '2-3시간'은 범위 길이 하나", () => {
  const d = dur("3~4시간 걸려");
  assert.deepEqual([d.value, d.range, d.approx], [180, [180, 240], true]);
  assert.equal(only("3~4시간 걸려", "other").length, 0);
  assert.deepEqual(dur("2-3시간").range, [120, 180]);
  assert.deepEqual(unsupportedNumbers("1~2시간", { ...ALLOWED, durations: [60, 120] }).map((m) => m.raw), []);
  assert.deepEqual(unsupportedNumbers("1~2시간", ALLOWED).map((m) => m.raw), ["1~2시간"]);
});

test("검토: '분' 없이 쓴 분 ('7시 40에' · '7시30' · '1시간 20')", () => {
  assert.equal(clock("7시 40에 깨워줘").value, hm("07:40"));
  assert.equal(only("7시 40에 깨워줘", "other").length, 0);
  assert.equal(clock("7시30").value, hm("07:30"));
  assert.equal(clock("오후 2시 15 스터디").value, hm("14:15"));
  assert.equal(dur("1시간 20 걸려").value, 80);
  assert.deepEqual(flagged("내일 7시 40에 알람이에요"), []);
  // 분이 아닌 숫자는 붙이지 않음
  assert.equal(clock("7시 3번 출구").value, hm("07:00"));
  assert.equal(clock("7시 20명 모임").value, hm("07:00"));
  assert.equal(clock("2시 10~15분 사이").value, hm("02:00"));
  assert.deepEqual(dur("2시 10~15분 사이").range, [10, 15]);
});

test("검토: '07시'는 24시간 표기(모호 아님), '08:12:30'은 초까지 쓴 시각", () => {
  assert.equal(clock("07시").hour12Ambiguous, false);
  assert.equal(clock("07시").value, hm("07:00"));
  const c = clock("기상 08:12:30");
  assert.deepEqual([c.value, c.raw], [hm("08:12"), "08:12:30"]);
  assert.equal(only("기상 08:12:30", "other").length, 0);
});

test("검토: '다담주' · '다음 다음 주'는 다다음 주", () => {
  assert.deepEqual(date("다담주 화요일").value, { type: "weekday", week: "after_next", weekday: "TUE", explicit: true });
  assert.deepEqual(date("다음 다음 주 월요일").value, { type: "weekday", week: "after_next", weekday: "MON", explicit: true });
  assert.equal(resolveRelativeDate(date("다담주 화요일"), DATES).date, "2026-10-20");
});

test("검토: '나두(나도) 시간 없어' · '일 분담' · '3일 연속' · '1박 2일'은 길이 · 날짜 아님", () => {
  assert.equal(only("나두 시간 없어", "duration").length, 0);
  assert.equal(dur("나두 두 시간 걸려").value, 120);
  assert.deepEqual(findTimeMentions("일 분담해서 하자"), []);
  assert.equal(only("3일 연속 지각", "date").length, 0);
  assert.equal(only("1박 2일 엠티", "date").length, 0);
  assert.equal(only("2박3일", "date").length, 0);
  // 10/9 — 날 수는 무시하는 구조 숫자가 아니라 허용 횟수와 비교 (ALLOWED.counts = [2])
  assert.deepEqual(flagged("3일 연속 늦잠이에요"), ["3일"]);
  assert.deepEqual(flagged("2일 연속 늦잠이에요"), []);
});

test("검토: 길이 방향 '20분만큼 더' · '10분 이따가'", () => {
  assert.equal(dur("20분만큼 더 걸렸어").modifier, "more");
  assert.equal(dur("10분 이따가 다시").modifier, "after");
});

test("검토: '8시 10분 전'은 7:50으로도 읽힘 (후보에 넣어 지어낸 숫자로 오판하지 않음)", () => {
  const c = clock("8시 10분 전에 도착");
  assert.equal(c.value, hm("08:10"));
  assert.equal(c.relation, "before");
  assert.ok(c.candidates.includes(hm("07:50")));
  assert.deepEqual(unsupportedNumbers("8시 10분 전에 도착해요", { ...ALLOWED, clocks: [hm("07:50")] }).map((m) => m.raw), []);
  assert.deepEqual(unsupportedNumbers("8시 10분 전에 도착해요", { ...ALLOWED, clocks: [hm("08:10")] }).map((m) => m.raw), []);
  assert.deepEqual(clock("9시 전").candidates, [hm("09:00"), hm("21:00")]); // 분이 없으면 그대로
  assert.deepEqual(clock("8시 10분 이전").candidates, [hm("08:10"), hm("20:10")]); // '이전'은 '그 시각보다 앞'
});

test("검토: '점심때 1시' · '저녁때 7시'의 때 표시", () => {
  assert.deepEqual([clock("점심때 1시").value, clock("점심때 1시").period], [hm("13:00"), "점심"]);
  assert.equal(clock("저녁때 7시").value, hm("19:00"));
});

test("검토: 경계 시각 00:00 · 23:59 · 24:00", () => {
  assert.equal(clock("23:59").value, 1439);
  assert.equal(clock("00:00").value, 0);
  assert.equal(clock("00:00").hour12Ambiguous, false);
  assert.equal(clock("24:00").value, 0);
  assert.equal(resolveClock(clock("12시"), { after: 1439 }).hhmm, "00:00");
  assert.equal(resolveClock(clock("12시"), { after: 0 }).hhmm, "00:00");
  assert.equal(resolveClock(clock("12시"), { after: 1 }).hhmm, "12:00");
  assert.deepEqual(unsupportedNumbers("자정에 자요", { ...ALLOWED, clocks: [1440] }).map((m) => m.raw), []);
  assert.equal(hhmmToMinutes("23:59"), 1439);
  assert.equal(hhmmToMinutes("00:00"), 0);
});

test("검토: 자정 뒤 모호성 경계 (00:00 · 03:59:59 · 04:00 · 23:59 · 해 넘김) — 달력 오늘만 본다", () => {
  assert.equal(resolveRelativeDate(date("내일"), DATES, calOf("2026-10-09T00:00:00+09:00")).ambiguous, true);
  assert.equal(resolveRelativeDate(date("내일"), DATES, calOf("2026-10-09T03:59:59+09:00")).ambiguous, true);
  // 04:00 이후여도 기준일이 안 넘어갔으면(오늘 기상 기록 없음, 설계 메모 4.1) 계속 모호
  assert.equal(resolveRelativeDate(date("내일"), DATES, calOf("2026-10-09T04:00:00+09:00")).ambiguous, true);
  assert.equal(resolveRelativeDate(date("내일"), DATES, calOf("2026-10-08T23:59:00+09:00")).ambiguous, false);
  // 해 넘김: 기준일 12/31, 달력 1/1 — 다른 해석은 하루 뒤
  const NYE = { ...DATES, today: "2025-12-31", tomorrow: "2026-01-01", day_after: "2026-01-02" };
  const r = resolveRelativeDate(date("내일"), NYE, calOf("2025-12-31T17:30:00Z")); // = 2026-01-01 02:30 KST
  assert.deepEqual([r.date, r.ambiguous, r.alternative], ["2026-01-01", true, "2026-01-02"]);
});

test("검토: 없는 날짜 · 시각의 ISO는 받지 않음 (조용히 넘기면 엉뚱한 record_date)", () => {
  assert.throws(() => seoulLocal("2026-02-30T10:00:00"));
  assert.throws(() => seoulLocal("2026-02-30T10:00:00+09:00")); // Date.parse는 3/2로 넘김
  assert.throws(() => seoulLocal("2026-10-08T25:00:00"));
  assert.throws(() => seoulLocal("2026-10-08T23:60:00+09:00"));
  assert.deepEqual(seoulLocal("2026-10-08T22:30:00+0900"), { date: "2026-10-08", minutes: 1350 });
});

test("검토: 2월 29일 · 다음 달에 없는 일 (날짜를 null로 버리지 않음)", () => {
  const d27 = { ...DATES, today: "2027-10-08" };
  assert.equal(resolveRelativeDate({ type: "absolute", year: null, month: 2, day: 29 }, d27).date, "2028-02-29");
  const jan31 = { ...DATES, today: "2027-01-31" };
  const r = resolveRelativeDate({ type: "absolute", year: null, month: null, day: 30 }, jan31);
  assert.deepEqual([r.date, r.ambiguous, r.alternative], ["2027-03-30", true, "2027-01-30"]);
  const r2 = resolveRelativeDate({ type: "absolute", year: null, month: null, day: 29 }, jan31);
  assert.equal(r2.date, "2027-03-29");
  // 날짜가 null인데 다른 해석만 있는 모양은 없어야 함
  for (let day = 1; day <= 31; day++) {
    for (const today of ["2027-01-31", "2026-10-31", "2027-02-28", "2028-02-29", "2026-12-31"]) {
      const x = resolveRelativeDate({ type: "absolute", year: null, month: null, day }, { ...DATES, today });
      assert.ok(x.date !== null, `${today} ${day}일`);
      assert.ok(x.date! >= today, `${today} ${day}일 → ${x.date}`);
    }
  }
});

test("검토: 말투 — 귀여운 존댓말 · 줄임 · 명령형 반말 · 명사 조각", () => {
  const want: [string, ReturnType<typeof sentenceStyle>][] = [
    ["잘자용", "haeyo"], ["그쵸?", "haeyo"], ["옙", "haeyo"], ["넹넹", "haeyo"], ["알겠어욬ㅋㅋ", "haeyo"],
    ["넵 알겠슴다", "hapsyo"], ["감사합니당", "hapsyo"],
    ["응응", "banmal"], ["그치?", "banmal"], ["알람 꺼", "banmal"], ["알람 켜", "banmal"], ["알람 미뤄", "banmal"],
    ["바꿔", "banmal"], ["7시로 맞춰", "banmal"], ["그냥 놔둬", "banmal"], ["슬퍼", "banmal"],
    ["다음 주 휴가", "unknown"], ["알림 메시지", "unknown"], ["올해", "unknown"], ["학교에서", "unknown"], ["아빠", "unknown"],
    ["스피커", "unknown"], ["배려", "unknown"], ["개요", "unknown"], ["아침마다", "unknown"], ["3페이지", "unknown"],
  ];
  for (const [s, st] of want) assert.equal(sentenceStyle(s), st, s);
});

test("검토: 문장 나누기 — 존댓말 뒤 물결 · 번호 목록 · 긴 받아쓰기 글 속도", () => {
  assert.deepEqual(splitSentences("좋아요~내일 봐요"), ["좋아요~", "내일 봐요"]);
  assert.deepEqual(splitSentences("월~금 수업이에요"), ["월~금 수업이에요"]);
  assert.deepEqual(splitSentences("1. 준비물 챙기기\n2. 알람 확인"), ["1. 준비물 챙기기", "2. 알람 확인"]);
  const long = "오늘 학교 갔다가 집에 와서 밥 먹고 ".repeat(1500); // 문장부호 없는 긴 글
  const t0 = performance.now();
  splitSentences(long);
  styleReport(long);
  assert.ok(performance.now() - t0 < 1500, "긴 글에서 느려지면 안 됨(제곱 시간)");
});

test("검토: 길이 방향 낱말 더 ('줄여' · '늘려' · '빼' · '추가' · '뒤로') · '더 일찍'은 earlier", () => {
  const want: [string, DurationMention["modifier"]][] = [
    ["준비 10분 줄여줘", "less"], ["10분 늘려줘", "more"], ["5분 빼줘", "less"], ["10분 추가해줘", "more"],
    ["10분 뒤로 미뤄", "later"], ["10분 더 일찍 깨워줘", "earlier"], ["10분 더 늦게", "later"], ["20분 더 걸렸어", "more"],
    ["10분 더 빨리", "earlier"],
  ];
  for (const [t, mod] of want) assert.equal(dur(t).modifier, mod, t);
  assert.equal(dur("10분 더 일찍 깨워줘").raw, "10분 더 일찍");
});

test("검토: 새벽(00:00~03:59)의 요일 — 일요일 밤 → 월요일 새벽은 주가 바뀜 (모호로 표시)", () => {
  // record_date = 10/11(일), 지금 = 10/12(월) 00:30
  const SUN: Context["dates"] = {
    today: "2026-10-11", tomorrow: "2026-10-12", day_after: "2026-10-13", weekday_today: "SUN",
    this_week: DATES.this_week, next_week: DATES.next_week,
  };
  const now = calOf("2026-10-12T00:30:00+09:00");
  const fri = resolveRelativeDate(date("이번 주 금요일"), SUN, now);
  assert.deepEqual([fri.date, fri.ambiguous, fri.alternative], ["2026-10-09", true, "2026-10-16"]);
  const tue = resolveRelativeDate(date("다음 주 화요일"), SUN, now);
  assert.deepEqual([tue.date, tue.ambiguous, tue.alternative], ["2026-10-13", true, "2026-10-20"]);
  assert.equal(resolveRelativeDate(date("월요일"), SUN, now).date, "2026-10-12");
  // 같은 말도 저녁이면 모호하지 않음
  assert.equal(resolveRelativeDate(date("다음 주 화요일"), SUN, calOf("2026-10-11T22:00:00+09:00")).ambiguous, false);
  // 목 → 금 새벽: '목요일'은 기록일(10/8)일 수도, 다음 주 목요일(10/15)일 수도
  const thu = resolveRelativeDate(date("목요일"), DATES, calOf("2026-10-09T00:30:00+09:00"));
  assert.deepEqual([thu.date, thu.ambiguous, thu.alternative], ["2026-10-08", true, "2026-10-15"]);
  assert.equal(resolveRelativeDate(date("금요일"), DATES, calOf("2026-10-09T00:30:00+09:00")).ambiguous, false);
  assert.equal(resolveRelativeDate(date("다음 주 화요일"), DATES, calOf("2026-10-09T00:30:00+09:00")).ambiguous, false);
  // 지어낸 숫자 검사는 두 해석 모두 받음
  assert.deepEqual(unsupportedNumbers("이번 주 금요일 스터디", { ...ALLOWED, dates: ["2026-10-16"] }, SUN, { calendarToday: now }).map((m) => m.raw), []);
});

test("검토: 받아쓰기형 — 이음말 '-는데' · '-면' · '아까' 뒤에 붙은 고유어 수", () => {
  assert.equal(dur("준비하는데한시간걸렸어").value, 60);
  assert.equal(dur("아까한시간전에일어났어").modifier, "before");
  assert.equal(dur("버스타면두시간걸려").value, 120);
  assert.equal(clock("끝나면세시쯤갈게").value, hm("03:00"));
  assert.equal(only("알람울렸는데세번이나껐어", "count")[0].value, 3);
  // 낱말 속 글자는 여전히 아님
  assert.deepEqual(findTimeMentions("모두 시간이 없어"), []);
  assert.deepEqual(findTimeMentions("또한 시간 맞추기 어려움"), []);
});

test("검토: '다음 달 15일'은 이번 달 15일이 아님 ('담달' · '이번 달' · 12월 넘김)", () => {
  assert.deepEqual(date("다음 달 15일").value, { type: "absolute", year: null, month: null, day: 15, monthOffset: 1 });
  assert.equal(resolveRelativeDate(date("다음 달 15일"), DATES).date, "2026-11-15");
  assert.equal(resolveRelativeDate(date("담달 3일"), DATES).date, "2026-11-03");
  assert.equal(resolveRelativeDate(date("담달 3일"), DATES).ambiguous, false);
  assert.equal(resolveRelativeDate(date("이번 달 20일"), DATES).date, "2026-10-20");
  assert.equal(resolveRelativeDate(date("다음 달 5일"), { ...DATES, today: "2026-12-20" }).date, "2027-01-05");
  assert.equal(resolveRelativeDate(date("다음 달 31일"), DATES).date, null); // 11월엔 31일 없음
  assert.deepEqual(flagged("다음 달 9일 스터디"), ["다음 달 9일"]); // 11/9는 허용 밖 (일만 같다고 통과시키지 않음)
  assert.deepEqual(flagged("이번 달 9일 스터디"), []);
  // 지금까지의 '9일'은 그대로
  assert.deepEqual(date("9일").value, { type: "absolute", year: null, month: null, day: 9 });
});

test("검토: 반말 금지형 '늦지 마' · '걱정 마'", () => {
  assert.equal(sentenceStyle("늦지 마"), "banmal");
  assert.equal(sentenceStyle("걱정 마~"), "banmal");
  assert.equal(sentenceStyle("엄마"), "unknown");
});

test("검토: '08:12요' · 'OK요'는 해요체", () => {
  assert.equal(sentenceStyle("기상은 08:12요"), "haeyo");
  assert.equal(sentenceStyle("OK요"), "haeyo");
  assert.equal(sentenceStyle("요"), "unknown");
});

test("검토: 퍼징 — 조각을 섞은 글 2000개에서 불변식 (겹침 없음 · 위치 = 원문 · 값 범위 · 글자 보존)", () => {
  const FRAGS = [
    "내일", "낼", "모레", "오늘", "어제", "다음 주 화요일", "담주 화욜", "이번 주 금요일", "10월 9일", "9일", "10/9", "5/10/15분",
    "오후 2시", "두시", "7시 반", "일곱시반", "14:00", "07:30", "08:12:30", "새벽 3시", "밤 12시 반", "정오", "자정", "7~8시", "8시 10분 전",
    "7시인데", "7시 40에", "10분", "20분 더", "1시간 반", "한두 시간", "3~4시간", "10~15분", "두 번", "2번", "한 번", "세 번째",
    "1번 출구", "2호선", "3학년", "1박 2일", "3일 연속", "모두 시간", "나두 시간", "이분이", "한시름", "네 시간 괜찮아요",
    "ㅋㅋ", "😊", "?", "!", ".", "~", "\n", " ", "요", "했어요", "할까요", "만나요", "알겠습니다", "응", "잘자", "1.", "(금)",
    "２시", "７：３０", "오후두시반에", "알람", "준비", "스터디", "도서관", "에", "는", "가",
    // 10/9 추가 — 진행 분수 · 동사 '두시' · 지난밤 · 날 수 · 문장 중간 반말
    "루틴 1/3단계", "2/3 완료", "두시는 게", "그대로 두시면", "어젯밤", "간밤", "지난 밤 11시", "최근 7일 중 3일", "이틀",
    "2~3일 동안", "3일째", "늦잠이었구나,", "좋네,", "수고했어,", "오후 18시", "낮 12시 반", "밤 12시",
    // 검수 10/9 추가
    "누구나", "발표하는 날이 9일", "그날은 9일", "이틀 뒤", "두시니까", "회의가 두시면", "고려해,", "오후 6:30", "9일 정도",
  ];
  let seed = 12345;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let i = 0; i < 2000; i++) {
    const n = 1 + rand(8);
    let t = "";
    for (let k = 0; k < n; k++) t += FRAGS[rand(FRAGS.length)] + (rand(3) === 0 ? "" : " ");
    const norm = t.normalize("NFC").replace(/[０-９：～？！．／]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const ms = findTimeMentions(t);
    let prevEnd = 0;
    for (const m of ms) {
      assert.ok(m.start >= prevEnd && m.end > m.start, `겹침: ${JSON.stringify(t)} ${JSON.stringify(ms)}`);
      prevEnd = m.end;
      assert.equal(norm.slice(m.start, m.end), m.raw, t);
      if (m.kind === "clock") {
        assert.ok(m.value >= 0 && m.value < 1440, `${t} → ${m.value}`);
        assert.ok(m.candidates.every((c) => c >= 0 && c < 1440) && m.candidates.includes(m.value), t);
        if (m.hour12Ambiguous) assert.ok(m.candidates.length >= 2, t);
      }
      if (m.kind === "duration") {
        assert.ok(Number.isFinite(m.value) && m.value >= 0, t);
        if (m.range) assert.ok(m.range[0] <= m.range[1] && m.value === m.range[0], t);
      }
    }
    const flagged = unsupportedNumbers(t, ALLOWED, DATES, { calendarToday: calOf("2026-10-09T01:30:00+09:00") });
    assert.ok(flagged.every((f) => ms.some((m) => m.start === f.start && m.end === f.end)), t);
    const sents = splitSentences(t);
    assert.equal(sents.join("").replace(/\s/gu, ""), norm.replace(/\s/gu, ""), `글자 보존: ${JSON.stringify(t)}`);
    const r = styleReport(t);
    assert.equal(r.haeyo + r.hapsyo + r.banmal + r.unknown, r.sentences);
    assert.ok(questionCount(t) <= r.sentences);
  }
});

test("검토: 결정성 — 같은 입력은 같은 결과, 호출 순서와 무관", () => {
  const a = "내일 오후 두시 · 7시 반 · 20분 더 · 두 번 · 다음 주 화요일";
  const first = findTimeMentions(a);
  findTimeMentions("모레 3시 10/9 5/10/15분");
  assert.deepEqual(findTimeMentions(a), first);
  assert.deepEqual(unsupportedNumbers(a, ALLOWED, DATES), unsupportedNumbers(a, ALLOWED, DATES));
});

// ═════════ v1 바퀴 준비 (10/9) — 숫자 검사 오탐 · 날 수 · 시각 표기 · 오전/오후 정확도 · 문장 중간 반말 ═════════

const kinds = (t: string): string[] => findTimeMentions(t).map((m) => `${m.kind}:${m.raw}`);

// ───────── 진행 분수 '1/3단계' (시운전 s-dev-022 · 034 오탐) ─────────

const FRACTIONS: [string, string, number, number][] = [
  ["오늘 07:51에 일어나서 08:52에 도착했고, 루틴은 1/3단계 완료했어요.", "1/3", 1, 3],
  ["루틴 1/3단계 완료가 기록됐어요", "1/3", 1, 3],
  ["아침 루틴은 2/3단계까지 했어요.", "2/3", 2, 3],
  ["루틴 2/3 완료", "2/3", 2, 3],
  ["루틴은 1/3", "1/3", 1, 3],
  ["체크리스트 3/5 끝", "3/5", 3, 5],
];
for (const [t, raw, n, d] of FRACTIONS) {
  test(`진행 분수: ${t} → ${raw} (날짜 아님)`, () => {
    const f = findTimeMentions(t).find((m): m is OtherMention => m.kind === "other" && m.unit === "분수");
    assert.ok(f, JSON.stringify(findTimeMentions(t)));
    assert.deepEqual([f.raw, f.value, f.denominator], [raw, n, d]);
    assert.equal(only(t, "date").filter((x) => x.value.type === "absolute").length, 0);
  });
}

test("진행 분수: 날짜 '10/9 스터디' · '1/3 스터디'는 그대로 날짜, '3/2단계'는 날짜 아님", () => {
  assert.deepEqual(date("10/9 스터디").value, { type: "absolute", year: null, month: 10, day: 9 });
  assert.deepEqual(date("1/3 스터디").value, { type: "absolute", year: null, month: 1, day: 3 });
  assert.equal(only("3/2단계", "date").length, 0);
  // 단위 · 완료 말이 아닌 뒤 낱말은 날짜 그대로 ('개강' · '진행 예정')
  assert.deepEqual(date("3/4 개강").value, { type: "absolute", year: null, month: 3, day: 4 });
  assert.deepEqual(date("3/4 진행 예정").value, { type: "absolute", year: null, month: 3, day: 4 });
});

test("진행 분수: 허용 분수 목록이 없으면 안 걸고, 있으면 'N/M'으로 비교 · fractionsIn", () => {
  assert.deepEqual(flagged("오늘 07:40에 일어났고 루틴은 1/3단계 완료했어요."), []); // s-dev-022 오탐 사라짐
  const al = { ...ALLOWED, fractions: fractionsIn("루틴 완료 — 루틴 2/3단계 완료") };
  assert.deepEqual(al.fractions, ["2/3"]);
  assert.deepEqual(unsupportedNumbers("루틴은 2/3단계 했어요", al).map((m) => m.raw), []);
  assert.deepEqual(unsupportedNumbers("루틴은 1/3단계 했어요", al).map((m) => m.raw), ["1/3"]);
});

test("구조 숫자: 'N단계' · 서수는 지어낸 숫자로 안 걸림", () => {
  for (const t of [
    "루틴 3단계 중 1단계 했어요", "강도 2단계로 올렸어요", "1단계부터 3단계까지 울려요", "두 번째 알람은 7시 40분이에요",
    "첫 번째, 두 번째 단계는 끝났어요", "셋째 알람", "2번째 알람", "2일차 엠티는 쉬어요",
  ]) assert.deepEqual(flagged(t), [], t);
});

// ───────── '두시는 게' (동사 두다) — 2시 아님 (시운전 s-dev-022 오탐) ─────────

const DU_VERB: string[] = [
  "발표 준비물이랑 옷 챙길 시간을 더 두시는 게 좋겠어요.",
  "알람은 그대로 두시면 돼요",
  "알람은 그대로 두시고 준비만 10분 늘릴게요",
  "7시 40분에 맞춰 두시면 돼요",
  "알람 켜 두시죠",
  "여유를 두시면 덜 급해요",
  "출발 전에 시간을 두시길 바라요",
  "그냥두시면돼요",
];
for (const t of DU_VERB) {
  test(`'두시' 동사: ${t} → 2시 없음`, () => {
    assert.equal(only(t, "clock").filter((c) => c.hour === 2).length, 0, JSON.stringify(findTimeMentions(t)));
  });
}

test("'두시' 시각은 그대로 ('내일 두시면' · '두시죠?' · '두시는 어때요' · '두시 반' · '오후 두시는')", () => {
  assert.equal(clock("내일 두시면 돼요").value, hm("02:00"));
  assert.equal(clock("약속이 두시죠?").value, hm("02:00"));
  assert.equal(clock("두시는 어때요?").value, hm("02:00"));
  assert.equal(clock("두시 반에 봐요").value, hm("02:30"));
  assert.equal(clock("오후 두시는 괜찮아요").value, hm("14:00"));
  assert.deepEqual(only("알람을 두시로 맞춰 두시면 돼요", "clock").map((c) => c.raw), ["두시"]);
  assert.deepEqual(flagged("발표 준비 시간을 더 두시는 게 좋겠어요."), []);
});

// ───────── 어젯밤 · 지난밤 · 간밤 = 기록 날짜 전날 밤 (시운전 s-dev-052 오탐) ─────────

const NIGHTS: string[] = ["어젯밤", "지난밤", "지난 밤", "간밤에 잘 주무셨어요", "어제 밤", "어제밤"];
for (const t of NIGHTS) {
  test(`지난밤: ${t} → last_night (= 기록 날짜 전날)`, () => {
    const d = date(t);
    assert.deepEqual(d.value, { type: "relative", key: "last_night" });
    assert.equal(resolveRelativeDate(d, DATES).date, "2026-10-07");
  });
}

test("지난밤: '밤'은 뒤 시각의 때 표시 ('어젯밤 11시' = 23:00 · '지난밤 1시' = 01:00 · '어젯밤 23시 26분')", () => {
  assert.equal(clock("어젯밤 11시에 주무셨고").value, hm("23:00"));
  assert.equal(clock("지난밤 1시에 잤어요").value, hm("01:00"));
  assert.equal(clock("어제 밤 12시 반에").value, hm("00:30"));
  assert.equal(clock("어젯밤 23시 26분에 주무셨고").value, hm("23:26"));
  assert.deepEqual(findTimeMentions("간식 먹고 자요"), []); // '간'만으로는 날짜 아님
});

test("지난밤: 기록 날짜가 월요일이라 어제가 날짜표에 없어도 통과 (s-dev-052) · '어제'는 그대로 검사", () => {
  const MON: Context["dates"] = {
    ...DATES, today: "2026-10-12", tomorrow: "2026-10-13", day_after: "2026-10-14", weekday_today: "MON",
    this_week: DATES.next_week, next_week: DATES.next_week,
  };
  const al = { ...ALLOWED, clocks: [hm("23:26"), hm("06:46")], dates: ["2026-10-12"] };
  const now = calOf("2026-10-12T07:10:00+09:00");
  const t = "좋은 아침이에요, 잘 잤어요? 어젯밤 23시 26분에 주무셨고 오늘 06시 46분에 일어나셨어요.";
  assert.deepEqual(unsupportedNumbers(t, al, MON, { calendarToday: now }).map((m) => m.raw), []);
  assert.deepEqual(unsupportedNumbers("간밤에 잘 주무셨어요?", al, MON, { calendarToday: now }).map((m) => m.raw), []);
  assert.deepEqual(unsupportedNumbers("어제 늦잠 잤죠?", al, MON, { calendarToday: now }).map((m) => m.raw), ["어제"]);
  // 묵시 허용을 끄면 걸림
  assert.deepEqual(unsupportedNumbers("어젯밤", al, MON, { calendarToday: now, implicitDateKeys: [] }).map((m) => m.raw), ["어젯"]);
});

// ───────── 날 수 '최근 7일 중 3일' · '3일 동안' · '3일 연속' · '이틀' ─────────

const DAY_COUNTS: [string, string, number, [number, number] | null][] = [
  ["최근 7일 중 3일", "7일", 7, null],
  ["3일 동안 늦게 잤어요", "3일", 3, null],
  ["3일 연속 지각", "3일", 3, null],
  ["3일째 늦잠이에요", "3일", 3, null],
  ["3일간 늦잠", "3일", 3, null],
  ["3일 이상 늦었어요", "3일", 3, null],
  ["2~3일 동안 바빴어요", "2~3일", 2, [2, 3]],
  ["이틀 연속 늦잠", "이틀", 2, null],
  ["사흘째 지각이에요", "사흘", 3, null],
  ["하루 이틀 늦는 건 괜찮아요", "하루 이틀", 1, [1, 2]],
  ["사나흘 걸려요", "사나흘", 3, [3, 4]],
];
for (const [t, raw, v, range] of DAY_COUNTS) {
  test(`날 수: ${t} → ${raw} (count · days, 날짜 아님)`, () => {
    const c = findTimeMentions(t).find((m): m is CountMention => m.kind === "count");
    assert.ok(c, JSON.stringify(findTimeMentions(t)));
    assert.deepEqual([c.raw, c.value, c.range, c.unit], [raw, v, range, "days"]);
    assert.equal(only(t, "date").length, 0);
  });
}

test("날 수: '7일 중 3일' · '7일 중에 3일' · '그중 2일'의 뒤 숫자도 날 수, '9일까지' · '10월 3일'은 날짜", () => {
  assert.deepEqual(kinds("최근 7일 중 3일은 늦었어요"), ["count:7일", "count:3일"]);
  assert.deepEqual(kinds("7일 중에 3일"), ["count:7일", "count:3일"]);
  assert.deepEqual(kinds("그중 2일은 늦었어요"), ["count:2일"]);
  // T5 코칭 실측 (t45-val) — '늦어진 날이 2일 있었고' · '3일 남았어요'는 날 수, '9일에 있었던' · '오늘은 9일이에요'는 날짜
  assert.deepEqual(kinds("늦어진 날이 2일 있었고, 지각도 1일 있었어요."), ["count:2일", "count:1일"]);
  assert.deepEqual(kinds("시험까지 3일 남았어요"), ["count:3일"]);
  assert.deepEqual(kinds("9일에 있었던 발표"), ["date:9일"]);
  assert.deepEqual(kinds("오늘은 9일이에요"), ["date:오늘", "date:9일"]);
  assert.deepEqual(kinds("9일까지 제출"), ["date:9일"]);
  assert.deepEqual(kinds("10월 3일 동안"), ["date:10월 3일"]);
  assert.deepEqual(kinds("1박 2일 엠티"), ["other:1박", "other:2일"]);
  assert.deepEqual(findTimeMentions("타이틀 곡"), []); // '이틀'이 낱말 속
});

test("날 수: 허용 횟수(또는 dayCounts)와 비교 — 날짜표에 같은 일이 있어도 통과시키지 않음", () => {
  // 10/7 · 10/8이 날짜표에 있지만 날 수 자리라 날짜로 통과시키지 않음
  assert.deepEqual(flagged("최근 7일 중 8일"), ["7일", "8일"]);
  assert.deepEqual(unsupportedNumbers("최근 7일 중 3일 늦었어요", { ...ALLOWED, counts: [2, 3, 7] }).map((m) => m.raw), []);
  // dayCounts를 주면 날 수는 그것과만, 횟수는 counts와만
  const al = { ...ALLOWED, counts: [2], dayCounts: [7, 3] };
  assert.deepEqual(unsupportedNumbers("최근 7일 중 3일, 알람은 2번", al).map((m) => m.raw), []);
  assert.deepEqual(unsupportedNumbers("최근 7일 중 2일, 알람은 3번", al).map((m) => m.raw), ["2일", "3번"]);
  assert.deepEqual(unsupportedNumbers("이틀 연속 늦잠", { ...ALLOWED, dayCounts: [2] }).map((m) => m.raw), []);
  assert.deepEqual(unsupportedNumbers("2~3일 동안", { ...ALLOWED, dayCounts: [2] }).map((m) => m.raw), ["2~3일"]);
});

// ───────── 받아쓰기형 수 (STT) ─────────

const STT_CLOCKS: [string, string, boolean][] = [
  ["일곱 시 반", "07:30", true],
  ["여섯시반", "06:30", true],
  ["일곱시 사십분에 깨워 줘", "07:40", true],
  ["열한 시 사십오 분", "11:45", true],
  ["오후 여섯시 반", "18:30", false],
  ["아침 여섯시 삼십분", "06:30", false],
  ["밤 열두시", "00:00", false],
  ["낮 열두시 반", "12:30", false],
  ["새벽 다섯시", "05:00", false],
  ["저녁 일곱시", "19:00", false],
  ["내일아침일곱시반에깨워줘", "07:30", false],
];
for (const [t, want, amb] of STT_CLOCKS) {
  test(`받아쓰기 시각: ${t} → ${want}${amb ? " (모호)" : ""}`, () => {
    const c = clock(t);
    assert.equal(clockToHHMM(c.value), want);
    assert.equal(c.hour12Ambiguous, amb);
  });
}

test("받아쓰기 시각: 허용 07:40이면 '일곱 시 사십 분' 통과, '일곱 시 반'은 걸림", () => {
  assert.deepEqual(flagged("내일 일곱 시 사십 분에 깨워 드릴게요"), []);
  assert.deepEqual(flagged("내일 일곱 시 반에 깨워 드릴게요"), ["일곱 시 반"]);
});

// ───────── timeFormatReport ─────────

const FORMATS: [string, { has24h: boolean; has12h: boolean; bare: string[]; mixed: boolean }][] = [
  ["오후 6시 30분에 출발해요", { has24h: false, has12h: true, bare: [], mixed: false }],
  ["18시 30분에 출발해요", { has24h: true, has12h: false, bare: [], mixed: false }],
  ["18:30 출발, 오후 7시 도착이에요", { has24h: true, has12h: true, bare: [], mixed: true }],
  ["5시에 일어나고 6시 30분에 출발해요", { has24h: false, has12h: false, bare: ["5시", "6시 30분"], mixed: false }],
  ["오전 7시에 일어나고 9시에 수업이에요", { has24h: false, has12h: true, bare: ["9시"], mixed: false }],
  ["어젯밤 23시 26분에 주무셨고 오늘 06시 46분에 일어나셨어요", { has24h: true, has12h: false, bare: [], mixed: false }],
  ["어젯밤 11시에 주무셨고 오전 7시에 일어나셨어요", { has24h: false, has12h: true, bare: [], mixed: false }],
  ["일곱 시 반에 깨워 드릴게요", { has24h: false, has12h: false, bare: ["일곱 시 반"], mixed: false }],
  ["정오에 점심, 자정 전에 자요", { has24h: false, has12h: true, bare: [], mixed: false }],
  ["밤 12시 30분에 자고 낮 12시 20분에 수업이에요", { has24h: false, has12h: true, bare: [], mixed: false }],
  ["07시에 알람이에요", { has24h: true, has12h: false, bare: [], mixed: false }],
  ["", { has24h: false, has12h: false, bare: [], mixed: false }],
];
for (const [t, want] of FORMATS) {
  test(`timeFormatReport(${JSON.stringify(t)})`, () => {
    const r = timeFormatReport(t);
    assert.deepEqual({ has24h: r.has24h, has12h: r.has12h, bare: r.bare, mixed: r.mixed }, want);
  });
}

test("timeFormatReport: 한 언급 안의 섞임 '오후 18시' · '저녁 19:00' (날 표시 '어젯밤 23시'는 아님)", () => {
  assert.deepEqual(timeFormatReport("오후 18시에 출발해요").selfMixed, ["오후 18시"]);
  assert.equal(timeFormatReport("오후 18시에 출발해요").mixed, true);
  assert.deepEqual(timeFormatReport("저녁 19:00 약속").selfMixed, ["저녁 19:00"]);
  assert.deepEqual(timeFormatReport("어젯밤 23시에 주무셨어요").selfMixed, []);
  assert.equal(clockForms("지난밤 01:37에 주무셨어요")[0].dayRefNight, true);
});

// ───────── ampmExact — 때 표시 시각을 정확히 비교 ─────────

const AMPM: [string, string[], { raw: string; hhmm: string; flipped: boolean }[]][] = [
  ["내일 오후 6시 30분에 출발해요", ["06:30"], [{ raw: "오후 6시 30분", hhmm: "18:30", flipped: true }]],
  ["내일 오후 6시 30분에 출발해요", ["18:30"], []],
  ["오전 6시 30분 알람이에요", ["18:30"], [{ raw: "오전 6시 30분", hhmm: "06:30", flipped: true }]],
  ["밤 12시 반에 주무셨어요", ["00:30"], []],
  ["낮 12시 반에 주무셨어요", ["00:30"], [{ raw: "낮 12시 반", hhmm: "12:30", flipped: true }]],
  ["낮 12시 20분 수업이에요", ["12:20"], []],
  ["오전 12시 20분 수업이에요", ["12:20"], [{ raw: "오전 12시 20분", hhmm: "00:20", flipped: true }]],
  ["오후 12시 20분 수업이에요", ["12:20"], []],
  ["자정에 주무셨어요", ["00:00"], []],
  ["밤 12시에 주무셨어요", ["00:00"], []],
  ["새벽 5시에 일어나셨어요", ["05:00"], []],
  ["저녁 5시에 일어나셨어요", ["05:00"], [{ raw: "저녁 5시", hhmm: "17:00", flipped: true }]],
  ["저녁 7시 약속이에요", ["19:00"], []],
  ["아침 7시 약속이에요", ["19:00"], [{ raw: "아침 7시", hhmm: "07:00", flipped: true }]],
  ["오후 3시 약속이에요", ["06:30"], [{ raw: "오후 3시", hhmm: "15:00", flipped: false }]],
  ["오후 여섯시 반 출발", ["18:30"], []],
  ["오전 여섯시 반 출발", ["18:30"], [{ raw: "오전 여섯시 반", hhmm: "06:30", flipped: true }]],
  ["어젯밤 11시에 주무셨어요", ["23:00"], []],
  ["어젯밤 23시 26분에 주무셨어요", ["23:26"], []],
  ["6시 30분에 출발해요", ["18:30"], []], // 때 표시 없음 → 여기선 안 봄 (timeFormatReport.bare)
];
for (const [t, allowedHHMM, want] of AMPM) {
  test(`ampmExact: ${t} · 허용 ${allowedHHMM.join(",")}`, () => {
    const r = ampmExact(t, allowedHHMM.map(hm));
    assert.deepEqual(r.map((x) => ({ raw: x.raw, hhmm: x.hhmm, flipped: x.flipped })), want);
  });
}

test("ampmExact: unsupportedNumbers는 그대로 — 때 표시 없는 시각은 오전 · 오후 둘 다 받음", () => {
  const al = { ...ALLOWED, clocks: [hm("18:30")] };
  assert.deepEqual(unsupportedNumbers("6시 30분에 출발해요", al).map((m) => m.raw), []);
  assert.deepEqual(unsupportedNumbers("오전 6시 30분에 출발해요", al).map((m) => m.raw), ["오전 6시 30분"]);
  // '8시 10분 전'의 7:50 해석도 정확한 값으로 침, 허용 24:00은 00:00
  assert.deepEqual(ampmExact("오후 8시 10분 전에 도착해요", [hm("19:50")]), []);
  assert.deepEqual(ampmExact("자정에 자요", [1440]), []);
});

// ───────── 문장 중간 반말 (시운전 s-dev-014 '늦잠이었구나,') ─────────

const MID_BANMAL: [string, string][] = [
  ["늦잠이었구나, 많이 아쉬웠겠어요.", "늦잠이었구나"],
  ["그랬구나 많이 힘들었겠어요", "그랬구나"],
  ["좋네, 내일도 이렇게 해요.", "좋네"],
  ["늦게 잤잖아 그래서 피곤해요", "잤잖아"],
  ["늦잠 잤거든 그래서 늦었어요", "잤거든"],
  ["피곤했겠지, 오늘은 푹 쉬어요.", "피곤했겠지"],
  ["중요한 거야, 꼭 챙겨요.", "거야"],
  ["수고했어, 푹 쉬어요.", "수고했어"],
  ["피곤해, 오늘은 일찍 자요.", "피곤해"],
];
for (const [t, w] of MID_BANMAL) {
  test(`문장 중간 반말: ${t} → banmal (${w})`, () => {
    assert.equal(midBanmalClause(t), w);
    assert.equal(sentenceStyle(t), "banmal");
  });
}

const MID_OK: string[] = [
  "오늘 늦게 일어났는데, 괜찮아요.", "내일을 위해, 일찍 자요.", "그에 대해, 말씀해 주세요.", "친구네 집에서 자고 왔어요.",
  "필요하거든, 말씀해 주세요.", "지금이야 괜찮지만 내일은 힘들 수 있어요.", "일찍 자야, 내일 덜 피곤해요.", "네, 알겠어요.",
  "많이 지쳤나 봐요, 오늘은 푹 쉬어요.", "아쉬웠지만, 잘했어요.", "알겠어요, 내일 7시에 깨워 드릴게요.", "오늘까지, 내일까지 해요.",
];
for (const t of MID_OK) {
  test(`문장 중간 반말 아님: ${t} → haeyo`, () => {
    assert.equal(midBanmalClause(t), null);
    assert.equal(sentenceStyle(t), "haeyo");
  });
}

test("말투: 끝맺음 반말 '~구나 · ~네 · ~거든 · ~해. · ~야 · ~지?' (문장 끝) · '~네요'는 해요체", () => {
  for (const s of ["그랬구나.", "좋네", "늦잠 잤거든.", "일찍 자려고 해.", "중요한 거야.", "늦게 잤지?"]) assert.equal(sentenceStyle(s), "banmal", s);
  assert.equal(sentenceStyle("좋네요"), "haeyo");
  // s-dev-014 AI 2턴 — 지금까지 non_haeyo 0으로 빠졌던 답
  const r = styleReport("늦잠이었구나, 많이 아쉬웠겠어요. 오늘 하루는 전체적으로 어땠어요?");
  assert.deepEqual([r.sentences, r.haeyo, r.banmal], [2, 1, 1]);
});

// ═════════ 검수 10/9 (적대 검토) — 위 수정이 새로 만든 오탐 · 놓침 ═════════

test("검수: '두시' + 이다 준말은 시각 ('두시니까' · '회의가 두시면' · '두시잖아요' · '두시라고' · '두시던데' · '벌써 두시겠네요')", () => {
  for (const t of [
    "약속이 두시니까 한 시에 출발해요", "회의가 두시면 한 시에 나가야 해요", "수업이 두시잖아요", "약속이 두시라고 하셨죠",
    "모임이 두시던데", "한시나 두시면 돼요", "벌써 두시겠네요", "아마 두시죠?", "회의가 두시고 세시에 끝나요", "친구와 두시면 괜찮아요",
  ]) assert.equal(only(t, "clock").filter((c) => c.hour === 2).length, 1, `${t} → ${JSON.stringify(findTimeMentions(t))}`);
  // 동사 '두다'는 그대로 빠짐 (보조 동사 자리 · 목적어 · 부사 뒤)
  for (const t of ["알람은 그대로 두시겠어요?", "켜 두시니까 편하죠", "맞춰 두시라고 말씀드렸어요", "시간을 넉넉히 두시잖아요", "두 시기로 나눠요"]) {
    assert.equal(only(t, "clock").filter((c) => c.hour === 2).length, 0, `${t} → ${JSON.stringify(findTimeMentions(t))}`);
  }
  // 시각으로 읽혀야 지어낸 '두시'도 잡힘 (전엔 동사로 빠져 놓침)
  assert.deepEqual(unsupportedNumbers("약속이 두시니까 서둘러요", { ...ALLOWED, clocks: [] }).map((m) => m.raw), ["두시"]);
});

test("검수: 문장 중간 '-구나' 오탐 — '누구나 · 친구나 · 더구나 · 도구나'는 낱말 + 조사 (sim-v2 s-dev-014 실측)", () => {
  for (const t of [
    "누구나 늦잠을 잘 수 있어요, 너무 자책하지 마세요.", "친구나 가족한테 말해 보세요.", "더구나 오늘은 발표도 있었잖아요.",
    "도구나 앱을 써 보세요.", "입구나 출구에서 만나요.",
  ]) {
    assert.equal(midBanmalClause(t), null, t);
    assert.equal(sentenceStyle(t), "haeyo", t);
  }
  // 진짜 '-구나'는 그대로 잡음
  assert.equal(midBanmalClause("그렇구나, 많이 피곤했겠어요."), "그렇구나");
  assert.equal(midBanmalClause("늦잠이었구나 많이 아쉬웠겠어요."), "늦잠이었구나");
});

test("검수: 문장 중간 '-해, · 있어, · 있거든'의 이음말과 옮긴 말 · 속생각은 반말 아님", () => {
  for (const t of [
    "최근 기록을 고려해, 내일은 10분 일찍 깨워 드릴게요.", "이동 시간을 감안해, 7시에 출발하면 돼요.", "여유가 있어, 천천히 준비해도 돼요.",
    "시간이 있거든 들러 주세요.", "\"수고했어, 오늘도\"라고 스스로에게 말해 주세요.", "오늘도 고생 많았어, 라고 말해 주세요.",
    "늦잠 잤구나 싶었어요.", "그랬구나 하고 넘어가도 돼요.",
  ]) {
    assert.equal(midBanmalClause(t), null, t);
    assert.equal(sentenceStyle(t), "haeyo", t);
  }
  // 상태 · 기분 '-해,'와 과거 '-었어,'는 그대로 반말
  assert.equal(midBanmalClause("미안해, 다음엔 꼭 깨워 드릴게요."), "미안해");
  assert.equal(midBanmalClause("많이 피곤해, 오늘은 일찍 자요."), "피곤해");
  assert.equal(midBanmalClause("시간이 있었어, 그래서 괜찮았어요."), "있었어");
  assert.equal(midBanmalClause("늦게 일어났거든 그래서 늦었어요."), "일어났거든");
});

test("검수: '날이 N일' — 앞이 명사면 날짜, 꾸미는 말이면 날 수(날짜로도 맞으면 통과)", () => {
  assert.deepEqual(kinds("발표 날이 9일이에요"), ["date:9일"]);
  assert.deepEqual(kinds("시험 날은 15일이니까 준비해요"), ["date:15일"]);
  assert.deepEqual(kinds("그날은 9일이에요"), ["date:9일"]);
  assert.deepEqual(kinds("늦은 날이 2일이에요"), ["count:2일"]);
  assert.deepEqual(kinds("짧았던 날은 1일이었어요"), ["count:1일"]);
  const c = only("발표하는 날이 9일이에요", "count")[0];
  assert.deepEqual([c.unit, c.value, c.dateDay], ["days", 9, 9]);
  // ALLOWED: 날짜 10/8 · 10/9, 횟수 [2]
  assert.deepEqual(flagged("발표 날이 9일이죠?"), []);
  assert.deepEqual(flagged("발표하는 날이 9일이죠?"), []); // 날짜 10/9로 맞음
  assert.deepEqual(flagged("늦은 날이 2일이에요"), []);
  assert.deepEqual(flagged("늦은 날이 3일이에요"), ["3일"]); // 날 수 3도, 3일 날짜도 없음
  assert.deepEqual(flagged("9일 정도에 만나요"), []);
  assert.equal(only("3일 정도 걸려요", "count")[0].dateDay, 3);
  assert.equal(only("3일 동안 늦었어요", "count")[0].dateDay, undefined);
});

test("검수: '이틀 뒤 · 전 · 후 · 이틀만'은 '3일 뒤'처럼 검사 안 하는 구조 숫자, '이틀 만에 · 이틀 연속'은 날 수", () => {
  assert.deepEqual(kinds("이틀 뒤에 시험이에요"), ["other:이틀"]);
  assert.deepEqual(kinds("3일 뒤에 시험이에요"), ["other:3일"]);
  assert.deepEqual(kinds("이틀 전에 말씀하셨죠"), ["other:이틀"]);
  assert.deepEqual(kinds("이틀만 참아요"), ["other:이틀"]);
  assert.deepEqual(kinds("이틀 만에 일찍 일어났어요"), ["count:이틀"]);
  assert.deepEqual(flagged("이틀 뒤에 시험이에요"), []);
  assert.deepEqual(flagged("이틀 연속 늦잠이에요"), []); // counts = [2]
  assert.deepEqual(flagged("사흘 연속 늦잠이에요"), ["사흘"]);
});

test("검수: '오후 6:30'(때 표시 + 0 없는 1~12시)은 12h — '아침 07:30' · '지난밤 1:37'은 24h", () => {
  assert.deepEqual(timeFormatReport("오후 6:30에 출발해요").has12h, true);
  assert.deepEqual(timeFormatReport("오후 6:30에 출발해요").has24h, false);
  assert.deepEqual(clockForms("아침 07:30 알람").map((i) => i.form), ["24h"]);
  assert.deepEqual(clockForms("지난밤 1:37에 주무셨어요").map((i) => i.form), ["24h"]);
  assert.equal(timeFormatReport("오후 6:30 출발, 19:00 도착").mixed, true);
  assert.equal(timeFormatReport("오후 6:30 출발, 오후 7시 도착").mixed, false);
});

test("검수: ampmExact opts.exact — 사용자의 모호한 '7시'가 허용 목록에 두 후보를 넣어도 틀린 오전/오후는 걸림", () => {
  // 사용자 '7시'(07:00 · 19:00 둘 다 허용) + 서버 알람 07:00(확실)
  const allowed = [hm("07:00"), hm("19:00")];
  const exact = [hm("07:00")];
  assert.deepEqual(ampmExact("내일 오후 7시에 깨워 드릴게요", allowed), []); // exact 없이는 못 거름 (unsupportedNumbers와 같음)
  assert.deepEqual(
    ampmExact("내일 오후 7시에 깨워 드릴게요", allowed, { exact }).map((x) => [x.raw, x.hhmm, x.flipped]),
    [["오후 7시", "19:00", true]],
  );
  assert.deepEqual(ampmExact("내일 오전 7시에 깨워 드릴게요", allowed, { exact }), []);
  // 반대쪽도 모호한 말에서만 나왔으면(확실한 시각 없음) 걸지 않음
  assert.deepEqual(ampmExact("내일 오후 7시 약속이죠?", allowed, { exact: [] }), []);
  // 허용 밖은 exact와 상관없이 걸림
  assert.deepEqual(ampmExact("오후 3시에 봐요", allowed, { exact }).map((x) => [x.raw, x.flipped]), [["오후 3시", false]]);
  assert.deepEqual(exactClocksIn("내일 7시, 오후 3시, 18:30, 07:40, 밤 12시"), [hm("15:00"), hm("18:30"), hm("07:40"), 0]);
});

// ───────── 영어 시각 (사용자가 '3pm'으로 써도 AI가 '오후 3시'로 되받을 수 있게) ─────────

test("영어 am/pm 시각을 오전 · 오후로 읽음", () => {
  const cases: [string, number][] = [
    ["meeting at Gangnam 3pm", hm("15:00")],
    ["내일 9am 수업", hm("09:00")],
    ["9:30 AM class", hm("09:30")],
    ["see you at 10 a.m.", hm("10:00")],
    ["dinner 7 PM", hm("19:00")],
    ["12am", 0],
    ["12pm", hm("12:00")],
  ];
  for (const [text, want] of cases) {
    const c = clock(text);
    assert.deepEqual(c.candidates, [want], text);
    assert.equal(c.hour12Ambiguous, false, text);
  }
});

test("영어 am/pm이 아닌 글자는 시각으로 안 읽음", () => {
  for (const text of ["I am here", "OS 수업", "Starbucks", "hello", "2pmx", "ver3.5pm", "13pm", "0am"]) {
    assert.deepEqual(only(text, "clock"), [], text);
  }
});

test("사용자가 영어로 쓴 시각을 AI가 한국어로 되받아도 근거 있음", () => {
  const allowed = { clocks: [] as number[], durations: [], counts: [], dates: [], exactClocks: [] as number[] };
  const said = findTimeMentions("meeting at Gangnam 3pm").flatMap((m) => (m.kind === "clock" ? m.candidates : []));
  const withUser = { ...allowed, clocks: said, exactClocks: said };
  assert.deepEqual(unsupportedNumbers("오후 3시 강남 미팅이네요.", withUser, DATES), []);
  assert.equal(unsupportedNumbers("오후 4시 강남 미팅이네요.", withUser, DATES).length, 1);
});
