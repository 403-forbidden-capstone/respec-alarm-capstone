import { describe, expect, it } from '@jest/globals';

import { db } from '@/mocks/data';

import { getFriendGrant, getGroup, getGroupCode, getMemberWake, getSharedAlarms } from '../api';

// 가짜 api가 실데이터(RLS · get_group_wake)와 같은 범위만 돌려주는지
describe('G03 그룹원 기상 상태', () => {
  it('같은 그룹에서 기상을 준 사람이면 그룹 이름 · 단계 · 알람 시각 (오전 7:55 시나리오)', async () => {
    const wake = await getMemberWake('cap', 'sy');
    expect(wake?.groupName).toBe('캡스톤팀');
    expect(wake?.state.text).toBe('준비 중 · 오전 7:38 시작'); // 수연은 출발 · 도착 공유를 켠 사람 — 7:38 준비 시작 체크
    expect(wake?.prepareStartedAt).not.toBeNull();
    expect(wake?.alarmAt).not.toBeNull();
    expect((await getMemberWake('cap', 'jh'))?.state.text).toBe('기상 완료 · 오전 7:30'); // 지형은 출발 · 도착 공유 꺼짐 — 기상 완료에서 멈춤
  });

  it('그 그룹 구성원이 아니면 null', async () => {
    expect(await getMemberWake('fam', 'sy')).toBeNull();
    expect(await getMemberWake('none', 'sy')).toBeNull();
    expect(await getMemberWake('cap', 'me')).toBeNull();
  });

  it('그 그룹 약속이 없는 날은 null이 아니라 noGroupAppointment (공유 안 함과 구분)', async () => {
    expect(await getMemberWake('fam', 'mom')).toMatchObject({ groupName: '우리 가족', noGroupAppointment: true, alarmAt: null });
  });

  it('약속 있는 날 기상을 안 준 사람은 null (공유 안 함)', async () => {
    const saved = db.received.js;
    db.received.js = [];
    try {
      expect(await getMemberWake('cap', 'js')).toBeNull();
      expect((await getGroup('cap'))?.members.find((m) => m.person.id === 'js')?.state.text).toBe('공유 안 함');
    } finally {
      db.received.js = saved;
    }
  });
});

describe('G02 그룹 상세', () => {
  it('연결 일정은 그 그룹에 묶인 것 모두, 초대 코드는 그룹마다 정해진 값', async () => {
    const cap = await getGroup('cap');
    expect(cap?.appointments.map((a) => a.id)).toEqual(['a1']);
    const extra = { ...db.appointments[0], id: 'a9', title: '발표 연습', groupId: 'cap' };
    db.appointments.push(extra);
    try {
      expect((await getGroup('cap'))?.appointments.map((a) => a.id)).toEqual(['a1', 'a9']);
    } finally {
      db.appointments.pop();
    }
    expect((await getGroup('fam'))?.appointments).toEqual([]);
    // 초대 코드는 8자(0 O 1 I 없음), 그룹마다 다름 — 상세에는 코드가 없고 코드 시트가 따로 읽음 (5장)
    const capCode = (await getGroupCode('cap')).code;
    expect(capCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect((await getGroupCode('fam')).code).not.toBe(capCode);
    expect(cap).not.toHaveProperty('inviteCode');
  });
});

describe('G04 공유받은 알람', () => {
  it('조회 · 설정 권한이 있으면 알람과 출처 꼬리표', async () => {
    const shared = await getSharedAlarms('sy');
    expect([shared?.canView, shared?.canEdit, shared?.alarms.length]).toEqual([true, true, 2]);
    expect(shared?.tags).toEqual(['조회 · 친구', '설정 · 친구', '조회 · 캡스톤팀']);
  });

  it('조회 권한이 없으면 알람을 비움', async () => {
    const shared = await getSharedAlarms('js');
    expect([shared?.canView, shared?.canEdit, shared?.alarms]).toEqual([false, false, []]);
  });
});

describe('F02 친구 권한', () => {
  it('친구 관계 + 같은 그룹 권한을 합침', async () => {
    const grant = await getFriendGrant('sy');
    expect(grant?.final.rows.map((r) => r.source)).toEqual(['친구', '캡스톤팀']);
    expect(grant?.final.count).toBe(3);
  });

  it('모르는 사람 · 친구가 아닌 그룹원 · 나는 null', async () => {
    expect(await getFriendGrant('nobody')).toBeNull();
    expect(await getFriendGrant('mom')).toBeNull();
    expect(await getFriendGrant('me')).toBeNull();
  });
});
