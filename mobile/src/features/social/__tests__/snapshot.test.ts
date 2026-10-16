import { describe, expect, it } from '@jest/globals';

import { F_SUYEON, GROUP, JIHYEONG, JUNSEONG, ME, SUYEON, snapshot } from '../__fixtures__/seed';
import {
  canSeeWakeIn,
  friendBetween,
  friendIds,
  friendShareSet,
  givenTo,
  groupShareSet,
  joinedIds,
  myGroup,
  myGroups,
  myOptIn,
  personOf,
  receivedFrom,
  receivedRows,
  requestIds,
  sharedGroups,
} from '../snapshot';

// 데모 시드 상황(__fixtures__/seed.ts)에서 화면이 쓰는 값이 문서(screen-data-map)와 DB 판정 규칙대로 나오는지
const s = snapshot();

describe('친구 · 요청', () => {
  it('수락된 친구만, 이름순', () => {
    expect(friendIds(s)).toEqual([SUYEON, JIHYEONG]); // 수연 < 지형
  });

  it('받은 요청은 PENDING이고 받는 사람이 나인 것만', () => {
    expect(requestIds(s)).toEqual([JUNSEONG]);
    // 내가 보낸 대기 요청은 받은 요청이 아님
    const sent = snapshot({ friends: [{ friend_id: 'f', requester_id: ME, addressee_id: JUNSEONG, status: 'PENDING', requested_at: '2026-10-05T00:00:00.000Z' }] });
    expect(requestIds(sent)).toEqual([]);
  });

  it('받은 요청이 여럿이면 최근 요청이 위', () => {
    const many = snapshot({
      friends: [
        { friend_id: 'a', requester_id: SUYEON, addressee_id: ME, status: 'PENDING', requested_at: '2026-10-01T00:00:00.000Z' },
        { friend_id: 'b', requester_id: JUNSEONG, addressee_id: ME, status: 'PENDING', requested_at: '2026-10-09T00:00:00.000Z' },
      ],
    });
    expect(requestIds(many)).toEqual([JUNSEONG, SUYEON]);
  });

  it('친구 관계 찾기: 수락된 것만', () => {
    expect(friendBetween(s, SUYEON)?.friend_id).toBe(F_SUYEON);
    expect(friendBetween(s, JUNSEONG)).toBeUndefined(); // 대기 중
    expect(friendBetween(s, '99999999-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('공개 프로필을 모르는 사람은 알 수 없음', () => {
    expect(personOf(s, SUYEON)).toMatchObject({ name: '수연', initial: '수', handle: '@demo_suyeon' });
    expect(personOf(s, 'nobody')).toMatchObject({ name: '알 수 없음', short: '?', handle: null });
  });
});

describe('그룹', () => {
  it('내가 JOINED인 그룹만 (초대만 받았거나 나간 그룹은 아님)', () => {
    expect(myGroups(s).map((g) => g.group_id)).toEqual([GROUP]);
    const invited = snapshot({ members: s.members.map((m) => (m.user_id === ME ? { ...m, invite_status: 'INVITED' as const } : m)) });
    expect(myGroups(invited)).toEqual([]);
    expect(myGroup(invited, GROUP)).toBeUndefined();
  });

  it('참여 중인 사람: 나 먼저, 나머지는 이름순', () => {
    expect(joinedIds(s, GROUP)).toEqual([ME, SUYEON, JUNSEONG, JIHYEONG]);
  });

  it('같이 참여 중인 그룹 · 내 기상 공유 동의', () => {
    expect(sharedGroups(s, SUYEON).map((g) => g.group_name)).toEqual(['캡스톤팀']);
    expect(sharedGroups(s, '99999999-0000-4000-8000-000000000000')).toEqual([]);
    expect(myOptIn(s, GROUP)).toBe(true);
    expect(myOptIn(snapshot({ members: s.members.map((m) => (m.user_id === ME ? { ...m, wake_share_opt_in: false } : m)) }), GROUP)).toBe(false);
  });
});

describe('받은 권한 (이 사람이 나에게 준 것, 효력 있는 값)', () => {
  it('수연: 친구 + 캡스톤팀 두 줄, 친구 먼저', () => {
    const rows = receivedRows(s, SUYEON);
    expect(rows.map((r) => [r.source, r.sourceType, r.sourceId])).toEqual([
      ['친구', 'FRIEND', SUYEON], // 친구 출처의 sourceId는 상대 사람 id (types.ts GrantRow)
      ['캡스톤팀', 'GROUP', GROUP],
    ]);
    expect(receivedFrom(s, SUYEON)).toMatchObject({ viewAlarm: true, editAlarm: true, viewWake: true, count: 3 });
  });

  it('준성: 기상 공유 동의가 꺼져 있어 그룹의 기상 조회가 효력 없음', () => {
    expect(receivedFrom(s, JUNSEONG)).toMatchObject({ viewAlarm: false, editAlarm: false, viewWake: false, count: 0 });
    expect(receivedRows(s, JUNSEONG)).toHaveLength(1); // 행은 있고 값만 꺼짐
  });

  it('친구가 끊기면 그 친구 출처의 권한은 빠짐', () => {
    const cut = snapshot({ friends: s.friends.filter((f) => f.friend_id !== F_SUYEON) });
    expect(receivedRows(cut, SUYEON).map((r) => r.sourceType)).toEqual(['GROUP']);
  });

  it('내가 못 읽는 그룹(이름을 모르는)의 행은 버림', () => {
    expect(receivedRows(snapshot({ groups: [] }), SUYEON).map((r) => r.sourceType)).toEqual(['FRIEND']);
  });
});

describe('준 권한 (내가 이 사람에게 준 것)', () => {
  it('수연: 친구(조회) + 캡스톤팀(기상)을 합쳐 2개', () => {
    const final = givenTo(s, SUYEON);
    expect(final).toMatchObject({ viewAlarm: true, editAlarm: false, viewWake: true, count: 2 });
    expect(final.rows.map((r) => r.source)).toEqual(['친구', '캡스톤팀']);
  });

  it('준 사람인 내가 그 그룹에서 동의하지 않았으면 기상 조회는 효력 없음', () => {
    const noOptIn = snapshot({ members: s.members.map((m) => (m.user_id === ME ? { ...m, wake_share_opt_in: false } : m)) });
    expect(givenTo(noOptIn, SUYEON)).toMatchObject({ viewWake: false, count: 1 });
    // 내가 F03에서 본 값(적어 둔 그대로)은 그대로 켜져 있음
    expect(groupShareSet(noOptIn, GROUP).viewWake).toBe(true);
  });

  it('F03 내가 공유: 친구는 그 친구에게 준 값, 그룹은 멤버마다 쓴 행의 합집합', () => {
    expect(friendShareSet(s, SUYEON)).toEqual({ viewAlarm: true, editAlarm: false, viewWake: false });
    expect(friendShareSet(s, JIHYEONG)).toEqual({ viewAlarm: false, editAlarm: false, viewWake: false }); // 행 없음 = 공유 없음
    expect(groupShareSet(s, GROUP)).toEqual({ viewAlarm: false, editAlarm: false, viewWake: true });
  });

  it('멤버마다 값이 달라도 합집합으로 한 벌', () => {
    const mixed = snapshot({
      perms: [
        { owner_id: ME, grantee_id: SUYEON, source_type: 'GROUP', source_id: GROUP, can_view_alarm: true, can_edit_alarm: false, can_view_wake: false },
        { owner_id: ME, grantee_id: JIHYEONG, source_type: 'GROUP', source_id: GROUP, can_view_alarm: false, can_edit_alarm: false, can_view_wake: true },
      ],
    });
    expect(groupShareSet(mixed, GROUP)).toEqual({ viewAlarm: true, editAlarm: false, viewWake: true });
  });
});

describe('G01 canSeeWake — 다른 구성원 중 한 명이라도 나에게 기상 조회를 허용했는지', () => {
  it('수연 · 지형이 허용 → true', () => {
    expect(canSeeWakeIn(s, GROUP)).toBe(true);
  });

  it('허용한 사람이 동의를 껐거나 아무도 안 줬으면 false', () => {
    const none = snapshot({ perms: s.perms.filter((p) => p.grantee_id !== ME) });
    expect(canSeeWakeIn(none, GROUP)).toBe(false);
    const allOff = snapshot({ members: s.members.map((m) => ({ ...m, wake_share_opt_in: false })) });
    // 친구 출처(수연 · 지형)로 받은 기상 조회는 동의와 상관없이 인정 — 그룹 기상은 친구 권한으로도 보임
    expect(canSeeWakeIn(allOff, GROUP)).toBe(true);
    const groupOnly = snapshot({ members: allOff.members, perms: s.perms.filter((p) => p.source_type === 'GROUP') });
    expect(canSeeWakeIn(groupOnly, GROUP)).toBe(false);
  });
});
