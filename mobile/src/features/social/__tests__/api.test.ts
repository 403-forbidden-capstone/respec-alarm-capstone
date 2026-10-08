import { describe, expect, it } from '@jest/globals';

import { getFriendGrant, getMemberWake, getSharedAlarms } from '../api';

// 가짜 api가 실데이터(RLS · get_group_wake_status)와 같은 범위만 돌려주는지
describe('G03 그룹원 기상 상태', () => {
  it('같은 그룹 · 기상 조회 권한이 있으면 그룹 이름과 함께', async () => {
    const wake = await getMemberWake('cap', 'sy');
    expect(wake?.groupName).toBe('캡스톤팀');
    expect(wake?.timeline.map((e) => e.label)).toEqual(['알람 울림', '알람 해제', '기상 확인', '준비 시작']); // 오전 7:55까지
  });

  it('그 그룹 구성원이 아니면 null', async () => {
    expect(await getMemberWake('fam', 'sy')).toBeNull();
    expect(await getMemberWake('none', 'sy')).toBeNull();
  });

  it('기상 조회 권한을 받지 않았으면 null', async () => {
    expect(await getMemberWake('fam', 'mom')).toBeNull();
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

  it('모르는 사람이면 null', async () => {
    expect(await getFriendGrant('nobody')).toBeNull();
  });
});
