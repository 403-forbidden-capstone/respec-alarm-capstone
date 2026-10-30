import { describe, expect, it, jest } from '@jest/globals';
import type { RingPackage, ScheduledAlarm } from '@capstone/alarm-core';

import { buildRingPlan } from '../../../../modules/alarm-core/src/plan'; // 폰 꾸러미가 알림에 쓰는 줄(heading) 확인용 — 알람 코어 본체는 jest에서 네이티브를 찾으므로 계산 파일만
import { buildServerPackages, dropRecorded, expandWithTextSiblings, planReconcile, RECONCILE_WINDOW_DAYS, upcomingParticipants, type ServerPackage, type SyncRow } from '../reconcile';

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
      vibration: 'STRONG_CONTINUOUS', // 칸이 비어 있어 강도에서
      departAt: Date.parse('2026-10-20T00:00:00.000Z'),
      groupKey: 'p1', // 같은 약속의 알람을 묶는 키 (맞추기 계산용 — planReconcile이 폰에 걸 때 뗌)
      voiceText: '좋은 아침이에요. 오늘 첫 일정은 오전 10시 팀 주간회의예요. 오전 9시에 나가면 돼요.', // 약속 기상 알람이라 출발 알람(9:00)을 읽어 줌
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

  it('DB가 주는 마이크로초 시각(.123456+00:00)은 소수 3자리로 맞춰 읽음 — Date.parse가 6자리를 못 읽는 엔진 대비', () => {
    const parse = jest.spyOn(Date, 'parse');
    try {
      const [wake] = buildServerPackages([
        row({
          alarm_id: 'w',
          alarm_type: 'WAKE',
          scheduled_at: '2026-10-19T22:30:00.123456+00:00',
          appointment: { title: '팀 주간회의', appointment_at: '2026-10-20T01:00:00.654321+00:00', dest_name: '세종대학교' },
        }),
      ]);
      expect(wake.atMillis).toBe(Date.UTC(2026, 9, 19, 22, 30, 0, 123));
      expect(wake.subtitle).toBe('오전 10:00 · 세종대학교');
      for (const [text] of parse.mock.calls) expect(String(text)).not.toMatch(/\.\d{4,}/);
    } finally {
      parse.mockRestore();
    }
  });

  it('꺼진 알람은 꾸러미에 안 넣음', () => {
    expect(buildServerPackages([row({ alarm_id: 'off', alarm_type: 'WAKE', scheduled_at: '2026-10-19T22:30:00.000Z', is_enabled: false })])).toEqual([]);
  });

  it('부제를 못 만들어도(시각 서식 실패) 맞추기가 멈추지 않고 장소만 달음', () => {
    const broken = row({ alarm_id: 'w', alarm_type: 'WAKE', scheduled_at: '2026-10-19T22:30:00.000Z', appointment: { title: '회의', appointment_at: '날짜 아님', dest_name: '세종대학교' } });
    const [pkg] = buildServerPackages([broken]);
    expect(pkg).toMatchObject({ alarmId: 'w', title: '회의', subtitle: '세종대학교' });
  });

  // 서버 supabase/functions/_shared/morning-flow.test.ts의 "하루 재생"과 같은 입력 · 같은 글자 — 둘 중 한쪽만 바뀌면 여기서 잡힘
  describe('알림 문구 (준비 · 출발 notice, 기상 voiceText) — 서버 alarm-commit과 같은 글자', () => {
    const lesson = { title: '전공 수업', appointment_at: '2025-05-22T01:00:00.000Z', dest_name: '광개토관' }; // 한국 시각 10:00
    const chain = (over: Partial<SyncRow> = {}) => [
      row({ alarm_id: 'wake', alarm_type: 'WAKE', scheduled_at: '2025-05-21T23:00:00.000Z', appointment: lesson, travel_minutes: 50, ...over }), // 8:00
      row({ alarm_id: 'prep', alarm_type: 'PREPARE', scheduled_at: '2025-05-21T23:30:00.000Z', appointment: lesson, travel_minutes: 50, ...over }), // 8:30
      row({ alarm_id: 'dep', alarm_type: 'DEPARTURE', scheduled_at: '2025-05-22T00:00:00.000Z', appointment: lesson, travel_minutes: 50, ...over }), // 9:00
      row({ alarm_id: 'arr', alarm_type: 'ARRIVE', scheduled_at: '2025-05-22T00:50:00.000Z', appointment: lesson, travel_minutes: 50, ...over }), // 9:50
    ];
    const byId = (packages: RingPackage[]) => Object.fromEntries(packages.map((p) => [p.alarmId, p]));

    it('약속 알람: 준비 · 출발은 notice, 기상은 voiceText, 도착은 그대로', () => {
      const packages = byId(buildServerPackages(chain()));
      expect(packages.prep.notice).toBe('오전 9:00 출발까지 30분');
      expect(packages.dep.notice).toBe('지금 나가면 오전 9:50 도착 · 여유 10분');
      expect(packages.wake.voiceText).toBe('좋은 아침이에요. 오늘 첫 일정은 오전 10시 전공 수업이에요. 오전 9시에 나가면 돼요.');
      expect(packages.wake.notice).toBeUndefined();
      expect([packages.arr.notice, packages.arr.voiceText]).toEqual([undefined, undefined]);
    });

    it('이동 시간을 모르면(칸이 비어 있음) 출발 문구만 빠지고 나머지는 그대로', () => {
      const packages = byId(buildServerPackages(chain({ travel_minutes: null })));
      expect(packages.dep.notice).toBeUndefined();
      expect(packages.prep.notice).toBe('오전 9:00 출발까지 30분');
    });

    it('약속 시각을 못 읽으면 문구는 모두 빠지고 알람은 그대로', () => {
      const packages = byId(buildServerPackages(chain({ appointment: { ...lesson, appointment_at: '날짜 아님' } })));
      expect(Object.keys(packages)).toHaveLength(4);
      expect([packages.dep.notice, packages.wake.voiceText, packages.prep.notice]).toEqual([undefined, undefined, undefined]);
    });

    it('일정 없는 알람 · 루틴 알람은 문구가 없음', () => {
      const packages = buildServerPackages([
        row({ alarm_id: 'solo', alarm_type: 'WAKE', scheduled_at: '2026-10-21T21:30:00.000Z', participant_id: null, appointment: null }),
        row({ alarm_id: 'routine', alarm_type: 'ROUTINE', scheduled_at: '2026-10-22T21:30:00.000Z', participant_id: null, appointment: null, routine_id: 'r1', routine_title: '출근 준비' }),
      ]);
      for (const p of packages) expect(Object.keys(p).filter((k) => k === 'notice' || k === 'voiceText')).toEqual([]);
    });
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

  it('배경음 · 진동이 폰과 다르면 다시 걸고, 폰이 안 돌려주는 칸(예전 APK)은 비교하지 않음 (D1 A)', () => {
    const server = [
      pkg('sound', at(60), { soundKey: 'theme_urgent', vibration: 'SHORT_REPEAT' }),
      pkg('vibration', at(60), { soundKey: 'theme_default', vibration: 'NONE' }),
      pkg('same', at(60), { soundKey: 'theme_default', vibration: 'SHORT_REPEAT' }),
      pkg('unknown', at(60), { soundKey: 'theme_urgent', vibration: 'NONE' }),
    ];
    const phone = [
      onPhone('sound', at(60), { soundKey: 'theme_default', vibration: 'SHORT_REPEAT' }),
      onPhone('vibration', at(60), { soundKey: 'theme_default', vibration: 'SHORT_REPEAT' }),
      onPhone('same', at(60), { soundKey: 'theme_default', vibration: 'SHORT_REPEAT' }),
      onPhone('unknown', at(60)),
    ];
    expect(planReconcile({ server, phone, nowMs: NOW }).schedule.map((p) => p.alarmId)).toEqual(['sound', 'vibration']);
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

  it('forceCancel(서버에서 꺼진 것으로 확인된 알람)은 첫 울림이 지났어도 지움 — 미룸 · 다시 울림 대기 · 울리는 중', () => {
    const phone = [onPhone('snoozed', at(-5), { snoozeCount: 1, nextRingAt: at(5) }), onPhone('ringing', at(-1)), onPhone('other-past', at(-30))];
    const plan = planReconcile({ server: [], phone, nowMs: NOW, forceCancel: new Set(['snoozed', 'ringing']) });
    expect(plan.cancel).toEqual(['snoozed', 'ringing']); // 지정하지 않은 지난 예약은 그대로
  });

  it('forceCancel에 있어도 서버 켜진 목록에 있으면 지우지 않음', () => {
    const plan = planReconcile({ server: [pkg('a', at(60))], phone: [onPhone('a', at(60))], nowMs: NOW, forceCancel: new Set(['a']) });
    expect(plan.cancel).toEqual([]);
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

// 준비 알림 글자 · 기상 음성 문장은 같은 약속의 출발 알람 시각 · 켜짐에서 나옴 — 폰 list()는 글자를 안 돌려줘서 출발 알람이 바뀌면 준비 · 기상을 다시 걸어야 새 글자가 됨
describe('출발 알람이 바뀌면 같은 약속의 준비 · 기상도 다시 걸림 (planReconcile)', () => {
  const lesson = { title: '전공 수업', appointment_at: '2025-05-22T01:00:00.000Z', dest_name: '광개토관' }; // 한국 시각 10:00
  const BEFORE = Date.parse('2025-05-21T12:00:00.000Z'); // 5월 21일 21:00 — 기상(8:00)보다 앞
  const DEP = '2025-05-22T00:00:00.000Z'; // 출발 9:00
  const chain = (participant = 'p1', over: { dep?: string; depEnabled?: boolean; depIntensity?: SyncRow['intensity'] } = {}): SyncRow[] => {
    const make = (suffix: string, alarm_type: SyncRow['alarm_type'], scheduled_at: string, extra: Partial<SyncRow> = {}) =>
      row({ alarm_id: `${participant}-${suffix}`, alarm_type, scheduled_at, participant_id: participant, appointment: lesson, travel_minutes: 50, ...extra });
    return [
      make('wake', 'WAKE', '2025-05-21T23:00:00.000Z'), // 8:00
      make('prep', 'PREPARE', '2025-05-21T23:30:00.000Z'), // 8:30
      make('dep', 'DEPARTURE', over.dep ?? DEP, { is_enabled: over.depEnabled ?? true, intensity: over.depIntensity ?? 'NORMAL' }),
      make('arr', 'ARRIVE', '2025-05-22T00:50:00.000Z'), // 9:50
    ];
  };
  // 서버 꾸러미가 그대로 폰에 걸려 있는 상태 (폰 list()는 시각 · 강도만 돌려줌)
  const phoneOf = (packages: readonly ServerPackage[]) => packages.map((x) => onPhone(x.alarmId, x.atMillis, { type: x.type, intensity: x.intensity }));
  const ids = (packages: readonly RingPackage[]) => packages.map((x) => x.alarmId);

  it('아무것도 안 바뀌면 다시 걸지 않음 (지금 동작 유지)', () => {
    const server = buildServerPackages(chain());
    expect(planReconcile({ server, phone: phoneOf(server), nowMs: BEFORE })).toEqual({ schedule: [], cancel: [] });
  });

  it('출발만 옮기면 시각 · 강도가 같은 준비 · 기상도 다시 걸어 새 글자로 덮음 (도착은 그대로)', () => {
    const phone = phoneOf(buildServerPackages(chain())); // 폰에는 옛 글자("9:00 출발")
    const server = buildServerPackages(chain('p1', { dep: '2025-05-21T23:50:00.000Z' })); // 다른 기기에서 출발을 8:50으로
    const plan = planReconcile({ server, phone, nowMs: BEFORE });
    expect(ids(plan.schedule)).toEqual(['p1-wake', 'p1-prep', 'p1-dep']); // 시각순
    expect(plan.cancel).toEqual([]);
    const byId = Object.fromEntries(plan.schedule.map((x) => [x.alarmId, x]));
    expect(byId['p1-prep'].notice).toBe('오전 8:50 출발까지 20분');
    expect(byId['p1-dep'].notice).toBe('지금 나가면 오전 9:40 도착 · 여유 20분');
    expect(byId['p1-wake'].voiceText).toBe('좋은 아침이에요. 오늘 첫 일정은 오전 10시 전공 수업이에요. 오전 8시 50분에 나가면 돼요.');
  });

  it('출발 알람이 새로 걸릴 때(폰에 없음)도 폰에 이미 있는 같은 약속의 준비 · 기상을 다시 걺', () => {
    const server = buildServerPackages(chain());
    const phone = phoneOf(server).filter((a) => a.id !== 'p1-dep'); // 출발만 폰에 없음 (켰거나 새로 생김)
    expect(ids(planReconcile({ server, phone, nowMs: BEFORE }).schedule)).toEqual(['p1-wake', 'p1-prep', 'p1-dep']);
  });

  it('출발 알람이 폰에서 지워질 때(서버에서 꺼짐)도 같은 약속의 준비 · 기상을 다시 걸어 기본 줄로 돌아감', () => {
    const phone = phoneOf(buildServerPackages(chain())); // 폰에는 출발까지 있음
    const server = buildServerPackages(chain('p1', { depEnabled: false })); // 서버에는 출발 행이 켜져 있지 않음
    const plan = planReconcile({ server, phone, nowMs: BEFORE, departureGroups: new Map([['p1-dep', 'p1']]) });
    expect(plan.cancel).toEqual(['p1-dep']);
    expect(ids(plan.schedule)).toEqual(['p1-wake', 'p1-prep']);
    const [wake, prep] = plan.schedule;
    expect(prep.notice).toBeUndefined();
    expect(buildRingPlan(prep).heading).toBe('준비할 시간이에요'); // 알림 글자가 기본 줄로
    expect(wake.voiceText).toBe('좋은 아침이에요. 오늘 첫 일정은 오전 10시 전공 수업이에요.'); // 나갈 시각 문장이 빠짐
  });

  it('지울 출발 알람의 약속을 모르면(departureGroups 없음) 준비 · 기상은 다시 걸지 않음 — 알 수 있는 호출(index.ts)이 넘김', () => {
    const phone = phoneOf(buildServerPackages(chain()));
    const server = buildServerPackages(chain('p1', { depEnabled: false }));
    const plan = planReconcile({ server, phone, nowMs: BEFORE });
    expect(plan.cancel).toEqual(['p1-dep']);
    expect(plan.schedule).toEqual([]);
  });

  it('다른 약속의 준비 · 기상은 건드리지 않음, 출발이 강도만 바뀌면 글자가 같아 준비 · 기상은 그대로', () => {
    const before = [...chain('p1'), ...chain('p2')];
    const phone = phoneOf(buildServerPackages(before));
    const moved = buildServerPackages([...chain('p1', { dep: '2025-05-21T23:50:00.000Z' }), ...chain('p2')]);
    expect(ids(planReconcile({ server: moved, phone, nowMs: BEFORE }).schedule).sort()).toEqual(['p1-dep', 'p1-prep', 'p1-wake']);
    const stronger = buildServerPackages([...chain('p1', { depIntensity: 'STRONG' }), ...chain('p2')]);
    expect(ids(planReconcile({ server: stronger, phone, nowMs: BEFORE }).schedule)).toEqual(['p1-dep']);
  });

  it('이미 지난 준비 · 기상은 다시 걸지 않음 (출발만 앞으로 남은 때)', () => {
    const server = buildServerPackages(chain('p1', { dep: '2025-05-22T00:05:00.000Z' }));
    const phone = phoneOf(buildServerPackages(chain()));
    const nowMs = Date.parse('2025-05-21T23:40:00.000Z'); // 8:40 — 기상 · 준비는 지남
    expect(ids(planReconcile({ server, phone, nowMs }).schedule)).toEqual(['p1-dep']);
  });

  it('폰에 걸 꾸러미에는 앱 안에서만 쓰는 묶음 키(groupKey)가 없음 — 알람 코어(네이티브)로 안 넘어감', () => {
    const phone = phoneOf(buildServerPackages(chain()));
    const server = buildServerPackages(chain('p1', { dep: '2025-05-21T23:50:00.000Z' }));
    expect(server.every((x) => x.groupKey === 'p1')).toBe(true); // 계산 중에는 있고
    const { schedule } = planReconcile({ server, phone: phone.filter((a) => a.id !== 'p1-prep'), nowMs: BEFORE });
    expect(schedule.length).toBeGreaterThan(0);
    for (const x of schedule) expect(Object.keys(x)).not.toContain('groupKey'); // 내보낼 때 뗌
    expect(server[0].groupKey).toBe('p1'); // 입력 꾸러미는 그대로
  });
});

describe('일부 알람만 맞출 때 출발 알람의 약속 알람을 대상에 더함 (expandWithTextSiblings)', () => {
  const lesson = { title: '전공 수업', appointment_at: '2025-05-22T01:00:00.000Z', dest_name: '광개토관' };
  const make = (participant: string, suffix: string, alarm_type: SyncRow['alarm_type'], scheduled_at: string) =>
    row({ alarm_id: `${participant}-${suffix}`, alarm_type, scheduled_at, participant_id: participant, appointment: lesson, travel_minutes: 50 });
  const server = buildServerPackages(
    ['p1', 'p2'].flatMap((participant) => [
      make(participant, 'wake', 'WAKE', '2025-05-21T23:00:00.000Z'),
      make(participant, 'prep', 'PREPARE', '2025-05-21T23:30:00.000Z'),
      make(participant, 'dep', 'DEPARTURE', '2025-05-22T00:00:00.000Z'),
      make(participant, 'arr', 'ARRIVE', '2025-05-22T00:50:00.000Z'),
    ]),
  );

  it('출발 알람이 들어 있으면 같은 약속의 준비 · 기상이 더해지고, 다른 약속과 도착은 안 더해짐', () => {
    expect([...expandWithTextSiblings(new Set(['p1-dep', 'p1-arr']), server, new Map())].sort()).toEqual(['p1-arr', 'p1-dep', 'p1-prep', 'p1-wake']);
  });

  it('출발 알람이 없으면 그대로', () => {
    expect([...expandWithTextSiblings(new Set(['p1-prep', 'p2-arr']), server, new Map())].sort()).toEqual(['p1-prep', 'p2-arr']);
  });

  it('서버에 없어 지울 출발 알람은 DB에서 읽은 약속(departureGroups)으로 같은 약속의 준비 · 기상을 더함', () => {
    const withoutDeparture = server.filter((x) => x.type !== 'DEPARTURE');
    const expanded = expandWithTextSiblings(new Set(['p1-dep']), withoutDeparture, new Map([['p1-dep', 'p1']]));
    expect([...expanded].sort()).toEqual(['p1-dep', 'p1-prep', 'p1-wake']);
  });
});

describe('출발 · 도착 기록이 있는 약속의 알람은 폰 예약 대상에서 뺌 (dropRecorded)', () => {
  const rows = [
    row({ alarm_id: 'wake', alarm_type: 'WAKE', scheduled_at: '2026-10-19T22:30:00.000Z' }),
    row({ alarm_id: 'prep', alarm_type: 'PREPARE', scheduled_at: '2026-10-19T23:00:00.000Z' }),
    row({ alarm_id: 'dep', alarm_type: 'DEPARTURE', scheduled_at: '2026-10-20T00:00:00.000Z' }),
    row({ alarm_id: 'arr', alarm_type: 'ARRIVE', scheduled_at: '2026-10-20T00:50:00.000Z' }),
  ];
  const ids = (list: readonly SyncRow[]) => list.map((r) => r.alarm_id);
  const withRecord = (record: Pick<SyncRow, 'departed_at' | 'arrived_at'>) => rows.map((r) => ({ ...r, ...record }));

  it('기록이 없으면(null · 칸 없음) 그대로', () => {
    expect(ids(dropRecorded(rows).kept)).toEqual(['wake', 'prep', 'dep', 'arr']);
    expect(ids(dropRecorded(withRecord({ departed_at: null, arrived_at: null })).kept)).toEqual(['wake', 'prep', 'dep', 'arr']);
  });

  it('출발 기록 → 준비 · 출발 알람을 뺌 (기상 · 도착 목표는 남김)', () => {
    const { kept, dropped } = dropRecorded(withRecord({ departed_at: '2026-10-20T00:01:00.000Z', arrived_at: null }));
    expect(ids(kept)).toEqual(['wake', 'arr']);
    expect(ids(dropped)).toEqual(['prep', 'dep']);
  });

  it('도착 기록 → 준비 · 출발 · 도착 목표를 뺌 (기상은 남김)', () => {
    const { kept } = dropRecorded(withRecord({ departed_at: '2026-10-20T00:01:00.000Z', arrived_at: '2026-10-20T00:40:00.000Z' }));
    expect(ids(kept)).toEqual(['wake']);
    expect(ids(dropRecorded(withRecord({ departed_at: null, arrived_at: '2026-10-20T00:40:00.000Z' })).kept)).toEqual(['wake']); // 출발 기록 없이 도착만 있어도
  });

  it('참여 행마다 따로 — 다른 약속(다른 참여 행)의 알람은 그대로', () => {
    const other = row({ alarm_id: 'other-dep', alarm_type: 'DEPARTURE', scheduled_at: '2026-10-21T00:00:00.000Z', participant_id: 'p2' });
    const mixed = [...withRecord({ departed_at: '2026-10-20T00:01:00.000Z' }), other];
    expect(ids(dropRecorded(mixed).kept)).toEqual(['wake', 'arr', 'other-dep']);
  });

  it('빼고 계획하면 폰에 이미 걸린 준비 · 출발은 "서버에 없음"으로 지워지고, 기상은 그대로 둠 (planReconcile)', () => {
    const { kept } = dropRecorded(withRecord({ departed_at: '2026-10-20T00:01:00.000Z' }));
    const server = buildServerPackages(kept);
    const phone = [
      onPhone('wake', Date.parse('2026-10-19T22:30:00.000Z')),
      onPhone('prep', Date.parse('2026-10-19T23:00:00.000Z'), { type: 'PREPARE' }),
      onPhone('dep', Date.parse('2026-10-20T00:00:00.000Z'), { type: 'DEPARTURE' }),
    ];
    const plan = planReconcile({ server, phone, nowMs: NOW });
    expect(plan.cancel.sort()).toEqual(['dep', 'prep']);
    expect(plan.schedule.map((p) => p.alarmId)).toEqual(['arr']); // 폰에 없는 도착 목표는 새로 걺 (이 시험의 폰에 없어서)
  });
});

describe('이번에 본 앞으로 알람의 참여 행 (upcomingParticipants)', () => {
  it('참여 행마다 하나, 약속 시각 빠른 순 — 일정 없는 알람 · 루틴 알람은 빠짐', () => {
    const late = { title: '저녁', appointment_at: '2026-10-21T10:00:00.123456+00:00', dest_name: null };
    const list = upcomingParticipants([
      row({ alarm_id: 'a1', alarm_type: 'WAKE', scheduled_at: '2026-10-21T08:00:00.000Z', participant_id: 'late', appointment: late }),
      row({ alarm_id: 'a2', alarm_type: 'DEPARTURE', scheduled_at: '2026-10-21T09:00:00.000Z', participant_id: 'late', appointment: late }),
      row({ alarm_id: 'b1', alarm_type: 'WAKE', scheduled_at: '2026-10-19T22:30:00.000Z', participant_id: 'early' }),
      row({ alarm_id: 'c1', alarm_type: 'WAKE', scheduled_at: '2026-10-20T22:30:00.000Z', participant_id: null, appointment: null }),
      row({ alarm_id: 'd1', alarm_type: 'ROUTINE', scheduled_at: '2026-10-20T22:30:00.000Z', participant_id: null, routine_id: 'r1', appointment: null, routine_title: '저녁 루틴' }),
    ]);
    expect(list).toEqual([
      { participantId: 'early', appointmentAt: '2026-10-20T01:00:00.000Z' },
      { participantId: 'late', appointmentAt: '2026-10-21T10:00:00.123Z' }, // 마이크로초는 밀리초 3자리로
    ]);
  });

  it('약속 시각을 읽을 수 없는 행은 뺌', () => {
    expect(upcomingParticipants([row({ alarm_id: 'x', alarm_type: 'WAKE', scheduled_at: '2026-10-19T22:30:00.000Z', appointment: { title: '?', appointment_at: '이상한 글자', dest_name: null } })])).toEqual([]);
  });
});
