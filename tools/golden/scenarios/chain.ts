// 알람 역산 · 직접 고른 시각 · 순서 확인 · 저장 검증 시나리오 — chain · order · validate
import { alarmChain, departureAt } from '../../../supabase/functions/_shared/calc/chain.ts';
import type { ChainAlarm, ChainInput, RingKind } from '../../../supabase/functions/_shared/calc/types.ts';
import { after, d, rng, RING, type Add, type Rng } from './kit.ts';

const APPT = d('2026-11-16T10:00:00+09:00');

const base = (over: Partial<ChainInput> = {}): ChainInput => ({
  at: APPT,
  travelMinutes: 30,
  bufferMinutes: 10,
  prepareMinutes: 50,
  beforePrepareMinutes: 20,
  withWake: true,
  ...over,
});

// 무작위 입력 — 값은 실제 앱에서 나올 법한 범위 + 경계(0 · 소수 분 · 초가 있는 약속 시각)
function randomInput(r: Rng): ChainInput {
  const at = new Date(APPT.getTime() + r.int(0, 7 * 1440) * 60_000 + r.pick([0, 0, 0, 30_000, 17_000]));
  const input: ChainInput = {
    at,
    travelMinutes: r.pick([0, 1, 5, 12.5, 17, 30, 45, 60, 90, 150]),
    bufferMinutes: r.pick([0, 5, 10, 15, 20, 30]),
    prepareMinutes: r.pick([0, 1, 10, 25, 45, 50, 90, 180]),
    beforePrepareMinutes: r.pick([0, 0, 5, 10, 20, 30, 60]),
    withWake: r.chance(0.6),
  };
  if (r.chance(0.5)) input.kinds = r.pick([[], ['WAKE'], ['PREPARE'], ['DEPARTURE'], ['WAKE', 'PREPARE'], ['PREPARE', 'DEPARTURE'], ['DEPARTURE', 'WAKE'], ['WAKE', 'PREPARE', 'DEPARTURE'], ['WAKE', 'WAKE']] as RingKind[][]);
  if (r.chance(0.6)) input.prepareAdvanceMinutes = r.pick([0, 5, 10, 15, 25, 45, -10]);
  if (r.chance(0.5)) {
    const auto = new Map(alarmChain({ ...input, manualTimes: undefined, kinds: undefined }).map((x) => [x.kind, x.at]));
    const manual: Partial<Record<RingKind, Date>> = {};
    for (const kind of RING) {
      if (!r.chance(0.35)) continue;
      const autoAt = auto.get(kind);
      manual[kind] = autoAt && r.chance(0.25) ? new Date(autoAt.getTime()) : after(at, -r.int(0, 600)); // 자동값과 같은 직접 값도 섞음
    }
    input.manualTimes = manual;
  }
  return input;
}

const randomAlarms = (r: Rng): { input: ChainInput; alarms: ChainAlarm[] } => {
  const input = randomInput(r);
  return { input, alarms: alarmChain({ ...input, kinds: r.chance(0.7) ? undefined : input.kinds }) };
};

function chain(add: Add) {
  add('chain', 'alarmChain', 'basic-with-wake', base());
  add('chain', 'alarmChain', 'basic-no-wake', base({ withWake: false }));
  add('chain', 'alarmChain', 'no-before-prepare', base({ beforePrepareMinutes: 0 }));
  add('chain', 'alarmChain', 'kinds-empty', base({ kinds: [] }));
  add('chain', 'alarmChain', 'kinds-departure-only', base({ kinds: ['DEPARTURE'] }));
  add('chain', 'alarmChain', 'kinds-wake-only', base({ kinds: ['WAKE'] }));
  add('chain', 'alarmChain', 'kinds-no-wake-ask-wake', base({ withWake: false, kinds: ['WAKE'] }));
  add('chain', 'alarmChain', 'kinds-no-wake-ask-prepare', base({ withWake: false, kinds: ['PREPARE'] }));
  for (const adv of [-10, 0, 5, 20, 21, 35, 100]) add('chain', 'alarmChain', `advance-${adv}`, base({ prepareAdvanceMinutes: adv }));
  add('chain', 'alarmChain', 'advance-no-wake', base({ withWake: false, prepareAdvanceMinutes: 15 }));
  add('chain', 'alarmChain', 'advance-without-before', base({ beforePrepareMinutes: 0, prepareAdvanceMinutes: 15 }));
  const auto = new Map(alarmChain(base()).map((x) => [x.kind, x.at]));
  add('chain', 'alarmChain', 'manual-wake', base({ manualTimes: { WAKE: after(APPT, -200) } }));
  add('chain', 'alarmChain', 'manual-prepare', base({ manualTimes: { PREPARE: after(APPT, -150) } }));
  add('chain', 'alarmChain', 'manual-departure', base({ manualTimes: { DEPARTURE: after(APPT, -45) } }));
  add('chain', 'alarmChain', 'manual-all', base({ manualTimes: { WAKE: after(APPT, -200), PREPARE: after(APPT, -150), DEPARTURE: after(APPT, -45) } }));
  add('chain', 'alarmChain', 'manual-equals-auto', base({ manualTimes: { WAKE: new Date(auto.get('WAKE')!.getTime()), DEPARTURE: new Date(auto.get('DEPARTURE')!.getTime()) } }));
  add('chain', 'alarmChain', 'manual-one-ms-off-auto', base({ manualTimes: { WAKE: new Date(auto.get('WAKE')!.getTime() + 1) } }));
  add('chain', 'alarmChain', 'manual-with-kinds-hidden', base({ kinds: ['DEPARTURE'], manualTimes: { WAKE: after(APPT, -200) } }));
  add('chain', 'alarmChain', 'manual-no-wake', base({ withWake: false, manualTimes: { WAKE: after(APPT, -200), PREPARE: after(APPT, -120) } }));
  add('chain', 'alarmChain', 'manual-wake-with-advance', base({ prepareAdvanceMinutes: 30, manualTimes: { WAKE: after(APPT, -200) } }));
  add('chain', 'alarmChain', 'zero-everything', base({ travelMinutes: 0, bufferMinutes: 0, prepareMinutes: 0, beforePrepareMinutes: 0 }));
  add('chain', 'alarmChain', 'fractional-minutes', base({ travelMinutes: 12.5, bufferMinutes: 7.25, prepareMinutes: 33.5 }));
  add('chain', 'alarmChain', 'seconds-in-appointment', base({ at: d('2026-11-16T10:00:42+09:00') }));
  const r = rng(0xc4a1);
  for (let i = 0; i < 110; i++) add('chain', 'alarmChain', `rand-${i}`, randomInput(r));

  add('chain', 'departureAuto', 'basic', base());
  add('chain', 'departureAuto', 'zero', base({ travelMinutes: 0, bufferMinutes: 0 }));
  for (let i = 0; i < 25; i++) add('chain', 'departureAuto', `rand-${i}`, randomInput(r));
  add('chain', 'departureAt', 'basic', base());
  add('chain', 'departureAt', 'kinds-hide-departure', base({ kinds: ['WAKE'] }));
  add('chain', 'departureAt', 'manual-departure', base({ manualTimes: { DEPARTURE: after(APPT, -45) } }));
  add('chain', 'departureAt', 'manual-departure-kinds-hide', base({ kinds: ['WAKE'], manualTimes: { DEPARTURE: after(APPT, -45) } }));
  for (let i = 0; i < 40; i++) add('chain', 'departureAt', `rand-${i}`, randomInput(r));
  // manualTimes: 알람 목록에서 직접 고른 시각만
  add('chain', 'manualTimes', 'none', alarmChain(base()));
  add('chain', 'manualTimes', 'empty', []);
  add('chain', 'manualTimes', 'all', alarmChain(base({ manualTimes: { WAKE: after(APPT, -200), PREPARE: after(APPT, -150), DEPARTURE: after(APPT, -45) } })));
  add('chain', 'manualTimes', 'arrive-with-auto-ignored', [{ kind: 'ARRIVE', at: APPT, auto: after(APPT, -10) }]);
  for (let i = 0; i < 30; i++) add('chain', 'manualTimes', `rand-${i}`, randomAlarms(r).alarms);
}

function order(add: Add) {
  const r = rng(0x0de7);
  const sample = alarmChain(base({ manualTimes: { WAKE: after(APPT, -200) } }));
  for (const [i, a] of sample.entries()) {
    add('order', 'autoTime', `sample-${i}`, a);
    add('order', 'isManualTime', `sample-${i}`, a);
  }
  add('order', 'autoTime', 'no-auto', { kind: 'WAKE', at: APPT });
  add('order', 'isManualTime', 'no-auto', { kind: 'WAKE', at: APPT });
  const plain = alarmChain(base());
  for (const kind of RING) {
    for (const delta of [-120, -1, 0, 1, 7, 90]) {
      add('order', 'moveAlarm', `${kind}-${delta}`, plain, kind, after(plain.find((x) => x.kind === kind)!.at, delta));
    }
    add('order', 'moveAlarm', `${kind}-back-to-auto`, sample, kind, sample.find((x) => x.kind === kind)!.auto ?? sample.find((x) => x.kind === kind)!.at);
    add('order', 'resetAlarm', `${kind}-after-manual`, sample, kind);
    add('order', 'resetAlarm', `${kind}-plain`, plain, kind);
  }
  add('order', 'moveAlarm', 'missing-kind', alarmChain(base({ withWake: false })), 'WAKE', after(APPT, -300));
  add('order', 'resetAlarm', 'missing-kind', alarmChain(base({ withWake: false })), 'WAKE');
  add('order', 'moveAlarm', 'wake-moves-prepare-with-manual', alarmChain(base({ manualTimes: { PREPARE: after(APPT, -150) } })), 'WAKE', after(APPT, -240));
  add('order', 'moveAlarm', 'empty', [], 'WAKE', APPT);
  for (let i = 0; i < 40; i++) {
    const { alarms } = randomAlarms(r);
    const kind = r.pick(RING);
    add('order', 'moveAlarm', `rand-${i}`, alarms, kind, after(alarms.find((x) => x.kind === kind)?.at ?? APPT, r.pick([-300, -45, -1, 0, 1, 20, 400])));
    add('order', 'resetAlarm', `rand-${i}`, alarms, kind);
  }
  // 순서 확인
  add('order', 'orderError', 'ok-chain', plain);
  add('order', 'orderError', 'empty', []);
  add('order', 'orderError', 'equal-times-ok', [{ kind: 'WAKE', at: APPT }, { kind: 'PREPARE', at: APPT }, { kind: 'DEPARTURE', at: APPT }, { kind: 'ARRIVE', at: APPT }]);
  add('order', 'orderError', 'prepare-before-wake', [{ kind: 'WAKE', at: after(APPT, -60) }, { kind: 'PREPARE', at: after(APPT, -61) }]);
  add('order', 'orderError', 'departure-before-prepare', [{ kind: 'PREPARE', at: after(APPT, -60) }, { kind: 'DEPARTURE', at: after(APPT, -61) }]);
  add('order', 'orderError', 'arrive-before-departure', [{ kind: 'DEPARTURE', at: after(APPT, -40) }, { kind: 'ARRIVE', at: after(APPT, -41) }]);
  add('order', 'orderError', 'arrive-before-wake-skip-order', [{ kind: 'ARRIVE', at: after(APPT, -300) }, { kind: 'WAKE', at: after(APPT, -200) }]);
  add('order', 'orderError', 'listed-out-of-order-but-fine', [{ kind: 'DEPARTURE', at: after(APPT, -40) }, { kind: 'WAKE', at: after(APPT, -100) }]);
  add('order', 'orderError', 'two-of-a-kind', [{ kind: 'WAKE', at: after(APPT, -100) }, { kind: 'WAKE', at: after(APPT, -200) }, { kind: 'PREPARE', at: after(APPT, -150) }]);
  add('order', 'orderError', 'one-ms-reversed', [{ kind: 'WAKE', at: new Date(APPT.getTime()) }, { kind: 'PREPARE', at: new Date(APPT.getTime() - 1) }]);
  for (let i = 0; i < 50; i++) {
    const { alarms } = randomAlarms(r);
    const bent = alarms.map((a) => (r.chance(0.3) ? { ...a, at: after(a.at, r.pick([-120, -5, -1, 1, 5, 120])) } : a));
    add('order', 'orderError', `rand-${i}`, r.chance(0.5) ? bent : r.shuffle(bent));
  }
}

function validate(add: Add) {
  const r = rng(0x7a11);
  const input = base();
  const alarms = alarmChain(input);
  const departure = departureAt(input);
  const wake = alarms.find((x) => x.kind === 'WAKE')!.at;
  const prepare = alarms.find((x) => x.kind === 'PREPARE')!.at;
  add('validate', 'checkAlarms', 'empty', [], departure, APPT);
  add('validate', 'checkAlarms', 'all-future', alarms, departure, after(APPT, -600));
  // 지금 + 5분 경계: 기상 시각이 정확히 now + 5분 → 아직 켜짐, 1ms 이르면 꺼짐
  add('validate', 'checkAlarms', 'wake-exactly-grace', alarms, departure, new Date(wake.getTime() - 5 * 60_000));
  add('validate', 'checkAlarms', 'wake-1ms-inside-grace', alarms, departure, new Date(wake.getTime() - 5 * 60_000 + 1));
  add('validate', 'checkAlarms', 'wake-1ms-outside-grace', alarms, departure, new Date(wake.getTime() - 5 * 60_000 - 1));
  add('validate', 'checkAlarms', 'wake-passed-prepare-live', alarms, departure, new Date(wake.getTime() + 60_000));
  add('validate', 'checkAlarms', 'both-passed', alarms, departure, new Date(prepare.getTime() + 60_000));
  add('validate', 'checkAlarms', 'departure-exactly-now', alarms, departure, new Date(departure.getTime()));
  add('validate', 'checkAlarms', 'departure-1ms-passed', alarms, departure, new Date(departure.getTime() + 1));
  add('validate', 'checkAlarms', 'departure-long-passed', alarms, departure, after(APPT, 600));
  add('validate', 'checkAlarms', 'order-wrong', [{ kind: 'WAKE', at: after(APPT, -60) }, { kind: 'PREPARE', at: after(APPT, -120) }], departure, after(APPT, -900));
  add('validate', 'checkAlarms', 'order-wrong-departure-passed-too', [{ kind: 'DEPARTURE', at: after(APPT, -40) }, { kind: 'ARRIVE', at: after(APPT, -45) }], after(APPT, -40), APPT);
  add('validate', 'checkAlarms', 'departure-alarm-not-made', alarmChain(base({ kinds: ['WAKE'] })), departure, after(APPT, -600));
  add('validate', 'checkAlarms', 'manual-kept', alarmChain(base({ manualTimes: { WAKE: after(APPT, -200) } })), departure, after(APPT, -600));
  add('validate', 'checkAlarms', 'manual-passed', alarmChain(base({ manualTimes: { WAKE: after(APPT, -200) } })), departure, after(APPT, -198));
  for (let i = 0; i < 70; i++) {
    const { input: ri, alarms: list } = randomAlarms(r);
    const dep = departureAt(ri);
    const now = new Date(dep.getTime() + r.pick([-3000, -600, -150, -60, -6, -5, -4, -1, 0, 1, 20, 200]) * 60_000 + r.pick([0, 0, -1, 1]));
    add('validate', 'checkAlarms', `rand-${i}`, list, dep, now);
  }
}

export function chainScenarios(add: Add) {
  chain(add);
  order(add);
  validate(add);
}
