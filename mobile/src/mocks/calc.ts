// 목업의 계산을 그대로 옮김 — 실제 계산은 서버(alarm-suggest Edge Function · DB 함수)가 함 (#32 · #44)
//   ALG-01 알람 역산 · ALG-02 강도 · ALG-03 권한 합집합 · 그룹원 기상 상태
import type { AlarmTime, IntensityAxis, Level } from '@/features/alarm/types';
import { IMPORTANCE_POINT } from '@/features/alarm/types';
import type { FinalGrant, GrantRow, WakeState } from '@/features/social/types';
import { addMinutes, formatTime, minuteOfDay, timeParts } from '@/lib/format';

import { db, kst, timelines, TODAY, type MockAppointment } from './data';

// ALG-01: 출발 = 약속 − 여유 − 이동, 기상 = 출발 − 예측 준비(P80)
// 그날 첫 일정이 아니면(기상 알람 없음) 준비 알람만. 준비 알람은 기상 뒤 준비 전 활동만큼 뒤
export function alarmChain(a: MockAppointment): AlarmTime[] {
  const depart = addMinutes(a.at, -(a.bufferMinutes + a.travelMinutes));
  const alarm = (kind: AlarmTime['kind'], at: Date): AlarmTime => ({
    id: `${a.id}:${kind}`,
    kind,
    at,
    enabled: kind === 'ARRIVE' || !db.disabledKinds.has(`${a.id}:${kind}`),
  });
  const list: AlarmTime[] = [];
  if (a.withWake) {
    const wake = addMinutes(depart, -a.predictedPrepMinutes);
    list.push(alarm('WAKE', wake));
    if (a.beforePrepMinutes > 0) list.push(alarm('PREPARE', addMinutes(wake, a.beforePrepMinutes)));
  } else {
    list.push(alarm('PREPARE', addMinutes(depart, -a.predictedPrepMinutes)));
  }
  list.push(alarm('DEPARTURE', depart));
  list.push(alarm('ARRIVE', addMinutes(a.at, -a.bufferMinutes)));
  return list;
}

// ALG-02: 중요도 점수 + 최근 4주 늦잠 지각 2회 이상이면 1 → 0~2
export function autoLevel(a: MockAppointment): Level {
  const late = db.lateCount4w >= 2 ? 1 : 0;
  return Math.max(0, Math.min(2, IMPORTANCE_POINT[a.importance] + late)) as Level;
}

// 직접 고른 강도가 있으면 그것, 없으면 자동
export function axisLevel(a: MockAppointment, axis: IntensityAxis): Level {
  return db.intensityOverrides[a.id]?.[axis] ?? autoLevel(a);
}

// ALG-03: 관계별 권한을 항목별로 OR
export function orGrants(rows: GrantRow[]): FinalGrant {
  const viewAlarm = rows.some((r) => r.viewAlarm);
  const editAlarm = rows.some((r) => r.editAlarm);
  const viewWake = rows.some((r) => r.viewWake);
  return { viewAlarm, editAlarm, viewWake, rows, count: [viewAlarm, editAlarm, viewWake].filter(Boolean).length };
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
