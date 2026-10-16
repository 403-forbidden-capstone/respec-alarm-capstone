import { describe, expect, it } from '@jest/globals';
import type { RingPackage, ScheduledAlarm } from '@capstone/alarm-core';

import { buildServerPackages, planReconcile, RECONCILE_WINDOW_DAYS, type SyncRow } from '../reconcile';

const NOW = Date.parse('2026-10-19T12:00:00.000Z'); // 한국 시각 21:00
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function row(overrides: Partial<SyncRow> & Pick<SyncRow, 'alarm_id' | 'alarm_type' | 'scheduled_at'>): SyncRow {
  return {
    intensity: 'NORMAL',
    sound_key: null,
    snooze_limit: 3,
    is_enabled: true,
    participant_id: 'p1',
    routine_id: null,
    appointment: { title: '팀 주간회의', appointment_at: '2026-10-20T01:00:00.000Z', dest_name: '세종대학교' }, // 한국 시각 10:00
    routine_title: null,
    ...overrides,
  };
}

function pkg(alarmId: string, atMillis: number, overrides: Partial<RingPackage> = {}): RingPackage {
  return { alarmId, type: 'WAKE', atMillis, title: '팀 주간회의', intensity: 'NORMAL', snoozeLimit: 3, ...overrides };
}

function onPhone(id: string, atMillis: number, overrides: Partial<ScheduledAlarm> = {}): ScheduledAlarm {
  return { id, type: 'WAKE', intensity: 'NORMAL', title: '팀 주간회의', atMillis, snoozeCount: 0, nextRingAt: atMillis, ...overrides };
}

describe('서버 행 → 예약 꾸러미 (서버 alarm-commit과 같은 조립)', () => {
  it('약속 알람은 제목 · "오전 10:00 · 장소" 부제 · 출발 시각을 달고 시각순', () => {
    const packages = buildServerPackages([
      row({ alarm_id: 'dep', alarm_type: 'DEPARTURE', scheduled_at: '2026-10-20T00:00:00.000Z' }),
      row({ alarm_id: 'wake', alarm_type: 'WAKE', scheduled_at: '2026-10-19T22:30:00.000Z', intensity: 'STRONG', sound_key: 'theme_urgent' }),
    ]);
    expect(packages.map((p) => p.alarmId)).toEqual(['wake', 'dep']);
    expect(packages[0]).toEqual({
      alarmId: 'wake',
      type: 'WAKE',
      atMillis: Date.parse('2026-10-19T22:30:00.000Z'),
      title: '팀 주간회의',
      subtitle: '오전 10:00 · 세종대학교',
      intensity: 'STRONG',
      snoozeLimit: 3,
      soundKey: 'theme_urgent',
      departAt: Date.parse('2026-10-20T00:00:00.000Z'),
    });
  });

  it('약속별로 따로 묶고, 일정 없는 알람은 "알람" + 알람 시각 부제, 루틴 알람은 루틴 이름', () => {
    const packages = buildServerPackages([
      row({ alarm_id: 'a-wake', alarm_type: 'WAKE', scheduled_at: '2026-10-19T22:30:00.000Z' }),
      row({ alarm_id: 'b-wake', alarm_type: 'WAKE', scheduled_at: '2026-10-20T23:00:00.000Z', participant_id: 'p2', appointment: { title: '수업', appointment_at: '2026-10-21T01:00:00.000Z', dest_name: null } }),
      row({ alarm_id: 'solo', alarm_type: 'WAKE', scheduled_at: '2026-10-21T21:30:00.000Z', participant_id: null, appointment: null }),
      row({ alarm_id: 'routine', alarm_type: 'ROUTINE', scheduled_at: '2026-10-22T21:30:00.000Z', participant_id: null, appointment: null, routine_id: 'r1', routine_title: '차분한 출근 준비' }),
    ]);
    const byId = Object.fromEntries(packages.map((p) => [p.alarmId, p]));
    expect(byId['a-wake'].title).toBe('팀 주간회의');
    expect(byId['b-wake']).toMatchObject({ title: '수업', subtitle: '오전 10:00' }); // 장소가 없으면 시각만
    expect(byId['solo']).toMatchObject({ title: '알람', subtitle: '오전 6:30' });
    expect(byId['routine']).toMatchObject({ type: 'ROUTINE', title: '차분한 출근 준비' });
    expect(byId['routine'].subtitle).toBeUndefined();
    expect(byId['a-wake'].departAt).toBeUndefined(); // 출발 알람이 이 목록에 없으면 빠짐
  });

  it('꺼진 알람은 꾸러미에 안 넣음', () => {
    expect(buildServerPackages([row({ alarm_id: 'off', alarm_type: 'WAKE', scheduled_at: '2026-10-19T22:30:00.000Z', is_enabled: false })])).toEqual([]);
  });

  it('부제의 시각은 사용자 시간대 기준', () => {
    const rows = [row({ alarm_id: 'w', alarm_type: 'WAKE', scheduled_at: '2026-10-19T22:30:00.000Z' })];
    expect(buildServerPackages(rows, 'Asia/Seoul')[0].subtitle).toBe('오전 10:00 · 세종대학교');
    expect(buildServerPackages(rows, 'UTC')[0].subtitle).toBe('오전 1:00 · 세종대학교');
    expect(buildServerPackages(rows, '없는/시간대')[0].subtitle).toBe('오전 10:00 · 세종대학교'); // 모르는 시간대는 서울
  });
});

describe('폰 예약 맞추기 계획 (planReconcile)', () => {
  const at = (minutes: number) => NOW + minutes * MIN;

  it('폰에 없으면 걸고, 같으면 그대로', () => {
    const server = [pkg('a', at(60)), pkg('b', at(120))];
    const plan = planReconcile({ server, phone: [onPhone('a', at(60))], nowMs: NOW });
    expect(plan.schedule.map((p) => p.alarmId)).toEqual(['b']);
    expect(plan.cancel).toEqual([]);
  });

  it('시각이 다르거나 강도가 다르면 다시 걸음 (친구의 ±5분 · 제안 적용 · 다른 기기에서 고친 것)', () => {
    const server = [pkg('time', at(65)), pkg('strong', at(60), { intensity: 'STRONG' }), pkg('same', at(70))];
    const phone = [onPhone('time', at(60)), onPhone('strong', at(60)), onPhone('same', at(70))];
    expect(planReconcile({ server, phone, nowMs: NOW }).schedule.map((p) => p.alarmId)).toEqual(['time', 'strong']);
  });

  it('울린 뒤 미룬 알람(첫 울림이 지남)은 서버 목록(지금 이후)에 없어도 지우지 않음', () => {
    const phone = [onPhone('snoozed', at(-5), { snoozeCount: 1, nextRingAt: at(5) })];
    expect(planReconcile({ server: [], phone, nowMs: NOW })).toEqual({ schedule: [], cancel: [] });
  });

  it('서버에 없는 폰 예약은 지움. 단 첫 울림이 이미 지난(울리는 중 · 미룸 · 다시 울림 대기) 예약은 건드리지 않음', () => {
    const phone = [onPhone('gone', at(60)), onPhone('ringing', at(-1)), onPhone('keep', at(90))];
    const plan = planReconcile({ server: [pkg('keep', at(90))], phone, nowMs: NOW });
    expect(plan.cancel).toEqual(['gone']);
    expect(plan.schedule).toEqual([]);
  });

  it('지난 시각 꾸러미는 건너뜀 (지금 정각도 지난 것)', () => {
    const plan = planReconcile({ server: [pkg('past', at(-1)), pkg('now', at(0)), pkg('next', at(1))], phone: [], nowMs: NOW });
    expect(plan.schedule.map((p) => p.alarmId)).toEqual(['next']);
  });

  it(`폰에 없는 알람은 ${RECONCILE_WINDOW_DAYS}일 안만 더하고, 폰에 이미 있는 먼 알람은 지우지 않고 맞춤`, () => {
    const far = at(RECONCILE_WINDOW_DAYS * 24 * 60 + 60);
    const edge = NOW + RECONCILE_WINDOW_DAYS * DAY;
    const server = [pkg('far-new', far), pkg('edge', edge), pkg('far-old', far), pkg('far-moved', far + 10 * MIN)];
    const phone = [onPhone('far-old', far), onPhone('far-moved', far)];
    const plan = planReconcile({ server, phone, nowMs: NOW });
    expect(plan.schedule.map((p) => p.alarmId)).toEqual(['edge', 'far-moved']);
    expect(plan.cancel).toEqual([]);
  });

  it('기간은 바꿀 수 있음', () => {
    const plan = planReconcile({ server: [pkg('two-days', at(2 * 24 * 60))], phone: [], nowMs: NOW, windowDays: 1 });
    expect(plan.schedule).toEqual([]);
  });

  it('서버에 있는 켜진 알람이 하나도 없으면 미래 폰 예약을 모두 지움 (로그아웃 뒤 다른 계정에 남은 알람 정리)', () => {
    const plan = planReconcile({ server: [], phone: [onPhone('x', at(30)), onPhone('y', at(60))], nowMs: NOW });
    expect(plan.cancel).toEqual(['x', 'y']);
  });
});
