// 미리보기 · 저장 계획 시나리오 — plan-core · commit-core · ring-package
//   서버가 실제로 이어 부르는 순서(computePlan → toSuggestion, computePlan → diffAlarms)를 합친 함수로도 시험 (registry.ts)
//   입력은 DB 행 모양(문자열 시각) + Date(`now` · 초안 시각)가 섞여 있음 — 본 레포 plan.ts가 만드는 PlanInputs 그대로
import { alarmChain } from '../../../supabase/functions/_shared/calc/chain.ts';
import { predictPrepare, prepareStatsOf } from '../../../supabase/functions/_shared/calc/prepare.ts';
import { after, d, IMPORTANCES, rng, TRANSPORTS, type Add, type Rng } from './kit.ts';

const NOW = d('2026-11-15T21:00:00+09:00');
const iso = (date: Date) => date.toISOString();

const profile = (over: Record<string, unknown> = {}) => ({
  timezone: 'Asia/Seoul',
  default_buffer_minutes: 10,
  default_transport: 'TRANSIT',
  home_name: '집',
  home_lat: 37.5547,
  home_lng: 126.9707,
  default_prepare_minutes: null,
  wake_sensitivity: null,
  wake_margin: null,
  ...over,
});

const appointmentRow = (over: Record<string, unknown> = {}) => ({
  appointment_id: 'appt-1',
  creator_id: 'u1',
  group_id: null,
  title: '수업',
  appointment_at: '2026-11-16T01:00:00+00:00', // 서울 10:00
  dest_name: '세종대',
  dest_lat: 37.5509,
  dest_lng: 127.0736,
  importance: 'LOW',
  recurrence_rule: null,
  ...over,
});

const participantRow = (over: Record<string, unknown> = {}) => ({
  participant_id: 'p1',
  appointment_id: 'appt-1',
  user_id: 'u1',
  origin_name: '집',
  origin_lat: 37.5547,
  origin_lng: 126.9707,
  transport_type: 'TRANSIT',
  est_travel_minutes: 30,
  travel_source: 'API',
  prepare_minutes: 50,
  buffer_minutes: 10,
  prepare_advance_minutes: null,
  ...over,
});

const alarmRow = (kind: string, at: Date | string, over: Record<string, unknown> = {}) => ({
  alarm_id: `a-${kind.toLowerCase()}`,
  participant_id: 'p1',
  user_id: 'u1',
  alarm_type: kind,
  scheduled_at: typeof at === 'string' ? at : iso(at),
  intensity: 'NORMAL',
  voice_tone: 'NEUTRAL',
  sound_key: 'theme_default',
  vibration: null,
  is_enabled: true,
  snooze_limit: 3,
  time_source: 'AUTO',
  intensity_source: 'AUTO',
  recurrence_rule: null,
  ...over,
});

const travelOf = (minutes: number, over: Record<string, unknown> = {}) => ({
  chosen: { minutes, source: 'API', needsConfirmation: false, note: '카카오 길찾기', ...over },
  auto: { minutes, source: 'API', needsConfirmation: false, note: '카카오 길찾기' },
  warnings: [] as unknown[],
});

const statsOf = (values: (number | string | null)[]) => prepareStatsOf(values);
const STATS = [
  { sampleCount: 0, p80: null },
  statsOf([40, 55, 48]),
  statsOf([40, 55, 48, 60, 52]),
  statsOf([30, 35, 38, 41, 44, 46, 50, 53, 57, 61, 64, 70]),
  statsOf(Array.from({ length: 20 }, (_, i) => 35 + (i * 7) % 40)),
];

type Inputs = Record<string, unknown>;

function newAppointmentInputs(over: Inputs = {}, draftOver: Inputs = {}): Inputs {
  return {
    now: NOW,
    draft: { at: d('2026-11-16T10:00:00+09:00'), destination: { name: '세종대', lat: 37.5509, lng: 127.0736 }, ...draftOver },
    profile: profile(),
    existingAlarms: [],
    stats: STATS[0],
    lateCount4w: 0,
    sameDayWake: false,
    ...over,
  };
}

function existingAppointmentInputs(over: Inputs = {}, draftOver: Inputs = {}, alarms: unknown[] | undefined = undefined): Inputs {
  const wake = d('2026-11-16T07:40:00+09:00');
  return {
    now: NOW,
    draft: { ...draftOver },
    profile: profile(),
    appointment: appointmentRow(),
    participant: participantRow(),
    existingAlarms:
      alarms ?? [alarmRow('WAKE', wake), alarmRow('PREPARE', after(wake, 20)), alarmRow('DEPARTURE', d('2026-11-16T08:50:00+09:00')), alarmRow('ARRIVE', d('2026-11-16T09:50:00+09:00'))],
    stats: STATS[2],
    lateCount4w: 0,
    sameDayWake: false,
    ...over,
  };
}

// ---------- 무작위 계획 입력 ----------
function randomWhen(r: Rng): Date {
  const day = r.pick(['2026-11-16', '2026-11-17', '2026-11-21']);
  const hhmm = r.pick(['00:30', '03:00', '05:45', '07:00', '08:30', '09:00', '10:00', '11:20', '12:00', '13:15', '15:00', '18:30', '20:00', '23:10']);
  return d(`${day}T${hhmm}:${r.pick(['00', '00', '00', '30'])}+09:00`);
}

function randomDraft(r: Rng, at: Date, isNew: boolean): Inputs {
  const draft: Inputs = {};
  if (isNew) {
    draft.at = at;
    draft.destination = r.pick([{ name: '세종대', lat: 37.5509, lng: 127.0736 }, { name: '학교' }, { name: '강남역', lat: 37.4979, lng: 127.0276 }]);
    if (r.chance(0.6)) draft.importance = r.pick(IMPORTANCES);
  }
  if (r.chance(0.3)) draft.transport = r.pick(TRANSPORTS);
  if (r.chance(0.3)) draft.bufferMinutes = r.pick([0, 5, 15, 30]);
  if (r.chance(0.3)) draft.beforePrepareMinutes = r.pick([0, 10, 20, 45]);
  if (r.chance(0.4)) draft.withWake = r.chance(0.5);
  if (r.chance(0.25)) draft.prepareMinutes = r.pick([15, 40, 75, 120]);
  if (r.chance(0.3)) draft.kinds = r.pick([[], ['WAKE'], ['PREPARE', 'DEPARTURE'], ['WAKE', 'PREPARE', 'DEPARTURE'], ['DEPARTURE']]);
  if (r.chance(0.3)) draft.enabled = r.pick([{ WAKE: false }, { PREPARE: true }, { DEPARTURE: false, WAKE: true }]);
  if (r.chance(0.3)) draft.manualTimes = r.pick([{ WAKE: after(at, -240) }, { PREPARE: after(at, -150), WAKE: null }, { DEPARTURE: after(at, -50) }, { WAKE: after(at, -400), PREPARE: after(at, -380), DEPARTURE: after(at, -60) }]);
  if (r.chance(0.3)) draft.levels = r.pick([{ sound: 0 }, { voice: 2, vibration: null }, { sound: 2, voice: 2, vibration: 2 }, { vibration: 0 }]);
  if (r.chance(0.3)) draft.origin = r.pick([{ name: '집' }, { name: '학교' }, { name: '카페', lat: 37.56, lng: 126.98 }, { name: '집', lat: 37.5, lng: 127.0 }]);
  return draft;
}

function randomExistingAlarms(r: Rng, at: Date): unknown[] {
  if (r.chance(0.3)) return [];
  const input = { at, travelMinutes: 30, bufferMinutes: 10, prepareMinutes: r.pick([30, 50, 70]), beforePrepareMinutes: r.pick([0, 20, 30]), withWake: r.chance(0.8) };
  const rows = alarmChain(input).map((x) =>
    alarmRow(x.kind, x.at, {
      alarm_id: `a-${x.kind.toLowerCase()}`,
      time_source: r.chance(0.2) ? 'MANUAL' : 'AUTO',
      is_enabled: r.chance(0.85),
      intensity_source: r.chance(0.2) ? 'MANUAL' : 'AUTO',
      ...(r.chance(0.2) ? { intensity: r.pick(['SOFT', 'STRONG']), voice_tone: r.pick(['CALM', 'DIRECT']), sound_key: r.pick(['theme_calm', 'theme_urgent']), vibration: r.pick(['NONE', 'STRONG_CONTINUOUS', null]) } : {}),
      ...(r.chance(0.1) ? { original_scheduled_at: iso(after(x.at, 15)), original_time_source: 'AUTO' } : {}),
    }),
  );
  if (r.chance(0.2)) rows.push(alarmRow('ROUTINE', after(at, -200), { alarm_id: 'a-routine', recurrence_rule: 'FREQ=DAILY' }));
  return r.chance(0.2) ? rows.filter((x) => x.alarm_type !== 'PREPARE') : rows;
}

function randomPlan(r: Rng): { inputs: Inputs; travel: unknown; mode: string } {
  const at = randomWhen(r);
  const isNew = r.chance(0.5);
  const draft = randomDraft(r, at, isNew);
  const inputs: Inputs = {
    now: after(at, -r.pick([-30, 20, 90, 180, 600, 1500, 3000])),
    draft,
    profile: profile({
      timezone: r.pick(['Asia/Seoul', 'Asia/Seoul', 'Asia/Seoul', 'UTC', 'America/New_York', 'Not/AZone']),
      default_buffer_minutes: r.pick([0, 5, 10, 15]),
      default_transport: r.pick(TRANSPORTS),
      wake_sensitivity: r.pick([null, 'LIGHT', 'NORMAL', 'HEAVY']),
      wake_margin: r.pick([null, 'TIGHT', 'NORMAL', 'LOOSE']),
      default_prepare_minutes: r.pick([null, null, 4, 5, 30, 60, 300, 301]),
    }),
    existingAlarms: randomExistingAlarms(r, at),
    stats: r.pick(STATS),
    lateCount4w: r.pick([0, 0, 1, 2, 3]),
    sameDayWake: r.chance(0.3),
  };
  if (!isNew) {
    inputs.appointment = appointmentRow({ appointment_at: iso(at), importance: r.pick(IMPORTANCES), dest_lat: r.pick([37.5509, null]), dest_lng: r.pick([127.0736, null]) });
    inputs.participant = r.chance(0.85) ? participantRow({ transport_type: r.pick(TRANSPORTS), buffer_minutes: r.pick([0, 10, 20]), prepare_minutes: r.pick([30, 50, 80]), prepare_advance_minutes: r.pick([null, 0, 5, 10, 30]), origin_name: r.pick(['집', '학교', null]), origin_lat: r.pick([37.5547, null]), origin_lng: 126.9707 }) : undefined;
  }
  if (r.chance(0.25)) inputs.mlPrediction = { model: r.pick(['c1_mae', 'w4_mae']), minutes: r.pick([35, 62, 80]) };
  if (r.chance(0.25)) inputs.prepareBound = { around: r.pick([50, 60]), within: r.pick([5, 10]) };
  if (r.chance(0.25)) inputs.existingAdvanceMinutes = r.pick([0, 5, 10]);
  const travel: Record<string, unknown> = travelOf(r.pick([0, 5, 12, 30, 45, 75, 130]), { source: r.pick(['API', 'CACHED', 'ESTIMATE', 'MANUAL']), needsConfirmation: r.chance(0.3), note: r.pick(['', '카카오 길찾기', '직선거리 근사']) });
  if (r.chance(0.3)) travel.warnings = [{ code: r.pick(['KAKAO_FAILED', 'KAKAO_PARTIAL', 'NO_COORDINATES']), message: '이동시간을 근사값으로 계산했어요' }];
  if (r.chance(0.2)) travel.auto = null;
  return { inputs, travel, mode: r.pick(['preview', 'save']) };
}

function plans(add: Add) {
  const hand: [string, Inputs, unknown, string?][] = [
    ['new-basic', newAppointmentInputs(), travelOf(30)],
    ['new-evening-no-wake', newAppointmentInputs({}, { at: d('2026-11-16T19:00:00+09:00') }), travelOf(30)],
    ['new-same-day-wake', newAppointmentInputs({ sameDayWake: true }), travelOf(30)],
    ['new-draft-with-wake-forced', newAppointmentInputs({ sameDayWake: true }, { withWake: true }), travelOf(30)],
    ['new-high-importance-learned', newAppointmentInputs({ stats: STATS[3], lateCount4w: 2 }, { importance: 'HIGH' }), travelOf(45)],
    ['new-heavy-sleeper', newAppointmentInputs({ profile: profile({ wake_sensitivity: 'HEAVY' }) }), travelOf(30)],
    ['new-voice-default-direct', newAppointmentInputs({ profile: profile({ preferred_voice_tone: 'DIRECT' }) }), travelOf(30)],
    ['new-tight-margin-learned', newAppointmentInputs({ stats: STATS[4], profile: profile({ wake_margin: 'TIGHT' }) }), travelOf(30)],
    ['new-manual-prepare-minutes', newAppointmentInputs({}, { prepareMinutes: 25 }), travelOf(30)],
    ['new-ml-model', newAppointmentInputs({ mlPrediction: { model: 'c1_mae', minutes: 62 } }), travelOf(30)],
    ['new-ml-ignored-when-manual', newAppointmentInputs({ mlPrediction: { model: 'w4_mae', minutes: 62 } }, { prepareMinutes: 40 }), travelOf(30)],
    ['new-ml-ignored-when-no-wake', newAppointmentInputs({ sameDayWake: true, mlPrediction: { model: 'w4_mae', minutes: 62 } }), travelOf(30)],
    ['new-bound-clamps-high', newAppointmentInputs({ prepareBound: { around: 40, within: 5 } }), travelOf(30)],
    ['new-bound-clamps-low', newAppointmentInputs({ prepareBound: { around: 70, within: 5 } }), travelOf(30)],
    ['new-past-departure', newAppointmentInputs({ now: d('2026-11-16T09:50:00+09:00') }), travelOf(30)],
    ['new-wake-already-passed', newAppointmentInputs({ now: d('2026-11-16T08:40:00+09:00') }), travelOf(30)],
    ['new-wake-and-prepare-passed', newAppointmentInputs({ now: d('2026-11-16T08:50:00+09:00') }), travelOf(30)],
    ['new-wake-passed-manual-wake-kept', newAppointmentInputs({ now: d('2026-11-16T08:40:00+09:00') }, { manualTimes: { WAKE: d('2026-11-16T08:50:00+09:00') } }), travelOf(30)],
    ['new-kinds-empty', newAppointmentInputs({}, { kinds: [] }), travelOf(30)],
    ['new-kinds-departure-only', newAppointmentInputs({}, { kinds: ['DEPARTURE'] }), travelOf(30)],
    ['new-manual-times', newAppointmentInputs({}, { manualTimes: { WAKE: d('2026-11-16T07:00:00+09:00'), DEPARTURE: d('2026-11-16T08:45:00+09:00') } }), travelOf(30)],
    ['new-manual-order-broken', newAppointmentInputs({}, { manualTimes: { WAKE: d('2026-11-16T09:30:00+09:00') } }), travelOf(30)],
    ['new-levels-manual', newAppointmentInputs({}, { levels: { sound: 0, voice: 2 } }), travelOf(30)],
    ['new-travel-warnings', newAppointmentInputs(), { ...travelOf(30), warnings: [{ code: 'KAKAO_PARTIAL', message: '일부 구간만 계산했어요' }] }],
    ['new-travel-manual-needs-confirm', newAppointmentInputs(), travelOf(20, { source: 'MANUAL', needsConfirmation: true, note: '' })],
    ['new-origin-home-name', newAppointmentInputs({}, { origin: { name: '집' } }), travelOf(30)],
    ['new-origin-unknown-place', newAppointmentInputs({}, { origin: { name: '카페' } }), travelOf(30)],
    ['new-before-prepare-draft', newAppointmentInputs({}, { beforePrepareMinutes: 35 }), travelOf(30)],
    ['new-zone-new-york', newAppointmentInputs({ profile: profile({ timezone: 'America/New_York' }) }, { at: d('2026-11-16T19:30:00Z') }), travelOf(30)],
    ['new-zone-invalid', newAppointmentInputs({ profile: profile({ timezone: 'Not/AZone' }) }), travelOf(30)],
    ['new-first-prepare-minutes', newAppointmentInputs({ profile: profile({ default_prepare_minutes: 70 }) }), travelOf(30)],
    ['existing-basic', existingAppointmentInputs(), travelOf(30)],
    ['existing-edit-transport', existingAppointmentInputs({}, { transport: 'WALK' }), travelOf(55)],
    ['existing-manual-wake-kept', existingAppointmentInputs({}, {}, [alarmRow('WAKE', d('2026-11-16T07:00:00+09:00'), { time_source: 'MANUAL' }), alarmRow('PREPARE', d('2026-11-16T07:20:00+09:00'))]), travelOf(30)],
    ['existing-advance-accepted', existingAppointmentInputs({ participant: participantRow({ prepare_advance_minutes: 10 }) }), travelOf(30)],
    ['existing-advance-with-existing-advance', existingAppointmentInputs({ participant: participantRow({ prepare_advance_minutes: 10 }), existingAdvanceMinutes: 0 }), travelOf(30)],
    ['existing-friend-times-not-stripped', existingAppointmentInputs({}, {}, [alarmRow('WAKE', d('2026-11-16T07:40:00+09:00'), { original_scheduled_at: '2026-11-16T07:00:00.000Z', original_time_source: 'AUTO' })]), travelOf(30)],
    ['existing-manual-intensity', existingAppointmentInputs({}, {}, [alarmRow('WAKE', d('2026-11-16T07:40:00+09:00'), { intensity_source: 'MANUAL', intensity: 'SOFT', voice_tone: 'CALM', sound_key: 'theme_calm', vibration: 'NONE' })]), travelOf(30)],
    ['existing-routine-row-ignored', existingAppointmentInputs({}, {}, [alarmRow('ROUTINE', d('2026-11-16T06:00:00+09:00'), { alarm_id: 'r1' }), alarmRow('DEPARTURE', d('2026-11-16T08:50:00+09:00'))]), travelOf(30)],
    ['existing-no-participant', existingAppointmentInputs({ participant: undefined }), travelOf(30)],
    ['existing-no-alarms', existingAppointmentInputs({}, {}, []), travelOf(30)],
    ['existing-importance-high', existingAppointmentInputs({ appointment: appointmentRow({ importance: 'HIGH' }), lateCount4w: 2 }), travelOf(30)],
  ];
  for (const [name, inputs, travel, mode] of hand) {
    for (const m of mode ? [mode] : ['preview', 'save']) {
      add('plan-core', 'computePlan', `${name}-${m}`, inputs, travel, m);
      add('plan-core', 'toSuggestionOfPlan', `${name}-${m}`, inputs, travel, m);
      add('commit-core', 'diffAlarmsOfPlan', `${name}-${m}`, inputs, travel, { now: inputs.now, replaceExisting: m === 'save' });
    }
    add('plan-core', 'toTravelRequiredSuggestion', name, inputs, travel);
  }
  // 오류가 나는 입력
  add('plan-core', 'computePlan', 'error-no-travel', newAppointmentInputs(), { chosen: null, auto: null, warnings: [] }, 'save');
  add('plan-core', 'computePlan', 'error-no-at', { ...newAppointmentInputs(), draft: { destination: { name: '세종대' } } }, travelOf(30), 'save');
  add('plan-core', 'computePlan', 'error-no-destination', { ...newAppointmentInputs(), draft: { at: d('2026-11-16T10:00:00+09:00') } }, travelOf(30), 'save');
  add('commit-core', 'diffAlarmsOfPlan', 'error-plan-not-ok', newAppointmentInputs({ now: d('2026-11-16T09:55:00+09:00') }), travelOf(30), { now: NOW, replaceExisting: true });
  const r = rng(0x91a7);
  const options = rng(0x0c0117); // commit-core 옵션용 — plan 입력용 난수와 수열을 나눔
  for (let i = 0; i < 60; i++) {
    const { inputs, travel, mode } = randomPlan(r);
    add('plan-core', 'computePlan', `rand-${i}`, inputs, travel, mode);
    add('plan-core', 'toSuggestionOfPlan', `rand-${i}`, inputs, travel, mode);
    add('commit-core', 'diffAlarmsOfPlan', `rand-${i}`, inputs, travel, { now: inputs.now, replaceExisting: options.chance(0.6), ...(options.chance(0.4) ? { enabled: options.pick([{ WAKE: false }, { PREPARE: true }, { DEPARTURE: false }]) } : {}) });
  }
}

function planHelpers(add: Add) {
  for (const v of [null, undefined, 4, 4.999, 5, 5.4, 5.5, 45, 50.5, 299.5, 300, 300.4, 301, -1, 0, '45', '45.5', Number.NaN, Infinity]) add('plan-core', 'firstPrepareMinutes', `${String(v)}-${typeof v}`, { default_prepare_minutes: v });
  add('plan-core', 'firstPrepareMinutes', 'missing-field', {});
  const basis = (over: Record<string, unknown> = {}) => predictPrepare({ commonP80: 50, personalP80: 80, sampleCount: 10, ...over });
  for (const [name, prepare] of [['auto', basis()], ['manual', basis({ override: 70 })], ['default', basis({ sampleCount: 2, personalP80: null })], ['high', basis({ personalP80: 200, sampleCount: 40 })]] as const) {
    for (const bound of [{ around: 50, within: 10 }, { around: 50, within: 0 }, { around: 20, within: 5 }, { around: 120, within: 10 }, { around: 62, within: 3 }]) {
      add('plan-core', 'clampPrepareToBound', `${name}-${bound.around}-${bound.within}`, prepare, bound);
    }
  }
  const rowWith = (id: string, original: string | null | undefined, srcOriginal: string | null | undefined) => alarmRow('WAKE', '2026-11-16T07:40:00.000Z', { alarm_id: id, ...(original === undefined ? {} : { original_scheduled_at: original }), ...(srcOriginal === undefined ? {} : { original_time_source: srcOriginal }) });
  add('plan-core', 'withoutFriendTimes', 'mixed', [rowWith('a', null, null), rowWith('b', '2026-11-16T07:00:00.000Z', 'MANUAL'), rowWith('c', '2026-11-16T07:10:00.000Z', null), rowWith('d', undefined, undefined), rowWith('e', '2026-11-16T07:20:00.000Z', undefined)]);
  add('plan-core', 'withoutFriendTimes', 'empty', []);
  const swRow = (id: string, at: unknown, alarms: unknown) => ({ appointment_id: id, appointments: at, alarms });
  add('plan-core', 'sameDayWakesFromRows', 'shapes', [
    swRow('a', { appointment_at: '2026-11-16T01:00:00+00:00' }, { is_enabled: true }),
    swRow('b', [{ appointment_at: '2026-11-16T03:00:00Z' }], [{ is_enabled: false }, { is_enabled: true }]),
    swRow('c', null, { is_enabled: true }),
    swRow('d', { appointment_at: 'not-a-date' }, { is_enabled: true }),
    swRow('e', { appointment_at: '2026-11-16T05:00:00Z' }, null),
    swRow('f', [], [{ is_enabled: true }]),
    swRow('g', [{ appointment_at: '2026-11-16T06:00:00Z' }, { appointment_at: '2026-11-16T07:00:00Z' }], [{ is_enabled: true }]),
    swRow('h', { appointment_at: '' }, { is_enabled: true }),
  ]);
  add('plan-core', 'sameDayWakesFromRows', 'empty', []);
  // resolveBasics
  const rb = (name: string, i: Inputs) => add('plan-core', 'resolveBasics', name, i);
  rb('new-basic', newAppointmentInputs());
  rb('new-origin-stored-by-name', { ...newAppointmentInputs({}, { origin: { name: '학교' } }), participant: participantRow({ origin_name: '학교', origin_lat: 37.55, origin_lng: 127.07 }) });
  rb('new-origin-home-alias', { ...newAppointmentInputs({}, { origin: { name: '집' } }), profile: profile({ home_name: '우리집' }) });
  rb('new-origin-with-coords', newAppointmentInputs({}, { origin: { name: '카페', lat: 37.5, lng: 127 } }));
  rb('new-origin-unknown-name', newAppointmentInputs({}, { origin: { name: '모르는 곳' } }));
  rb('new-no-home-coords', newAppointmentInputs({ profile: profile({ home_lat: null, home_lng: null }) }));
  rb('new-draft-importance', newAppointmentInputs({}, { importance: 'HIGH' }));
  rb('new-draft-transport-buffer', newAppointmentInputs({}, { transport: 'CAR', bufferMinutes: 0 }));
  rb('existing-basic', existingAppointmentInputs());
  rb('existing-appointment-wins-over-draft', existingAppointmentInputs({}, { importance: 'HIGH', at: d('2026-11-20T10:00:00+09:00'), destination: { name: '다른 곳' } }));
  rb('existing-participant-origin-blank-name', existingAppointmentInputs({ participant: participantRow({ origin_name: '', origin_lat: 37.5 }) }));
  rb('existing-participant-no-origin', existingAppointmentInputs({ participant: participantRow({ origin_name: null, origin_lat: null, origin_lng: null }) }));
  rb('existing-string-coords', existingAppointmentInputs({ appointment: appointmentRow({ dest_lat: '37.5509', dest_lng: '127.0736' }), profile: profile({ home_lat: '37.5547', home_lng: '126.9707' }) }));
  rb('error-missing-at-and-destination', { draft: {}, profile: profile() });
  // resolveKinds · resolveManualTimes · resolveOverrides · inferBeforePrepare
  const exist = [alarmRow('WAKE', d('2026-11-16T07:40:00+09:00'), { time_source: 'MANUAL' }), alarmRow('PREPARE', d('2026-11-16T08:00:00+09:00')), alarmRow('ARRIVE', d('2026-11-16T09:50:00+09:00')), alarmRow('ROUTINE', d('2026-11-16T06:00:00+09:00'))];
  add('plan-core', 'resolveKinds', 'draft-wins', ['DEPARTURE'], exist);
  add('plan-core', 'resolveKinds', 'draft-empty-wins', [], exist);
  add('plan-core', 'resolveKinds', 'from-existing', undefined, exist);
  add('plan-core', 'resolveKinds', 'none', undefined, []);
  add('plan-core', 'resolveKinds', 'only-non-ring', undefined, [alarmRow('ARRIVE', d('2026-11-16T09:50:00+09:00'))]);
  add('plan-core', 'resolveManualTimes', 'draft', { WAKE: d('2026-11-16T07:00:00+09:00'), PREPARE: null }, exist);
  add('plan-core', 'resolveManualTimes', 'draft-empty-object', {}, exist);
  add('plan-core', 'resolveManualTimes', 'from-existing', undefined, exist);
  add('plan-core', 'resolveManualTimes', 'none', undefined, []);
  const levelsExist = [alarmRow('PREPARE', d('2026-11-16T08:00:00+09:00'), { intensity_source: 'MANUAL', sound_key: 'theme_calm', voice_tone: 'DIRECT', vibration: 'SHORT_REPEAT' }), alarmRow('WAKE', d('2026-11-16T07:40:00+09:00'), { intensity_source: 'MANUAL', sound_key: 'theme_urgent', voice_tone: 'NEUTRAL', vibration: null })];
  for (const auto of [0, 1, 2]) {
    for (const [name, draft, rows, enabled] of [['draft', { sound: 0 }, levelsExist, undefined], ['stored-wake-first', undefined, levelsExist, undefined], ['stored-only-other', undefined, [levelsExist[0]], undefined], ['none-stored', undefined, [alarmRow('WAKE', d('2026-11-16T07:40:00+09:00'))], undefined], ['axes-disabled', { sound: 0 }, levelsExist, false], ['axes-disabled-stored', undefined, levelsExist, false]] as const) {
      add('plan-core', 'resolveOverrides', `${name}-auto${auto}`, draft, rows, auto, ...(enabled === undefined ? [] : [enabled]));
    }
  }
  // 저장된 말소리가 설정의 기본 말소리(voiceAuto)와 같으면 직접 고른 값이 아님
  for (const voiceAuto of [0, 1, 2]) add('plan-core', 'resolveOverrides', `stored-voice-auto${voiceAuto}`, undefined, levelsExist, 1, true, voiceAuto);
  const wakePrep = (gap: number, over: Record<string, unknown> = {}) => [alarmRow('WAKE', d('2026-11-16T07:00:00+09:00'), over), alarmRow('PREPARE', after(d('2026-11-16T07:00:00+09:00'), gap), over)];
  for (const gap of [-5, 0, 1, 20, 240, 241]) {
    add('plan-core', 'inferBeforePrepare', `gap${gap}`, wakePrep(gap));
    for (const advance of [5, 10, 30]) {
      add('plan-core', 'inferBeforePrepare', `gap${gap}-adv${advance}`, wakePrep(gap), advance);
      add('plan-core', 'inferBeforePrepare', `gap${gap}-adv${advance}-prep50`, [...wakePrep(gap), alarmRow('DEPARTURE', d('2026-11-16T08:50:00+09:00'))], advance, 50);
      add('plan-core', 'inferBeforePrepare', `gap${gap}-adv${advance}-prep50-manual-depart`, [...wakePrep(gap), alarmRow('DEPARTURE', d('2026-11-16T08:50:00+09:00'), { time_source: 'MANUAL' })], advance, 50);
    }
  }
  // 간격 0 · 당김 > 0: 기상이 자동 기상(출발 − 준비)에서 앞당겨진 만큼을 빼서 되찾음 (D111 B안). 숫자 결과가 나오는 사례
  const wakeAt = (hhmmss: string) => d(`2026-11-16T${hhmmss}+09:00`);
  const together = (wake: string, over: Record<string, unknown> = {}, departOver: Record<string, unknown> = {}) => [
    alarmRow('WAKE', wakeAt(wake), over),
    alarmRow('PREPARE', wakeAt(wake)),
    alarmRow('DEPARTURE', wakeAt('08:50:00'), departOver),
  ];
  add('plan-core', 'inferBeforePrepare', 'regain-wake-moved-5', together('07:55:00'), 25, 50);
  add('plan-core', 'inferBeforePrepare', 'regain-wake-moved-5-adv30', together('07:55:00'), 30, 50);
  add('plan-core', 'inferBeforePrepare', 'regain-wake-manual', together('07:55:00', { time_source: 'MANUAL' }), 25, 50);
  add('plan-core', 'inferBeforePrepare', 'regain-depart-manual', together('07:55:00', {}, { time_source: 'MANUAL' }), 25, 50);
  add('plan-core', 'inferBeforePrepare', 'regain-no-prepare-minutes', together('07:55:00'), 25);
  add('plan-core', 'inferBeforePrepare', 'regain-prepare-minutes-null', together('07:55:00'), 25, null);
  add('plan-core', 'inferBeforePrepare', 'regain-half-minute-4.5', together('07:55:30'), 25, 50);
  add('plan-core', 'inferBeforePrepare', 'regain-half-minute-5.5', together('07:54:30'), 25, 50);
  add('plan-core', 'inferBeforePrepare', 'regain-wake-after-auto', together('08:05:00'), 25, 50);
  add('plan-core', 'inferBeforePrepare', 'regain-exactly-zero-left', together('07:55:00'), 5, 50);
  add('plan-core', 'inferBeforePrepare', 'regain-gap-rounds-half', [alarmRow('WAKE', wakeAt('07:00:00')), alarmRow('PREPARE', wakeAt('07:20:30'))]);
  add('plan-core', 'inferBeforePrepare', 'regain-gap-rounds-half-adv', [alarmRow('WAKE', wakeAt('07:00:00')), alarmRow('PREPARE', wakeAt('07:20:30'))], 10);
  add('plan-core', 'inferBeforePrepare', 'gap210-adv30-is-240', wakePrep(210), 30);
  add('plan-core', 'inferBeforePrepare', 'gap211-adv30-is-241', wakePrep(211), 30);
  add('plan-core', 'inferBeforePrepare', 'gap239-adv1-is-240', wakePrep(239), 1);
  add('plan-core', 'inferBeforePrepare', 'manual-prepare', [alarmRow('WAKE', d('2026-11-16T07:00:00+09:00')), alarmRow('PREPARE', d('2026-11-16T07:20:00+09:00'), { time_source: 'MANUAL' })]);
  add('plan-core', 'inferBeforePrepare', 'no-wake', [alarmRow('PREPARE', d('2026-11-16T07:20:00+09:00'))]);
  add('plan-core', 'inferBeforePrepare', 'empty', []);
  for (const imp of IMPORTANCES) {
    for (const late of [0, 2]) {
      for (const [name, overrides] of [['auto', {}], ['manual', { sound: 0, vibration: 2 }]] as const) {
        for (const wake of [undefined, 'HEAVY']) add('plan-core', 'intensityReasonOf', `${imp}-late${late}-${name}-${wake}`, imp, late, overrides, wake);
      }
    }
  }
}

function commit(add: Add) {
  const now = d('2026-11-16T07:00:00+09:00');
  for (const checked of [true, false]) {
    for (const [name, old] of [
      ['no-old', undefined],
      ['old-on-future', { is_enabled: true, scheduled_at: iso(after(now, 60)) }],
      ['old-off-future', { is_enabled: false, scheduled_at: iso(after(now, 60)) }],
      ['old-off-past', { is_enabled: false, scheduled_at: iso(after(now, -60)) }],
      ['old-off-grace-edge', { is_enabled: false, scheduled_at: iso(after(now, 5)) }],
      ['old-off-grace-edge-minus1ms', { is_enabled: false, scheduled_at: new Date(after(now, 5).getTime() - 1).toISOString() }],
      ['old-on-past', { is_enabled: true, scheduled_at: iso(after(now, -60)) }],
    ] as const) {
      for (const requested of [undefined, true, false]) add('commit-core', 'resolveEnabled', `${checked}-${name}-${requested}`, { checkedEnabled: checked, ...(old ? { old } : {}), ...(requested === undefined ? {} : { requested }), now });
    }
  }
  const alarms = [{ alarm_id: 'a1', alarm_type: 'WAKE' }, { alarm_id: 'a2', alarm_type: 'PREPARE' }, { alarm_id: 'a3', alarm_type: 'DEPARTURE' }];
  const edits = [
    { screen: 'H05', field: 'time', alarmType: 'WAKE', autoValue: '2026-11-16T07:00:00.000Z', editedValue: '2026-11-16T06:30:00.000Z' },
    { screen: 'H03', field: 'transport', autoValue: 'TRANSIT', editedValue: 'WALK' },
    { screen: 'S01', field: 'x', alarmType: 'ARRIVE', editedValue: 5 },
    { screen: 'H05', field: 'time', alarmType: 'PREPARE', autoValue: null, editedValue: null },
    { screen: 'H05', field: 'time', alarmType: 'ROUTINE', autoValue: { nested: [1, 2] }, editedValue: false },
    { screen: 'H03', field: 'zero', autoValue: 0, editedValue: '' },
  ];
  add('commit-core', 'buildEditLogRows', 'all', 'u1', 'appt-1', alarms, edits);
  add('commit-core', 'buildEditLogRows', 'no-appointment', 'u1', null, alarms, edits.slice(0, 2));
  add('commit-core', 'buildEditLogRows', 'no-edits', 'u1', 'appt-1', alarms, []);
  add('commit-core', 'buildEditLogRows', 'no-alarms', 'u1', 'appt-1', [], edits);
}

function ring(add: Add) {
  const seoul = 'Asia/Seoul';
  const t = d('2026-11-16T08:05:00+09:00');
  for (const place of [null, undefined, '', '세종대학교 광개토관']) for (const zone of [seoul, 'UTC', 'America/New_York']) add('ring-package', 'subtitleFor', `${place === undefined ? 'undef' : place === null ? 'null' : place || 'empty'}-${zone}`, t, place, zone);
  for (const minutes of [-10, 0, 0.4, 0.5, 1, 59, 60, 61, 90, 119.5, 120, 1500]) {
    add('ring-package', 'prepareNotice', `m${minutes}`, { prepareAt: t, departAt: after(t, minutes), timeZone: seoul });
  }
  add('ring-package', 'prepareNotice', 'seconds', { prepareAt: t, departAt: new Date(t.getTime() + 89_000), timeZone: seoul });
  add('ring-package', 'prepareNotice', 'zone-utc', { prepareAt: t, departAt: after(t, 45), timeZone: 'UTC' });
  const appt = d('2026-11-16T10:00:00+09:00');
  for (const slack of [-75, -61, -60, -1, -0.5, 0, 0.5, 1, 10, 59, 60, 61, 125, 600]) {
    add('ring-package', 'departureNotice', `slack${slack}`, { departAt: after(appt, -30 - slack), appointmentAt: appt, travelMinutes: 30, timeZone: seoul });
  }
  for (const travel of [0, 12.5, 90, Number.NaN, Infinity]) add('ring-package', 'departureNotice', `travel${String(travel)}`, { departAt: after(appt, -60), appointmentAt: appt, travelMinutes: travel, timeZone: seoul });
  const src = (over: Record<string, unknown> = {}) => ({ sound_key: null, vibration: null, voice_tone: null, intensity: 'NORMAL', ...over });
  for (const [name, row] of [['empty', src()], ['soft', src({ intensity: 'SOFT' })], ['strong', src({ intensity: 'STRONG' })], ['custom', src({ sound_key: 'custom', vibration: 'NONE', voice_tone: 'DIRECT', intensity: 'STRONG' })], ['blank-sound', src({ sound_key: '  ', intensity: 'STRONG' })], ['unknown-vibration', src({ vibration: 'x', intensity: 'SOFT' })], ['undefined-fields', { intensity: 'NORMAL' }]] as const) {
    for (const enabled of [undefined, true, false]) add('ring-package', 'axesOf', `${name}-${enabled}`, row, ...(enabled === undefined ? [] : [enabled]));
  }
  // 말소리 시작 단계 값 — 직접 고른 값 · 빈 칸 · 모르는 값 · 축별 선택 끔
  for (const [name, row] of [['calm', { voice_tone: 'CALM', intensity: 'STRONG' }], ['direct', { voice_tone: 'DIRECT', intensity: 'SOFT' }], ['null-soft', { voice_tone: null, intensity: 'SOFT' }], ['missing-strong', { intensity: 'STRONG' }], ['unknown', { voice_tone: 'x', intensity: 'NORMAL' }], ['bad-intensity', { voice_tone: null, intensity: 'x' }]] as const) {
    for (const enabled of [undefined, false]) add('ring-package', 'voiceToneOf', `${name}-${enabled}`, row, ...(enabled === undefined ? [] : [enabled]));
  }
  const titles: [string, string][] = [['수업', 'batchim-ㅂ'], ['회의', 'no-batchim'], ['시험(2차)', 'bracket-after-batchim'], ['회의(오전)', 'bracket-after-no-batchim'], ['스터디 3', 'digit-3'], ['스터디 2', 'digit-2'], ['스터디 0', 'digit-0'], ['A1', 'digit-1'], ['반6', 'digit-6'], ['반7', 'digit-7'], ['반8', 'digit-8'], ['반9', 'digit-9'], ['  ', 'blank'], ['', 'empty'], ['(점심)', 'only-bracket'], ['수업[ (A) ]', 'nested-brackets'], ['（회의）', 'fullwidth-bracket'], ['점심 약속 ', 'trailing-space'], ['Study', 'latin'], ['한글ABC', 'latin-after-hangul'], ['수업 (1) (2)', 'two-brackets'], ['수업()', 'empty-brackets'], ['(수업', 'unclosed'], ['😀', 'emoji']];
  for (const [title, name] of titles) {
    for (const tone of ['NEUTRAL', 'CALM', 'DIRECT']) add('ring-package', 'wakeVoiceText', `${name}-${tone}`, { title, appointmentAt: appt, departAt: d('2026-11-16T09:20:00+09:00'), timeZone: seoul, voiceTone: tone });
  }
  for (const tone of [null, undefined, 'x']) add('ring-package', 'wakeVoiceText', `tone-${tone}`, { title: '수업', appointmentAt: appt, timeZone: seoul, voiceTone: tone });
  for (const [name, at] of [['noon', '2026-11-16T12:00:00+09:00'], ['midnight', '2026-11-16T00:05:00+09:00'], ['half', '2026-11-16T15:30:00+09:00'], ['eleven-pm', '2026-11-16T23:59:00+09:00']] as const) {
    add('ring-package', 'wakeVoiceText', `time-${name}`, { title: '수업', appointmentAt: d(at), departAt: d(at), timeZone: seoul, voiceTone: 'NEUTRAL' });
  }
  const wake = d('2026-11-16T07:40:00+09:00');
  const rows = (over: Record<string, Record<string, unknown>> = {}) => [
    { alarm_id: 'a4', alarm_type: 'ARRIVE', scheduled_at: iso(d('2026-11-16T09:50:00+09:00')), intensity: 'NORMAL', sound_key: null, vibration: null, voice_tone: null, snooze_limit: 2, is_enabled: true, ...over.ARRIVE },
    { alarm_id: 'a3', alarm_type: 'DEPARTURE', scheduled_at: iso(d('2026-11-16T09:20:00+09:00')), intensity: 'STRONG', sound_key: 'theme_urgent', vibration: 'STRONG_CONTINUOUS', voice_tone: 'DIRECT', snooze_limit: 3, is_enabled: true, ...over.DEPARTURE },
    { alarm_id: 'a2', alarm_type: 'PREPARE', scheduled_at: iso(after(wake, 20)), intensity: 'NORMAL', sound_key: 'theme_default', vibration: null, voice_tone: 'NEUTRAL', snooze_limit: 3, is_enabled: true, ...over.PREPARE },
    { alarm_id: 'a1', alarm_type: 'WAKE', scheduled_at: iso(wake), intensity: 'SOFT', sound_key: 'theme_calm', vibration: 'NONE', voice_tone: 'CALM', snooze_limit: 5, is_enabled: true, ...over.WAKE },
  ];
  const noticeFor = { appointmentAt: appt, travelMinutes: 30, timeZone: seoul };
  add('ring-package', 'buildRingPackages', 'basic-no-appointment', { alarms: rows(), title: '수업' });
  add('ring-package', 'buildRingPackages', 'with-subtitle-and-depart', { alarms: rows(), title: '수업', subtitle: '오전 10:00 · 세종대', departAt: d('2026-11-16T09:20:00+09:00') });
  add('ring-package', 'buildRingPackages', 'with-appointment', { alarms: rows(), title: '수업', subtitle: '오전 10:00', appointment: noticeFor });
  add('ring-package', 'buildRingPackages', 'appointment-no-travel', { alarms: rows(), title: '수업', appointment: { appointmentAt: appt, timeZone: seoul } });
  add('ring-package', 'buildRingPackages', 'appointment-null-travel', { alarms: rows(), title: '수업', appointment: { ...noticeFor, travelMinutes: null } });
  add('ring-package', 'buildRingPackages', 'appointment-nan-travel', { alarms: rows(), title: '수업', appointment: { ...noticeFor, travelMinutes: Number.NaN } });
  add('ring-package', 'buildRingPackages', 'departure-disabled', { alarms: rows({ DEPARTURE: { is_enabled: false } }), title: '수업', appointment: noticeFor });
  add('ring-package', 'buildRingPackages', 'all-disabled', { alarms: rows({ WAKE: { is_enabled: false }, PREPARE: { is_enabled: false }, DEPARTURE: { is_enabled: false }, ARRIVE: { is_enabled: false } }), title: '수업', appointment: noticeFor });
  add('ring-package', 'buildRingPackages', 'empty', { alarms: [], title: '수업' });
  add('ring-package', 'buildRingPackages', 'same-time-tie-keeps-input-order', { alarms: [rows()[1], { ...rows()[2], alarm_id: 'z', scheduled_at: rows()[1].scheduled_at }], title: '수업' });
  add('ring-package', 'buildRingPackages', 'empty-title-wake-voice', { alarms: rows(), title: '   ', appointment: noticeFor });
  add('ring-package', 'buildRingPackages', 'prepare-after-departure', { alarms: rows({ PREPARE: { scheduled_at: iso(d('2026-11-16T09:30:00+09:00')) } }), title: '수업', appointment: noticeFor });
  add('ring-package', 'buildRingPackages', 'routine-and-arrive-types', { alarms: [...rows(), { alarm_id: 'r', alarm_type: 'ROUTINE', scheduled_at: iso(d('2026-11-16T06:00:00+09:00')), intensity: 'SOFT', sound_key: null, vibration: null, voice_tone: null, snooze_limit: 1, is_enabled: true }], title: '수업', appointment: noticeFor });
  add('ring-package', 'buildRingPackages', 'voice-tone-missing', { alarms: rows({ WAKE: { voice_tone: undefined, vibration: undefined } }), title: '수업', appointment: noticeFor });
  add('ring-package', 'buildRingPackages', 'timezone-utc', { alarms: rows(), title: '수업', appointment: { ...noticeFor, timeZone: 'UTC' } });
  add('ring-package', 'buildRingPackages', 'bad-time-zone-text-skipped', { alarms: rows(), title: '수업', appointment: { ...noticeFor, timeZone: 'Not/AZone' } });
  add('ring-package', 'canceledAlarmIds', 'some-disabled', { before: [{ alarm_id: 'a' }, { alarm_id: 'b' }, { alarm_id: 'c' }], after: [{ alarm_id: 'a', is_enabled: true }, { alarm_id: 'b', is_enabled: false }] });
  add('ring-package', 'canceledAlarmIds', 'nothing-before', { before: [], after: [{ alarm_id: 'a', is_enabled: true }] });
  add('ring-package', 'canceledAlarmIds', 'new-ones-not-canceled', { before: [{ alarm_id: 'a' }], after: [{ alarm_id: 'a', is_enabled: true }, { alarm_id: 'n', is_enabled: false }] });
  add('ring-package', 'canceledAlarmIds', 'all-removed', { before: [{ alarm_id: 'a' }, { alarm_id: 'b' }], after: [] });
}

export function planScenarios(add: Add) {
  plans(add);
  planHelpers(add);
  commit(add);
  ring(add);
}
