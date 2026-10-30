// 계획 합치기 — 앱 목업(estimateAppointment → alarmChain)과 같은 결과가 나오는지, 저장된 값을 어떻게 이어받는지
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prepareSourceLabel } from './calc/index.ts';
import { clampPrepareToBound, computePlan, firstPrepareMinutes, inferBeforePrepare, resolveBasics, toSuggestion, type AlarmRow, type AppointmentRow, type ParticipantRow, type PlanInputs, type ProfileRow } from './plan-core.ts';
import type { ResolvedTravel } from './route.ts';

const kst = (day: number, minutes: number) => new Date(Date.UTC(2025, 4, day) + (minutes - 9 * 60) * 60_000);
const hm = (iso: string | null) => {
  const d = new Date(iso as string);
  const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + 9 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

const profile: ProfileRow = {
  timezone: 'Asia/Seoul',
  default_buffer_minutes: 10,
  default_transport: 'TRANSIT',
  home_name: '우리 집',
  home_lat: 37.5547,
  home_lng: 126.9707,
};
const api = (minutes: number): ResolvedTravel => {
  const choice = { minutes, source: 'API' as const, needsConfirmation: false, note: '길찾기 기준' };
  return { chosen: choice, auto: choice, warnings: [] };
};
const NOW = kst(22, 7 * 60 + 55); // 목업 기본 상태: 5월 22일 오전 7:55

// 새 일정: 5월 22일 10시 팀 주간회의 (목업 a1 — 이동 50분 · 여유 10분)
const base = (over: Partial<PlanInputs> = {}): PlanInputs => ({
  now: kst(22, 400),
  draft: { at: kst(22, 600), destination: { name: '세종대학교', lat: 37.55, lng: 127.07 } },
  profile,
  existingAlarms: [],
  // 목업 estimate: n 10 · 공통 50 · 개인 오차 P80 20 → 보정 10 → 예측 60. 기록은 이미 기상~출발이라 P80 70 그대로 (예전에는 40 + 준비 전 활동을 또 더하는 계산이었음 — 학습 루프 기초 2절 1)
  stats: { sampleCount: 10, p80: 70 },
  lateCount4w: 1,
  sameDayWake: false,
  ...over,
});
const text = (plan: ReturnType<typeof computePlan>) => plan.chain.map((x) => `${x.kind} ${hm(x.at.toISOString())}${x.auto ? '*' : ''}`);

test('목업 a1과 같은 숫자: 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50, 준비 60 = 공통 50 + 보정 10', () => {
  const plan = computePlan(base({ draft: { at: kst(22, 600), destination: { name: '세종대학교' }, beforePrepareMinutes: 30 } }), api(50));
  assert.deepEqual(text(plan), ['WAKE 08:00', 'PREPARE 08:30', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  assert.deepEqual([plan.prepare.commonP80, plan.prepare.correction, plan.prepare.minutes], [50, 10, 60]);
  assert.equal(plan.intensity.fields.intensity, 'NORMAL'); // NORMAL 일정 + 늦잠 1회 → 중
  assert.ok(plan.check.ok);
});

test('기록이 없는 사용자는 공통 P80 그대로 (50분) + 기본 준비 전 활동 20분', () => {
  const plan = computePlan(base({ stats: { sampleCount: 0, p80: null } }), api(50));
  assert.equal(plan.prepare.minutes, 50);
  assert.equal(plan.prepare.source, 'DEFAULT');
  assert.equal(plan.beforePrepareMinutes, 20);
  assert.deepEqual(text(plan), ['WAKE 08:10', 'PREPARE 08:30', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
});

test('같은 날 앞선 일정에 기상 알람이 있으면 기상 없이 준비부터, 공통 15분 (목업 a2)', () => {
  const plan = computePlan(
    base({ draft: { at: kst(22, 1080), destination: { name: '강남역' }, bufferMinutes: 5 }, sameDayWake: true, stats: { sampleCount: 0, p80: null }, now: kst(22, 600) }),
    api(20),
  );
  assert.equal(plan.withWake, false);
  assert.equal(plan.prepare.minutes, 15);
  assert.deepEqual(text(plan), ['PREPARE 17:20', 'DEPARTURE 17:35', 'ARRIVE 17:55']);
});

test('직접 고른 준비 · 이동 · 시각이 자동보다 먼저 (D42 C)', () => {
  const travel: ResolvedTravel = {
    chosen: { minutes: 70, source: 'MANUAL', needsConfirmation: false, note: '직접 입력' },
    auto: { minutes: 50, source: 'API', needsConfirmation: false, note: '길찾기 기준' },
    warnings: [],
  };
  const plan = computePlan(base({ draft: { at: kst(22, 600), destination: { name: '세종대학교' }, prepareMinutes: 40, beforePrepareMinutes: 10, manualTimes: { PREPARE: kst(22, 500) } } }), travel);
  assert.deepEqual(text(plan), ['WAKE 08:00', 'PREPARE 08:20*', 'DEPARTURE 08:40', 'ARRIVE 09:50']);
  const dto = toSuggestion(plan);
  assert.equal(dto.travel.minutes, 70);
  assert.equal(dto.travel.auto_minutes, 50);
  assert.equal(dto.prepare.source, 'MANUAL');
  assert.equal(dto.prepare.auto_minutes, 60); // 내 기록 P80 70(이미 기상~출발) → 공통 50 + 보정 10. 예전 식은 준비 전 활동을 또 더했음
});

test('고른 종류만 · 알람 없는 일정', () => {
  const some = computePlan(base({ draft: { at: kst(22, 600), destination: { name: 'x' }, kinds: ['WAKE'] } }), api(50));
  assert.deepEqual(some.chain.map((x) => x.kind), ['WAKE', 'ARRIVE']);
  assert.equal(some.fullChain.length, 4); // 미리 보기용 전체는 그대로
  const none = computePlan(base({ draft: { at: kst(22, 600), destination: { name: 'x' }, kinds: [] } }), api(50));
  assert.deepEqual(none.chain, []);
  assert.deepEqual(none.check, { ok: true, alarms: [] });
});

test('지난 기상은 끄고 저장 + 경고, 출발까지 지나면 막힘 (8.2.1)', () => {
  const late = computePlan(base({ now: kst(22, 490) }), api(50)); // 기상 < 8:10 + 5분 (이 입력의 예측 준비는 60분이라 기상 8:00)
  assert.ok(late.check.ok);
  assert.equal(late.check.ok && late.check.alarms[0].enabled, false);
  assert.deepEqual(late.warnings.map((w) => [w.code, w.detail]), [['PAST_ALARM_DISABLED', 'WAKE']]);
  const dto = toSuggestion(late);
  assert.equal(dto.alarms[0].disabled_reason, 'PASSED');
  assert.equal(dto.alarms[0].is_enabled, false);

  // 경고 문구: 저장한 뒤(alarm-commit)는 "끄고 저장했어요", 미리 보기(alarm-suggest)는 아직 저장하지 않았으니 "저장할 때 꺼져요"
  assert.equal(late.warnings[0].message, '이미 지난 알림은 끄고 저장했어요');
  const preview = computePlan(base({ now: kst(22, 490) }), api(50), 'preview');
  assert.deepEqual(preview.warnings.map((w) => [w.code, w.detail, w.message]), [['PAST_ALARM_DISABLED', 'WAKE', '이미 지난 알림은 저장할 때 꺼져요']]);
  assert.equal(computePlan(base({ now: kst(22, 490) }), api(50), 'save').warnings[0].message, late.warnings[0].message);

  const gone = computePlan(base({ now: kst(22, 545) }), api(50));
  assert.equal(gone.check.ok, false);
  assert.equal(!gone.check.ok && gone.check.reason, 'DEPARTURE_PASSED');
});

// ---- 이미 저장된 값 이어받기 ----

const appointment: AppointmentRow = {
  appointment_id: 'ap1', creator_id: 'u1', group_id: null, title: '팀 주간회의',
  appointment_at: kst(22, 600).toISOString(), dest_name: '세종대학교', dest_lat: 37.55, dest_lng: 127.07, importance: 'NORMAL', recurrence_rule: null,
};
const participant: ParticipantRow = {
  participant_id: 'pt1', appointment_id: 'ap1', user_id: 'u1', origin_name: '학교', origin_lat: 37.5, origin_lng: 127.0,
  transport_type: 'CAR', est_travel_minutes: 30, travel_source: 'API', prepare_minutes: 60, buffer_minutes: 5,
};
const row = (type: AlarmRow['alarm_type'], minutes: number, over: Partial<AlarmRow> = {}): AlarmRow => ({
  alarm_id: `al-${type}`, participant_id: 'pt1', user_id: 'u1', alarm_type: type, scheduled_at: kst(22, minutes).toISOString(),
  intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', is_enabled: true, snooze_limit: 3,
  time_source: 'AUTO', intensity_source: 'AUTO', recurrence_rule: null, ...over,
});

test('기존 약속은 DB의 시각 · 장소 · 중요도를 씀 (D41: 요청 값은 무시) · 출발지 · 수단 · 여유는 저장된 값', () => {
  const b = resolveBasics({ draft: { at: kst(25, 0), destination: { name: '딴 곳' }, importance: 'LOW', appointmentId: 'ap1' }, profile, appointment, participant });
  assert.equal(b.at.getTime(), kst(22, 600).getTime());
  assert.deepEqual(b.destination, { name: '세종대학교', lat: 37.55, lng: 127.07 });
  assert.equal(b.importance, 'NORMAL');
  assert.deepEqual(b.origin, { name: '학교', lat: 37.5, lng: 127 });
  assert.equal(b.transport, 'CAR');
  assert.equal(b.bufferMinutes, 5);
});

test('저장된 값이 없으면 프로필 기본값 (집 · 기본 이동 수단 · 기본 여유)', () => {
  const b = resolveBasics({ draft: { at: kst(22, 600), destination: { name: 'x' } }, profile });
  assert.deepEqual(b.origin, { name: '우리 집', lat: 37.5547, lng: 126.9707 });
  assert.equal(b.transport, 'TRANSIT');
  assert.equal(b.bufferMinutes, 10);
  assert.equal(b.importance, 'NORMAL');
});

test('출발지 이름만 오면 같은 이름의 집 · 저장된 출발지 좌표를 씀 (목업의 "집")', () => {
  assert.deepEqual(resolveBasics({ draft: { at: kst(22, 600), destination: { name: 'x' }, origin: { name: '집' } }, profile }).origin, { name: '집', lat: 37.5547, lng: 126.9707 });
  assert.deepEqual(resolveBasics({ draft: { at: kst(22, 600), destination: { name: 'x' }, origin: { name: '강남역' } }, profile }).origin, { name: '강남역' });
  assert.deepEqual(
    resolveBasics({ draft: { appointmentId: 'ap1', origin: { name: '학교' } }, profile, appointment, participant }).origin,
    { name: '학교', lat: 37.5, lng: 127 },
  );
});

test('칸이 없으면 저장된 직접 시각을 그대로, 칸이 있으면 그 칸이 전부 (null = 자동으로 되돌림)', () => {
  const alarms = [row('WAKE', 450, { time_source: 'MANUAL' }), row('PREPARE', 480), row('DEPARTURE', 540), row('ARRIVE', 590)];
  const keep = computePlan(base({ draft: { appointmentId: 'ap1' }, appointment, participant, existingAlarms: alarms, stats: { sampleCount: 0, p80: null } }), api(30));
  assert.equal(keep.manualTimes.WAKE?.getTime(), kst(22, 450).getTime());
  const reset = computePlan(
    base({ draft: { appointmentId: 'ap1', manualTimes: { WAKE: null } }, appointment, participant, existingAlarms: alarms, stats: { sampleCount: 0, p80: null } }),
    api(30),
  );
  assert.deepEqual(reset.manualTimes, {});
});

test('부분 알람 일정(기상만)을 다시 저장해도 종류가 늘지 않음, 알람 없는 일정은 계산된 전부', () => {
  const plan = computePlan(base({ draft: { appointmentId: 'ap1' }, appointment, participant, existingAlarms: [row('WAKE', 450), row('ARRIVE', 590)] }), api(30));
  assert.deepEqual(plan.chain.map((x) => x.kind), ['WAKE', 'ARRIVE']);
  const fresh = computePlan(base({ draft: { appointmentId: 'ap1' }, appointment, participant, existingAlarms: [] }), api(30));
  assert.deepEqual(fresh.chain.map((x) => x.kind), ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE']);
});

test('저장된 직접 강도는 유지, 자동과 같은 값이면 자동으로 (자동 값이 바뀌면 같이 바뀜)', () => {
  // 중요도 NORMAL · 늦잠 1회 → 자동 중(1). 저장: 배경음 약(0) 직접, 말소리 중(= 자동), 진동 강(2) 직접
  const stored = row('WAKE', 480, { intensity: 'STRONG', voice_tone: 'NEUTRAL', sound_key: 'theme_calm', intensity_source: 'MANUAL' });
  const keep = computePlan(base({ draft: { appointmentId: 'ap1' }, appointment, participant, existingAlarms: [stored] }), api(30));
  assert.deepEqual(keep.intensity.axes, { sound: { level: 0, manual: true }, voice: { level: 1, manual: false }, vibration: { level: 2, manual: true } });
  // 요청이 levels를 주면 그 칸이 전부 — null은 자동으로 되돌림
  const reset = computePlan(base({ draft: { appointmentId: 'ap1', levels: { sound: null, voice: null, vibration: null } }, appointment, participant, existingAlarms: [stored] }), api(30));
  assert.equal(reset.intensity.manual, false);
  // 자동으로 저장된 강도는 늦잠 횟수가 바뀌면 같이 바뀜
  const autoStored = row('WAKE', 480);
  assert.equal(computePlan(base({ draft: { appointmentId: 'ap1' }, appointment, participant, existingAlarms: [autoStored], lateCount4w: 3 }), api(30)).intensity.fields.intensity, 'STRONG');
});

test('준비가 자동이면 준비 − 기상 간격을 준비 전 활동으로 이어받음 (기상을 직접 옮겼어도), 준비가 직접이면 읽지 않음', () => {
  assert.equal(inferBeforePrepare([row('WAKE', 450), row('PREPARE', 480)]), 30);
  assert.equal(inferBeforePrepare([row('WAKE', 450, { time_source: 'MANUAL' }), row('PREPARE', 480)]), 30); // 기상을 옮기면 자동 준비가 같은 간격으로 따라옴
  assert.equal(inferBeforePrepare([row('WAKE', 450), row('PREPARE', 480, { time_source: 'MANUAL' })]), undefined);
  assert.equal(inferBeforePrepare([row('WAKE', 450, { time_source: 'MANUAL' }), row('PREPARE', 480, { time_source: 'MANUAL' })]), undefined);
  assert.equal(inferBeforePrepare([row('WAKE', 450)]), undefined);
  const plan = computePlan(base({ draft: { appointmentId: 'ap1' }, appointment, participant, existingAlarms: [row('WAKE', 450), row('PREPARE', 480)] }), api(30));
  assert.equal(plan.beforePrepareMinutes, 30);
});

test('기상을 직접 옮긴 약속을 다시 저장해도 준비 알람 간격은 20분으로 돌아가지 않고 준비 전 활동(30분) 그대로', () => {
  // 자동 기상 8:00이던 걸 7:30으로 옮김 → 자동 준비는 7:30 + 30 = 8:00. 요청에 칸이 없으면 저장된 직접 기상 시각 · 준비 전 활동을 둘 다 이어받음
  const stored = [row('WAKE', 450, { time_source: 'MANUAL' }), row('PREPARE', 480), row('DEPARTURE', 540), row('ARRIVE', 590)];
  const plan = computePlan(base({ draft: { appointmentId: 'ap1' }, appointment, participant, existingAlarms: stored, stats: { sampleCount: 0, p80: null } }), api(30));
  assert.equal(plan.beforePrepareMinutes, 30);
  assert.deepEqual(text(plan), ['WAKE 07:30*', 'PREPARE 08:00', 'DEPARTURE 09:25', 'ARRIVE 09:55']);
});

test('응답 모양: 5.4.1 AlarmSuggestionDTO 칸', () => {
  const dto = toSuggestion(computePlan(base(), api(50)));
  assert.deepEqual(Object.keys(dto), [
    'appointment_at', 'wake_at', 'prepare_at', 'departure_at', 'arrive_at', 'alarms', 'check', 'travel', 'prepare', 'intensity', 'with_wake', 'same_day_wake', 'confidence', 'warnings',
  ]);
  assert.equal(dto.intensity.level, 'NORMAL');
  assert.equal(dto.intensity.reason, '중요 일정 → 중');
  assert.deepEqual(dto.alarms.map((a) => a.alarm_type), ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE']);
  assert.equal(dto.confidence, 'MEDIUM');
});

test('늦잠 지각이 2회 이상이면 이유 문구에 나옴', () => {
  const dto = toSuggestion(computePlan(base({ lateCount4w: 3 }), api(50)));
  assert.equal(dto.intensity.level, 'STRONG');
  assert.equal(dto.intensity.reason, '중요 일정 + 최근 4주 늦잠 지각 3회 → 강');
});

// ---- 학습 루프 기초 a (이슈 #266) — 5절 시험 표 ----

test('[5절] 기록 0건 · 온보딩 70분: 기상~출발 70분, 출처 첫 값(DEFAULT), "배우는 중 0/5"', () => {
  const onboarded = { ...profile, default_prepare_minutes: 70 };
  const plan = computePlan(base({ profile: onboarded, stats: { sampleCount: 0, p80: null } }), api(50));
  assert.deepEqual([plan.prepare.minutes, plan.prepare.source, plan.prepare.commonP80, plan.prepare.sampleCount], [70, 'DEFAULT', 70, 0]);
  assert.equal(prepareSourceLabel(plan.prepare.sampleCount), '배우는 중 0/5');
  assert.equal(toSuggestion(plan).prepare.common_p80, 70); // 앱이 받는 "공통(첫 값)"도 70
  // 기상 = 약속 10:00 − 여유 10 − 이동 50 − 준비 70 = 7:50 (온보딩을 안 읽던 때는 50분 기준이라 8:10)
  assert.equal(text(plan)[0], 'WAKE 07:50');
});

test('온보딩 값이 없거나 범위 밖이면 50 (프로필 없음 · null · 5분 · 400분)', () => {
  assert.equal(firstPrepareMinutes({}), 50);
  assert.equal(firstPrepareMinutes({ default_prepare_minutes: null }), 50);
  assert.equal(firstPrepareMinutes({ default_prepare_minutes: 4 }), 50);
  assert.equal(firstPrepareMinutes({ default_prepare_minutes: 5 }), 5);
  assert.equal(firstPrepareMinutes({ default_prepare_minutes: 400 }), 50);
  assert.equal(firstPrepareMinutes({ default_prepare_minutes: 10 }), 10);
  assert.equal(firstPrepareMinutes({ default_prepare_minutes: 300 }), 300);
});

test('[5절] 그날 두 번째 일정(기상 없음): 준비 15분 그대로 — 기록이 0건이든 30건이든 같음, 온보딩 값과도 무관', () => {
  const second = (stats: PlanInputs['stats']) =>
    computePlan(
      base({ draft: { at: kst(22, 1080), destination: { name: '강남역' }, bufferMinutes: 5 }, sameDayWake: true, profile: { ...profile, default_prepare_minutes: 90 }, stats, now: kst(22, 600) }),
      api(20),
    );
  for (const stats of [{ sampleCount: 0, p80: null }, { sampleCount: 5, p80: 60 }, { sampleCount: 30, p80: 120 }]) {
    const plan = second(stats);
    assert.deepEqual([plan.withWake, plan.prepare.minutes, plan.prepare.correction, plan.prepare.source], [false, 15, 0, 'DEFAULT'], `기록 ${stats.sampleCount}건`);
  }
  // 요청에서 기상을 빼도(withWake false) 같음 — 기록 수와 상관없음
  const asked = computePlan(base({ draft: { at: kst(22, 1080), destination: { name: '강남역' }, withWake: false }, sameDayWake: false, stats: { sampleCount: 30, p80: 120 } }), api(20));
  assert.equal(asked.prepare.minutes, 15);
  // 반대로 첫 일정(기상 있음)은 같은 기록으로 보정됨
  const first = computePlan(base({ stats: { sampleCount: 30, p80: 120 } }), api(50));
  assert.ok(first.prepare.minutes > 50);
});

test('[5절] 20분 중복 없음: 기록 60분 · n=10이면 기상~출발 = 공통 50 + 보정 5 = 55 (준비 전 활동이 얼마든 안 변함)', () => {
  for (const beforePrepareMinutes of [0, 10, 20, 30]) {
    const plan = computePlan(base({ draft: { at: kst(22, 600), destination: { name: 'x' }, beforePrepareMinutes }, stats: { sampleCount: 10, p80: 60 } }), api(50));
    assert.deepEqual([plan.prepare.correction, plan.prepare.minutes], [5, 55], `준비 전 활동 ${beforePrepareMinutes}분`);
  }
  // 예전 식(+20분)이었다면 개인 P80이 80이 되어 보정 15 · 65분이었음
  const plan = computePlan(base({ stats: { sampleCount: 10, p80: 60 } }), api(50));
  assert.notEqual(plan.prepare.minutes, 65);
});

test('[5절] 기록이 쌓이면 출처 문구가 바뀜: 4건까지 배우는 중, 5건부터 내 기록 기반 (출처 DEFAULT → PERSONAL)', () => {
  const at = (n: number) => computePlan(base({ stats: { sampleCount: n, p80: n ? 80 : null } }), api(50)).prepare;
  assert.deepEqual([4, 5].map((n) => [at(n).source, prepareSourceLabel(at(n).sampleCount)]), [['DEFAULT', '배우는 중 4/5'], ['PERSONAL', '내 기록 기반 5건']]);
});

test('clampPrepareToBound: 자동 값만 기준 ±범위로, 직접 고른 값(MANUAL)과 범위 안 값은 그대로, 보정 칸은 합이 맞게', () => {
  const auto = (minutes: number) => ({ minutes, autoMinutes: minutes, commonP80: 50, correction: minutes - 50, sampleCount: 30, prior: 10, weight: 0.75, residualP80: 70, source: 'PERSONAL' as const, confidence: 'HIGH' as const });
  const bound = { around: 70, within: 10 };
  const up = clampPrepareToBound(auto(103), bound);
  assert.deepEqual([up.minutes, up.autoMinutes, up.correction], [80, 80, 30]);
  assert.equal(clampPrepareToBound(auto(30), bound).minutes, 60);
  assert.equal(clampPrepareToBound(auto(80), bound).minutes, 80); // 경계 포함
  const inside = auto(75);
  assert.equal(clampPrepareToBound(inside, bound), inside);
  const manual = { ...auto(200), source: 'MANUAL' as const };
  assert.equal(clampPrepareToBound(manual, bound).minutes, 200);
});

test('computePlan의 prepareBound: 직접 고른 준비시간은 안 자름, 기상 없는 일정(15분)에는 걸지 않음', () => {
  const big = { sampleCount: 30, p80: 150 }; // 자동 예측 약 105
  const auto = computePlan(base({ stats: big, prepareBound: { around: 60, within: 10 } }), api(50));
  assert.deepEqual([auto.prepare.minutes, auto.prepare.autoMinutes], [70, 70]);
  const manual = computePlan(base({ stats: big, prepareBound: { around: 60, within: 10 }, draft: { at: kst(22, 600), destination: { name: 'x' }, prepareMinutes: 120 } }), api(50));
  assert.deepEqual([manual.prepare.minutes, manual.prepare.source], [120, 'MANUAL']);
  const second = computePlan(base({ stats: big, sameDayWake: true, prepareBound: { around: 60, within: 10 } }), api(50));
  assert.equal(second.prepare.minutes, 15);
});

// D69: 기본 보통 — 중요도 낮음(앱 라벨 '보통')이어도 약이 아니고, 매우 중요(HIGH)만 한 단계 올림
test('강도 이유: 중요도 낮음은 보통(중), 매우 중요는 한 단계 올려 강 — 약이라는 문구는 안 나옴', () => {
  const draft = { at: kst(22, 600), destination: { name: '세종대학교', lat: 37.55, lng: 127.07 } };
  const low = toSuggestion(computePlan(base({ draft: { ...draft, importance: 'LOW' }, lateCount4w: 0 }), api(50)));
  assert.equal(low.intensity.level, 'NORMAL');
  assert.equal(low.intensity.reason, '보통 일정 → 중');
  assert.deepEqual([low.intensity.auto_level, low.intensity.importance_point, low.intensity.late_point], [1, 0, 0]);

  const high = toSuggestion(computePlan(base({ draft: { ...draft, importance: 'HIGH' }, lateCount4w: 0 }), api(50)));
  assert.equal(high.intensity.level, 'STRONG');
  assert.equal(high.intensity.reason, '매우 중요 일정 (한 단계 올림) → 강');
  assert.deepEqual([high.intensity.auto_level, high.intensity.importance_point], [2, 1]);

  const lowLate = toSuggestion(computePlan(base({ draft: { ...draft, importance: 'LOW' }, lateCount4w: 2 }), api(50)));
  assert.equal(lowLate.intensity.level, 'STRONG'); // 낮음 + 늦잠 지각 2회 = 보통에서 한 단계 올림
  assert.equal(lowLate.intensity.reason, '보통 일정 + 최근 4주 늦잠 지각 2회 → 강');
});
