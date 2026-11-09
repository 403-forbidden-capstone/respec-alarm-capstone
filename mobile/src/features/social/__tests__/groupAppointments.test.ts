import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createFake } from '../__fixtures__/fakeSupabase';
import { friends, groups, GROUP, JIHYEONG, JUNSEONG, ME, members, perms, profiles, SUYEON } from '../__fixtures__/seed';
import { appointmentStateText, HOME_MISSING_JOIN_ACTION, HOME_MISSING_JOIN_TOAST, INVITES_SHOWN, joinedCountText, leaveText, moreInvitesText } from '../groupTexts';
import * as real from '../real';

// 친구 9장 앱 층 — G02 연결 일정 (시험케이스 9-03 · 9-21 · 9-23 · 9-27 · 9-29 · 9-32 · 9-33 · 9-42)
//   인원수 · 참여 여부는 서버가 셈(group_appointment_counts · appointment_joiners) — 여기서는 호출 모양 · 화면 모양
const mockFake = createFake();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFake.client.from(table),
    rpc: (name: string, args?: unknown) => mockFake.client.rpc(name, args),
  },
}));
jest.mock('@/lib/user', () => ({ requireUserId: async () => '00000000-0000-4000-8000-000000000001' }));
jest.mock('@/lib/clock', () => ({ now: () => new Date('2026-10-20T00:00:00.000Z') })); // 한국 시간 10/20 09:00

const ok = (data: unknown) => ({ data, error: null });
const publicProfiles = profiles.map((p) => ({ user_id: p.user_id, nickname: p.nickname, handle: p.handle, profile_image_url: null }));

const AP_PAST = 'a0000000-0000-4000-8000-000000000001'; // 오늘 08:00 — 지남
const AP_NEXT = 'a0000000-0000-4000-8000-000000000002'; // 오늘 10:00
const AP_NOBODY = 'a0000000-0000-4000-8000-000000000003'; // 내일, 만든 사람 탈퇴
const appt = (appointment_id: string, at: string, creator_id: string | null, title = '팀 주간회의') => ({
  appointment_id,
  title,
  appointment_at: at,
  dest_name: '세종대학교',
  importance: 'NORMAL',
  creator_id,
});

beforeEach(() => {
  mockFake.reset();
  mockFake.answer('friends.select', ok(friends));
  mockFake.answer('groups.select', ok(groups));
  mockFake.answer('group_members.select', ok(members));
  mockFake.answer('sharing_permissions.select', ok(perms));
  mockFake.answerRpc('get_public_profiles', ok(publicProfiles));
  mockFake.answerRpc('get_group_wake', ok([]));
  mockFake.answer(
    'appointments.select',
    ok([appt(AP_PAST, '2026-10-19T23:00:00.000Z', JIHYEONG), appt(AP_NEXT, '2026-10-20T01:00:00.000Z', ME), appt(AP_NOBODY, '2026-10-21T01:00:00.000Z', null, '스터디')]),
  );
  mockFake.answerRpc(
    'group_appointment_counts',
    ok([
      { appointment_id: AP_PAST, joined_count: 2, i_joined: true },
      { appointment_id: AP_NEXT, joined_count: 3, i_joined: true },
      { appointment_id: AP_NOBODY, joined_count: 0, i_joined: false },
    ]),
  );
});

describe('G02 연결 일정 줄 (9-03 · 9-23 · 9-27 · 9-32 · 9-42)', () => {
  it('인원수 = 서버가 센 참여 수, 내 참여 · 지난 약속 · 만든 사람(나 · 알 수 없음)', async () => {
    const g = await real.getGroup(GROUP);
    expect(g?.appointments.map((a) => [a.id, a.joinedCount, a.iJoined, a.past, a.mine, a.creatorUnknown])).toEqual([
      [AP_PAST, 2, true, true, false, false],
      [AP_NEXT, 3, true, false, true, false],
      [AP_NOBODY, 0, false, false, false, true],
    ]);
    expect(mockFake.rpcCalls.filter((c) => c.name === 'group_appointment_counts').map((c) => c.args)).toEqual([{ p_group_id: GROUP }]);
    expect(mockFake.opsOf('appointments', 'select')[0].columns).toContain('creator_id');
  });

  it('인원수를 못 읽은 약속은 0명 · 안 참여로 (줄은 그대로)', async () => {
    mockFake.answerRpc('group_appointment_counts', ok([]));
    const g = await real.getGroup(GROUP);
    expect(g?.appointments.every((a) => a.joinedCount === 0 && !a.iJoined)).toBe(true);
  });

  it('줄 글자: 참여는 "참여", 안 누름 · 빠짐 · 끔은 모두 "알람 없음", 지난 약속은 "지난 약속이에요"(버튼 숨김)', () => {
    expect(appointmentStateText({ iJoined: true, past: false })).toBe('참여');
    expect(appointmentStateText({ iJoined: false, past: false })).toBe('알람 없음');
    expect(appointmentStateText({ iJoined: true, past: true })).toBe('지난 약속이에요');
    expect(appointmentStateText({ iJoined: false, past: true })).toBe('지난 약속이에요');
    expect(joinedCountText(3)).toBe('3명 참여');
    expect(joinedCountText(0)).toBe('보이는 참여자가 없어요');
  });
});

describe('탐색 시험 반영 문구 (X-BOUND-15 · 차단 쌍 0명 · 집 위치 없음)', () => {
  it('받은 초대는 3개까지 펼치고 나머지는 개수로 접음', () => {
    expect(INVITES_SHOWN).toBe(3);
    expect(moreInvitesText(47)).toBe('초대 47개 더 보기');
  });
  it('집 위치가 없을 때 [내 알람 만들기] 안내는 이유 + 설정 바로 가기', () => {
    expect(HOME_MISSING_JOIN_TOAST).toBe('집 위치를 먼저 정해 주세요');
    expect(HOME_MISSING_JOIN_ACTION).toBe('설정 열기');
  });
});

describe('참여자 줄 (9-21 · 9-33 · 9-42)', () => {
  it('참여 / 알람 없음 두 가지, 차단 쌍은 이름만(참여 여부 비움), 나 먼저', async () => {
    mockFake.answerRpc(
      'appointment_joiners',
      ok([
        { user_id: ME, joined: true, hidden: false },
        { user_id: SUYEON, joined: false, hidden: false }, // 빠졌거나 알람을 끔
        { user_id: JUNSEONG, joined: false, hidden: true }, // 차단 쌍
        { user_id: JIHYEONG, joined: true, hidden: false },
      ]),
    );
    const rows = await real.getAppointmentJoiners(AP_NEXT);
    expect(rows.map((r) => [r.person.name, r.isMe, r.state])).toEqual([
      ['나(데모)', true, 'JOINED'],
      ['수연', false, 'NO_ALARM'],
      ['준성', false, 'HIDDEN'],
      ['지형', false, 'JOINED'],
    ]);
    expect(mockFake.rpcCalls.filter((c) => c.name === 'appointment_joiners').map((c) => c.args)).toEqual([{ p_appointment_id: AP_NEXT }]);
  });
});

describe('그룹 나가기 확인 창 n (9-29)', () => {
  it('앞으로 약속 중 내가 참여한 것만 셈 — 지난 약속 기록은 남음', async () => {
    const g = await real.getGroup(GROUP);
    const n = g!.appointments.filter((a) => a.iJoined && !a.past).length;
    expect(n).toBe(1);
    expect(leaveText('캡스톤팀', n, false).body).toContain('공동 약속 알람 1개');
  });
});
