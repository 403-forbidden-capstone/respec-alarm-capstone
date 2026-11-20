import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createFake, type Op } from '../__fixtures__/fakeSupabase';
import { F_SUYEON, friends, GROUP, groups, JIHYEONG, JUNSEONG, ME, members, perms, profiles, SUYEON } from '../__fixtures__/seed';
import { UserError } from '@/lib/errors';
import { addDays, dayKey } from '@/lib/format';

import * as real from '../real';

// 쿼리 · 쓰기 순서 시험 — 가짜 supabase로 "어느 표에 무엇을 어떤 조건으로" 읽고 썼는지만 확인 (RLS · 실제 응답 모양은 실제 Supabase에서)
const mockFake = createFake();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFake.client.from(table),
    rpc: (name: string, args?: unknown) => mockFake.client.rpc(name, args),
  },
}));
jest.mock('@/lib/alarmSync', () => ({ afterEvent: async () => {} })); // 그룹 나가기 뒤 폰 정리는 시나리오 시험(__scenarios__)이 봄
jest.mock('@/lib/user', () => ({ requireUserId: async () => '00000000-0000-4000-8000-000000000001' }));
jest.mock('@/lib/clock', () => ({ now: () => new Date('2026-10-19T12:00:00.000Z') })); // 한국 시간 21:00

const mockCallEdge = jest.fn<(name: string, body?: Record<string, unknown>) => Promise<unknown>>();
jest.mock('@/lib/edge', () => ({ callEdge: (name: string, body?: Record<string, unknown>) => mockCallEdge(name, body) }));

const ok = (data: unknown) => ({ data, error: null });
const publicProfiles = profiles.map((p) => ({ user_id: p.user_id, nickname: p.nickname, handle: p.handle, profile_image_url: null }));

function seed() {
  mockFake.reset();
  mockCallEdge.mockReset();
  mockFake.answer('friends.select', ok(friends));
  mockFake.answer('groups.select', ok(groups));
  mockFake.answer('group_members.select', ok(members));
  mockFake.answer('sharing_permissions.select', ok(perms));
  mockFake.answerRpc('get_public_profiles', ok(publicProfiles));
}

const wakeRow = (user_id: string, over: Record<string, unknown> = {}) => ({
  user_id,
  nickname: '',
  profile_image_url: null,
  is_me: user_id === ME,
  wake_alarm_at: '2026-10-19T22:30:00.000Z',
  wake_confirmed_at: null,
  wake_status: 'SCHEDULED',
  ...over,
});

beforeEach(seed);

describe('읽기 공용', () => {
  it('같은 시각에 여러 함수가 불러도 친구 · 그룹 · 권한은 한 번만 읽음', async () => {
    await Promise.all([real.listFriends(), real.listFriendRequests(), real.listRelations()]);
    expect(mockFake.opsOf('friends', 'select')).toHaveLength(1);
    expect(mockFake.opsOf('sharing_permissions', 'select')).toHaveLength(1);
    expect(mockFake.rpcCalls.filter((c) => c.name === 'get_public_profiles')).toHaveLength(1);
    // 끝난 뒤 다시 부르면 새로 읽음 (오래된 값을 붙잡지 않음)
    await real.listFriends();
    expect(mockFake.opsOf('friends', 'select')).toHaveLength(2);
  });

  it('읽기 오류는 그대로 던짐', async () => {
    mockFake.answer('groups.select', { data: null, error: new Error('db down') });
    await expect(real.listGroups()).rejects.toThrow('db down');
  });
});

describe('F01 친구 · 요청', () => {
  it('친구 목록: 수락된 친구만 이름순, 권한 수는 내가 준 효력 있는 권한', async () => {
    const list = await real.listFriends();
    expect(list.map((f) => [f.person.name, f.grantCount])).toEqual([
      ['수연', 2], // 친구(조회) + 캡스톤팀(기상)
      ['지형', 1], // 캡스톤팀(기상)
    ]);
  });

  it('받은 요청', async () => {
    expect((await real.listFriendRequests()).map((p) => p.name)).toEqual(['준성']);
  });

});

describe('G01 · H01 · G02 그룹', () => {
  const wake = [
    wakeRow(ME, { wake_status: 'CONFIRMED', wake_confirmed_at: '2026-10-19T22:35:00.000Z' }),
    wakeRow(SUYEON, { wake_status: 'CONFIRMED', wake_confirmed_at: '2026-10-19T22:31:00.000Z' }),
    wakeRow(JIHYEONG, { wake_status: 'RINGING' }),
  ];

  it('그룹 목록: 참여 중인 그룹마다 오늘 일어난 수 · 내가 준 권한', async () => {
    mockFake.answerRpc('get_group_wake', ok(wake));
    expect(await real.listGroups()).toEqual([
      {
        id: GROUP,
        name: '캡스톤팀',
        initial: '캡',
        memberCount: 4,
        wokeCount: 2,
        trip: null,
        grants: { viewAlarm: false, editAlarm: false, viewWake: true, viewTrip: false },
      },
    ]);
    // 날짜를 안 주면 p_date 없이 → 함수가 내 시간대의 오늘
    expect(mockFake.rpcCalls.filter((c) => c.name === 'get_group_wake').map((c) => c.args)).toEqual([{ p_group_id: GROUP }]);
  });

  it('기상 신호가 알려 준 날은 그대로 p_date로', async () => {
    mockFake.answerRpc('get_group_wake', ok([]));
    const day = dayKey(new Date());
    await real.listGroups(day);
    await real.getGroupSummary(GROUP, day);
    await real.getGroup(GROUP, day);
    await real.getMemberWake(GROUP, SUYEON, day);
    const dates = mockFake.rpcCalls.filter((c) => c.name === 'get_group_wake').map((c) => (c.args as { p_date?: string }).p_date);
    expect(dates).toEqual([day, day, day, day]);
  });

  it('어제 · 내일은 그대로, 그 밖의 날짜는 p_date 없이 — 서버가 어제~내일만 받음', async () => {
    mockFake.answerRpc('get_group_wake', ok([]));
    const now = new Date();
    const yesterday = dayKey(addDays(now, -1));
    const tomorrow = dayKey(addDays(now, 1));
    for (const day of [yesterday, tomorrow, dayKey(addDays(now, -2)), dayKey(addDays(now, 2)), '2026-01-01']) await real.getGroupSummary(GROUP, day);
    const args = mockFake.rpcCalls.filter((c) => c.name === 'get_group_wake').map((c) => c.args);
    expect(args).toEqual([
      { p_group_id: GROUP, p_date: yesterday },
      { p_group_id: GROUP, p_date: tomorrow },
      { p_group_id: GROUP },
      { p_group_id: GROUP },
      { p_group_id: GROUP },
    ]);
  });

  it('홈 요약: 나 먼저, 줄이 없는 멤버는 공유 안 함, 일어난 수는 기상 확인만', async () => {
    mockFake.answerRpc('get_group_wake', ok(wake));
    const summary = await real.getGroupSummary(GROUP);
    expect(summary?.wokeCount).toBe(2);
    expect(summary?.members.map((m) => [m.person.name, m.state.text])).toEqual([
      ['나(데모)', '기상 완료 · 오전 7:35'],
      ['수연', '기상 완료 · 오전 7:31'],
      ['준성', '공유 안 함'], // 동의가 꺼져 있어 함수가 안 줌
      ['지형', '알람 울리는 중'],
    ]);
  });

  it('그 그룹 약속이 없는 날은 함수가 빈 결과 → 모두 "그룹 약속이 없어요", 일어난 수 줄 없음(null)', async () => {
    mockFake.answerRpc('get_group_wake', ok([]));
    const summary = await real.getGroupSummary(GROUP);
    expect(summary?.wokeCount).toBeNull();
    expect(new Set(summary?.members.map((m) => m.state.text))).toEqual(new Set(['오늘은 그룹 약속이 없어요']));
  });

  it('내가 참여 중이 아닌 그룹은 null (함수도 부르지 않음)', async () => {
    expect(await real.getGroupSummary('99999999-0000-4000-8000-000000000000')).toBeNull();
    expect(await real.getGroup('99999999-0000-4000-8000-000000000000')).toBeNull();
    expect(mockFake.rpcCalls.filter((c) => c.name === 'get_group_wake')).toHaveLength(0);
  });

  it('상세: 연결 일정은 오늘부터 이 그룹 것만, 초대 코드 · 만든 사람 · 동의, 멤버가 준 권한', async () => {
    mockFake.answerRpc('get_group_wake', ok(wake));
    mockFake.answer('appointments.select', ok([{ appointment_id: 'ap1', title: '팀 주간회의', appointment_at: '2026-10-20T01:00:00.000Z', dest_name: '세종대학교', importance: 'NORMAL' }]));
    const g = await real.getGroup(GROUP);
    expect(g).toMatchObject({ id: GROUP, name: '캡스톤팀', since: '2026년 4월부터 함께하는 중', wakeShareOptIn: true, notificationsOff: false });
    expect(g?.appointments).toEqual([
      { id: 'ap1', title: '팀 주간회의', at: new Date('2026-10-20T01:00:00.000Z'), place: '세종대학교', importance: 'NORMAL', joinedCount: 0, iJoined: false, past: false, mine: false, creatorUnknown: true },
    ]); // 인원수 · 만든 사람은 groupAppointments.test.ts
    const [query] = mockFake.opsOf('appointments', 'select');
    expect(query.filters).toEqual([
      ['eq', 'group_id', GROUP],
      ['gte', 'appointment_at', '2026-10-18T15:00:00.000Z'], // 한국 시간 오늘 0시
    ]);
    expect(g?.members.map((m) => [m.person.name, m.isMe, m.received.viewWake])).toEqual([
      ['나(데모)', true, false],
      ['수연', false, true],
      ['준성', false, false], // 동의가 꺼져 있어 기상 조회가 효력 없음
      ['지형', false, true],
    ]);
  });
});

describe('F02 · F03 권한', () => {
  it('F02: 친구가 아니면 null, 친구면 내가 준 권한을 출처별로 합침', async () => {
    expect(await real.getFriendGrant(JUNSEONG)).toBeNull(); // 대기 중 요청
    expect(await real.getFriendGrant(ME)).toBeNull();
    const grant = await real.getFriendGrant(SUYEON);
    expect(grant?.person.name).toBe('수연');
    expect(grant?.groupCount).toBe(1);
    expect(grant?.final).toMatchObject({ viewAlarm: true, editAlarm: false, viewWake: true, count: 2 });
    expect(grant?.final.rows.map((r) => r.source)).toEqual(['친구', '캡스톤팀']);
  });

  it('관계 고르기: 그룹 먼저, 그다음 친구', async () => {
    expect(await real.listRelations()).toEqual([
      { id: `group:${GROUP}`, kind: 'group', label: '캡스톤팀', sub: '그룹 · 멤버 4명', initial: '캡' },
      { id: `friend:${SUYEON}`, kind: 'friend', label: '수연', sub: '친구', initial: '수' },
      { id: `friend:${JIHYEONG}`, kind: 'friend', label: '지형', sub: '친구', initial: '지' },
    ]);
    expect((await real.getRelation(`friend:${SUYEON}`))?.label).toBe('수연');
    expect(await real.getRelation('friend:nobody')).toBeNull();
  });

  it('내가 공유하는 값', async () => {
    expect(await real.getShareSettings(`friend:${SUYEON}`)).toEqual({ viewAlarm: true, editAlarm: false, viewWake: false });
    expect(await real.getShareSettings(`group:${GROUP}`)).toEqual({ viewAlarm: false, editAlarm: false, viewWake: true, viewTrip: false });
    expect(await real.getShareSettings(`friend:${JUNSEONG}`)).toEqual({ viewAlarm: false, editAlarm: false, viewWake: false });
  });

  it('친구에게 저장: 그 친구와의 친구 관계 id를 출처로 한 행 하나를 upsert', async () => {
    await real.saveShareSettings(`friend:${SUYEON}`, { viewAlarm: true, editAlarm: true, viewWake: false });
    const [op] = mockFake.opsOf('sharing_permissions', 'upsert');
    expect(op.payload).toEqual({
      owner_id: ME,
      grantee_id: SUYEON,
      source_type: 'FRIEND',
      source_id: F_SUYEON,
      can_view_alarm: true,
      can_edit_alarm: true,
      can_view_wake: false,
    });
    expect(op.options).toEqual({ onConflict: 'owner_id,grantee_id,source_type,source_id' });
  });

  it('그룹에 저장: save_group_permissions 한 번 — 멤버마다 행을 따로 쓰지 않음 (6-14 · 6-15)', async () => {
    mockFake.answerRpc('save_group_permissions', ok({ status: 'OK', saved: 3 }));
    await real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: true });
    expect(mockFake.rpcCalls.filter((c) => c.name === 'save_group_permissions')).toEqual([
      { name: 'save_group_permissions', args: { p_group_id: GROUP, p_can_view_alarm: true, p_can_edit_alarm: false } },
    ]);
    expect(mockFake.opsOf('sharing_permissions', 'upsert')).toHaveLength(0);
  });

  it('설정만 켜서 보내도 조회를 같이 켬 (설정만 켠 행은 DB 제약이 거절) · 친구 관계도 같음', async () => {
    mockFake.answerRpc('save_group_permissions', ok({ status: 'OK', saved: 3 }));
    await real.saveShareSettings(`group:${GROUP}`, { viewAlarm: false, editAlarm: true, viewWake: true });
    expect(mockFake.rpcCalls.find((c) => c.name === 'save_group_permissions')?.args).toMatchObject({ p_can_view_alarm: true, p_can_edit_alarm: true });
    await real.saveShareSettings(`friend:${SUYEON}`, { viewAlarm: false, editAlarm: true, viewWake: false });
    const [op] = mockFake.opsOf('sharing_permissions', 'upsert');
    expect(op.payload).toMatchObject({ can_view_alarm: true, can_edit_alarm: true });
  });

  it('친구 관계는 기상 조회를 켜 보내도 항상 꺼서 씀 (친구 출처에는 기상 조회 없음)', async () => {
    await real.saveShareSettings(`friend:${SUYEON}`, { viewAlarm: true, editAlarm: false, viewWake: true });
    expect(mockFake.opsOf('sharing_permissions', 'upsert')[0].payload).toMatchObject({ can_view_wake: false });
  });

  it('그룹의 기상 스위치는 그룹 기상 공유 동의를 바꿈 — 값이 같으면 안 건드리고, 다르면 내 동의 한 줄만 (6-23)', async () => {
    mockFake.answerRpc('save_group_permissions', ok({ status: 'OK', saved: 3 }));
    mockFake.answer('group_members.update', ok([{ group_member_id: 'gm1' }]));
    await real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: true }); // 내 동의가 이미 켜져 있음
    expect(mockFake.opsOf('group_members', 'update')).toHaveLength(0);
    await real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: false });
    const [op] = mockFake.opsOf('group_members', 'update');
    expect(op.payload).toEqual({ wake_share_opt_in: false, trip_share_opt_in: false }); // 기상 공유를 끄면 출발 · 도착 공유도 같이 끔
  });

  it('출발 · 도착 스위치는 내 trip_share_opt_in 한 줄 — 기상 공유를 같이 끄면 한 번에 끄고, 기상이 꺼진 채로는 못 켬', async () => {
    mockFake.answerRpc('save_group_permissions', ok({ status: 'OK', saved: 3 }));
    mockFake.answer('group_members.update', ok([{ group_member_id: 'gm1' }]));
    await real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: true, viewTrip: false }); // 이미 꺼져 있음
    expect(mockFake.opsOf('group_members', 'update')).toHaveLength(0);
    await real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: true, viewTrip: true });
    expect(mockFake.opsOf('group_members', 'update').map((o) => o.payload)).toEqual([{ trip_share_opt_in: true }]);
    expect((await real.getGroup(GROUP))?.tripShareOptIn).toBe(false); // 시드의 내 줄은 꺼짐
  });

  it('그룹 권한 저장이 실패하면 기상 동의는 바꾸지 않고, 동의만 실패하면 그 사실을 알림 (알람 권한은 저장된 뒤)', async () => {
    mockFake.answerRpc('save_group_permissions', { data: null, error: new Error('rpc') });
    await expect(real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: false })).rejects.toThrow('rpc');
    expect(mockFake.opsOf('group_members', 'update')).toHaveLength(0);
    mockFake.answerRpc('save_group_permissions', ok({ status: 'OK', saved: 3 }));
    mockFake.answer('group_members.update', { data: null, error: new Error('rls') });
    await expect(real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: false })).rejects.toThrow(
      new UserError('알람 권한은 저장했지만 기상 공유 동의는 바꾸지 못했어요. 다시 저장해 주세요'),
    );
  });

  it('친구가 아니거나 참여 중이 아닌 관계에는 저장하지 않고 이유를 알림', async () => {
    await expect(real.saveShareSettings(`friend:${JUNSEONG}`, { viewAlarm: true, editAlarm: false, viewWake: false })).rejects.toThrow(UserError);
    await expect(real.saveShareSettings('group:99999999-0000-4000-8000-000000000000', { viewAlarm: true, editAlarm: false, viewWake: false })).rejects.toThrow(UserError);
    expect(mockFake.opsOf('sharing_permissions', 'upsert')).toHaveLength(0);
  });

  it('혼자인 그룹은 오류(UserError) — 가짜 성공 없음 (6-18)', async () => {
    mockFake.answerRpc('save_group_permissions', ok({ status: 'NO_MEMBERS' }));
    await expect(real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: false })).rejects.toThrow(
      new UserError('이 그룹에는 나 말고 멤버가 없어요. 멤버가 들어오면 권한을 줄 수 있어요'),
    );
    expect(mockFake.opsOf('group_members', 'update')).toHaveLength(0);
  });

  it('서버가 모르는 상태를 주면 성공으로 넘기지 않음 · 그룹이 사라졌으면(NOT_FOUND) 이유를 알림', async () => {
    mockFake.answerRpc('save_group_permissions', ok({ status: 'SOMETHING' }));
    await expect(real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: false })).rejects.toThrow();
    mockFake.answerRpc('save_group_permissions', ok({ status: 'NOT_FOUND' }));
    await expect(real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: false })).rejects.toBeInstanceOf(UserError);
  });

  it('쓰기 오류는 그대로 던짐 (화면은 기본 문구)', async () => {
    mockFake.answer('sharing_permissions.upsert', { data: null, error: new Error('rls') });
    await expect(real.saveShareSettings(`friend:${SUYEON}`, { viewAlarm: true, editAlarm: false, viewWake: false })).rejects.toThrow('rls');
  });

  it('받은 권한: 친구는 한 줄(기상 조회 없음), 그룹은 구성원마다 (기상 = 그 사람의 그룹 동의, 동의가 꺼진 사람은 꺼진 값)', async () => {
    expect(await real.getReceived(`friend:${SUYEON}`)).toEqual([{ person: expect.objectContaining({ name: '수연' }), permissions: { viewAlarm: true, editAlarm: true, viewWake: false } }]);
    expect(await real.getReceived(`friend:${JUNSEONG}`)).toEqual([]);
    const group = await real.getReceived(`group:${GROUP}`);
    expect(group.map((r) => [r.person.name, r.permissions])).toEqual([
      ['수연', { viewAlarm: true, editAlarm: false, viewWake: true }],
      ['준성', { viewAlarm: false, editAlarm: false, viewWake: false }],
      ['지형', { viewAlarm: false, editAlarm: false, viewWake: true }],
    ]);
  });
});

describe('G03 그룹원 기상 상태', () => {
  const confirmed = wakeRow(SUYEON, { wake_status: 'CONFIRMED', wake_confirmed_at: '2026-10-19T22:35:00.000Z' });

  it('줄이 있는 멤버면 단계 · 알람 시각 · 확인 시각 (약속 이름 · 장소는 안 읽음)', async () => {
    mockFake.answerRpc('get_group_wake', ok([wakeRow(ME), confirmed]));
    const wake = await real.getMemberWake(GROUP, SUYEON);
    expect(wake).toMatchObject({ groupName: '캡스톤팀', noGroupAppointment: false, canViewAlarm: true });
    expect(wake?.person.name).toBe('수연');
    expect(wake?.state.text).toBe('기상 완료 · 오전 7:35');
    expect(wake?.alarmAt?.toISOString()).toBe('2026-10-19T22:30:00.000Z');
    expect(mockFake.opsOf('appointments')).toHaveLength(0);
  });

  it('약속 있는 날 줄이 없으면(동의 꺼짐 · 숨김 · 차단) null, 구성원이 아니거나 나 자신이면 함수도 안 부르고 null', async () => {
    mockFake.answerRpc('get_group_wake', ok([wakeRow(ME), confirmed]));
    expect(await real.getMemberWake(GROUP, JUNSEONG)).toBeNull();
    seed();
    expect(await real.getMemberWake(GROUP, ME)).toBeNull();
    expect(await real.getMemberWake(GROUP, 'nobody')).toBeNull();
    expect(await real.getMemberWake('99999999-0000-4000-8000-000000000000', SUYEON)).toBeNull();
    expect(mockFake.rpcCalls.filter((c) => c.name === 'get_group_wake')).toHaveLength(0);
  });

  it('그날 그룹 약속이 없으면 공유 안 함과 구분해서 알림', async () => {
    mockFake.answerRpc('get_group_wake', ok([]));
    const wake = await real.getMemberWake(GROUP, SUYEON);
    expect(wake).toMatchObject({ alarmAt: null, confirmedAt: null, noGroupAppointment: true });
  });

  it('약속이 있는 날 기상 알람이 없으면 "알람 없음", 약속 없는 날 표시는 아님', async () => {
    mockFake.answerRpc('get_group_wake', ok([wakeRow(ME), wakeRow(SUYEON, { wake_status: 'NO_ALARM', wake_alarm_at: null })]));
    expect(await real.getMemberWake(GROUP, SUYEON)).toMatchObject({ alarmAt: null, noGroupAppointment: false, state: { text: '알람 없음' } });
  });

  it('깨우기: notify(WAKE_PING)에 받는 사람 + 어느 그룹 화면인지만 보내고, 서버가 준 ping 상태를 돌려줌 (8-01 · 8-06 · 8-17)', async () => {
    mockCallEdge.mockResolvedValue({ sent: 1, failed: 0, ping: { status: 'OK', count: 1, limit: 3, next_at: '2026-11-10T23:15:00.000Z' } });
    await expect(real.sendWakePing(GROUP, SUYEON)).resolves.toEqual({ status: 'OK', count: 1, limit: 3, nextAt: new Date('2026-11-10T23:15:00.000Z') });
    expect(mockCallEdge).toHaveBeenCalledWith('notify', { kind: 'WAKE_PING', targetUserId: SUYEON, groupId: GROUP });
  });
});

describe('G04 공유받은 알람', () => {
  const ap = (alarm_id: string) => ({ alarm_id, user_id: SUYEON, appointment_id: 'ap1', title: '팀 주간회의', dest_name: '세종대학교', appointment_at: '2026-10-20T01:00:00.000Z' });
  const alarmRow = (alarm_id: string, alarm_type: string, scheduled_at: string, over: Record<string, unknown> = {}) => ({
    alarm_id,
    alarm_type,
    scheduled_at,
    intensity: 'NORMAL',
    sound_key: 'theme_default',
    is_enabled: true,
    time_source: 'AUTO',
    ...over,
  });
  const alarms = [
    alarmRow('w1', 'WAKE', '2026-10-19T22:30:00.000Z'),
    alarmRow('p1', 'PREPARE', '2026-10-19T22:40:00.000Z'),
    alarmRow('d1', 'DEPARTURE', '2026-10-19T23:50:00.000Z'),
    alarmRow('a1', 'ARRIVE', '2026-10-20T00:50:00.000Z'),
  ];

  function shareSetup() {
    mockFake.answerRpc('get_shared_alarm_appointments', ok(alarms.map((a) => ap(a.alarm_id))));
    mockFake.answer('alarms.select', ok(alarms));
    mockFake.answer('alarms.update', ok([{ alarm_id: 'x' }]));
  }

  it('읽기: 조회 권한이 있으면 함수 + 알람을 읽어 카드로, 권한 꼬리표 포함', async () => {
    shareSetup();
    const shared = await real.getSharedAlarms(SUYEON);
    expect(shared).toMatchObject({ canView: true, canEdit: true, tags: ['조회 · 친구', '설정 · 친구', '조회 · 캡스톤팀'] });
    expect(shared?.alarms).toHaveLength(1);
    expect(shared?.alarms[0].chain.map((c) => c.label)).toEqual(['기상', '준비', '출발']);
    expect(mockFake.rpcCalls.find((c) => c.name === 'get_shared_alarm_appointments')?.args).toEqual({ p_owner_id: SUYEON });
    const [query] = mockFake.opsOf('alarms', 'select');
    expect(query.filters).toEqual([
      ['eq', 'user_id', SUYEON],
      ['in', 'alarm_id', ['w1', 'p1', 'd1', 'a1']],
    ]);
  });

  it('조회만 있으면 canEdit false, 조회 권한이 없으면 알람을 읽지 않고 빈 목록', async () => {
    shareSetup();
    expect(await real.getSharedAlarms(JIHYEONG)).toMatchObject({ canView: true, canEdit: false });
    mockFake.rpcCalls.length = 0;
    const none = await real.getSharedAlarms(JUNSEONG);
    expect(none).toMatchObject({ canView: false, canEdit: false, alarms: [], tags: [] });
    expect(mockFake.rpcCalls.filter((c) => c.name === 'get_shared_alarm_appointments')).toHaveLength(0);
  });

  it('모르는 사람 · 나 자신은 null', async () => {
    expect(await real.getSharedAlarms('99999999-0000-4000-8000-000000000000')).toBeNull();
    expect(await real.getSharedAlarms(ME)).toBeNull();
  });

  it('약속 시각이 지난 카드는 거름', async () => {
    mockFake.answerRpc('get_shared_alarm_appointments', ok(alarms.map((a) => ({ ...ap(a.alarm_id), appointment_at: '2026-10-19T01:00:00.000Z' }))));
    mockFake.answer('alarms.select', ok(alarms));
    expect((await real.getSharedAlarms(SUYEON))?.alarms).toEqual([]);
  });

  it('알람은 오늘 0시(한국) 이후 약속의 것만 읽음 — 함수가 주는 지난 이력이 .in() 목록에 쌓이지 않게', async () => {
    const old = [alarmRow('ow', 'WAKE', '2026-09-01T22:30:00.000Z'), alarmRow('op', 'PREPARE', '2026-09-01T22:40:00.000Z')];
    mockFake.answerRpc(
      'get_shared_alarm_appointments',
      ok([
        ...old.map((a) => ({ ...ap(a.alarm_id), appointment_id: 'old', appointment_at: '2026-09-02T01:00:00.000Z' })),
        ...alarms.map((a) => ap(a.alarm_id)),
        { ...ap('x'), appointment_id: 'earlier-today', appointment_at: '2026-10-18T15:00:00.000Z' }, // 오늘 0시 정각은 남김
        { ...ap('y'), appointment_id: 'yesterday', appointment_at: '2026-10-18T14:59:59.000Z' },
      ]),
    );
    mockFake.answer('alarms.select', ok([...old, ...alarms]));
    const shared = await real.getSharedAlarms(SUYEON);
    expect(mockFake.opsOf('alarms', 'select')[0].filters).toEqual([
      ['eq', 'user_id', SUYEON],
      ['in', 'alarm_id', ['w1', 'p1', 'd1', 'a1', 'x']],
    ]);
    expect(shared?.alarms).toHaveLength(1); // 화면 카드는 그대로 (앞으로의 약속 하나)
  });

  it('제안 보내기: 카드의 가장 이른 알람(기상) 기준 새 시각으로 propose_alarm_time, 성공하면 주인에게 알림(받는 사람 · 알람 id만)', async () => {
    shareSetup();
    mockFake.answerRpc('propose_alarm_time', ok({ status: 'OK', proposal_id: 'pr1', from_at: '2026-10-19T22:30:00.000Z', to_at: '2026-10-19T22:00:00.000Z' }));
    mockCallEdge.mockResolvedValue({ sent: 1, failed: 0 });
    await expect(real.proposeSharedAlarm(SUYEON, 'w1', new Date('2026-10-19T22:00:00.000Z'))).resolves.toEqual({ notified: true });
    expect(mockFake.rpcCalls.find((c) => c.name === 'propose_alarm_time')?.args).toEqual({ p_alarm_id: 'w1', p_new_at: '2026-10-19T22:00:00.000Z' });
    expect(mockCallEdge).toHaveBeenCalledWith('notify', { kind: 'ALARM_CHANGED', targetUserId: SUYEON, alarmId: 'w1' });
    expect(mockFake.opsOf('alarms', 'update')).toHaveLength(0); // 상대 알람은 바로 고치지 않음 — 상대가 [적용]해야 바뀜
  });

  it('서버 거절은 이유를 알림: 곧 울릴 알람 · ±60분 · 같은 시각 · 권한 없음(안 보이는 알람과 구분 없음) — 알림은 부르지 않음 (10-파)', async () => {
    shareSetup();
    const try_ = (status: string) => {
      mockFake.answerRpc('propose_alarm_time', ok({ status }));
      return real.proposeSharedAlarm(SUYEON, 'w1', new Date('2026-10-19T22:00:00.000Z'));
    };
    await expect(try_('TOO_SOON')).rejects.toThrow('곧 울릴 알람이라 지금은 제안할 수 없어요');
    await expect(try_('TOO_LATE')).rejects.toThrow('이대로면 약속에 늦어요');
    await expect(try_('LIMIT')).rejects.toThrow('원래 시각에서 1시간(±60분) 안에서만 제안할 수 있어요');
    await expect(try_('SAME')).rejects.toThrow('지금 시각과 같아요');
    await expect(try_('FORBIDDEN')).rejects.toThrow('이 알람은 바꿀 수 없어요');
    await expect(try_('SOMETHING_NEW')).rejects.toThrow();
    expect(mockCallEdge).not.toHaveBeenCalled();
  });

  it('알림이 실패해도 제안은 그대로, 던지지 않고 notified: false', async () => {
    shareSetup();
    mockFake.answerRpc('propose_alarm_time', ok({ status: 'OK' }));
    mockCallEdge.mockRejectedValue(new Error('오프라인'));
    await expect(real.proposeSharedAlarm(SUYEON, 'w1', new Date('2026-10-19T22:00:00.000Z'))).resolves.toEqual({ notified: false });
  });

  it('제안을 보낼 알람 = 켜져 있고 아직 안 울린 가장 이른 알람 — 기상이 이미 울렸거나 꺼졌으면 다음 알람, 하나도 없으면 시각 제안 불가 (10-18)', async () => {
    const at = (a: ReturnType<typeof alarmRow>[]) => {
      mockFake.answerRpc('get_shared_alarm_appointments', ok(a.map((x) => ap(x.alarm_id))));
      mockFake.answer('alarms.select', ok(a));
    };
    at([{ ...alarms[0], is_enabled: false }, alarms[1], alarms[2], alarms[3]]); // 기상만 꺼짐
    expect((await real.getSharedAlarms(SUYEON))?.alarms[0]).toMatchObject({ firstAlarmId: 'p1', proposeAt: new Date('2026-10-19T22:40:00.000Z') });
    at(alarms.map((x) => ({ ...x, is_enabled: false })));
    expect((await real.getSharedAlarms(SUYEON))?.alarms[0].firstAlarmId).toBeUndefined();
  });

  it("보낸 제안 상태: '제안함'(대기 · 무시는 서버가 대기로 돌려줌) · '반영됨'(적용)을 카드에 붙이고, 원래 시각을 같이 줌 (10-파)", async () => {
    const withOriginal = alarms.map((a) => (a.alarm_id === 'w1' ? { ...a, original_scheduled_at: '2026-10-19T22:45:00.000Z' } : a));
    mockFake.answerRpc('get_shared_alarm_appointments', ok(alarms.map((a) => ap(a.alarm_id))));
    mockFake.answer('alarms.select', ok(withOriginal));
    mockFake.answerRpc('sent_alarm_proposals', ok([{ proposal_id: 'pr1', alarm_id: 'w1', status: 'PENDING', from_at: '2026-10-19T22:30:00.000Z', to_at: '2026-10-19T22:00:00.000Z', created_at: '2026-10-19T12:00:00.000Z' }]));
    const [card] = (await real.getSharedAlarms(SUYEON))?.alarms ?? [];
    expect(card.proposal).toEqual({ status: 'PENDING', toAt: new Date('2026-10-19T22:00:00.000Z') });
    expect(card.originalAt).toEqual(new Date('2026-10-19T22:45:00.000Z'));
    expect(card.firstAlarmId).toBe('w1');
    expect(card.proposeAt).toEqual(new Date('2026-10-19T22:30:00.000Z'));
    expect(mockFake.rpcCalls.find((c) => c.name === 'sent_alarm_proposals')?.args).toEqual({ p_owner_id: SUYEON });
  });

  it('보낸 제안을 못 읽어도 카드는 열림 (제안 상태만 안 보임)', async () => {
    shareSetup();
    mockFake.answerRpc('sent_alarm_proposals', { data: null, error: new Error('rpc') });
    const [card] = (await real.getSharedAlarms(SUYEON))?.alarms ?? [];
    expect(card.proposal).toBeNull();
  });
});

describe('새 UI용 함수', () => {
  it('기상 공유 동의: 내 구성원 행만 고침, 바뀐 행이 없으면 이유를 알림', async () => {
    mockFake.answer('group_members.update', ok([{ group_member_id: 'm1' }]));
    await real.setWakeShareOptIn(GROUP, true);
    const [op] = mockFake.opsOf('group_members', 'update');
    expect(op.payload).toEqual({ wake_share_opt_in: true });
    expect(op.filters).toEqual([
      ['eq', 'group_id', GROUP],
      ['eq', 'user_id', ME],
      ['eq', 'invite_status', 'JOINED'],
    ]);
    mockFake.answer('group_members.update', ok([]));
    await expect(real.setWakeShareOptIn(GROUP, false)).rejects.toThrow(UserError);
  });
});
