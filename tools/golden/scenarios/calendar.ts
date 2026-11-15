// 시간대 · 반복 시나리오 — tz · recur
//   시간대는 서울(일광절약 없음)과 서울 밖 여섯 곳(뉴욕 · 런던의 일광절약 전환, 로드하우의 30분 전환, 인도의 30분 오프셋, UTC, 상파울루)
//   전환 날: 2026-03-08 뉴욕 02:00 → 03:00(없는 시각) · 2026-11-01 뉴욕 02:00 → 01:00(두 번 있는 시각)
//   · 2026-03-29 런던 01:00 → 02:00 · 2026-10-25 런던 02:00 → 01:00 · 2026-10-04 로드하우 02:00 → 02:30 · 2026-04-05 로드하우 02:00 → 01:30
import { d, rng, ZONES, type Add } from './kit.ts';

const DATES = ['2026-01-01', '2026-02-28', '2026-03-01', '2026-03-08', '2026-03-29', '2026-04-05', '2026-10-04', '2026-10-25', '2026-11-01', '2026-11-16', '2026-12-31', '2024-02-29', '2028-02-29', '2100-03-01'];

function tz(add: Add) {
  const instants = [
    '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-03-08T07:30:00Z', '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z',
    '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:59Z', '2026-10-25T01:00:00Z', '2026-10-03T15:29:59Z', '2026-10-03T15:30:00Z', '2026-04-04T15:29:59Z', '2026-04-04T15:30:00Z',
    '2026-11-16T00:00:00Z', '2026-11-16T14:59:59Z', '2026-11-16T15:00:00Z', '2026-12-31T23:59:59Z', '2026-01-01T00:00:00Z', '2026-06-15T12:34:56.789Z', '2024-02-29T23:30:00Z',
  ];
  for (const zone of ZONES) {
    for (const [i, iso] of instants.entries()) {
      const at = d(iso);
      add('tz', 'offsetMinutes', `${zone}-i${i}`, at, zone);
      add('tz', 'localDayRange', `${zone}-i${i}`, at, zone);
      add('tz', 'localDateKey', `${zone}-i${i}`, at, zone);
      add('tz', 'localMinuteOfDay', `${zone}-i${i}`, at, zone);
      add('tz', 'formatKoTime', `${zone}-i${i}`, at, zone);
      add('tz', 'formatKoSpokenTime', `${zone}-i${i}`, at, zone);
    }
    for (const date of DATES) {
      for (const minute of [0, 59, 60, 119, 120, 121, 150, 179, 180, 390, 720, 1439, 1440, 1500, -30]) add('tz', 'zonedTime', `${zone}-${date}-m${minute}`, date, minute, zone);
    }
  }
  for (const m of [0, 0.4, 0.5, 0.6, 1, 59, 59.5, 60, 61, 90, 119.5, 120, 1440, 1441, 100_000, -5, -0.4]) add('tz', 'formatKoDuration', `${m}`, m);
  for (const v of [null, undefined, '', 'Asia/Seoul', 'UTC', 'America/New_York', 'Europe/London', 'Not/AZone', 'Seoul', 'Mars/Olympus', 'Asia/Kolkata']) add('tz', 'safeTimeZone', `${JSON.stringify(v ?? null)}-${v === undefined ? 'undef' : 'v'}`, v);
  for (const bad of ['2026-1-1', '', 'abc', '2026-11-16T00:00', '20261116']) add('tz', 'zonedTime', `bad-date-${bad || 'empty'}`, bad, 0, 'Asia/Seoul');
}

const RULES: (string | null | undefined)[] = [
  null, undefined, '', ' ', 'FREQ=DAILY', 'RRULE:FREQ=DAILY', 'rrule:freq=daily', ' FREQ=DAILY ', 'FREQ=DAILY;', 'FREQ=DAILY;INTERVAL=1', 'FREQ=DAILY;FREQ=DAILY', 'FREQ=DAILY=1',
  'FREQ=WEEKLY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=MO,WE,FR', 'FREQ=WEEKLY;BYDAY=FR,MO,MO', 'FREQ=WEEKLY;BYDAY=mo,su', 'BYDAY=MO;FREQ=WEEKLY', 'FREQ=WEEKLY', 'FREQ=WEEKLY;BYDAY=', 'FREQ=WEEKLY;BYDAY=XX', 'FREQ=WEEKLY;BYDAY=MO,,TU',
  'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2', 'FREQ=MONTHLY', 'FREQ=MONTHLY;BYMONTHDAY=1', 'FREQ', 'FREQ=', '=DAILY', 'FREQ=DAILY;COUNT=3', 'RRULE:', 'FREQ=WEEKLY;BYDAY=SA,SU', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
];

function recur(add: Add) {
  RULES.forEach((rule, i) => add('recur', 'parseRecurrence', `rule-${i}`, rule));
  for (const date of ['2026-11-16', '2026-11-22', '2026-11-23', '2026-03-01', '2024-02-29', '2100-12-31', '1970-01-01', '2000-01-01', '2026-12-31', '2027-01-01', '2026-01-01']) add('recur', 'weekdayOfDate', date, date);
  for (const bad of ['2026-1-1', '', 'abc', '2026/11/16']) add('recur', 'weekdayOfDate', `bad-${bad || 'empty'}`, bad);
  for (const [date, days] of [['2026-11-16', 0], ['2026-11-16', 1], ['2026-11-16', -1], ['2026-11-30', 1], ['2026-12-31', 1], ['2026-01-01', -1], ['2026-02-28', 1], ['2024-02-28', 1], ['2024-02-28', 2], ['2026-03-31', 31], ['2026-11-16', 14], ['2026-11-16', -14], ['2026-11-16', 400], ['2026-11-16', -400], ['2026-11-16', 365], ['2100-02-28', 1], ['2000-02-28', 1], ['1999-12-31', 1]] as [string, number][]) add('recur', 'addDaysToKey', `${date}${days >= 0 ? '+' : ''}${days}`, date, days);
  for (const bad of ['2026-1-1', '', 'abc']) add('recur', 'addDaysToKey', `bad-${bad || 'empty'}`, bad, 1);
  const recs = [{ freq: 'DAILY' }, { freq: 'WEEKLY', days: [0] }, { freq: 'WEEKLY', days: [0, 2, 4] }, { freq: 'WEEKLY', days: [5, 6] }, { freq: 'WEEKLY', days: [] }];
  for (const [i, rec] of recs.entries()) for (const date of ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-21', '2026-11-22']) add('recur', 'occursOn', `rec${i}-${date}`, rec, date);

  // nextOccurrences
  const baseAt = d('2026-11-02T08:30:00+09:00'); // 월요일 08:30 서울
  const now = d('2026-11-16T07:00:00+09:00'); // 월요일 07:00 서울
  const ruleSet = ['FREQ=DAILY', 'FREQ=WEEKLY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=MO,WE,FR', 'FREQ=WEEKLY;BYDAY=SA,SU', 'FREQ=MONTHLY', null, 'rrule:freq=weekly;byday=tu,th'];
  for (const [i, rule] of ruleSet.entries()) {
    add('recur', 'nextOccurrences', `seoul-rule${i}`, { rule, baseAt, now, timeZone: 'Asia/Seoul' });
    for (const windowDays of [0, 1, 7, 30, 60]) add('recur', 'nextOccurrences', `seoul-rule${i}-win${windowDays}`, { rule, baseAt, now, timeZone: 'Asia/Seoul', windowDays });
    add('recur', 'nextOccurrences', `seoul-rule${i}-after-future`, { rule, baseAt, now, timeZone: 'Asia/Seoul', afterDate: '2026-11-20' });
    add('recur', 'nextOccurrences', `seoul-rule${i}-after-past`, { rule, baseAt, now, timeZone: 'Asia/Seoul', afterDate: '2026-10-01' });
  }
  // 지금 = 정확히 회차 시각 / 1ms 앞 · 뒤 / 창 끝 경계
  for (const delta of [-1, 0, 1]) {
    add('recur', 'nextOccurrences', `now-at-occurrence${delta}`, { rule: 'FREQ=DAILY', baseAt, now: new Date(d('2026-11-16T08:30:00+09:00').getTime() + delta), timeZone: 'Asia/Seoul', windowDays: 3 });
    add('recur', 'nextOccurrences', `window-end${delta}`, { rule: 'FREQ=DAILY', baseAt, now: new Date(d('2026-11-14T08:30:00+09:00').getTime() + delta), timeZone: 'Asia/Seoul', windowDays: 2 });
  }
  add('recur', 'nextOccurrences', 'base-in-future', { rule: 'FREQ=DAILY', baseAt: d('2026-11-20T09:00:00+09:00'), now, timeZone: 'Asia/Seoul' });
  add('recur', 'nextOccurrences', 'after-date-beyond-window', { rule: 'FREQ=DAILY', baseAt, now, timeZone: 'Asia/Seoul', afterDate: '2027-01-01' });
  add('recur', 'nextOccurrences', 'seconds-in-base', { rule: 'FREQ=DAILY', baseAt: d('2026-11-02T08:30:45+09:00'), now, timeZone: 'Asia/Seoul', windowDays: 3 });
  for (const zone of [...ZONES.slice(1), null, undefined, '', 'Not/AZone']) {
    const label = `${zone}`.replace('/', '-');
    // 전환일을 지나는 창: 뉴욕 · 런던 · 로드하우
    for (const [name, base, nowIso] of [
      ['ny-spring', '2026-03-01T02:30:00-05:00', '2026-03-05T12:00:00Z'],
      ['ny-fall', '2026-10-28T01:30:00-04:00', '2026-10-30T12:00:00Z'],
      ['london-spring', '2026-03-20T01:30:00Z', '2026-03-25T12:00:00Z'],
      ['london-fall', '2026-10-20T01:30:00+01:00', '2026-10-22T12:00:00Z'],
      ['lordhowe-spring', '2026-09-28T02:15:00+10:30', '2026-09-30T00:00:00Z'],
      ['lordhowe-fall', '2026-03-30T01:45:00+11:00', '2026-04-01T00:00:00Z'],
    ] as const) {
      for (const rule of ['FREQ=DAILY', 'FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA']) {
        add('recur', 'nextOccurrences', `${label}-${name}-${rule === 'FREQ=DAILY' ? 'daily' : 'week'}`, { rule, baseAt: d(base), now: d(nowIso), timeZone: zone, windowDays: 14 });
      }
    }
  }
  const r = rng(0x4ec7);
  for (let i = 0; i < 40; i++) {
    const nowAt = new Date(d('2026-10-01T00:00:00Z').getTime() + r.int(0, 100 * 24 * 60) * 60_000);
    add('recur', 'nextOccurrences', `rand-${i}`, {
      rule: r.pick(ruleSet.slice(0, 4).concat(['FREQ=WEEKLY;BYDAY=TU,TH'])),
      baseAt: new Date(d('2026-09-01T00:00:00Z').getTime() + r.int(0, 40 * 24 * 60) * 60_000),
      now: nowAt,
      timeZone: r.pick(ZONES),
      ...(r.chance(0.5) ? { windowDays: r.pick([1, 3, 7, 14, 21, 45]) } : {}),
      ...(r.chance(0.3) ? { afterDate: r.pick(['2026-09-15', '2026-10-15', '2026-11-05', '2026-12-01']) } : {}),
    });
  }
  // 루틴(요일 글자)
  const repeatTexts: (string | null | undefined)[] = [null, undefined, '', ' ', 'MON', 'MON,WED,FRI', 'MON~FRI', 'MON-FRI', 'FRI~MON', 'SAT~SUN', 'SUN~SAT', 'SUN~MON', 'mon tue wed', 'MON,MON', 'MON , TUE', 'XXX', 'MON~XXX', 'XXX~MON', 'MON TUE,WED', 'mon~fri,sat', 'MONDAY', 'MON~', '~MON', 'THU~THU', 'WED~TUE'];
  repeatTexts.forEach((text, i) => add('recur', 'parseRepeatDays', `text-${i}`, text));
  const routineNow = d('2026-11-16T07:00:00+09:00');
  for (const text of ['MON~FRI', 'MON,WED', 'SAT', 'SUN~SAT', '', null, 'XXX']) {
    for (const offset of [0, 30, 479, 480, 1439, 1440, 1500, 2880, 4000, -5, 7.9, 0.4, 100_000]) {
      add('recur', 'nextRoutineAt', `${text ?? 'null'}-off${offset}`, { repeatDays: text, stepOffsetMinutes: offset, now: routineNow, timeZone: 'Asia/Seoul' });
    }
  }
  for (const delta of [-1, 0, 1]) add('recur', 'nextRoutineAt', `exact-now${delta}`, { repeatDays: 'MON~SUN', stepOffsetMinutes: 420, now: new Date(d('2026-11-16T07:00:00+09:00').getTime() + delta), timeZone: 'Asia/Seoul' });
  for (const zone of ['UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kolkata', null, 'Not/AZone']) {
    for (const [name, nowIso] of [['ny-spring-eve', '2026-03-07T23:00:00Z'], ['ny-fall-eve', '2026-10-31T23:00:00Z'], ['london-spring-eve', '2026-03-28T23:00:00Z'], ['lordhowe-eve', '2026-10-03T00:00:00Z'], ['plain', '2026-11-16T07:00:00Z']] as const) {
      for (const offset of [0, 90, 150, 330, 1500]) add('recur', 'nextRoutineAt', `${`${zone}`.replace('/', '-')}-${name}-off${offset}`, { repeatDays: 'MON~SUN', stepOffsetMinutes: offset, now: d(nowIso), timeZone: zone });
    }
  }
}

export function calendarScenarios(add: Add) {
  tz(add);
  recur(add);
}
