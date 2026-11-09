import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createFake, type Op } from '../__fixtures__/fakeSupabase';
import { F_SUYEON, friends, GROUP, groups, JIHYEONG, JUNSEONG, ME, members, perms, profiles, SUYEON } from '../__fixtures__/seed';
import { UserError } from '@/lib/errors';

import * as real from '../real';

// 쿼리 · 쓰기 순서 시험 — 가짜 supabase로 "어느 표에 무엇을 어떤 조건으로" 읽고 썼는지만 확인 (RLS · 실제 응답 모양은 실제 Supabase에서)
const mockFake = createFake();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFake.client.from(table),
    rpc: (name: string, args?: unknown) => mockFake.client.rpc(name, args),
  },
}));
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
        grants: { viewAlarm: false, editAlarm: false, viewWake: true },
      },
    ]);
    // 날짜를 안 주면 p_date 없이 → 함수가 내 시간대의 오늘
    expect(mockFake.rpcCalls.filter((c) => c.name === 'get_group_wake').map((c) => c.args)).toEqual([{ p_group_id: GROUP }]);
  });

  it('기상 신호가 알려 준 날은 그대로 p_date로', async () => {
    mockFake.answerRpc('get_group_wake', ok([]));
    await real.listGroups('2026-10-20');
    await real.getGroupSummary(GROUP, '2026-10-20');
    await real.getGroup(GROUP, '2026-10-20');
    await real.getMemberWake(GROUP, SUYEON, '2026-10-20');
    const dates = mockFake.rpcCalls.filter((c) => c.name === 'get_group_wake').map((c) => (c.args as { p_date?: string }).p_date);
    expect(dates).toEqual(['2026-10-20', '2026-10-20', '2026-10-20', '2026-10-20']);
  });

  it('홈 요약: 나 먼저, 줄이 없는 멤버는 공유 안 함, 일어난 수는 기상 확인만', async () => {
    mockFake.answerRpc('get_group_wake', ok(wake));
    const summary = await real.getGroupSummary(GROUP);
    expect(summary?.wokeCount).toBe(2);
    expect(summary?.members.map((m) => [m.person.name, m.state.text])).toEqual([
      ['나(데모)', '일어났어요 오전 7:35'],
      ['수연', '일어났어요 오전 7:31'],
      ['준성', '공유 안 함'], // 동의가 꺼져 있어 함수가 안 줌
      ['지형', '울렸어요'],
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
    expect(await real.getShareSettings(`group:${GROUP}`)).toEqual({ viewAlarm: false, editAlarm: false, viewWake: true });
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

  it('그룹에 저장(D18 열림): 지금 참여 중인 다른 구성원마다 행을 씀, 나는 빼고', async () => {
    await real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: true });
    const [op] = mockFake.opsOf('sharing_permissions', 'upsert');
    const rows = op.payload as { grantee_id: string; source_type: string; source_id: string; can_view_alarm: boolean; can_view_wake: boolean }[];
    expect(rows.map((r) => r.grantee_id)).toEqual([SUYEON, JUNSEONG, JIHYEONG]);
    expect(rows.every((r) => r.source_type === 'GROUP' && r.source_id === GROUP && r.can_view_alarm && r.can_view_wake)).toBe(true);
  });

  it('저장은 기상 공유 동의를 건드리지 않음 (D19 열림)', async () => {
    await real.saveShareSettings(`group:${GROUP}`, { viewAlarm: false, editAlarm: false, viewWake: true });
    expect(mockFake.opsOf('group_members', 'update')).toHaveLength(0);
  });

  it('친구가 아니거나 참여 중이 아닌 관계에는 저장하지 않고 이유를 알림', async () => {
    await expect(real.saveShareSettings(`friend:${JUNSEONG}`, { viewAlarm: true, editAlarm: false, viewWake: false })).rejects.toThrow(UserError);
    await expect(real.saveShareSettings('group:99999999-0000-4000-8000-000000000000', { viewAlarm: true, editAlarm: false, viewWake: false })).rejects.toThrow(UserError);
    expect(mockFake.opsOf('sharing_permissions', 'upsert')).toHaveLength(0);
  });

  it('혼자인 그룹은 줄 사람이 없어 아무것도 쓰지 않음', async () => {
    mockFake.answer('group_members.select', ok(members.filter((m) => m.user_id === ME)));
    await real.saveShareSettings(`group:${GROUP}`, { viewAlarm: true, editAlarm: false, viewWake: false });
    expect(mockFake.opsOf('sharing_permissions', 'upsert')).toHaveLength(0);
  });

  it('쓰기 오류는 그대로 던짐 (화면은 기본 문구)', async () => {
    mockFake.answer('sharing_permissions.upsert', { data: null, error: new Error('rls') });
    await expect(real.saveShareSettings(`friend:${SUYEON}`, { viewAlarm: true, editAlarm: false, viewWake: false })).rejects.toThrow('rls');
  });

  it('받은 권한: 친구는 한 줄, 그룹은 구성원마다 (동의가 꺼진 사람의 기상 조회는 꺼진 값)', async () => {
    expect(await real.getReceived(`friend:${SUYEON}`)).toEqual([{ person: expect.objectContaining({ name: '수연' }), permissions: { viewAlarm: true, editAlarm: true, viewWake: true } }]);
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
    expect(wake?.state.text).toBe('일어났어요 오전 7:35');
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

  it('깨우기는 실데이터에서 보내지 않고 "준비 중"으로 안내 (D19 열림)', async () => {
    await expect(real.sendWakePing(SUYEON)).rejects.toThrow(new UserError('깨우기는 준비 중이에요'));
    expect(mockCallEdge).not.toHaveBeenCalled();
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
    await expect(real.proposeSharedAlarm(SUYEON, 'ap1', new Date('2026-10-19T22:00:00.000Z'))).resolves.toEqual({ notified: true });
    expect(mockFake.rpcCalls.find((c) => c.name === 'propose_alarm_time')?.args).toEqual({ p_alarm_id: 'w1', p_new_at: '2026-10-19T22:00:00.000Z' });
    expect(mockCallEdge).toHaveBeenCalledWith('notify', { kind: 'ALARM_CHANGED', targetUserId: SUYEON, alarmId: 'w1' });
    expect(mockFake.opsOf('alarms', 'update')).toHaveLength(0); // 상대 알람은 바로 고치지 않음 — 상대가 [적용]해야 바뀜
  });

  it('서버 거절은 이유를 알림: 곧 울릴 알람 · ±60분 · 같은 시각 · 권한 없음(안 보이는 알람과 구분 없음) — 알림은 부르지 않음 (10-파)', async () => {
    shareSetup();
    const try_ = (status: string) => {
      mockFake.answerRpc('propose_alarm_time', ok({ status }));
      return real.proposeSharedAlarm(SUYEON, 'ap1', new Date('2026-10-19T22:00:00.000Z'));
    };
    await expect(try_('TOO_SOON')).rejects.toThrow('곧 울릴 알람이라 지금은 제안할 수 없어요');
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
    await expect(real.proposeSharedAlarm(SUYEON, 'ap1', new Date('2026-10-19T22:00:00.000Z'))).resolves.toEqual({ notified: false });
  });

  it('이미 사라진 카드는 이유를 알림 (함수를 부르지 않음)', async () => {
    shareSetup();
    await expect(real.proposeSharedAlarm(SUYEON, 'gone', new Date())).rejects.toThrow(UserError);
    expect(mockFake.rpcCalls.filter((c) => c.name === 'propose_alarm_time')).toHaveLength(0);
  });

  it("보낸 제안 상태: '제안함'(대기 · 무시) · '반영됨'(적용)을 카드에 붙이고, 원래 시각을 같이 줌 (10-파)", async () => {
    const withOriginal = alarms.map((a) => (a.alarm_id === 'w1' ? { ...a, original_scheduled_at: '2026-10-19T22:45:00.000Z' } : a));
    mockFake.answerRpc('get_shared_alarm_appointments', ok(alarms.map((a) => ap(a.alarm_id))));
    mockFake.answer('alarms.select', ok(withOriginal));
    mockFake.answerRpc('sent_alarm_proposals', ok([{ proposal_id: 'pr1', alarm_id: 'w1', status: 'DISMISSED', from_at: '2026-10-19T22:30:00.000Z', to_at: '2026-10-19T22:00:00.000Z', created_at: '2026-10-19T12:00:00.000Z' }]));
    const [card] = (await real.getSharedAlarms(SUYEON))?.alarms ?? [];
    expect(card.proposal).toEqual({ status: 'DISMISSED', toAt: new Date('2026-10-19T22:00:00.000Z') });
    expect(card.originalAt).toEqual(new Date('2026-10-19T22:45:00.000Z'));
    expect(card.firstAlarmId).toBe('w1');
    expect(mockFake.rpcCalls.find((c) => c.name === 'sent_alarm_proposals')?.args).toEqual({ p_owner_id: SUYEON });
  });

  it('보낸 제안을 못 읽어도 카드는 열림 (제안 상태만 안 보임)', async () => {
    shareSetup();
    mockFake.answerRpc('sent_alarm_proposals', { data: null, error: new Error('rpc') });
    const [card] = (await real.getSharedAlarms(SUYEON))?.alarms ?? [];
    expect(card.proposal).toBeNull();
  });

  it('변경 기록: DB에 저장하지 않고 이번 실행 동안 바꾼 것만', async () => {
    shareSetup();
    mockFake.answerRpc('propose_alarm_time', ok({ status: 'OK' }));
    mockCallEdge.mockResolvedValue({ sent: 0 });
    const before = (await real.getShareLog()).length;
    await real.proposeSharedAlarm(SUYEON, 'ap1', new Date('2026-10-19T22:00:00.000Z'));
    const log = await real.getShareLog();
    expect(log).toHaveLength(before + 1);
    expect(log[log.length - 1].text).toBe('수연님 알람 시각 제안');
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
