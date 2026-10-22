import { describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';
import { kst } from '@/mocks/data';

import {
  addItems,
  changedAlarms,
  chainLabel,
  dayHeading,
  earlierWakeOf,
  groupByDay,
  initialTime,
  isEvening,
  parseDayParam,
  pickCardAlarm,
  splitUpcoming,
  upcomingAlarms,
} from '../schedule';
import type { AlarmKind, AlarmTime, Appointment } from '../types';

const alarm = (kind: AlarmKind, minutes: number, enabled = true): AlarmTime => ({ id: `a1:${kind}`, kind, at: kst(22, minutes), enabled });
// 팀 주간회의: 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50
const chain = (enabled: Partial<Record<AlarmKind, boolean>> = {}) => [
  alarm('WAKE', 480, enabled.WAKE ?? true),
  alarm('PREPARE', 510, enabled.PREPARE ?? true),
  alarm('DEPARTURE', 540, enabled.DEPARTURE ?? true),
  alarm('ARRIVE', 590),
];
const appt = (id: string, at: Date) => ({ id, at }) as Appointment;

describe('H01 다음 알람 카드 — 큰 시각', () => {
  it('앞으로 울릴 첫 알람 (8시 10분이면 8시 기상이 아니라 8시 30분 준비)', () => {
    const picked = pickCardAlarm(chain(), kst(22, 490));
    expect([picked.alarm.kind, picked.passed]).toEqual(['PREPARE', false]);
    expect(pickCardAlarm(chain(), kst(22, 475)).alarm.kind).toBe('WAKE');
  });

  it('알람 시각과 같은 순간은 아직 안 지남', () => {
    expect(pickCardAlarm(chain(), kst(22, 480)).alarm.kind).toBe('WAKE');
  });

  it('꺼진 알람은 건너뜀', () => {
    expect(pickCardAlarm(chain({ WAKE: false }), kst(22, 475)).alarm.kind).toBe('PREPARE');
  });

  it('다 지났으면 켜진 첫 알람을 지남으로, 다 껐으면 첫 알람', () => {
    const passed = pickCardAlarm(chain(), kst(22, 600));
    expect([passed.alarm.kind, passed.passed]).toEqual(['WAKE', true]);
    const off = pickCardAlarm(chain({ WAKE: false, PREPARE: false, DEPARTURE: false }), kst(22, 475));
    expect([off.alarm.kind, off.passed]).toEqual(['WAKE', false]);
  });

  it('오른쪽 줄 — 지난 알람은 지남, 꺼진 알람은 꺼짐', () => {
    const t = kst(22, 490);
    const [wake, prepare] = chain({ PREPARE: false });
    expect(chainLabel(wake, t, formatTime(wake.at))).toBe('오전 8:00 기상 · 지남');
    expect(chainLabel(prepare, t, formatTime(prepare.at))).toBe('오전 8:30 준비 · 꺼짐');
    expect(chainLabel(chain()[2], t, '오전 9:00')).toBe('오전 9:00 출발');
  });
});

describe('울릴 알람 수', () => {
  it('도착 목표 · 꺼진 알람 · 지난 알람은 세지 않음 (저장 토스트의 N개 = 칩에 지남이 안 붙은 것)', () => {
    expect(upcomingAlarms(chain(), kst(22, 475)).map((x) => x.kind)).toEqual(['WAKE', 'PREPARE', 'DEPARTURE']);
    expect(upcomingAlarms(chain({ PREPARE: false }), kst(22, 475)).map((x) => x.kind)).toEqual(['WAKE', 'DEPARTURE']);
    expect(upcomingAlarms(chain(), kst(22, 495)).map((x) => x.kind)).toEqual(['PREPARE', 'DEPARTURE']);
    expect(upcomingAlarms(chain(), kst(22, 600))).toEqual([]);
  });
});

describe('H02 알람 목록 — 예정 · 지난 일정', () => {
  const list = [appt('p', kst(20, 600)), appt('a', kst(22, 480)), appt('b', kst(22, 1080)), appt('c', kst(23, 540))];

  it('오늘 0시부터는 예정, 그 앞은 지난 일정 (오늘 이미 지난 시각의 일정은 예정에 둠)', () => {
    const { upcoming, past } = splitUpcoming(list, kst(22, 1000));
    expect(upcoming.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(past.map((x) => x.id)).toEqual(['p']);
  });

  it('날짜별로 묶음', () => {
    expect(groupByDay(list).map((day) => day.map((x) => x.id))).toEqual([['p'], ['a', 'b'], ['c']]);
  });

  it('날짜 제목 — 오늘 · 내일 표시', () => {
    const t = kst(22, 475);
    expect(dayHeading(kst(22, 1080), t)).toBe('오늘 · 5월 22일 (목)');
    expect(dayHeading(kst(23, 540), t)).toBe('내일 · 5월 23일 (금)');
    expect(dayHeading(kst(24, 540), t)).toBe('5월 24일 (토)');
    expect(dayHeading(kst(21, 540), t)).toBe('5월 21일 (수)');
  });
});

describe('H03 바뀌는 알람', () => {
  it('시각이 달라진 기상 · 준비 · 출발을 전부 (도착 목표는 뺌)', () => {
    const after = [alarm('WAKE', 475), alarm('PREPARE', 505), alarm('DEPARTURE', 540), alarm('ARRIVE', 585)];
    const changes = changedAlarms(chain(), after);
    expect(changes.map((c) => [c.kind, formatTime(c.from), formatTime(c.to)])).toEqual([
      ['WAKE', '오전 8:00', '오전 7:55'],
      ['PREPARE', '오전 8:30', '오전 8:25'],
    ]);
    expect(changedAlarms(chain(), chain())).toEqual([]);
  });
});

describe('H05 처음 날짜 · 시각', () => {
  it('?date 값을 그날 0시로, 틀린 값은 null', () => {
    const day = parseDayParam('2025-05-22');
    expect(day).toEqual(kst(22, 0));
    expect(parseDayParam('2025-02-31')).toBeNull();
    expect(parseDayParam('5월 22일')).toBeNull();
    expect(parseDayParam(undefined)).toBeNull();
  });

  it('오후 2시, 이미 지났으면 다음 정각', () => {
    expect(initialTime(kst(23, 0), kst(22, 475))).toBe('14:00');
    expect(initialTime(kst(22, 0), kst(22, 475))).toBe('14:00');
    expect(initialTime(kst(22, 0), kst(22, 15 * 60 + 20))).toBe('16:00');
    expect(initialTime(kst(22, 0), kst(22, 14 * 60))).toBe('15:00');
    expect(initialTime(kst(22, 0), kst(22, 23 * 60 + 30))).toBe('23:59');
  });

  it('지난 날은 판단하지 않고 14:00 (날짜 고르기가 막음)', () => {
    expect(initialTime(kst(20, 0), kst(22, 475))).toBe('14:00');
  });

  it('준비물 — 쉼표로 여러 개, 빈 값 · 같은 이름은 건너뜀', () => {
    expect(addItems([], '노트북, 충전기,, ')).toEqual(['노트북', '충전기']);
    expect(addItems(['노트북'], ' 노트북 ')).toEqual(['노트북']);
    expect(addItems(['노트북'], '우산')).toEqual(['노트북', '우산']);
  });
});

describe('홈 저녁 전환 (D13)', () => {
  it('오후 6시부터 저녁', () => {
    expect(isEvening(kst(22, 17 * 60 + 59))).toBe(false);
    expect(isEvening(kst(22, 18 * 60))).toBe(true);
  });
});

describe('H05 같은 날 앞 일정의 기상 알람 (earlierWakeOf)', () => {
  // 5/22 10:00 팀 주간회의(기상 8:00) · 5/22 18:00 저녁약속(기상 없음)
  const meeting = { ...appt('a1', kst(22, 600)), title: '팀 주간회의', enabled: true, alarms: chain() } as Appointment;
  const dinner = { ...appt('a2', kst(22, 1080)), title: '저녁약속', enabled: true, alarms: chain().filter((x) => x.kind !== 'WAKE') } as Appointment;

  it('같은 날 앞 일정의 켜진 기상 알람 — 일정명과 알람 시각', () => {
    expect(earlierWakeOf(kst(22, 840), [dinner, meeting])).toEqual({ title: '팀 주간회의', at: kst(22, 480) });
  });

  it('앞 일정이 없거나(같은 시각 포함), 다른 날이면 없음', () => {
    expect(earlierWakeOf(kst(22, 600), [meeting])).toBeNull();
    expect(earlierWakeOf(kst(22, 540), [meeting])).toBeNull();
    expect(earlierWakeOf(kst(23, 840), [meeting])).toBeNull();
  });

  it('꺼 둔 일정 · 꺼 둔 기상 · 기상 없는 앞 일정 · 자기 자신은 안 셈', () => {
    expect(earlierWakeOf(kst(22, 840), [{ ...meeting, enabled: false }])).toBeNull();
    expect(earlierWakeOf(kst(22, 840), [{ ...meeting, alarms: chain({ WAKE: false }) }])).toBeNull();
    expect(earlierWakeOf(kst(22, 1200), [dinner])).toBeNull();
    expect(earlierWakeOf(kst(22, 840), [meeting], 'a1')).toBeNull();
  });
});
