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
  rang_at: null,
  snooze_count: 0,
  dismissed_at: null,
  wake_confirmed_at: null,
  missed_at: null,
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

  it('그룹 목록: 참여 중인 그룹마다 기상 수 · 내가 준 권한 · 기상 상태를 볼 수 있는지', async () => {
    mockFake.answerRpc('get_group_wake_status', ok(wake));
    expect(await real.listGroups()).toEqual([
      {
        id: GROUP,
        name: '캡스톤팀',
        initial: '캡',
        memberCount: 4,
        wokeCount: 2,
        grants: { viewAlarm: false, editAlarm: false, viewWake: true },
        canSeeWake: true,
      },
    ]);
    // 날짜를 안 주면 p_date 없이 → 함수가 내 시간대의 오늘
    expect(mockFake.rpcCalls.filter((c) => c.name === 'get_group_wake_status').map((c) => c.args)).toEqual([{ p_group_id: GROUP }]);
  });

  it('기상 신호가 알려 준 날은 그대로 p_date로', async () => {
    mockFake.answerRpc('get_group_wake_status', ok([]));
    await real.listGroups('2026-10-20');
    await real.getGroupSummary(GROUP, '2026-10-20');
    await real.getGroup(GROUP, '2026-10-20');
    await real.getMemberWake(GROUP, SUYEON, '2026-10-20');
    const dates = mockFake.rpcCalls.filter((c) => c.name === 'get_group_wake_status').map((c) => (c.args as { p_date?: string }).p_date);
    expect(dates).toEqual(['2026-10-20', '2026-10-20', '2026-10-20', '2026-10-20']);
  });

  it('홈 요약: 나 먼저, 행이 없는 멤버는 볼 수 없음, 기상 수는 기상 확인만', async () => {
    mockFake.answerRpc('get_group_wake_status', ok(wake));
    const summary = await real.getGroupSummary(GROUP);
    expect(summary?.wokeCount).toBe(2);
    expect(summary?.members.map((m) => [m.person.name, m.state.text])).toEqual([
      ['나(데모)', '기상 완료 · 오전 7:35'],
      ['수연', '기상 완료 · 오전 7:31'],
      ['준성', '기상 상태를 볼 수 없어요'], // 동의가 꺼져 있어 함수가 안 줌
      ['지형', '알람 울리는 중'],
    ]);
  });

  it('그 그룹 약속이 없는 날은 함수가 빈 결과 → 모두 "그룹 약속이 없어요", 기상 0명', async () => {
    mockFake.answerRpc('get_group_wake_status', ok([]));
    const summary = await real.getGroupSummary(GROUP);
    expect(summary?.wokeCount).toBe(0);
    expect(new Set(summary?.members.map((m) => m.state.text))).toEqual(new Set(['오늘은 그룹 약속이 없어요']));
  });

  it('내가 참여 중이 아닌 그룹은 null (함수도 부르지 않음)', async () => {
    expect(await real.getGroupSummary('99999999-0000-4000-8000-000000000000')).toBeNull();
    expect(await real.getGroup('99999999-0000-4000-8000-000000000000')).toBeNull();
    expect(mockFake.rpcCalls.filter((c) => c.name === 'get_group_wake_status')).toHaveLength(0);
  });

  it('상세: 연결 일정은 오늘부터 이 그룹 것만, 초대 코드 · 만든 사람 · 동의, 멤버가 준 권한', async () => {
    mockFake.answerRpc('get_group_wake_status', ok(wake));
    mockFake.answer('appointments.select', ok([{ appointment_id: 'ap1', title: '팀 주간회의', appointment_at: '2026-10-20T01:00:00.000Z', dest_name: '세종대학교', importance: 'NORMAL' }]));
    const g = await real.getGroup(GROUP);
    expect(g).toMatchObject({ id: GROUP, name: '캡스톤팀', since: '2026년 3월부터 함께하는 중', inviteCode: 'ABCD1234', isOwner: false, wakeShareOptIn: true });
    expect(g?.appointments).toEqual([{ id: 'ap1', title: '팀 주간회의', at: new Date('2026-10-20T01:00:00.000Z'), place: '세종대학교', importance: 'NORMAL' }]);
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

  it('내가 만든 그룹이면 isOwner', async () => {
    mockFake.answer('groups.select', ok(groups.map((g) => ({ ...g, owner_id: ME }))));
    mockFake.answerRpc('get_group_wake_status', ok([]));
    expect((await real.getGroup(GROUP))?.isOwner).toBe(true);
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
  const confirmed = wakeRow(SUYEON, {
    wake_status: 'CONFIRMED',
    rang_at: '2026-10-19T22:30:00.000Z',
    dismissed_at: '2026-10-19T22:32:00.000Z',
    wake_confirmed_at: '2026-10-19T22:35:00.000Z',
  });

  it('허용한 구성원이면 알람 카드 · 흐름 · 약속 줄', async () => {
    mockFake.answerRpc('get_group_wake_status', ok([wakeRow(ME), confirmed]));
    mockFake.answer('appointments.select', ok({ title: '팀 주간회의', dest_name: '세종대학교', appointment_at: '2026-10-20T01:00:00.000Z' }));
    const wake = await real.getMemberWake(GROUP, SUYEON);
    expect(wake).toMatchObject({ groupName: '캡스톤팀', noGroupAppointment: false });
    expect(wake?.person.name).toBe('수연');
    expect(wake?.alarm).toMatchObject({ appointmentLabel: '팀 주간회의 · 세종대학교 · 오전 10:00', chain: [{ label: '기상' }] });
    expect(wake?.timeline.map((e) => e.label)).toEqual(['알람 울림', '알람 해제', '기상 확인']);
    expect(wake?.firstAlarmAt?.toISOString()).toBe('2026-10-19T22:30:00.000Z');
    // 약속 줄은 기상 알람 뒤 하루 안의 이 그룹 약속 하나
    const [query] = mockFake.opsOf('appointments', 'select');
    expect(query.filters).toEqual([
      ['eq', 'group_id', GROUP],
      ['gte', 'appointment_at', '2026-10-19T22:30:00.000Z'],
      ['lt', 'appointment_at', '2026-10-20T22:30:00.000Z'],
    ]);
  });

  it('기상 조회를 허용하지 않았거나(동의 꺼짐) 구성원이 아니거나 나 자신이면 null — 함수도 부르지 않음', async () => {
    expect(await real.getMemberWake(GROUP, JUNSEONG)).toBeNull();
    expect(await real.getMemberWake(GROUP, ME)).toBeNull();
    expect(await real.getMemberWake(GROUP, 'nobody')).toBeNull();
    expect(await real.getMemberWake('99999999-0000-4000-8000-000000000000', SUYEON)).toBeNull();
    expect(mockFake.rpcCalls.filter((c) => c.name === 'get_group_wake_status')).toHaveLength(0);
  });

  it('허용은 했는데 그날 그룹 약속이 없으면 알람 없음과 구분해서 알림', async () => {
    mockFake.answerRpc('get_group_wake_status', ok([]));
    const wake = await real.getMemberWake(GROUP, SUYEON);
    expect(wake).toMatchObject({ alarm: null, timeline: [], firstAlarmAt: null, noGroupAppointment: true });
    expect(mockFake.opsOf('appointments')).toHaveLength(0);
  });

  it('약속이 있는 날 기상 알람이 없으면 alarm: null, 약속 없는 날 표시는 아님', async () => {
    mockFake.answerRpc('get_group_wake_status', ok([wakeRow(ME), wakeRow(SUYEON, { wake_status: 'NO_ALARM', wake_alarm_at: null })]));
    expect(await real.getMemberWake(GROUP, SUYEON)).toMatchObject({ alarm: null, noGroupAppointment: false });
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

  it('켜기 · 끄기: 기상 · 준비 · 출발 알람만 바꾸고(도착 목표 제외) 주인에게 알림', async () => {
    shareSetup();
    mockFake.answer('alarms.update', ok([{ alarm_id: 'w1' }, { alarm_id: 'p1' }, { alarm_id: 'd1' }]));
    mockCallEdge.mockResolvedValue({ sent: 1, failed: 0 });
    await expect(real.setSharedAlarmEnabled(SUYEON, 'ap1', false)).resolves.toEqual({ notified: true });
    const [update] = mockFake.opsOf('alarms', 'update');
    expect(update.payload).toEqual({ is_enabled: false });
    expect(update.filters).toEqual([['in', 'alarm_id', ['w1', 'p1', 'd1']]]);
    expect(mockCallEdge).toHaveBeenCalledWith('notify', {
      kind: 'ALARM_CHANGED',
      targetUserId: SUYEON,
      alarmId: 'w1',
      title: '공유한 알람이 바뀌었어요',
      body: "나(데모)님이 '팀 주간회의' 알람을 껐어요",
    });
  });

  it('켤 때는 아직 안 지난 알람만 켬 — 지난 기상 알람을 켜면 서버가 울린 적 없는 알람을 기상 미확인으로 기록하므로 (내 알람과 같은 규칙)', async () => {
    const mixed = [
      alarmRow('w1', 'WAKE', '2026-10-19T11:00:00.000Z', { is_enabled: false }), // 지금(12:00Z)보다 앞 = 지남
      alarmRow('p1', 'PREPARE', '2026-10-19T22:40:00.000Z', { is_enabled: false }),
      alarmRow('d1', 'DEPARTURE', '2026-10-19T23:50:00.000Z', { is_enabled: false }),
      alarmRow('a1', 'ARRIVE', '2026-10-20T00:50:00.000Z'),
    ];
    mockFake.answerRpc('get_shared_alarm_appointments', ok(mixed.map((a) => ap(a.alarm_id))));
    mockFake.answer('alarms.select', ok(mixed));
    mockFake.answer('alarms.update', ok([{ alarm_id: 'p1' }, { alarm_id: 'd1' }]));
    mockCallEdge.mockResolvedValue({ sent: 1, failed: 0 });
    await expect(real.setSharedAlarmEnabled(SUYEON, 'ap1', true)).resolves.toEqual({ notified: true });
    const [update] = mockFake.opsOf('alarms', 'update');
    expect(update.payload).toEqual({ is_enabled: true });
    expect(update.filters).toEqual([
      ['in', 'alarm_id', ['p1', 'd1']],
      ['gt', 'scheduled_at', '2026-10-19T12:00:00.000Z'],
    ]);

    // 끄는 것은 지난 알람도 포함해 전부
    mockFake.reset();
    mockFake.answerRpc('get_shared_alarm_appointments', ok(mixed.map((a) => ap(a.alarm_id))));
    mockFake.answer('alarms.select', ok(mixed));
    mockFake.answer('alarms.update', ok([{ alarm_id: 'w1' }, { alarm_id: 'p1' }, { alarm_id: 'd1' }]));
    mockFake.answer('friends.select', ok(friends));
    mockFake.answer('groups.select', ok(groups));
    mockFake.answer('group_members.select', ok(members));
    mockFake.answer('sharing_permissions.select', ok(perms));
    mockFake.answerRpc('get_public_profiles', ok(publicProfiles));
    await real.setSharedAlarmEnabled(SUYEON, 'ap1', false);
    expect(mockFake.opsOf('alarms', 'update')[0].filters).toEqual([['in', 'alarm_id', ['w1', 'p1', 'd1']]]);
  });

  it('켤 알람이 모두 지났으면 쓰지 않고 이유를 알림 (내 알람과 같은 문구)', async () => {
    const past = [
      alarmRow('w1', 'WAKE', '2026-10-19T09:00:00.000Z', { is_enabled: false }),
      alarmRow('p1', 'PREPARE', '2026-10-19T10:00:00.000Z', { is_enabled: false }),
      alarmRow('d1', 'DEPARTURE', '2026-10-19T11:00:00.000Z', { is_enabled: false }),
    ];
    mockFake.answerRpc('get_shared_alarm_appointments', ok(past.map((a) => ap(a.alarm_id))));
    mockFake.answer('alarms.select', ok(past));
    await expect(real.setSharedAlarmEnabled(SUYEON, 'ap1', true)).rejects.toThrow('켤 수 있는 알람이 없어요. 이미 지난 알람이거나 지워졌을 수 있어요');
    expect(mockFake.opsOf('alarms', 'update')).toHaveLength(0);
    expect(mockCallEdge).not.toHaveBeenCalled();
  });

  it('알림 본문은 서버 한도(200자) 안으로 — 약속 제목이 길면 줄임', async () => {
    const long = '가'.repeat(100);
    mockFake.answerRpc('get_shared_alarm_appointments', ok(alarms.map((a) => ({ ...ap(a.alarm_id), title: long }))));
    mockFake.answer('alarms.select', ok(alarms));
    mockFake.answer('alarms.update', ok([{ alarm_id: 'w1' }, { alarm_id: 'p1' }, { alarm_id: 'd1' }]));
    mockCallEdge.mockResolvedValue({ sent: 1, failed: 0 });
    await real.setSharedAlarmEnabled(SUYEON, 'ap1', false);
    const body = (mockCallEdge.mock.calls[0][1] as { body: string }).body;
    expect(body).toBe(`나(데모)님이 '${'가'.repeat(39)}…' 알람을 껐어요`);
    expect(body.length).toBeLessThanOrEqual(200);
  });

  it('알림이 실패해도 저장은 그대로, 던지지 않고 notified: false', async () => {
    shareSetup();
    mockFake.answer('alarms.update', ok([{ alarm_id: 'w1' }, { alarm_id: 'p1' }, { alarm_id: 'd1' }]));
    mockCallEdge.mockRejectedValue(new Error('network'));
    await expect(real.setSharedAlarmEnabled(SUYEON, 'ap1', true)).resolves.toEqual({ notified: false });
    // 푸시 토큰이 없어 못 보낸 경우도 같음 (sent: 0)
    mockCallEdge.mockReset();
    mockCallEdge.mockResolvedValue({ sent: 0, failed: 0, reason: 'NO_TOKENS' });
    await expect(real.setSharedAlarmEnabled(SUYEON, 'ap1', true)).resolves.toEqual({ notified: false });
  });

  it('권한이 없어 바뀐 행이 없으면(RLS) 이유를 알리고 알림은 보내지 않음', async () => {
    shareSetup();
    mockFake.answer('alarms.update', ok([]));
    await expect(real.setSharedAlarmEnabled(SUYEON, 'ap1', false)).rejects.toThrow(UserError);
    expect(mockCallEdge).not.toHaveBeenCalled();
  });

  it('이미 사라진 카드는 이유를 알림', async () => {
    shareSetup();
    await expect(real.setSharedAlarmEnabled(SUYEON, 'nope', false)).rejects.toThrow(UserError);
    expect(mockFake.opsOf('alarms', 'update')).toHaveLength(0);
  });

  it('±5분: 카드의 알람마다 시각을 옮기고 time_source를 MANUAL로 같이 씀 (주인의 다음 저장이 자동 시각으로 덮지 않게)', async () => {
    shareSetup();
    mockFake.answer('alarms.update', ok([{ alarm_id: 'x' }]));
    mockCallEdge.mockResolvedValue({ sent: 1, failed: 0 });
    await expect(real.shiftSharedAlarm(SUYEON, 'ap1', -5)).resolves.toEqual({ notified: true });
    const updates = mockFake.opsOf('alarms', 'update');
    expect(updates.map((u) => [u.filters[0][2], u.payload])).toEqual([
      ['w1', { scheduled_at: '2026-10-19T22:25:00.000Z', time_source: 'MANUAL' }],
      ['p1', { scheduled_at: '2026-10-19T22:35:00.000Z', time_source: 'MANUAL' }],
      ['d1', { scheduled_at: '2026-10-19T23:45:00.000Z', time_source: 'MANUAL' }],
    ]);
    expect(mockCallEdge).toHaveBeenCalledWith('notify', expect.objectContaining({ kind: 'ALARM_CHANGED', targetUserId: SUYEON, body: "나(데모)님이 '팀 주간회의' 알람을 5분 앞당겼어요" }));
  });

  describe('앞당기기 — 옮긴 시각이 지금 + 5분(서버 PAST_GRACE_MINUTES)보다 이르게 되면 거절', () => {
    // 지금 = 2026-10-19T12:00Z. 기상 알람이 지금 + wakeMin분, 준비는 + 10분 뒤, 출발은 + 90분 뒤
    const near = (wakeMin: number, over: Record<string, unknown> = {}) => {
      const at = (min: number) => new Date(Date.parse('2026-10-19T12:00:00.000Z') + min * 60_000).toISOString();
      const list = [alarmRow('w1', 'WAKE', at(wakeMin), over), alarmRow('p1', 'PREPARE', at(wakeMin + 10)), alarmRow('d1', 'DEPARTURE', at(wakeMin + 90)), alarmRow('a1', 'ARRIVE', at(wakeMin + 180))];
      mockFake.answerRpc('get_shared_alarm_appointments', ok(list.map((a) => ap(a.alarm_id))));
      mockFake.answer('alarms.select', ok(list));
      mockFake.answer('alarms.update', ok([{ alarm_id: 'x' }]));
    };

    it('5분 앞당기면 지금 + 5분 안쪽이 되는 켜진 알람이 있으면 아무것도 쓰지 않고 이유를 알림', async () => {
      near(8); // 기상이 8분 뒤 -> 3분 뒤가 됨
      await expect(real.shiftSharedAlarm(SUYEON, 'ap1', -5)).rejects.toThrow(new UserError('곧 울릴 알람이라 앞당길 수 없어요'));
      expect(mockFake.opsOf('alarms', 'update')).toHaveLength(0);
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('딱 지금 + 5분이 되는 것은 허용 (서버는 지금 + 5분보다 앞인 것만 지난 것으로 봄)', async () => {
      near(10); // 10분 뒤 -> 정확히 5분 뒤
      mockCallEdge.mockResolvedValue({ sent: 1 });
      await expect(real.shiftSharedAlarm(SUYEON, 'ap1', -5)).resolves.toEqual({ notified: true });
      expect(mockFake.opsOf('alarms', 'update')).toHaveLength(3);
    });

    it('이미 지난 알람이나 꺼 둔 알람은 걸리지 않음 — 지난 기상은 그대로 두고 나머지만 앞당길 수 있음', async () => {
      near(-30); // 기상은 30분 전에 지났고 준비는 20분 전, 출발은 60분 뒤
      mockCallEdge.mockResolvedValue({ sent: 0 });
      await expect(real.shiftSharedAlarm(SUYEON, 'ap1', -5)).resolves.toEqual({ notified: false });
      near(8, { is_enabled: false }); // 곧 울릴 수 있어도 꺼 둔 알람
      await expect(real.shiftSharedAlarm(SUYEON, 'ap1', -5)).resolves.toBeDefined();
    });

    it('늦추기는 검사하지 않음', async () => {
      near(1);
      mockCallEdge.mockResolvedValue({ sent: 1 });
      await expect(real.shiftSharedAlarm(SUYEON, 'ap1', 5)).resolves.toEqual({ notified: true });
    });
  });

  it('늦추기는 +분으로 옮기고, 알림이 안 가면 notified: false', async () => {
    shareSetup();
    mockFake.answer('alarms.update', ok([{ alarm_id: 'x' }]));
    mockCallEdge.mockResolvedValue({ sent: 0, failed: 0, reason: 'NO_TOKENS' });
    await expect(real.shiftSharedAlarm(SUYEON, 'ap1', 5)).resolves.toEqual({ notified: false });
    expect(mockFake.opsOf('alarms', 'update')[0].payload).toEqual({ scheduled_at: '2026-10-19T22:35:00.000Z', time_source: 'MANUAL' });
  });

  it('중간에 막히면 이미 옮긴 알람을 되돌려 기상 · 준비 · 출발 간격이 어긋나지 않게', async () => {
    shareSetup();
    let n = 0;
    mockFake.answer('alarms.update', (op: Op) => {
      n++;
      // 첫 번째 옮기기는 되고, 두 번째에서 막힘, 되돌리기 쓰기는 됨
      if (n === 2 && (op.payload as { time_source?: string }).time_source === 'MANUAL') return ok([]);
      return ok([{ alarm_id: 'x' }]);
    });
    await expect(real.shiftSharedAlarm(SUYEON, 'ap1', 5)).rejects.toThrow(UserError);
    const updates = mockFake.opsOf('alarms', 'update');
    expect(updates).toHaveLength(3); // w1 옮김, p1 막힘, w1 되돌림
    expect(updates[2].filters[0][2]).toBe('w1');
    expect(updates[2].payload).toEqual({ scheduled_at: '2026-10-19T22:30:00.000Z', time_source: 'AUTO' });
    expect(mockCallEdge).not.toHaveBeenCalled();
  });

  it('변경 기록: DB에 저장하지 않고 이번 실행 동안 바꾼 것만', async () => {
    shareSetup();
    mockFake.answer('alarms.update', ok([{ alarm_id: 'w1' }, { alarm_id: 'p1' }, { alarm_id: 'd1' }]));
    mockCallEdge.mockResolvedValue({ sent: 0 });
    const before = (await real.getShareLog()).length;
    await real.setSharedAlarmEnabled(SUYEON, 'ap1', false);
    const log = await real.getShareLog();
    expect(log).toHaveLength(before + 1);
    expect(log[log.length - 1].text).toBe('수연님 알람 끔');
  });
});

describe('새 UI용 함수', () => {
  it('그룹 만들기: 이름을 다듬어 만든 사람(나)으로 넣고 초대 코드를 돌려줌', async () => {
    mockFake.answer('groups.insert', ok({ group_id: 'g-new', invite_code: 'ZZZZ9999' }));
    await expect(real.createGroup('  스터디 모임 ')).resolves.toEqual({ id: 'g-new', inviteCode: 'ZZZZ9999' });
    const [op] = mockFake.opsOf('groups', 'insert');
    expect(op.payload).toEqual({ group_name: '스터디 모임', owner_id: ME });
    expect(op.returning).toBe(true);
    // 만든 사람이 참여(JOINED)로 들어가는 것은 DB 트리거(add_owner_as_member)가 함 — 앱은 구성원 행을 쓰지 않음
    expect(mockFake.opsOf('group_members', 'insert')).toHaveLength(0);
  });

  it('그룹 이름이 비었거나 50자를 넘으면 DB에 가지 않음', async () => {
    await expect(real.createGroup('   ')).rejects.toThrow(UserError);
    await expect(real.createGroup('가'.repeat(51))).rejects.toThrow(UserError);
    expect(mockFake.opsOf('groups', 'insert')).toHaveLength(0);
  });

  it('코드로 참여: 코드를 다듬어 DB 함수에 맡기고 그룹 id를 돌려줌, 틀린 코드는 이유를 알림', async () => {
    mockFake.answerRpc('join_group_by_invite_code', ok(GROUP));
    await expect(real.joinGroupByCode(' abcd1234 ')).resolves.toBe(GROUP);
    expect(mockFake.rpcCalls.find((c) => c.name === 'join_group_by_invite_code')?.args).toEqual({ p_invite_code: 'abcd1234' });
    mockFake.answerRpc('join_group_by_invite_code', { data: null, error: { code: 'P0001', message: '초대 코드가 맞지 않음' } });
    await expect(real.joinGroupByCode('nope')).rejects.toThrow(new UserError('초대 코드가 맞지 않아요'));
    mockFake.answerRpc('join_group_by_invite_code', { data: null, error: { code: '42501', message: 'login' } });
    await expect(real.joinGroupByCode('nope')).rejects.toMatchObject({ message: 'login' });
    await expect(real.joinGroupByCode('  ')).rejects.toThrow(UserError);
  });

  it('초대 코드 다시 만들기: 만든 사람만 (아니면 이유를 알림)', async () => {
    mockFake.answerRpc('regenerate_invite_code', ok('NEWCODE1'));
    await expect(real.regenerateInviteCode(GROUP)).resolves.toBe('NEWCODE1');
    expect(mockFake.rpcCalls.find((c) => c.name === 'regenerate_invite_code')?.args).toEqual({ p_group_id: GROUP });
    mockFake.answerRpc('regenerate_invite_code', { data: null, error: { code: '42501', message: 'owner only' } });
    await expect(real.regenerateInviteCode(GROUP)).rejects.toThrow(new UserError('그룹을 만든 사람만 초대 코드를 바꿀 수 있어요'));
  });

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
