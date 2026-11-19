// 계획 합치기 — 앱 목업(estimateAppointment → alarmChain)과 같은 결과가 나오는지, 저장된 값을 어떻게 이어받는지
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prepareSourceLabel, prepareStatsOf } from './calc/index.ts';
import { clampPrepareToBound, computePlan, firstPrepareMinutes, inferBeforePrepare, resolveBasics, resolveOverrides, toSuggestion, type AlarmRow, type AppointmentRow, type ParticipantRow, type PlanInputs, type ProfileRow } from './plan-core.ts';
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

test('C1 예측이 준비시간과 기상 알람 계산에 적용되고 응답에 모델이 표시됨', () => {
  const plan = computePlan(base({
    stats: { sampleCount: 0, p80: null },
    mlPrediction: { model: 'c1_mae', minutes: 80 },
  }), api(50));
  assert.equal(plan.prepare.minutes, 80);
  assert.equal(plan.prepare.autoMinutes, 80);
  assert.equal(plan.prepare.source, 'MODEL');
  assert.equal(plan.prepare.confidence, 'LOW');
  assert.deepEqual(text(plan), ['WAKE 07:40', 'PREPARE 08:00', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  const dto = toSuggestion(plan);
  assert.equal(dto.prepare.model, 'c1_mae');
  assert.equal(dto.prepare.source, 'MODEL');
  assert.equal(dto.prepare.auto_minutes, 80);
});

test('W4 예측이 적용돼도 직접 준비시간은 수동값 우선', () => {
  const mlPrediction = { model: 'w4_mae' as const, minutes: 90 };
  const automatic = computePlan(base({ mlPrediction }), api(50));
  assert.equal(automatic.prepare.minutes, 90);
  assert.equal(automatic.prepare.mlModel, 'w4_mae');
  assert.equal(toSuggestion(automatic).prepare.model, 'w4_mae');
  const manual = computePlan(base({
    mlPrediction,
    draft: { at: kst(22, 600), destination: { name: '세종대학교' }, prepareMinutes: 30 },
  }), api(50));
  assert.equal(manual.prepare.source, 'MANUAL');
  assert.equal(manual.prepare.minutes, 30);
  assert.equal(manual.prepare.mlModel, undefined);
  assert.equal('model' in toSuggestion(manual).prepare, false);
});

test('기상 없는 당일 추가 일정에는 모델 예측을 사용하지 않음', () => {
  const plan = computePlan(base({
    draft: { at: kst(22, 1080), destination: { name: '강남역' }, bufferMinutes: 5 },
    sameDayWake: true,
    mlPrediction: { model: 'w4_mae', minutes: 90 },
  }), api(20));
  assert.equal(plan.withWake, false);
  assert.equal(plan.prepare.minutes, 15);
  assert.notEqual(plan.prepare.source, 'MODEL');
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
  intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', vibration: null, is_enabled: true, snooze_limit: 3,
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
  assert.equal(b.importance, 'LOW'); // 새 일정 기본 중요도는 약(LOW) — 알람 정책 변경
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
  // 중요도 NORMAL · 늦잠 1회 → 자동 중(1). 저장: 배경음 약(0) 직접, 말소리 중(= 자동), 진동 강(2) 직접 (진동은 vibration 칸 — intensity는 전체 세기라 자동 중)
  const stored = row('WAKE', 480, { intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_calm', vibration: 'STRONG_CONTINUOUS', intensity_source: 'MANUAL' });
  const keep = computePlan(base({ draft: { appointmentId: 'ap1' }, appointment, participant, existingAlarms: [stored] }), api(30));
  assert.deepEqual(keep.intensity.axes, { sound: { level: 0, manual: true }, voice: { level: 1, manual: false }, vibration: { level: 2, manual: true } });
  // 요청이 levels를 주면 그 칸이 전부 — null은 자동으로 되돌림
  const reset = computePlan(base({ draft: { appointmentId: 'ap1', levels: { sound: null, voice: null, vibration: null } }, appointment, participant, existingAlarms: [stored] }), api(30));
  assert.equal(reset.intensity.manual, false);
  assert.equal(reset.intensity.fields.vibration, null); // 진동도 "자동으로" → vibration null
  assert.equal(keep.intensity.fields.vibration, 'STRONG_CONTINUOUS');
  assert.equal(keep.intensity.fields.intensity, 'NORMAL'); // 전체 세기는 직접 고른 진동과 상관없이 자동 단계
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
  assert.equal(dto.intensity.reason, '평소 일정 → 중');
  assert.deepEqual(dto.alarms.map((a) => a.alarm_type), ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE']);
  assert.equal(dto.confidence, 'MEDIUM');
});

test('늦잠 지각이 2회 이상이면 이유 문구에 나옴', () => {
  const dto = toSuggestion(computePlan(base({ lateCount4w: 3 }), api(50)));
  assert.equal(dto.intensity.level, 'STRONG');
  assert.equal(dto.intensity.reason, '평소 일정 + 최근 4주 늦잠 지각 3회 → 강');
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

// D69: 기본 보통 — 중요도 낮음(앱 라벨 '평소')이어도 약이 아니고, 매우 중요(HIGH)만 한 단계 올림
test('강도 이유: 중요도 낮음은 보통(중), 매우 중요는 한 단계 올려 강 — 약이라는 문구는 안 나옴', () => {
  const draft = { at: kst(22, 600), destination: { name: '세종대학교', lat: 37.55, lng: 127.07 } };
  const low = toSuggestion(computePlan(base({ draft: { ...draft, importance: 'LOW' }, lateCount4w: 0 }), api(50)));
  assert.equal(low.intensity.level, 'NORMAL');
  assert.equal(low.intensity.reason, '평소 일정 → 중');
  assert.deepEqual([low.intensity.auto_level, low.intensity.importance_point, low.intensity.late_point], [1, 0, 0]);

  const high = toSuggestion(computePlan(base({ draft: { ...draft, importance: 'HIGH' }, lateCount4w: 0 }), api(50)));
  assert.equal(high.intensity.level, 'STRONG');
  assert.equal(high.intensity.reason, '매우 중요 일정 (한 단계 올림) → 강');
  assert.deepEqual([high.intensity.auto_level, high.intensity.importance_point], [2, 1]);

  const lowLate = toSuggestion(computePlan(base({ draft: { ...draft, importance: 'LOW' }, lateCount4w: 2 }), api(50)));
  assert.equal(lowLate.intensity.level, 'STRONG'); // 낮음 + 늦잠 지각 2회 = 보통에서 한 단계 올림
  assert.equal(lowLate.intensity.reason, '평소 일정 + 최근 4주 늦잠 지각 2회 → 강');
});

test('옛 알람(vibration 칸이 비어 있고 intensity만 STRONG인 직접 알람)은 진동을 직접 고른 것으로 안 읽음 — 강도를 따르는 칸이라 자동', () => {
  const legacy = row('WAKE', 480, { intensity: 'STRONG', vibration: null, intensity_source: 'MANUAL' });
  const plan = computePlan(base({ draft: { appointmentId: 'ap1' }, appointment, participant, existingAlarms: [legacy] }), api(30));
  assert.equal(plan.intensity.axes.vibration.manual, false);
  assert.equal(plan.intensity.fields.vibration, null);
});

test('미리 보기 응답의 intensity 블록에 vibration이 실림 (직접 고른 진동만 값, 자동이면 null)', () => {
  const auto = toSuggestion(computePlan(base({ draft: { at: kst(22, 600), destination: { name: '세종대학교' } } }), api(50)));
  assert.equal(auto.intensity.vibration, null);
  const picked = toSuggestion(computePlan(base({ draft: { at: kst(22, 600), destination: { name: '세종대학교' }, levels: { vibration: 0 } } }), api(50)));
  assert.equal(picked.intensity.vibration, 'NONE');
  assert.equal(picked.intensity.level, 'NORMAL');
});

// ---- 학습 루프 기초 b (이슈 #272) — 잠귀 · 깨우는 여유 · 최근 5번 ----

const TEN = [70, 100, 40, 80, 45, 75, 55, 60, 50, 65]; // 최신순. 정렬하면 0.7 → 71.5, 0.8 → 76, 0.9 → 82
const withMargin = (wake_margin: string | null | undefined): ProfileRow => ({ ...profile, wake_margin });
const prepareOf = (margin: string | null | undefined, importance: 'LOW' | 'NORMAL' | 'HIGH' = 'NORMAL', stats = prepareStatsOf(TEN)) =>
  computePlan(base({ profile: withMargin(margin), stats, draft: { at: kst(22, 600), destination: { name: 'x' }, importance } }), api(50)).prepare;

test('[5절] 같은 기록, 빠듯 / 보통 / 넉넉: 넉넉이 더 이름 (0.7 < 0.8 < 0.9)', () => {
  const [tight, normal, loose] = ['TIGHT', 'NORMAL', 'LOOSE'].map((m) => prepareOf(m));
  assert.ok(tight.minutes < normal.minutes && normal.minutes < loose.minutes, `${tight.minutes} < ${normal.minutes} < ${loose.minutes}`);
  // 공통 50 + round(0.5 × (분위수 − 50)) — 71.5 → 61, 76 → 63, 82 → 66
  assert.deepEqual([tight.minutes, normal.minutes, loose.minutes], [61, 63, 66]);
  assert.deepEqual([tight.sampleCount, normal.sampleCount, loose.sampleCount], [10, 10, 10]); // 기록 수는 여유와 무관
});

test('깨우는 여유 보통은 예전 값과 정확히 같음: 칸이 없거나 모르는 값이어도, 옛 모양 stats(p80만)여도', () => {
  const old = computePlan(base({ stats: { sampleCount: 10, p80: 76 } }), api(50)).prepare; // wake_margin 칸 없는 프로필 + 옛 모양
  for (const margin of ['NORMAL', undefined, null, 'x']) assert.deepEqual(prepareOf(margin), old, String(margin));
  assert.equal(old.minutes, 63);
});

test('[5절] 매우 중요 일정은 여유가 한 단계 위: 빠듯 → 보통, 보통 → 넉넉, 넉넉은 그대로 · 중요 / 보통 일정은 그대로', () => {
  assert.equal(prepareOf('TIGHT', 'HIGH').minutes, prepareOf('NORMAL').minutes);
  assert.equal(prepareOf('NORMAL', 'HIGH').minutes, prepareOf('LOOSE').minutes);
  assert.equal(prepareOf('LOOSE', 'HIGH').minutes, prepareOf('LOOSE').minutes);
  for (const importance of ['LOW', 'NORMAL'] as const) assert.equal(prepareOf('TIGHT', importance).minutes, prepareOf('TIGHT').minutes);
});

test('기록이 5건 미만이어도 같은 규칙 (섞는 가중치 n:(n+10) 그대로): 3건 → 빠듯 < 보통 < 넉넉, 매우 중요는 한 단계 위', () => {
  const three = prepareStatsOf([90, 70, 50]); // 정렬 50 70 90: 0.7 → 78, 0.8 → 82, 0.9 → 86
  const at = (m: string, imp: 'NORMAL' | 'HIGH' = 'NORMAL') => prepareOf(m, imp, three);
  // 가중치 3/13: 보정 = round(3/13 × (분위수 − 50)) → 78 → 6, 82 → 7, 86 → 8
  assert.deepEqual(['TIGHT', 'NORMAL', 'LOOSE'].map((m) => at(m).minutes), [56, 57, 58]);
  assert.equal(at('NORMAL').source, 'DEFAULT'); // 5건 미만이라 출처는 첫 값
  assert.equal(at('TIGHT', 'HIGH').minutes, at('NORMAL').minutes);
  assert.equal(at('NORMAL', 'HIGH').minutes, at('LOOSE').minutes);
});

test('기록이 0건이면 여유와 상관없이 첫 값 그대로', () => {
  for (const m of ['TIGHT', 'NORMAL', 'LOOSE']) {
    for (const imp of ['NORMAL', 'HIGH'] as const) {
      const p = prepareOf(m, imp, prepareStatsOf([]));
      assert.deepEqual([p.minutes, p.source], [50, 'DEFAULT']);
    }
  }
});

test('[5절] 그날 두 번째 일정(기상 없음)은 여유 · 중요도와 상관없이 준비 15분 그대로', () => {
  for (const m of ['TIGHT', 'NORMAL', 'LOOSE']) {
    for (const importance of ['NORMAL', 'HIGH'] as const) {
      const plan = computePlan(
        base({ draft: { at: kst(22, 1080), destination: { name: '강남역' }, bufferMinutes: 5, importance }, sameDayWake: true, profile: withMargin(m), stats: prepareStatsOf(TEN), now: kst(22, 600) }),
        api(20),
      );
      assert.deepEqual([plan.withWake, plan.prepare.minutes, plan.prepare.correction, plan.recentPrepare], [false, 15, 0, []], `${m} ${importance}`);
    }
  }
});

test('직접 고른 준비 시간은 여유와 상관없이 그 값', () => {
  const plan = computePlan(base({ profile: withMargin('LOOSE'), stats: prepareStatsOf(TEN), draft: { at: kst(22, 600), destination: { name: 'x' }, prepareMinutes: 40 } }), api(50));
  assert.deepEqual([plan.prepare.minutes, plan.prepare.source], [40, 'MANUAL']);
});

test('깨우는 여유가 알람 시각에 닿음: 같은 기록에서 넉넉하면 기상이 더 이름', () => {
  const wake = (m: string) => {
    const plan = computePlan(base({ profile: withMargin(m), stats: prepareStatsOf(TEN), draft: { at: kst(22, 600), destination: { name: 'x' }, beforePrepareMinutes: 30 } }), api(50));
    return plan.chain.find((x) => x.kind === 'WAKE')?.at.getTime() as number;
  };
  assert.ok(wake('LOOSE') < wake('NORMAL') && wake('NORMAL') < wake('TIGHT'));
});

// 잠귀 — 강도 (D69: 약은 직접 고를 때만)
const levelOf = (wake_sensitivity: string | null | undefined, importance: 'LOW' | 'NORMAL' | 'HIGH', lateCount4w = 0) =>
  computePlan(base({ profile: { ...profile, wake_sensitivity }, lateCount4w, draft: { at: kst(22, 600), destination: { name: 'x' }, importance } }), api(50)).intensity;

test('[5절] 잠귀 깊음(HEAVY): 보통 일정이어도 강 — 매우 중요 · 지각 2번이어도 최대 강에서 멈춤', () => {
  assert.equal(levelOf('HEAVY', 'NORMAL').auto, 2);
  assert.equal(levelOf('HEAVY', 'LOW').auto, 2);
  const max = levelOf('HEAVY', 'HIGH', 2);
  assert.deepEqual([max.auto, max.fields.intensity, max.heavySleeper], [2, 'STRONG', true]);
});

test('[5절] 잠귀 가벼움(LIGHT) · 보통(NORMAL) · 칸 없음 + 보통 일정: 기본 보통 (약 아님)', () => {
  for (const sensitivity of ['LIGHT', 'NORMAL', undefined, null, 'x']) {
    for (const importance of ['LOW', 'NORMAL'] as const) {
      const it = levelOf(sensitivity, importance);
      assert.deepEqual([it.auto, it.fields.intensity, it.heavySleeper], [1, 'NORMAL', false], `${sensitivity} ${importance}`);
    }
  }
  assert.equal(levelOf('LIGHT', 'HIGH').auto, 2); // 매우 중요는 한 단계 올림 그대로
});

test('잠귀가 무거우면 이유 문구에 나오고, 직접 고른 칸은 잠귀보다 먼저', () => {
  const dto = toSuggestion(computePlan(base({ profile: { ...profile, wake_sensitivity: 'HEAVY' }, lateCount4w: 0 }), api(50)));
  assert.equal(dto.intensity.reason, '평소 일정 + 잠귀가 무거움 → 강');
  const manual = computePlan(base({ profile: { ...profile, wake_sensitivity: 'HEAVY' }, draft: { at: kst(22, 600), destination: { name: 'x' }, levels: { sound: 0, voice: null, vibration: null } } }), api(50));
  assert.deepEqual([manual.intensity.axes.sound, manual.intensity.axes.voice], [{ level: 0, manual: true }, { level: 2, manual: false }]);
});

test('저장된 직접 고른 강도 비교는 잠귀를 반영한 자동 값 기준: HEAVY인 사람의 강 칸은 직접 고름이 아님', () => {
  const stored = [
    { alarm_id: 'a1', participant_id: 'p1', user_id: 'u', alarm_type: 'WAKE', scheduled_at: '2025-05-22T07:00:00+09:00', intensity: 'STRONG', voice_tone: 'DIRECT', sound_key: 'theme_urgent', is_enabled: true, snooze_limit: 3, time_source: 'AUTO', intensity_source: 'MANUAL', recurrence_rule: null },
  ] as AlarmRow[];
  const plan = computePlan(base({ profile: { ...profile, wake_sensitivity: 'HEAVY' }, existingAlarms: stored, draft: { at: kst(22, 600), destination: { name: 'x' } } }), api(50));
  assert.equal(plan.intensity.manual, false);
});

// 최근 5번
test('응답의 prepare.recent: 최신순 최대 5개 — 0건 빈 배열 · 3건 3개 · 7건 최신 5개', () => {
  const recent = (values: number[]) => toSuggestion(computePlan(base({ stats: prepareStatsOf(values) }), api(50))).prepare.recent;
  assert.deepEqual(recent([]), []);
  assert.deepEqual(recent([62, 55, 48]), [62, 55, 48]);
  assert.deepEqual(recent([75, 70, 62, 55, 48, 90, 91]), [75, 70, 62, 55, 48]);
  assert.deepEqual(toSuggestion(computePlan(base({ stats: { sampleCount: 10, p80: 70 } }), api(50))).prepare.recent, []); // 옛 모양 stats
});

test('응답의 prepare.recent: 그날 두 번째 일정은 기록을 안 쓰므로 빈 배열', () => {
  const dto = toSuggestion(computePlan(base({ sameDayWake: true, stats: prepareStatsOf([62, 55, 48]) }), api(20)));
  assert.deepEqual([dto.prepare.recent, dto.prepare.sample_count], [[], 0]);
});

// ---- 저녁에만 일정이 있는 날은 기상 알람 없음 (#320, 헤드 10/30) ----

test('저녁 단일 일정 18:00(이동 30 · 여유 10): 기상 없음 · 준비 · 출발 · 도착만, 준비 15분', () => {
  const plan = computePlan(base({ draft: { at: kst(22, 1080), destination: { name: '강남역' } }, now: kst(22, 600) }), api(30));
  assert.equal(plan.withWake, false);
  assert.equal(plan.prepare.minutes, 15);
  assert.equal(plan.beforePrepareMinutes, 0);
  assert.deepEqual(text(plan), ['PREPARE 17:05', 'DEPARTURE 17:20', 'ARRIVE 17:50']);
  const s = toSuggestion(plan);
  assert.equal(s.with_wake, false);
  assert.equal(s.wake_at, null);
});

test('경계: 계산된 기상이 11:59면 기상 있음, 12:00이면 기상 없음', () => {
  // 기록 없음: 준비 50 + 이동 30 + 여유 10 = 90분 전이 기상 → 약속 13:29면 기상 11:59, 13:30이면 12:00
  const at = (minutes: number) => computePlan(base({ stats: { sampleCount: 0, p80: null }, draft: { at: kst(22, minutes), destination: { name: '강남역' } }, now: kst(22, 400) }), api(30));
  const before = at(13 * 60 + 29);
  assert.equal(before.withWake, true);
  assert.equal(hm(before.chain[0].at.toISOString()), '11:59');
  const exact = at(13 * 60 + 30);
  assert.equal(exact.withWake, false);
  assert.deepEqual(text(exact), ['PREPARE 12:35', 'DEPARTURE 12:50', 'ARRIVE 13:20']); // 기상 없이 준비 15분으로 다시 계산
});

test('낮 일정 14:00에서 계산된 기상이 오전이면 기상 있음', () => {
  // 첫 값(온보딩) 90분 · 이동 30 · 여유 10 → 기상 14:00 − 10 − 30 − 90 = 11:50. 기본 50분이면 12:30이라 기상 없음
  const draft = { at: kst(22, 14 * 60), destination: { name: '강남역' } };
  const long = computePlan(base({ profile: { ...profile, default_prepare_minutes: 90 }, stats: { sampleCount: 0, p80: null }, draft, now: kst(22, 400) }), api(30));
  assert.equal(long.withWake, true);
  assert.equal(hm(long.chain[0].at.toISOString()), '11:50');
  const short = computePlan(base({ stats: { sampleCount: 0, p80: null }, draft, now: kst(22, 400) }), api(30));
  assert.equal(short.withWake, false);
});

test('직접 지정은 존중: with_wake true · 직접 고른 기상 시각은 12시 이후여도 기상 있음', () => {
  const draft = { at: kst(22, 1080), destination: { name: '강남역' } };
  const forced = computePlan(base({ draft: { ...draft, withWake: true }, now: kst(22, 400) }), api(30));
  assert.equal(forced.withWake, true);
  assert.equal(forced.chain[0].kind, 'WAKE');
  const manual = computePlan(base({ draft: { ...draft, manualTimes: { WAKE: kst(22, 15 * 60) } }, now: kst(22, 400) }), api(30));
  assert.equal(manual.withWake, true);
  assert.deepEqual(text(manual).slice(0, 1), ['WAKE 15:00*']);
  // with_wake false는 원래대로 기상 없음 (오전 일정이어도)
  const off = computePlan(base({ draft: { at: kst(22, 600), destination: { name: '세종대학교' }, withWake: false } }), api(50));
  assert.equal(off.withWake, false);
});

test('kinds에 WAKE가 있어도 저녁이면 기상은 안 만들어짐 (kinds는 거르기만, L6 안건후보 기본안)', () => {
  const plan = computePlan(base({ draft: { at: kst(22, 1080), destination: { name: '강남역' }, kinds: ['WAKE', 'PREPARE', 'DEPARTURE'] }, now: kst(22, 400) }), api(30));
  assert.equal(plan.withWake, false);
  assert.deepEqual(plan.chain.map((x) => x.kind), ['PREPARE', 'DEPARTURE', 'ARRIVE']);
});

test('시간대: 같은 순간도 profile.timezone의 낮으로 판정 (서울이면 오후 → 기상 없음, 뉴욕이면 새벽 → 기상 있음)', () => {
  // 약속 UTC 08:00 (서울 17:00 · 뉴욕 04:00), 기록 없음 · 이동 30 · 여유 10 · 준비 50 → 기상 UTC 06:30 (서울 15:30 · 뉴욕 02:30)
  const at = new Date('2025-05-22T08:00:00Z');
  const input = (timezone: string) => base({ profile: { ...profile, timezone }, stats: { sampleCount: 0, p80: null }, draft: { at, destination: { name: '강남역' } }, now: new Date('2025-05-21T00:00:00Z') });
  assert.equal(computePlan(input('Asia/Seoul'), api(30)).withWake, false);
  assert.equal(computePlan(input('America/New_York'), api(30)).withWake, true);
  // 시간대가 비었거나 틀리면 서울
  assert.equal(computePlan(input(''), api(30)).withWake, false);
  assert.equal(computePlan(input('No/Such_Zone'), api(30)).withWake, false);
});

test('축별 선택을 끄면(axesEnabled false) 요청 · 저장된 축 값을 모두 무시하고 자동(강도 따름) — 켜면 요청 값이 우선 (D1 A flag, 헤드 확정 10/30)', () => {
  const stored = row('WAKE', 480, { intensity_source: 'MANUAL', sound_key: 'theme_urgent', vibration: 'NONE' });
  assert.deepEqual(resolveOverrides({ sound: 2 }, [stored], 1, true), { sound: 2 });
  assert.deepEqual(resolveOverrides({ sound: 2 }, [stored], 1, false), {});
  assert.deepEqual(resolveOverrides(undefined, [stored], 1, false), {});
  assert.notDeepEqual(resolveOverrides(undefined, [stored], 1, true), {}); // 켜면 저장된 직접 값이 살아 있음
});

test('저장된 말소리가 설정의 기본 말소리와 같으면 직접 고른 값으로 보지 않음 (기본 말소리를 바꾸면 같이 바뀜)', () => {
  const stored = row('WAKE', 480, { intensity_source: 'MANUAL', sound_key: 'theme_urgent', voice_tone: 'DIRECT' });
  assert.equal(resolveOverrides(undefined, [stored], 1, true, 2).voice, null);
  assert.equal(resolveOverrides(undefined, [stored], 1, true).voice, 2); // 기본 말소리 없으면 자동(1)과 달라 직접 고른 값
});

test('9-05: 같은 약속(11:00)에 사람마다 이동 · 기상~출발이 다르면 알람도 각자 따로 — 서로의 값이 섞이지 않고 한쪽만 바꿔도 다른 쪽은 그대로', () => {
  const at = kst(22, 660); // 11:00 약속, 여유 0
  const mine = (travel: number, prepare: number) =>
    text(computePlan(base({ draft: { at, destination: { name: '세종대학교' }, bufferMinutes: 0, prepareMinutes: prepare, beforePrepareMinutes: 5 } }), api(travel))).filter((x) => x.startsWith('WAKE') || x.startsWith('DEPARTURE'));
  const a = mine(30, 20); // A: 이동 30 · 기상~출발 20 → 출발 10:30, 기상 10:10
  const b = mine(60, 40); // B: 이동 60 · 기상~출발 40 → 출발 10:00, 기상 9:20
  assert.deepEqual(a, ['WAKE 10:10', 'DEPARTURE 10:30']);
  assert.deepEqual(b, ['WAKE 09:20', 'DEPARTURE 10:00']);
  assert.deepEqual(mine(30, 20), a); // 같은 입력은 같은 결과 — B를 계산해도 A는 안 변함
  assert.deepEqual(mine(60, 20), ['WAKE 09:40', 'DEPARTURE 10:00']); // 이동만 늘면 출발이 그만큼 일러지고 기상도 같이 감
});

test('C1/W4 preview and save calculate exactly the same timestamps before database writes', () => {
  for (const model of ['c1_mae', 'w4_mae'] as const) {
    const inputs = base({
      mlPrediction: { model, minutes: model === 'c1_mae' ? 66 : 58 },
      draft: {
        at: kst(22, 600),
        destination: { name: '세종대학교' },
        travelMinutes: 30,
        travelSource: 'MANUAL',
        bufferMinutes: 10,
        beforePrepareMinutes: 20,
        withWake: true,
      },
    });
    const preview = toSuggestion(computePlan(inputs, api(30), 'preview'), inputs);
    const save = toSuggestion(computePlan(inputs, api(30), 'save'), inputs);
    assert.equal(preview.prepare.source, 'MODEL');
    assert.equal(preview.prepare.model, model);
    assert.equal(preview.prepare.minutes, model === 'c1_mae' ? 66 : 58);
    assert.deepEqual(
      [preview.wake_at, preview.prepare_at, preview.departure_at, preview.arrive_at],
      [save.wake_at, save.prepare_at, save.departure_at, save.arrive_at],
    );
    assert.equal(preview.check.ok, save.check.ok);
  }
});

test('missing prediction falls back to existing personal P80 while keeping manual override first', () => {
  const args = base();
  const fallback = computePlan({ ...args, mlPrediction: undefined }, api(50), 'preview');
  assert.equal(fallback.prepare.source, 'PERSONAL');
  assert.equal(fallback.prepare.minutes, 60);
  assert.equal(toSuggestion(fallback).prepare.model, undefined);
  const manual = computePlan({
    ...args,
    mlPrediction: { model: 'w4_mae', minutes: 58 },
    draft: { ...args.draft, prepareMinutes: 75 },
  }, api(50), 'preview');
  assert.equal(manual.prepare.source, 'MANUAL');
  assert.equal(manual.prepare.minutes, 75);
  assert.equal(manual.prepare.mlModel, undefined);
});

// ---- 준비 알람 당김 (#484 · 안건 D111, B안: 준비 전 활동은 저장하지 않고 되찾음) ----
// 저장된 일정: 출발 9:25(약속 10:00 − 여유 5 − 이동 30), 준비 시간 60 → 기상 8:25, 준비 전 활동 20 → 준비 알람 8:45
const saved = (adv: number, alarms: AlarmRow[], over: Partial<PlanInputs> = {}) =>
  computePlan(base({ draft: {}, appointment, participant: { ...participant, prepare_advance_minutes: adv }, existingAlarms: alarms, ...over }), api(30));
const at = (plan: ReturnType<typeof computePlan>) => text(plan).filter((x) => !x.startsWith('ARRIVE'));

test('준비 전 활동 되찾기: 당김 10(간격 10)이면 20, 당김 25(기상도 5분 당김 · 간격 0)이면 출발 · 준비 시간으로 20, 당김 없으면 간격 그대로', () => {
  assert.equal(inferBeforePrepare([row('WAKE', 505), row('PREPARE', 515), row('DEPARTURE', 565)], 10, 60), 20);
  assert.equal(inferBeforePrepare([row('WAKE', 500), row('PREPARE', 500), row('DEPARTURE', 565)], 25, 60), 20);
  assert.equal(inferBeforePrepare([row('WAKE', 505), row('PREPARE', 525), row('DEPARTURE', 565)]), 20);
  assert.equal(inferBeforePrepare([row('WAKE', 505), row('PREPARE', 525, { time_source: 'MANUAL' })], 10, 60), undefined);
});

test('당김을 받은 일정을 다시 계산해도 같은 시각 — 같은 당김이 두 번 들어가지 않음 (10분 · 25분)', () => {
  const ten = saved(10, [row('WAKE', 505), row('PREPARE', 515), row('DEPARTURE', 565)]);
  assert.deepEqual(at(ten), ['WAKE 08:25', 'PREPARE 08:35', 'DEPARTURE 09:25']);
  assert.equal(ten.beforePrepareMinutes, 20); // 계획의 준비 전 활동 · 준비 시간은 원래 값
  assert.equal(ten.prepare.minutes, 60);
  assert.deepEqual(at(saved(25, [row('WAKE', 500), row('PREPARE', 500), row('DEPARTURE', 565)])), ['WAKE 08:20', 'PREPARE 08:20', 'DEPARTURE 09:25']);
});

test('당김을 처음 적용할 때(저장된 알람은 당김 0) — existingAdvanceMinutes로 옛 값을 알려 주면 준비 알람만 10분 당겨짐', () => {
  const applied = saved(10, [row('WAKE', 505), row('PREPARE', 525), row('DEPARTURE', 565)], { existingAdvanceMinutes: 0 });
  assert.deepEqual(at(applied), ['WAKE 08:25', 'PREPARE 08:35', 'DEPARTURE 09:25']);
});

test('준비 알람을 직접 고른 일정은 당기지 않음 — 직접 고른 시각 그대로, 기상도 그대로', () => {
  const plan = saved(10, [row('WAKE', 505), row('PREPARE', 520, { time_source: 'MANUAL' }), row('DEPARTURE', 565)]);
  assert.deepEqual(at(plan), ['WAKE 08:25', 'PREPARE 08:40*', 'DEPARTURE 09:25']); // * = 직접 고른 시각
});


test('pure preparation profile basis yields different PREPARE and WAKE, fixed 20min intact', () => {
  const plan = computePlan(base({
    stats: { sampleCount: 0, p80: null },
    purePrepCandidate: { source: 'PROFILE', minutes: 35 },
    draft: { at: kst(22, 600), destination: { name: '세종대학교' } },
  }), api(50));
  assert.equal(plan.prepare.minutes, 55);
  assert.equal(plan.beforePrepareMinutes, 20);
  assert.equal(plan.prepare.source, 'DEFAULT');
  assert.deepEqual(text(plan), ['WAKE 08:05', 'PREPARE 08:25', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  assert.deepEqual(plan.recentPrepare, []);
});

test('pure preparation basis is still applied to same-day second appointment without WAKE', () => {
  const plan = computePlan(base({
    sameDayWake: true,
    purePrepCandidate: { source: 'HISTORY', minutes: 35, sampleCount: 4 },
    draft: { at: kst(22, 1080), destination: { name: '강남역' }, bufferMinutes: 5 },
  }), api(20));
  assert.equal(plan.withWake, false);
  assert.equal(plan.prepare.minutes, 35);
  assert.equal(plan.beforePrepareMinutes, 0);
  assert.deepEqual(text(plan), ['PREPARE 17:00', 'DEPARTURE 17:35', 'ARRIVE 17:55']);
});

test('legacy explicit override and C1/W4 both remain higher priority than an injected pure candidate', () => {
  const profilePure = { source: 'PROFILE' as const, minutes: 35 };
  const manual = computePlan(base({
    purePrepCandidate: profilePure,
    draft: { at: kst(22, 600), destination: { name: '세종대학교' }, prepareMinutes: 60 },
  }), api(50));
  assert.equal(manual.prepare.source, 'MANUAL');
  assert.equal(manual.prepare.minutes, 60);
  const oldMl = computePlan(base({
    purePrepCandidate: profilePure,
    mlPrediction: { model: 'c1_mae', minutes: 80 },
  }), api(50));
  assert.equal(oldMl.prepare.mlModel, 'c1_mae');
  assert.equal(oldMl.prepare.minutes, 80);
});

test('new model provenance is exposed only when explicitly injected (not by name alone)', () => {
  const plan = computePlan(base({
    purePrepCandidate: { source: 'MODEL', minutes: 35, model: 'prep_start_ratio_v2' },
    stats: { sampleCount: 0, p80: null },
  }), api(50));
  assert.equal(plan.prepare.source, 'MODEL');
  assert.equal(plan.prepare.mlModel, 'prep_start_ratio_v2');
  assert.equal(toSuggestion(plan).prepare.model, 'prep_start_ratio_v2');
});

test('suggestion explicitly distinguishes legacy whole-wake target from new pure-preparation target', () => {
  const pure = computePlan(base({
    purePrepCandidate: { source:'PROFILE', minutes:35 },
    stats:{sampleCount:0,p80:null},
  }), api(50));
  const pureDto = toSuggestion(pure);
  assert.equal(pure.prepareTarget,'PREPARE_START_TO_DEPART');
  assert.equal(pureDto.prepare.target,'PREPARE_START_TO_DEPART');
  assert.equal(pureDto.prepare.pure_minutes,35);
  assert.equal(pureDto.prepare.minutes,55);
  const legacy = computePlan(base({stats:{sampleCount:0,p80:null}}),api(50));
  const dto=toSuggestion(legacy);
  assert.equal(dto.prepare.target,'WAKE_TO_DEPART');
  assert.equal(dto.prepare.pure_minutes,null);
});
test('pure candidate is not clamped to legacy repeated wake-to-departure value',()=>{
  const plan=computePlan(base({
     purePrepCandidate:{source:'PROFILE',minutes:35},
     prepareBound:{around:90,within:10},
     stats:{sampleCount:0,p80:null},
  }),api(50));
  assert.equal(plan.prepare.minutes,55);
});
