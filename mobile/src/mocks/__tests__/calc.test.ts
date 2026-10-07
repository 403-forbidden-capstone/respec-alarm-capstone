import { describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';

import { alarmChain, autoLevel, memberState, orGrants } from '../calc';
import { db, kst } from '../data';

const appointment = (id: string) => {
  const a = db.appointments.find((x) => x.id === id);
  if (!a) throw new Error(id);
  return a;
};
const times = (id: string) => alarmChain(appointment(id)).map((x) => `${x.kind} ${formatTime(x.at)}`);

// 목업 · 발표 자료의 숫자와 같은지 — 실제 계산(#32)을 만들 때 기준으로 씀
describe('ALG-01 알람 역산', () => {
  it('10시 팀 주간회의: 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50', () => {
    expect(times('a1')).toEqual(['WAKE 오전 8:00', 'PREPARE 오전 8:30', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
  });

  it('그날 첫 일정이 아니면 기상 없이 준비부터', () => {
    expect(times('a2')).toEqual(['PREPARE 오후 5:10', 'DEPARTURE 오후 5:35', 'ARRIVE 오후 5:55']);
  });
});

describe('ALG-02 강도', () => {
  it('중요 일정은 중, 최근 4주 늦잠 지각이 2회 이상이면 한 단계 올림', () => {
    expect(autoLevel(appointment('a1'))).toBe(1);
    expect(autoLevel(appointment('a2'))).toBe(0);
    db.lateCount4w = 2;
    try {
      expect(autoLevel(appointment('a1'))).toBe(2);
    } finally {
      db.lateCount4w = 1;
    }
  });
});

describe('ALG-03 권한 합집합', () => {
  it('관계 중 하나라도 허용하면 허용', () => {
    const f = orGrants([
      { source: '친구', sourceType: 'FRIEND', sourceId: 'sy', viewAlarm: true, editAlarm: true, viewWake: false },
      { source: '캡스톤팀', sourceType: 'GROUP', sourceId: 'cap', viewAlarm: true, editAlarm: false, viewWake: true },
    ]);
    expect([f.viewAlarm, f.editAlarm, f.viewWake, f.count]).toEqual([true, true, true, 3]);
  });
});

describe('그룹원 기상 상태', () => {
  const morning = kst(22, 475); // 오전 7:55

  it('오전 7:55 기준 마지막으로 일어난 일', () => {
    expect(memberState('sy', morning).text).toBe('준비 시작 · 오전 7:38');
    expect(memberState('jh', morning)).toEqual({ text: '기상 완료 · 오전 7:30', dot: 'ok', woke: true });
    expect(memberState('js', morning)).toEqual({ text: '취침 중 · 알람 8:50', dot: 'zz', woke: false });
    expect(memberState('me', morning).text).toBe('취침 중 · 알람 8:00');
  });

  it('전날 밤에는 내일 알람', () => {
    expect(memberState('sy', kst(21, 1260)).text).toBe('내일 알람 7:30');
  });
});
