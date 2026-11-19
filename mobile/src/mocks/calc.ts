// 목업 계산 — 알람 역산 · 강도는 서버 함수와 같은 공용 계산(supabase/functions/_shared/calc)을 얇게 감쌈 (전체작업계획 8.1 Q4 A)
//   ALG-01 알람 역산 · ALG-02 강도 · 그룹원 기상 상태 (ALG-03 권한 합집합은 features/social/grants.ts의 mergeGrants — 목업 · 실데이터 같이 씀)
//   역산 · 강도는 목업 일정(MockAppointment) ↔ 공용 입력만 바꿔 그대로 부름. 강도는 D69 규칙(기본 보통) — 옛 목업 규칙 "중요도 낮음 = 약"은 바뀜.
//   그룹원 기상 줄(mockWakeRow)은 목업 시나리오(timelines · db.me · db.wake)로 서버 get_group_wake 줄을 흉내 내는 목업 전용 로직
import type { AlarmTime, IntensityAxis, Level } from '@/features/alarm/types';
import { wakeStateOf, type WakeRow } from '@/features/social/map';
import type { WakeState } from '@/features/social/types';
import { now as clockNow, scenarioTime } from '@/lib/clock';
import { minuteOfDay } from '@/lib/format';
import { alarmChain as sharedAlarmChain } from '@shared/calc/chain.ts';
import { autoLevel as sharedAutoLevel, levelOfVoiceTone, resolveIntensity, wakeSensitivityOf } from '@shared/calc/intensity.ts';

import { db, kst, ME_TRIP, timelines, TODAY, tripTimelines, type MockAppointment } from './data';

// ALG-01: 출발 = 약속 − 여유 − 이동, 기상 = 출발 − 예측 준비(P80)
// 그날 첫 일정이 아니면(기상 알람 없음) 준비 알람만. 준비 알람은 기상 뒤 준비 전 활동만큼 뒤
// a.kinds가 있으면 H05에서 고른 종류만 — 도착 목표는 울리는 알람이 하나라도 있을 때만, 하나도 없으면 빈 목록(알람 없는 일정)
// a.manual이 있으면 직접 고른 이동 · 준비 시간 · 알람 시각이 자동 계산보다 먼저 (D42 C). 직접 고른 알람은 auto에 자동 계산값을 남김
//   준비 알람은 (직접 고른 시각을 포함한) 기상 시각 뒤 — 기상을 옮기면 준비도 같은 간격으로 따라옴
export function alarmChain(a: MockAppointment): AlarmTime[] {
  const chain = sharedAlarmChain({
    at: a.at,
    travelMinutes: a.manual?.travelMinutes ?? a.travelMinutes,
    bufferMinutes: a.bufferMinutes,
    prepareMinutes: a.manual?.predictedPrepMinutes ?? a.predictedPrepMinutes,
    beforePrepareMinutes: a.beforePrepMinutes,
    withWake: a.withWake,
    kinds: a.kinds,
    manualTimes: a.manual?.times,
    prepareAdvanceMinutes: a.manual?.times?.PREPARE ? 0 : (a.prepareAdvanceMinutes ?? 0), // 준비 알람을 직접 고르면 당기지 않음 (서버 plan-core와 같음)
  });
  return chain.map((x) => ({
    id: `${a.id}:${x.kind}`,
    kind: x.kind,
    at: x.at,
    enabled: x.kind === 'ARRIVE' || !db.disabledKinds.has(`${a.id}:${x.kind}`),
    ...(x.auto ? { auto: x.auto } : {}),
  }));
}

// 켜진 출발(DEPARTURE) 알람의 시각 — 꺼져 있거나 고르지 않았으면 undefined.
// 실제 폰 꾸러미의 departAt도 같은 규칙임 (lib/alarmSync/reconcile.ts: 출발 알람 행이 있을 때만 넣음). 미루기 "늦어요" 판단에 씀
export function departAtOf(a: MockAppointment): Date | undefined {
  return alarmChain(a).find((x) => x.kind === 'DEPARTURE' && x.enabled)?.at;
}

// ALG-02: 기본 보통 + 매우 중요면 한 단계 + 최근 4주 늦잠 지각 2회 이상이면 한 단계, 잠귀가 무거우면 곧바로 강 (상한 강, D69) — 약은 직접 고를 때만
export function autoLevel(a: MockAppointment): Level {
  return sharedAutoLevel(a.importance, db.lateCount4w, wakeSensitivityOf(db.wakeSensitivity));
}

// 직접 고른 강도가 있으면 그것, 없으면 자동 — 말소리는 설정의 기본 말소리(db.voiceTone)가 자동 값을 대신함 (서버 plan-core와 같음)
export function axisLevel(a: MockAppointment, axis: IntensityAxis): Level {
  return resolveIntensity(a.importance, db.lateCount4w, db.intensityOverrides[a.id], wakeSensitivityOf(db.wakeSensitivity), levelOfVoiceTone(db.voiceTone)).axes[axis].level;
}

// 내 첫 알람 (팀 주간회의 기상)
function myFirstAlarm() {
  const a1 = db.appointments.find((a) => a.id === 'a1');
  return a1 ? alarmChain(a1)[0].at : kst(TODAY, 480);
}

// 그룹원의 지금 기상 줄 — 시나리오 시각(now)까지 일어난 마지막 일을 서버 get_group_wake 줄 모양으로 (친구 7장)
//   출발 · 도착은 그 사람이 출발 · 도착 공유를 켰을 때(tripVisible)만 줌 — 꺼져 있으면 시각 없이 trip_visible false. 시나리오가 없는 사람은 null (= 공유 안 함)
//   '이동 중' · '도착' 시각(lib/clock)에는 tripTimelines · ME_TRIP, 평소 아침에는 timelines · db.me
export function mockWakeRow(personId: string, now: Date, tripVisible = false): WakeRow | null {
  const beforeToday = now.getTime() < kst(TODAY, 0).getTime();
  const iso = (d: Date) => d.toISOString();
  const trip = (departed: Date | null, arrived: Date | null) => ({
    trip_visible: tripVisible,
    departed_at: tripVisible && departed ? iso(departed) : null,
    arrived_at: tripVisible && arrived ? iso(arrived) : null,
    prepare_alarm_at: null as string | null,
    prepare_started_at: null as string | null,
    trip_appointment_at: tripVisible && (departed || arrived) ? iso(kst(TODAY, 600)) : null, // 시나리오의 그 그룹 약속 (팀 주간회의 10:00)
  });
  if (personId === 'me') {
    const first = myFirstAlarm();
    const base = { user_id: 'me', is_me: true, wake_alarm_at: iso(first), wake_confirmed_at: null as string | null, ...trip(null, null) };
    if (beforeToday) return { ...base, wake_status: 'SCHEDULED' };
    const { arriveAt, departAt, wakeAt } = myTrip(now);
    const woke = wakeAt ?? departAt ?? arriveAt;
    const tripRow = trip(departAt, arriveAt);
    if (woke) return { ...base, ...tripRow, wake_status: 'CONFIRMED', wake_confirmed_at: iso(woke) };
    if (db.wake.phase === 'ringing') return { ...base, wake_status: 'RINGING' };
    if (db.wake.phase === 'observing' || db.wake.phase === 'prompt') return { ...base, wake_status: 'DISMISSED' };
    return { ...base, wake_status: 'SCHEDULED' };
  }
  const tl = (isTripScenario() ? tripTimelines : timelines)[personId];
  if (!tl) return null;
  // 기상 알람이 없는 날(오후 · 저녁 일정) — 첫 줄이 준비 알람. 서버처럼 출발 · 도착 공유가 보일 때만 준비 알람 시각을 줌
  if (tl[0][1] === '준비 알람') {
    const prep = { ...trip(null, null), prepare_alarm_at: tripVisible ? iso(kst(TODAY, tl[0][0])) : null, prepare_started_at: null as string | null };
    return { user_id: personId, is_me: false, wake_alarm_at: null, wake_confirmed_at: null, wake_status: 'NO_ALARM', ...prep };
  }
  const base = { user_id: personId, is_me: false, wake_alarm_at: iso(kst(TODAY, tl[0][0])), wake_confirmed_at: null as string | null, ...trip(null, null) };
  if (beforeToday) return { ...base, wake_status: 'SCHEDULED' };
  const nowMin = minuteOfDay(now);
  const passed = tl.filter(([m]) => m <= nowMin);
  const timeOf = (label: string) => {
    const at = passed.find(([, l]) => l === label);
    return at ? kst(TODAY, at[0]) : null;
  };
  const prepStart = tripVisible ? timeOf('준비 시작') : null; // 준비 알람 해제 = 준비 시작 체크 (출발 · 도착 공유가 보일 때만)
  const tripRow = { ...trip(timeOf('출발'), timeOf('도착')), prepare_started_at: prepStart ? iso(prepStart) : null };
  const confirmed = passed.find(([, label]) => label === '기상 확인');
  if (confirmed) return { ...base, ...tripRow, wake_status: 'CONFIRMED', wake_confirmed_at: iso(kst(TODAY, confirmed[0])) };
  if (passed.some(([, label]) => label === '알람 해제')) return { ...base, wake_status: 'DISMISSED' };
  if (passed.length) return { ...base, wake_status: 'RINGING' };
  return { ...base, wake_status: 'SCHEDULED' };
}

export const isTripScenario = () => scenarioTime() === 'moving' || scenarioTime() === 'arrived';

// 내 하루의 기상 · 출발 · 도착 시각 — 직접 만든 기록(db.me)이 먼저, 없으면 '이동 중' · '도착' 시각의 시나리오 값. 시나리오 값은 지금(now) 이후면 아직 안 일어난 일이라 뺌 (홈 이동 중 줄 · 그룹 내 줄이 같이 읽음)
export function myTrip(current: Date = clockNow()): { wakeAt: Date | null; departAt: Date | null; arriveAt: Date | null } {
  const preset = isTripScenario() ? ME_TRIP : null;
  const past = (d: Date | null | undefined) => (d && d.getTime() <= current.getTime() ? d : null);
  return { wakeAt: db.me.wakeAt ?? past(preset?.wakeAt), departAt: db.me.departAt ?? past(preset?.departAt), arriveAt: db.me.arriveAt ?? past(preset?.arriveAt) };
}

// 그 줄의 화면 글자 (시험이 씀 — 화면은 social/api의 mockWakeRows로 읽음)
export const memberState = (personId: string, now: Date): WakeState => wakeStateOf(mockWakeRow(personId, now) ?? undefined, true);
