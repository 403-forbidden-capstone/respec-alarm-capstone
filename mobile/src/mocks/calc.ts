// 목업 계산 — 알람 역산 · 강도는 서버 함수와 같은 공용 계산(supabase/functions/_shared/calc)을 얇게 감쌈 (전체작업계획 8.1 Q4 A)
//   ALG-01 알람 역산 · ALG-02 강도 · 그룹원 기상 상태 (ALG-03 권한 합집합은 features/social/grants.ts의 mergeGrants — 목업 · 실데이터 같이 씀)
//   공용 계산이 목업 규칙을 그대로 옮긴 것이라(D56 열림 = 목업 계산이 기준) 결과가 같음. 역산 · 강도는 목업 일정(MockAppointment) ↔ 공용 입력만 바꾸고,
//   그룹원 기상 상태(memberState)는 목업 시나리오(timelines · db.me · db.wake)로 글자를 만드는 목업 전용 로직
import type { AlarmTime, IntensityAxis, Level } from '@/features/alarm/types';
import type { WakeState } from '@/features/social/types';
import { formatTime, minuteOfDay, timeParts } from '@/lib/format';
import { alarmChain as sharedAlarmChain, departureAt as sharedDepartureAt } from '@shared/calc/chain.ts';
import { autoLevel as sharedAutoLevel, resolveIntensity } from '@shared/calc/intensity.ts';

import { db, kst, timelines, TODAY, type MockAppointment } from './data';

// ALG-01: 출발 = 약속 − 여유 − 이동, 기상 = 출발 − 예측 준비(P80)
// 그날 첫 일정이 아니면(기상 알람 없음) 준비 알람만. 준비 알람은 기상 뒤 준비 전 활동만큼 뒤
// a.kinds가 있으면 H05에서 고른 종류만 — 도착 목표는 울리는 알람이 하나라도 있을 때만, 하나도 없으면 빈 목록(알람 없는 일정)
// a.manual이 있으면 직접 고른 이동 · 준비 시간 · 알람 시각이 자동 계산보다 먼저 (D42 C). 직접 고른 알람은 auto에 자동 계산값을 남김
//   준비 알람은 (직접 고른 시각을 포함한) 기상 시각 뒤 — 기상을 옮기면 준비도 같은 간격으로 따라옴
function chainInput(a: MockAppointment) {
  return {
    at: a.at,
    travelMinutes: a.manual?.travelMinutes ?? a.travelMinutes,
    bufferMinutes: a.bufferMinutes,
    prepareMinutes: a.manual?.predictedPrepMinutes ?? a.predictedPrepMinutes,
    beforePrepareMinutes: a.beforePrepMinutes,
    withWake: a.withWake,
    kinds: a.kinds,
    manualTimes: a.manual?.times,
  };
}

export function alarmChain(a: MockAppointment): AlarmTime[] {
  const chain = sharedAlarmChain(chainInput(a));
  return chain.map((x) => ({
    id: `${a.id}:${x.kind}`,
    kind: x.kind,
    at: x.at,
    enabled: x.kind === 'ARRIVE' || !db.disabledKinds.has(`${a.id}:${x.kind}`),
    ...(x.auto ? { auto: x.auto } : {}),
  }));
}

// 출발 시각 — 출발 알람을 안 골랐어도 계산됨 (서버 꾸러미의 departAt과 같은 값, 미루기 "늦어요" 판단에 씀)
export function departAtOf(a: MockAppointment): Date {
  return sharedDepartureAt(chainInput(a));
}

// ALG-02: 중요도 점수 + 최근 4주 늦잠 지각 2회 이상이면 1 → 0~2
export function autoLevel(a: MockAppointment): Level {
  return sharedAutoLevel(a.importance, db.lateCount4w);
}

// 직접 고른 강도가 있으면 그것, 없으면 자동
export function axisLevel(a: MockAppointment, axis: IntensityAxis): Level {
  return resolveIntensity(a.importance, db.lateCount4w, db.intensityOverrides[a.id]).axes[axis].level;
}

const STATE_TEXT: Record<string, (t: string) => WakeState> = {
  '알람 울림': () => ({ text: '알람 울리는 중', dot: 'zz', woke: false }),
  '알람 해제': () => ({ text: '알람 해제 · 기상 확인 전', dot: 'zz', woke: false }),
  '기상 확인': (t) => ({ text: `기상 완료 · ${t}`, dot: 'ok', woke: true }),
  '준비 시작': (t) => ({ text: `준비 시작 · ${t}`, dot: 'mid', woke: true }),
  출발: (t) => ({ text: `출발 · ${t}`, dot: 'mid', woke: true }),
  도착: (t) => ({ text: `도착 · ${t}`, dot: 'ok', woke: true }),
};

// 내 첫 알람 (팀 주간회의 기상)
function myFirstAlarm() {
  const a1 = db.appointments.find((a) => a.id === 'a1');
  return a1 ? alarmChain(a1)[0].at : kst(TODAY, 480);
}

// 그룹원의 지금 상태 — 시나리오 시각(now)까지 일어난 마지막 일
export function memberState(personId: string, now: Date): WakeState {
  const beforeToday = now.getTime() < kst(TODAY, 0).getTime();
  if (personId === 'me') {
    const first = timeParts(myFirstAlarm()).hm;
    if (beforeToday) return { text: `내일 알람 ${first}`, dot: 'zz', woke: false };
    const { arriveAt, departAt, wakeAt } = db.me;
    if (arriveAt) return { text: `도착 · ${formatTime(arriveAt)}`, dot: 'ok', woke: true };
    if (departAt) return { text: `출발 · ${formatTime(departAt)}`, dot: 'mid', woke: true };
    if (wakeAt) return { text: `기상 완료 · ${formatTime(wakeAt)}`, dot: 'ok', woke: true };
    // 기상 알람이 울리는 중 · 끈 뒤 판정 중 (목업 myState)
    if (db.wake.phase === 'ringing') return { text: '알람 울리는 중', dot: 'zz', woke: false };
    if (db.wake.phase === 'observing' || db.wake.phase === 'prompt') {
      return { text: '알람 해제 · 기상 확인 중', dot: 'zz', woke: false };
    }
    return { text: `취침 중 · 알람 ${first}`, dot: 'zz', woke: false };
  }
  const tl = timelines[personId];
  if (!tl) return { text: '기상 상태를 볼 수 없어요', dot: 'zz', woke: false };
  const first = timeParts(kst(TODAY, tl[0][0])).hm;
  if (beforeToday) return { text: `내일 알람 ${first}`, dot: 'zz', woke: false };
  const nowMin = minuteOfDay(now);
  const last = [...tl].reverse().find(([m]) => m <= nowMin);
  if (!last) return { text: `취침 중 · 알람 ${first}`, dot: 'zz', woke: false };
  return STATE_TEXT[last[1]](formatTime(kst(TODAY, last[0])));
}
