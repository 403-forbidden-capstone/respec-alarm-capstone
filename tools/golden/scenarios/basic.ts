// 작은 순수 함수 시나리오 — time · depart · wake · importance · suggest · travel
//   JS와 파이썬이 달라지기 쉬운 곳을 일부러 넣음: 반올림(Math.round는 .5를 위로, 음수 -0.5는 -0 → 0, -1.5는 -1),
//   소수 분(밀리초 내림), 경계값(10분 · 0분 · 5분 · 300m · 12:00 정각), 문자 → 숫자(Number('0x1A') 같은 읽기)
import { addMinutes } from '../../../supabase/functions/_shared/calc/time.ts';
import { d, rng, type Add } from './kit.ts';

const T0 = d('2026-11-16T09:00:00+09:00');

function time(add: Add) {
  for (const m of [0, 1, -1, 60, 90, 1440, -1440, 0.5, 1.5, -0.5, 1 / 3, 0.00001, -0.00001, 100000, 12.25])
    add('time', 'addMinutes', `${m}`, T0, m);
  // 밀리초 차이 → 분 (반올림 경계)
  for (const ms of [0, 1, -1, 29_999, 30_000, 30_001, -29_999, -30_000, -30_001, 59_999, 60_000, 89_999, 90_000, 90_001, -89_999, -90_000, -90_001, 150_000, -150_000, 3_600_000, 86_400_000, -86_400_000])
    add('time', 'minutesBetween', `diff${ms}ms`, T0, new Date(T0.getTime() + ms));
  add('time', 'sameTime', 'equal', T0, new Date(T0.getTime()));
  add('time', 'sameTime', 'one-ms', T0, addMinutes(T0, 1 / 60000));
  add('time', 'sameTime', 'null-left', null, T0);
  add('time', 'sameTime', 'null-right', T0, null);
  add('time', 'sameTime', 'both-null', null, null);
}

function depart(add: Add) {
  for (const s of [-1_000_000, -100, -1, -0.5, 0, 0.5, 1, 9, 9.5, 9.999, 10, 10.0001, 11, 60, 1_000_000])
    add('depart', 'departStatus', `slack${s}`, s);
  const r = rng(0x1d0a);
  const appt = d('2026-11-16T15:00:00+09:00');
  // 경계: 여유 정확히 -1 · 0 · 9 · 10 분, 초 단위 반올림(.5분)
  for (const slackSeconds of [-90, -61, -60, -31, -30, -29, 0, 29, 30, 31, 539, 540, 570, 575, 599, 600, 601, 629, 630]) {
    const travel = 30;
    const now = new Date(appt.getTime() - travel * 60_000 - slackSeconds * 1000 - 20 * 60_000);
    add('depart', 'departSlack', `edge${slackSeconds}s`, { appointmentAt: appt, travelMinutes: travel, now, remainingMinutes: 20 });
    add('depart', 'departNow', `edge${slackSeconds}s`, { appointmentAt: appt, travelMinutes: travel, now: new Date(appt.getTime() - travel * 60_000 - slackSeconds * 1000) });
  }
  for (let i = 0; i < 50; i++) {
    const input = {
      appointmentAt: new Date(appt.getTime() + r.int(0, 3000) * 1000),
      travelMinutes: r.pick([0, 1, 7, 12.5, 30, 45, 90, 150]),
      now: new Date(appt.getTime() - r.int(0, 600) * 60_000 - r.int(0, 59) * 1000),
      remainingMinutes: r.pick([0, 0, 5, 20, 45.5, 90]),
    };
    add('depart', 'departSlack', `rand-${i}`, input);
    const { remainingMinutes: _unused, ...withoutRemaining } = input;
    add('depart', 'departNow', `rand-${i}`, withoutRemaining);
  }
}

function wake(add: Add) {
  const seoul = 'Asia/Seoul';
  const appt = d('2026-11-16T10:00:00+09:00');
  const wakes = (rows: [string | undefined, string, boolean | undefined][]) =>
    rows.map(([id, at, on]) => ({ ...(id ? { appointmentId: id } : {}), appointmentAt: d(at), ...(on === undefined ? {} : { isEnabled: on }) }));
  add('wake', 'hasEarlierWake', 'none', appt, []);
  add('wake', 'hasEarlierWake', 'earlier-on', appt, wakes([['a', '2026-11-16T08:00:00+09:00', true]]));
  add('wake', 'hasEarlierWake', 'earlier-default-on', appt, wakes([['a', '2026-11-16T08:00:00+09:00', undefined]]));
  add('wake', 'hasEarlierWake', 'earlier-off', appt, wakes([['a', '2026-11-16T08:00:00+09:00', false]]));
  add('wake', 'hasEarlierWake', 'same-time', appt, wakes([['a', '2026-11-16T10:00:00+09:00', true]]));
  add('wake', 'hasEarlierWake', 'one-ms-earlier', appt, [{ appointmentId: 'a', appointmentAt: new Date(appt.getTime() - 1), isEnabled: true }]);
  add('wake', 'hasEarlierWake', 'later', appt, wakes([['a', '2026-11-16T12:00:00+09:00', true]]));
  add('wake', 'hasEarlierWake', 'own-excluded', appt, wakes([['own', '2026-11-16T08:00:00+09:00', true]]), 'own');
  add('wake', 'hasEarlierWake', 'own-and-other', appt, wakes([['own', '2026-11-16T08:00:00+09:00', true], ['b', '2026-11-16T09:00:00+09:00', true]]), 'own');
  add('wake', 'hasEarlierWake', 'no-id-with-own', appt, wakes([[undefined, '2026-11-16T08:00:00+09:00', true]]), 'own');
  add('wake', 'hasEarlierWake', 'mixed', appt, wakes([['a', '2026-11-16T07:00:00+09:00', false], ['b', '2026-11-16T09:30:00+09:00', false], ['c', '2026-11-16T10:00:00+09:00', true]]));
  // 저녁 기상: 11:59 · 12:00 · 12:01, 약속 날짜와 다른 날, 시간대
  for (const hhmm of ['00:00', '06:30', '11:59', '12:00', '12:01', '18:30', '23:59']) {
    add('wake', 'isEveningWake', `seoul-${hhmm}`, d(`2026-11-16T${hhmm}:00+09:00`), seoul);
    add('wake', 'isEveningWake', `seoul-${hhmm}-appt-next-day`, d(`2026-11-16T${hhmm}:00+09:00`), seoul, d('2026-11-17T01:00:00+09:00'));
    add('wake', 'isEveningWake', `seoul-${hhmm}-appt-same-day`, d(`2026-11-16T${hhmm}:00+09:00`), seoul, d('2026-11-16T23:30:00+09:00'));
  }
  for (const zone of [null, undefined, '', 'UTC', 'America/New_York', 'Australia/Lord_Howe', 'Not/AZone']) {
    add('wake', 'isEveningWake', `zone-${zone}-utc-0300`, d('2026-11-16T03:00:00Z'), zone);
    add('wake', 'isEveningWake', `zone-${zone}-utc-1200`, d('2026-11-16T12:00:00Z'), zone);
    add('wake', 'isEveningWake', `zone-${zone}-utc-1700`, d('2026-11-16T17:00:00Z'), zone);
  }
  add('wake', 'isEveningWake', 'default-zone', d('2026-11-16T12:30:00+09:00'));
}

function importance(add: Add) {
  const titles: (string | null | undefined)[] = [
    null, undefined, '', '   ', '점심', '시험', '기말고사', '중간고사 보는 날', '면접', '면접 준비', '면접준비', '면접   공부', '시험 공부', '시험공부', '시험 대비', '시험대비반',
    '토익', '토익 스터디', '토익스터디', '토플 대비', '토플', 'TOEIC', '영어 시험 보러 가기', '시험 후 회식', '면접 끝나고 밥', '고사장 가기', '수능 고사', '시험\n공부', '시험\t준비', '면접 보고 공부', '공부 시험', '시험 시험 공부',
  ];
  titles.forEach((t, i) => add('importance', 'autoImportance', `title-${i}`, t));
}

function suggest(add: Add) {
  const r = rng(0x5e57);
  for (const [i, residuals] of ([[], [6], [6, 6], [6, 6, 6], [5, 5, 5], [4, 5, 6], [4, 4, 4], [10, 14, 12], [0, 8, 8, 8], [8, 8, 0], [8, -1, 8, 8], [3, 6, 9, 12], [0.5, 5, 9.5], [4.99, 5, 5.01], [30, 30, 30], [-5, -6, -7]] as number[][]).entries()) {
    add('suggest', 'detectOverrun', `case-${i}`, residuals);
    add('suggest', 'detectOverrun', `case-${i}-window2`, residuals, { window: 2, minMean: 3 });
    add('suggest', 'detectOverrun', `case-${i}-window5`, residuals, { window: 5, minMean: 8 });
  }
  for (const overrun of [-3, 0, 4.99, 5, 5.01, 9.99, 10, 12, 14.999, 15, 19.99, 25, 100]) {
    for (const cap of [0, 4, 5, 9, 10, 14, 15, 100]) add('suggest', 'sizeAdvance', `${overrun}-cap${cap}`, overrun, cap);
  }
  for (const advance of [0, 5, 10, 25]) for (const before of [-5, 0, 5, 10, 20, Infinity]) add('suggest', 'wakeShift', `${advance}-before${before}`, advance, before);
  for (let i = 0; i < 80; i++) {
    const len = r.int(0, 7);
    const residuals = Array.from({ length: len }, () => r.pick([-4, -1, 0, 0, 3, 5, 6, 7.5, 9, 10, 12, 14, 20, 30, 4.5, 0.25]));
    const rule = r.pick([undefined, undefined, { window: 2, minMean: 3 }, { window: 3, minMean: 8 }, { window: 5, minMean: 5 }]);
    const input = { residuals, beforePrepareMinutes: r.pick([0, 5, 10, 20, 30, Infinity, -5]), capMinutes: r.pick([0, 4, 5, 9, 10, 14, 15, 20, 100]), ...(rule ? { rule } : {}) };
    add('suggest', 'suggestPrepareAdvance', `rand-${i}`, input);
  }
  add('suggest', 'suggestPrepareAdvance', 'doc-example', { residuals: [10, 14, 12], beforePrepareMinutes: 5, capMinutes: 10 });
}

function travel(add: Add) {
  const places: [string, { lat: number; lng: number }][] = [
    ['seoul-station', { lat: 37.5547, lng: 126.9707 }],
    ['gangnam', { lat: 37.4979, lng: 127.0276 }],
    ['busan', { lat: 35.1151, lng: 129.0422 }],
    ['jeju', { lat: 33.5113, lng: 126.493 }],
    ['equator', { lat: 0, lng: 0 }],
    ['antipode', { lat: 0, lng: 180 }],
    ['north-pole', { lat: 90, lng: 0 }],
    ['near', { lat: 37.5548, lng: 126.9708 }],
    ['sydney', { lat: -33.8688, lng: 151.2093 }],
  ];
  for (const [an, a] of places) for (const [bn, b] of places) add('travel', 'haversineKm', `${an}-${bn}`, a, b);
  for (const transport of ['WALK', 'TRANSIT', 'BUS', 'SUBWAY', 'CAR']) {
    for (const [an, a] of places.slice(0, 5)) {
      for (const [bn, b] of places.slice(0, 5)) add('travel', 'estimateTravelMinutes', `${transport}-${an}-${bn}`, a, b, transport);
    }
    // 아주 가까움 → 최소 1분
    add('travel', 'estimateTravelMinutes', `${transport}-same-point`, places[0][1], places[0][1], transport);
    add('travel', 'estimateTravelMinutes', `${transport}-near`, places[0][1], places[7][1], transport);
  }
  const r = rng(0x7a41);
  const origin = { lat: 37.5547, lng: 126.9707 };
  const dest = { lat: 37.4979, lng: 127.0276 };
  const sample = (dur: number, o = origin, ds = dest, transport = 'TRANSIT') => {
    const departedAt = d('2026-11-10T08:00:00+09:00');
    return { origin: o, destination: ds, transport, departedAt, arrivedAt: new Date(departedAt.getTime() + dur * 1000) };
  };
  // 오프셋: 위도 0.001도 ≈ 111m → 300m 경계 근처
  const shift = (meters: number) => ({ lat: origin.lat + meters / 111_195, lng: origin.lng });
  add('travel', 'medianSameRoute', 'empty', [], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'two-only', [sample(1200), sample(1500)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'three-odd', [sample(1200), sample(1800), sample(1500)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'four-even-median-23', [sample(1200), sample(1260), sample(1500), sample(1590)], origin, dest, 'TRANSIT');
  // 중앙값 .5: JS Math.round는 위로(20.5 → 21 · 22.5 → 23), 파이썬 round는 짝수 쪽(20 · 22)이라 갈림
  add('travel', 'medianSameRoute', 'four-even-median-20.5', [sample(60 * 18), sample(60 * 20), sample(60 * 21), sample(60 * 30)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'four-even-median-22.5', [sample(60 * 20), sample(60 * 22), sample(60 * 23), sample(60 * 25)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'four-even-median-21.5', [sample(60 * 20), sample(60 * 21), sample(60 * 22), sample(60 * 23)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'median-0.4-fraction', [sample(60 * 20 + 24), sample(60 * 20 + 24), sample(60 * 20 + 24)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'filter-short-long', [sample(59), sample(60), sample(18_000), sample(18_001), sample(1200), sample(1300)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'all-filtered', [sample(30), sample(20_000), sample(10)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'transport-mismatch', [sample(1200), sample(1300), sample(1400, origin, dest, 'WALK')], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'radius-inside', [sample(1200, shift(250)), sample(1300, shift(-250)), sample(1400)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'radius-outside', [sample(1200, shift(350)), sample(1300, shift(-350)), sample(1400)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'radius-edge-299', [sample(1200, shift(299)), sample(1300, shift(-299)), sample(1400)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'radius-edge-301', [sample(1200, shift(301)), sample(1300, shift(-301)), sample(1400)], origin, dest, 'TRANSIT');
  add('travel', 'medianSameRoute', 'median-exactly-1', [sample(60), sample(60), sample(61)], origin, dest, 'TRANSIT');
  for (let i = 0; i < 40; i++) {
    const n = r.int(0, 8);
    const samples = Array.from({ length: n }, () =>
      sample(r.pick([20, 55, 60, 90, 600, 1200, 1230, 1500, 1790, 3600, 18_000, 18_030]), r.chance(0.7) ? origin : shift(r.int(100, 500)), r.chance(0.8) ? dest : { lat: dest.lat, lng: dest.lng + r.int(1, 8) / 1000 }, r.pick(['TRANSIT', 'TRANSIT', 'WALK', 'BUS'])),
    );
    add('travel', 'medianSameRoute', `rand-${i}`, samples, origin, dest, r.pick(['TRANSIT', 'TRANSIT', 'WALK']));
  }
}

export function basic(add: Add) {
  time(add);
  depart(add);
  wake(add);
  importance(add);
  suggest(add);
  travel(add);
}
