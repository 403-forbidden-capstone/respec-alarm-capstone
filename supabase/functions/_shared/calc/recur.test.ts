import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RRULE_PATTERN, ROLL_WINDOW_DAYS, addDaysToKey, nextOccurrences, nextRoutineAt, occursOn, parseRecurrence, parseRepeatDays, weekdayOfDate } from './recur.ts';
import { localDateKey } from '../tz.ts';

// 한국 시각. 시험 날짜: 2026-10-27 화 · 10-28 수 · 10-29 목 · 11-02 월 · 11-03 화 · 11-04 수 · 11-09 월 · 11-10 화
const kst = (date: string, hhmm = '00:00') => new Date(`${date}T${hhmm}:00+09:00`);
const days = (rule: string) => {
  const r = parseRecurrence(rule);
  return r && r.freq === 'WEEKLY' ? [...r.days] : r;
};
const dates = (list: { date: string }[]) => list.map((o) => o.date);

// ---------------------------------------------------------------------------
// 규칙 읽기 — 앱 mobile/src/features/alarm/__tests__/repeat.test.ts의 규칙 표와 같은 해석 (요일 번호: 월 0 … 일 6)
// ---------------------------------------------------------------------------

test('앱이 쓴 규칙을 그대로 읽음: 매일 · 주간 + 요일 코드 (repeat.test.ts "요일 → RRULE" 표)', () => {
  assert.deepEqual(parseRecurrence('FREQ=DAILY'), { freq: 'DAILY' });
  assert.deepEqual(days('FREQ=WEEKLY;BYDAY=TH'), [3]);
  assert.deepEqual(days('FREQ=WEEKLY;BYDAY=MO,WE'), [0, 2]);
  assert.deepEqual(days('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'), [0, 1, 2, 3, 4]);
  assert.deepEqual(days('FREQ=WEEKLY;BYDAY=SA,SU'), [5, 6]);
});

test('요일 조합 127가지: 앱 repeatToRrule이 만드는 글자(7개 모두면 매일)를 읽으면 같은 요일이고, 쓸 때 받는 글자 모양(RRULE_PATTERN)에도 통과', () => {
  const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  for (let mask = 1; mask < 128; mask++) {
    const picked = BYDAY.map((_, i) => i).filter((i) => mask & (1 << i));
    const rule = picked.length === 7 ? 'FREQ=DAILY' : `FREQ=WEEKLY;BYDAY=${picked.map((i) => BYDAY[i]).join(',')}`; // repeat.ts repeatToRrule
    assert.ok(RRULE_PATTERN.test(rule), rule);
    assert.deepEqual(picked.length === 7 ? parseRecurrence(rule) : days(rule), picked.length === 7 ? { freq: 'DAILY' } : picked, rule);
  }
});

test('RRULE 앞 접두사 · 소문자 · 순서 · 겹친 요일이 달라도 읽음 (DB에서 온 글자, repeat.test.ts)', () => {
  assert.deepEqual(days('RRULE:FREQ=WEEKLY;BYDAY=WE,MO'), [0, 2]); // 요일은 월요일부터 정렬
  assert.deepEqual(days('freq=weekly;byday=fr'), [4]);
  assert.deepEqual(days('BYDAY=MO;FREQ=WEEKLY'), [0]);
  assert.deepEqual(days('FREQ=WEEKLY;BYDAY=MO,MO,TU'), [0, 1]);
  assert.deepEqual(parseRecurrence('rrule:freq=daily'), { freq: 'DAILY' });
});

test('읽지 못하는 글자 · 요일 없는 주간은 반복 없음, 두 모양 밖은 거절 (월간 · 간격 · 횟수 · 끝 날짜 …)', () => {
  for (const rule of [null, undefined, '', '  ']) assert.equal(parseRecurrence(rule), null, String(rule));
  for (const rule of [
    'FREQ=MONTHLY;BYMONTHDAY=3', 'FREQ=MONTHLY', 'FREQ=YEARLY', 'FREQ=HOURLY', 'FREQ=WEEKLY', 'FREQ=WEEKLY;BYDAY=XX', 'FREQ=WEEKLY;BYDAY=', 'FREQ=WEEKLY;BYDAY=MO,XX',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', 'FREQ=WEEKLY;BYDAY=TH;COUNT=3', 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231', 'FREQ=DAILY;INTERVAL=2', 'FREQ=DAILY;COUNT=5', 'FREQ=DAILY;BYDAY=MO',
    'FREQ=DAILY;FREQ=WEEKLY', 'FREQ=DAILY;', 'DAILY', 'BYDAY=MO', 'FREQ', 'FREQ=DAILY=1',
  ]) {
    assert.equal(parseRecurrence(rule), null, rule);
  }
});

test('쓸 때 받는 글자(RRULE_PATTERN)는 읽는 쪽이 반드시 읽음 — 받았는데 회차를 못 만드는 규칙이 없게', () => {
  for (const rule of ['FREQ=DAILY', 'FREQ=WEEKLY;BYDAY=TH', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'FREQ=WEEKLY;BYDAY=SU', 'FREQ=WEEKLY;BYDAY=SU,SU']) {
    assert.ok(RRULE_PATTERN.test(rule), rule);
    assert.notEqual(parseRecurrence(rule), null, rule);
  }
  for (const rule of ['FREQ=MONTHLY', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', 'freq=daily', 'RRULE:FREQ=DAILY', 'FREQ=WEEKLY']) assert.ok(!RRULE_PATTERN.test(rule), rule);
});

// ---------------------------------------------------------------------------
// 날짜 글자
// ---------------------------------------------------------------------------

test('날짜의 요일(월 0 … 일 6) · 날짜 더하기 · 규칙에 드는 날', () => {
  assert.equal(weekdayOfDate('2026-11-02'), 0);
  assert.equal(weekdayOfDate('2026-11-03'), 1);
  assert.equal(weekdayOfDate('2026-11-08'), 6);
  assert.equal(addDaysToKey('2026-10-31', 1), '2026-11-01');
  assert.equal(addDaysToKey('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysToKey('2026-03-01', -1), '2026-02-28');
  assert.throws(() => weekdayOfDate('2026-1-1'), RangeError);
  const tuTh = parseRecurrence('FREQ=WEEKLY;BYDAY=TU,TH');
  assert.ok(tuTh);
  assert.equal(occursOn(tuTh, '2026-11-03'), true);
  assert.equal(occursOn(tuTh, '2026-11-04'), false);
  assert.equal(occursOn({ freq: 'DAILY' }, '2026-11-04'), true);
});

// ---------------------------------------------------------------------------
// 다음 회차
// ---------------------------------------------------------------------------

test('매일: 기준 회차 다음 날부터 14일 안의 날짜 전부, 시각은 같은 시:분', () => {
  const list = nextOccurrences({ rule: 'FREQ=DAILY', baseAt: kst('2026-10-27', '10:00'), now: kst('2026-10-27', '10:10'), timeZone: 'Asia/Seoul' });
  assert.equal(list.length, 14);
  assert.equal(list[0].date, '2026-10-28');
  assert.equal(list[13].date, '2026-11-10'); // 11-10 10:00 < 지금 + 14일 = 11-10 10:10
  assert.ok(list.every((o) => o.at.toISOString().endsWith('T01:00:00.000Z'))); // 한국 10:00
  assert.equal(ROLL_WINDOW_DAYS, 14);
});

test('주간 요일 반복: 요일에 드는 날만 (화 · 목)', () => {
  const list = nextOccurrences({ rule: 'FREQ=WEEKLY;BYDAY=TU,TH', baseAt: kst('2026-10-27', '10:00'), now: kst('2026-10-27', '10:10'), timeZone: 'Asia/Seoul' });
  assert.deepEqual(dates(list), ['2026-10-29', '2026-11-03', '2026-11-05', '2026-11-10']);
  assert.deepEqual(list.map((o) => o.at.toISOString()), ['2026-10-29T01:00:00.000Z', '2026-11-03T01:00:00.000Z', '2026-11-05T01:00:00.000Z', '2026-11-10T01:00:00.000Z']);
});

test('첫 회차는 고른 날짜 그대로 — 요일이 규칙에 안 맞아도 두고, 다음 회차부터 규칙 (화요일에 고른 월·수 반복)', () => {
  const list = nextOccurrences({ rule: 'FREQ=WEEKLY;BYDAY=MO,WE', baseAt: kst('2026-10-27', '10:00'), now: kst('2026-10-27', '10:10'), timeZone: 'Asia/Seoul' });
  assert.deepEqual(dates(list), ['2026-10-28', '2026-11-02', '2026-11-04', '2026-11-09']);
  assert.ok(!dates(list).includes('2026-10-27'));
});

test('요일은 내 시간대 날짜의 요일 — 새벽 1시 약속은 UTC로는 전날이어도 한국 요일 (UTC 요일이 아님)', () => {
  const base = kst('2026-10-27', '01:00'); // 화요일 한국 01:00 = UTC 월요일 16:00
  assert.equal(base.getUTCDay(), 1);
  const now = kst('2026-10-27', '00:00');
  const tue = nextOccurrences({ rule: 'FREQ=WEEKLY;BYDAY=TU', baseAt: base, now, timeZone: 'Asia/Seoul', windowDays: 8 });
  assert.deepEqual(dates(tue), ['2026-11-03']);
  assert.equal(tue[0].at.toISOString(), '2026-11-02T16:00:00.000Z'); // UTC로는 월요일
  assert.equal(tue[0].at.getUTCDay(), 1);
  const mon = nextOccurrences({ rule: 'FREQ=WEEKLY;BYDAY=MO', baseAt: base, now, timeZone: 'Asia/Seoul', windowDays: 8 });
  assert.deepEqual(dates(mon), ['2026-11-02']); // 한국 월요일 01:00 = UTC 일요일 16:00
  assert.equal(mon[0].at.getUTCDay(), 0);
  assert.equal(localDateKey(mon[0].at, 'Asia/Seoul'), '2026-11-02');
});

test('창: 지금 < 회차 시각 < 지금 + 14일 — 둘 다 포함 안 함, 창 끝 1분 전은 포함', () => {
  const base = kst('2026-10-27', '10:00');
  const rule = 'FREQ=DAILY';
  // 지금과 같은 시각의 회차는 제외 (10-28 10:00이 지금) · 14일 뒤 같은 시각(11-11 10:00)도 제외
  const atNow = nextOccurrences({ rule, baseAt: base, now: kst('2026-10-28', '10:00'), timeZone: 'Asia/Seoul' });
  assert.equal(atNow[0].date, '2026-10-29');
  assert.equal(atNow[atNow.length - 1].date, '2026-11-10');
  assert.equal(atNow.length, 13);
  // 창 끝 정각: 11-10 10:00 == 지금(10-27 10:00) + 14일 → 제외
  const exactEnd = nextOccurrences({ rule, baseAt: base, now: kst('2026-10-27', '10:00'), timeZone: 'Asia/Seoul' });
  assert.equal(exactEnd[exactEnd.length - 1].date, '2026-11-09');
  // 창 끝 1분 전: 지금 10:01 → 끝 11-10 10:01 > 11-10 10:00 → 포함
  const justIn = nextOccurrences({ rule, baseAt: base, now: kst('2026-10-27', '10:01'), timeZone: 'Asia/Seoul' });
  assert.equal(justIn[justIn.length - 1].date, '2026-11-10');
  // 창 길이를 바꾸면 그만큼
  const short = nextOccurrences({ rule, baseAt: base, now: kst('2026-10-27', '10:10'), timeZone: 'Asia/Seoul', windowDays: 3 });
  assert.deepEqual(dates(short), ['2026-10-28', '2026-10-29', '2026-10-30']);
});

test('서버가 며칠 못 돌았어도 지난 회차는 안 메움 · 이미 지난 오늘 회차도 안 만듦', () => {
  const stale = nextOccurrences({ rule: 'FREQ=DAILY', baseAt: kst('2026-10-20', '10:00'), now: kst('2026-10-27', '10:05'), timeZone: 'Asia/Seoul' });
  assert.equal(stale[0].date, '2026-10-28'); // 10-21 ~ 10-27은 지난 회차, 오늘(10-27) 10:00도 이미 지남
  const earlyToday = nextOccurrences({ rule: 'FREQ=DAILY', baseAt: kst('2026-10-20', '10:00'), now: kst('2026-10-27', '09:00'), timeZone: 'Asia/Seoul' });
  assert.equal(earlyToday[0].date, '2026-10-27'); // 오늘 10:00은 아직 앞
});

test('afterDate: 이 날짜 뒤부터 셈 — 중간 날짜가 비었을 때 묶음 첫 회차 날짜부터 다시 구함', () => {
  const base = kst('2026-11-03', '10:00'); // 가장 늦은 회차
  const now = kst('2026-10-27', '10:05');
  const rule = 'FREQ=WEEKLY;BYDAY=TU';
  assert.deepEqual(dates(nextOccurrences({ rule, baseAt: base, now, timeZone: 'Asia/Seoul' })), ['2026-11-10']);
  assert.deepEqual(dates(nextOccurrences({ rule, baseAt: base, now, timeZone: 'Asia/Seoul', afterDate: '2026-10-20' })), ['2026-11-03', '2026-11-10']);
  assert.deepEqual(dates(nextOccurrences({ rule: 'FREQ=DAILY', baseAt: base, now, timeZone: 'Asia/Seoul', afterDate: '2026-10-28' })).slice(0, 2), ['2026-10-29', '2026-10-30']);
});

test('일광절약시간 시간대도 같은 벽시계 시:분 (뉴욕 09:30은 11/1 전후로 UTC 시각이 한 시간 바뀜)', () => {
  const base = new Date('2026-10-27T13:30:00Z'); // 뉴욕 09:30 EDT
  const list = nextOccurrences({ rule: 'FREQ=DAILY', baseAt: base, now: new Date('2026-10-27T14:00:00Z'), timeZone: 'America/New_York' });
  const at = Object.fromEntries(list.map((o) => [o.date, o.at.toISOString()]));
  assert.equal(at['2026-10-28'], '2026-10-28T13:30:00.000Z');
  assert.equal(at['2026-11-01'], '2026-11-01T14:30:00.000Z'); // 시계가 되돌아간 날 — EST
  assert.equal(at['2026-11-02'], '2026-11-02T14:30:00.000Z');
});

test('요일 판정은 사용자 시간대 기준 (LA 월요일 18:00은 UTC 화요일 02:00)', () => {
  const base = new Date('2026-10-27T01:00:00Z'); // LA 10/26(월) 18:00 PDT
  const list = nextOccurrences({ rule: 'FREQ=WEEKLY;BYDAY=MO', baseAt: base, now: new Date('2026-10-27T02:00:00Z'), timeZone: 'America/Los_Angeles' });
  assert.deepEqual(dates(list), ['2026-11-02']);
  assert.equal(list[0].at.toISOString(), '2026-11-03T02:00:00.000Z'); // 11/2는 PST(-8)
});

test('두 모양 밖 · 규칙 없음은 회차 없음 (거절)', () => {
  const common = { baseAt: kst('2026-10-27', '10:00'), now: kst('2026-10-27', '10:10'), timeZone: 'Asia/Seoul' };
  for (const rule of [null, undefined, '', 'FREQ=MONTHLY;BYMONTHDAY=27', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', 'FREQ=DAILY;COUNT=3', 'FREQ=WEEKLY']) {
    assert.deepEqual(nextOccurrences({ rule, ...common }), [], String(rule));
  }
});

test('모르는 시간대 이름이면 서울로 (방어)', () => {
  const list = nextOccurrences({ rule: 'FREQ=DAILY', baseAt: kst('2026-10-27', '10:00'), now: kst('2026-10-27', '10:10'), timeZone: 'Mars/Olympus', windowDays: 2 });
  assert.deepEqual(dates(list), ['2026-10-28', '2026-10-29']);
});

// ---------------------------------------------------------------------------
// 루틴 반복 요일 — 앱 mobile/src/features/routine/__tests__/map.test.ts의 규칙 표 (요일 번호: 월 0 … 일 6)
// ---------------------------------------------------------------------------

test('루틴 repeat_days: 범위 · 쉼표 · 일요일을 넘는 범위 · 공백/소문자 (map.test.ts "저장한 글자를 읽음")', () => {
  assert.deepEqual(parseRepeatDays('MON~FRI'), [0, 1, 2, 3, 4]);
  assert.deepEqual(parseRepeatDays('MON,WED,FRI'), [0, 2, 4]);
  assert.deepEqual(parseRepeatDays('sat~mon'), [0, 5, 6]); // 토 일 월
  assert.deepEqual(parseRepeatDays('FRI, SAT'), [4, 5]);
  assert.deepEqual(parseRepeatDays('MON-WED'), [0, 1, 2]);
});

test('루틴 repeat_days: 모르는 글자 · 빈 값은 건너뜀', () => {
  assert.deepEqual(parseRepeatDays(null), []);
  assert.deepEqual(parseRepeatDays(undefined), []);
  assert.deepEqual(parseRepeatDays(''), []);
  assert.deepEqual(parseRepeatDays('주중,XYZ,WED'), [2]);
  assert.deepEqual(parseRepeatDays('MON~XYZ'), []);
});

test('루틴 repeat_days: 어떤 요일 조합이든 앱이 저장한 글자(formatRepeatDays)를 읽으면 같음', () => {
  const CODES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const format = (picked: boolean[]) => {
    // 앱 features/routine/map.ts formatRepeatDays와 같음 — 3일 이상 이어지면 'MON~FRI', 나머지는 쉼표
    const parts: string[] = [];
    for (let i = 0; i < 7; i++) {
      if (!picked[i]) continue;
      let end = i;
      while (end + 1 < 7 && picked[end + 1]) end++;
      if (end - i >= 2) parts.push(`${CODES[i]}~${CODES[end]}`);
      else for (let k = i; k <= end; k++) parts.push(CODES[k]);
      i = end;
    }
    return parts.join(',');
  };
  for (let mask = 0; mask < 128; mask++) {
    const picked = CODES.map((_, i) => (mask & (1 << i)) !== 0);
    assert.deepEqual(parseRepeatDays(format(picked)), picked.flatMap((p, i) => (p ? [i] : [])), format(picked));
  }
});

// ---------------------------------------------------------------------------
// 루틴 단계 알람의 다음 시각
// ---------------------------------------------------------------------------

test('루틴 다음 발생 = 지금 뒤 첫 요일의 같은 단계 시각 (월·수·금 07:30)', () => {
  const next = (nowAt: Date) => nextRoutineAt({ repeatDays: 'MON,WED,FRI', stepOffsetMinutes: 450, now: nowAt, timeZone: 'Asia/Seoul' })?.toISOString();
  assert.equal(next(kst('2026-11-04', '07:29')), kst('2026-11-04', '07:30').toISOString()); // 오늘 수요일 아직 안 울림
  assert.equal(next(kst('2026-11-04', '07:30')), kst('2026-11-06', '07:30').toISOString()); // 정각이면 지난 것 → 금
  assert.equal(next(kst('2026-11-04', '07:31')), kst('2026-11-06', '07:30').toISOString());
  assert.equal(next(kst('2026-11-06', '08:00')), kst('2026-11-09', '07:30').toISOString()); // 금 → 다음 월
  assert.equal(next(kst('2026-11-03', '23:59')), kst('2026-11-04', '07:30').toISOString()); // 화 밤 → 수
});

test('루틴 다음 발생: 평일 · 요일 하나 · 요일 없음', () => {
  assert.equal(nextRoutineAt({ repeatDays: 'MON~FRI', stepOffsetMinutes: 1290, now: kst('2026-11-06', '22:00'), timeZone: 'Asia/Seoul' })?.toISOString(), kst('2026-11-09', '21:30').toISOString()); // 금 21:30은 이미 지남 → 월
  assert.equal(nextRoutineAt({ repeatDays: 'THU', stepOffsetMinutes: 420, now: kst('2026-10-29', '07:00'), timeZone: 'Asia/Seoul' })?.toISOString(), kst('2026-11-05', '07:00').toISOString()); // 정각 → 일주일 뒤
  assert.equal(nextRoutineAt({ repeatDays: '', stepOffsetMinutes: 420, now: kst('2026-10-29', '07:00'), timeZone: 'Asia/Seoul' }), null);
  assert.equal(nextRoutineAt({ repeatDays: null, stepOffsetMinutes: 420, now: kst('2026-10-29', '07:00'), timeZone: 'Asia/Seoul' }), null);
  assert.equal(nextRoutineAt({ repeatDays: 'XYZ', stepOffsetMinutes: 420, now: kst('2026-10-29', '07:00'), timeZone: 'Asia/Seoul' }), null);
});

test('루틴 단계가 자정을 넘으면 시작한 날의 요일이 기준 (월요일 밤에 시작해 화요일 00:30에 울리는 단계)', () => {
  // 월요일 루틴, 단계 offset 1470 = 24:30
  const next = (nowAt: Date) => nextRoutineAt({ repeatDays: 'MON', stepOffsetMinutes: 1470, now: nowAt, timeZone: 'Asia/Seoul' })?.toISOString();
  assert.equal(next(kst('2026-11-02', '23:30')), kst('2026-11-03', '00:30').toISOString()); // 월 밤 → 오늘 시작한 루틴의 화 00:30
  assert.equal(next(kst('2026-11-03', '00:29')), kst('2026-11-03', '00:30').toISOString()); // 이미 화요일이어도 월요일 루틴의 단계가 아직 앞
  assert.equal(next(kst('2026-11-03', '00:31')), kst('2026-11-10', '00:30').toISOString()); // 지나면 다음 주 월요일 루틴의 화 00:30
  assert.equal(next(kst('2026-11-05', '12:00')), kst('2026-11-10', '00:30').toISOString());
  assert.equal(next(kst('2026-11-04', '07:00')), kst('2026-11-10', '00:30').toISOString());
});
