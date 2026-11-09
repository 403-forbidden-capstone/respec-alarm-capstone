import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { UserError } from '@/lib/errors';
import { dayKey } from '@/lib/format';

import { createFake } from '../__fixtures__/fakeSupabase';
import { friends, groups, GROUP, JIHYEONG, JUNSEONG, ME, members, perms, profiles, SUYEON } from '../__fixtures__/seed';
import { alarmLine, NO_APPOINTMENT_STATE, NOT_SHARED_STATE, stageOf, wakeStateOf, wokeCountOf, type WakeRow } from '../map';
import { WAKE_HIDE_FAILED, WAKE_STALE_TEXT, wakeHideLabel, wakeHideToast, wokeLine } from '../wakeTexts';
import * as real from '../real';

// 친구 7장 앱 층 — 그룹 기상 상태 (시험케이스 7-02 · 7-06 · 7-13 · 7-15 · 7-17 · 7-18 · 7-34 · 7-38 · 7-39 · 7-41 · 7-42 · 7-43)
//   7-30(다시 연결 · 앱이 앞에 올 때) · 7-36(오프라인 문구)은 useGroupWake.test.ts
//   서버 판단(동의 · 숨김 · 차단 · 20분 · 30분 · 하루 기준)은 get_group_wake가 함 — 여기서는 6단계 → 화면 3단계 묶기 · 줄 글자 · 호출 모양
const mockFake = createFake();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFake.client.from(table),
    rpc: (name: string, args?: unknown) => mockFake.client.rpc(name, args),
  },
}));
jest.mock('@/lib/user', () => ({ requireUserId: async () => '00000000-0000-4000-8000-000000000001' }));

const ok = (data: unknown) => ({ data, error: null });
const publicProfiles = profiles.map((p) => ({ user_id: p.user_id, nickname: p.nickname, handle: p.handle, profile_image_url: null }));
const calls = (name: string) => mockFake.rpcCalls.filter((c) => c.name === name);

// get_group_wake 한 줄 — 칸 7개뿐 (미루기 횟수 · 알람 끈 시각 · 울린 시각 · 미확인 시각 없음, 7-37)
const row = (user_id: string, over: Partial<WakeRow> = {}) => ({
  user_id,
  nickname: '',
  profile_image_url: null,
  is_me: user_id === ME,
  wake_alarm_at: '2026-10-19T23:50:00.000Z', // 8:50 KST
  wake_confirmed_at: null,
  wake_status: 'SCHEDULED',
  ...over,
});

beforeEach(() => {
  mockFake.reset();
  mockFake.answer('friends.select', ok(friends));
  mockFake.answer('groups.select', ok(groups));
  mockFake.answer('group_members.select', ok(members));
  mockFake.answer('sharing_permissions.select', ok(perms));
  mockFake.answerRpc('get_public_profiles', ok(publicProfiles));
  mockFake.answerRpc('get_group_wake', ok([]));
});

describe('6단계 → 화면 3단계 (7-13 · 7-15 · 7-17 · 7-18 · 7-38 · 7-42)', () => {
  it('울림 · 해제 · 미확인은 모두 "울렸어요" — 해제만 한 것(7-15)도 일어남이 아님', () => {
    expect(['RINGING', 'DISMISSED', 'MISSED'].map(stageOf)).toEqual(['RANG', 'RANG', 'RANG']);
    for (const wake_status of ['RINGING', 'DISMISSED', 'MISSED']) {
      expect(wakeStateOf(row(SUYEON, { wake_status }), true)).toMatchObject({ stage: 'RANG', text: '울렸어요', dot: 'mid', woke: false });
    }
  });

  it('아직은 알람 시각 한 줄 "오전 8:50 알람", 일어남은 "일어났어요 오전 8:08"', () => {
    expect(wakeStateOf(row(SUYEON), true)).toMatchObject({ stage: 'SCHEDULED', text: '오전 8:50 알람', dot: 'zz', woke: false });
    expect(wakeStateOf(row(SUYEON, { wake_status: 'CONFIRMED', wake_confirmed_at: '2026-10-19T23:08:00.000Z' }), true)).toMatchObject({
      stage: 'WOKE',
      text: '일어났어요 오전 8:08',
      dot: 'ok',
      woke: true,
    });
  });

  it('약속은 있는데 알람이 없거나 기상 알람을 꺼 둠 → "알람 없음" 한 가지 (7-18)', () => {
    expect(wakeStateOf(row(SUYEON, { wake_status: 'NO_ALARM', wake_alarm_at: null }), true)).toMatchObject({ stage: 'NO_ALARM', text: '알람 없음' });
  });

  it('알 수 없는 단계 값은 "울렸어요"로 — 일어남으로 잘못 보이지 않게', () => {
    expect(wakeStateOf(row(SUYEON, { wake_status: 'SOMETHING_NEW' }), true)).toMatchObject({ stage: 'RANG', woke: false });
  });

  it('줄 글자에 "취침 중" · 미루기 횟수 · 준비 · 출발 · 도착이 없음 (7-42 · 7-d3)', () => {
    const texts = ['SCHEDULED', 'RINGING', 'DISMISSED', 'MISSED', 'CONFIRMED', 'NO_ALARM'].map(
      (wake_status) => wakeStateOf(row(SUYEON, { wake_status, wake_confirmed_at: '2026-10-19T23:08:00.000Z' }), true).text,
    );
    for (const t of texts) expect(t).not.toMatch(/취침|미루기|준비|출발|도착|미확인|해제/);
  });

  it('알람 시각 줄', () => {
    expect(alarmLine(new Date('2026-10-19T23:50:00.000Z'))).toBe('오전 8:50 알람');
    expect(alarmLine(null)).toBeNull();
  });
});

describe('공유 안 함 · 약속 없는 날 (7-02 · 7-06)', () => {
  it('그날 줄이 하나도 없으면 그룹 약속이 없는 날', () => {
    expect(wakeStateOf(undefined, false)).toBe(NO_APPOINTMENT_STATE);
    expect(NO_APPOINTMENT_STATE.text).toBe('오늘은 그룹 약속이 없어요');
  });

  it('약속 있는 날 줄이 없는 멤버(동의 안 함 · 숨김 · 차단)는 구분 없이 "공유 안 함", 색 점 없음', () => {
    expect(wakeStateOf(undefined, true)).toBe(NOT_SHARED_STATE);
    expect(NOT_SHARED_STATE).toMatchObject({ stage: 'NOT_SHARED', text: '공유 안 함', dot: null, woke: false });
  });

  it('G02 멤버 줄: 동의 안 한 준성 · 숨긴 지형은 "공유 안 함"', async () => {
    mockFake.answerRpc('get_group_wake', ok([row(ME), row(SUYEON, { wake_status: 'RINGING' })]));
    const g = await real.getGroup(GROUP);
    expect(g?.members.map((m) => [m.person.name, m.state.text])).toEqual([
      ['나(데모)', '오전 8:50 알람'],
      ['수연', '울렸어요'],
      ['준성', '공유 안 함'],
      ['지형', '공유 안 함'],
    ]);
  });
});

describe('G01 "오늘 n명 일어남" (7-34)', () => {
  it('약속 있는 날: 일어남 수(분모 없음), 상세의 일어남 수와 같음', async () => {
    const rows = [row(ME, { wake_status: 'CONFIRMED', wake_confirmed_at: '2026-10-19T23:00:00.000Z' }), row(SUYEON, { wake_status: 'DISMISSED' })];
    mockFake.answerRpc('get_group_wake', ok(rows));
    const [item] = await real.listGroups();
    expect(item.wokeCount).toBe(1);
    const g = await real.getGroup(GROUP);
    expect(g?.members.filter((m) => m.state.woke)).toHaveLength(1);
    expect(wokeLine(item.wokeCount)).toBe('오늘 1명 일어남');
    expect(wokeLine(0)).toBe('오늘 0명 일어남');
  });

  it('약속 없는 날은 null → 그 줄을 숨김', async () => {
    const [item] = await real.listGroups();
    expect(item.wokeCount).toBeNull();
    expect(wokeLine(null)).toBeNull();
    expect(wokeCountOf([])).toBeNull();
  });

  it('홈 요약도 같은 수', async () => {
    mockFake.answerRpc('get_group_wake', ok([row(ME, { wake_status: 'CONFIRMED', wake_confirmed_at: '2026-10-19T23:00:00.000Z' })]));
    expect((await real.getGroupSummary(GROUP))?.wokeCount).toBe(1);
  });
});

describe('읽기는 get_group_wake (7-39 · 7-37)', () => {
  it('옛 함수(get_group_wake_status)는 안 부르고, 날짜를 주면 p_date로', async () => {
    const day = dayKey(new Date());
    await real.listGroups(day);
    await real.getGroupSummary(GROUP, day);
    await real.getGroup(GROUP, day);
    await real.getMemberWake(GROUP, SUYEON, day);
    expect(calls('get_group_wake_status')).toHaveLength(0);
    expect(calls('get_group_wake').map((c) => c.args)).toEqual(Array(4).fill({ p_group_id: GROUP, p_date: day }));
  });

  it('정정(잘못 누른 기상 확인을 고침)은 다음 조회 때 그대로 — 앱이 값을 붙잡아 두지 않음', async () => {
    mockFake.answerRpc('get_group_wake', ok([row(ME), row(SUYEON, { wake_status: 'CONFIRMED', wake_confirmed_at: '2026-10-19T23:08:00.000Z' })]));
    expect((await real.getGroup(GROUP))?.members[1].state.text).toBe('일어났어요 오전 8:08');
    mockFake.answerRpc('get_group_wake', ok([row(ME), row(SUYEON, { wake_status: 'DISMISSED' })]));
    expect((await real.getGroup(GROUP))?.members[1].state.text).toBe('울렸어요');
  });
});

describe('G03 기상 상태 (7-41 · 7-06 · 7-02)', () => {
  it('알람 시각 한 줄 · 확인 시각만, 알람 카드(강도 · 장소 · 준비)는 없음 — 알람 조회 권한이 있으면 [알람 보기]로', async () => {
    mockFake.answerRpc('get_group_wake', ok([row(ME), row(SUYEON, { wake_status: 'CONFIRMED', wake_confirmed_at: '2026-10-19T23:08:00.000Z' })]));
    const w = await real.getMemberWake(GROUP, SUYEON);
    expect(w).toEqual({
      person: expect.objectContaining({ name: '수연' }),
      groupName: '캡스톤팀',
      state: expect.objectContaining({ stage: 'WOKE', text: '일어났어요 오전 8:08' }),
      alarmAt: new Date('2026-10-19T23:50:00.000Z'),
      confirmedAt: new Date('2026-10-19T23:08:00.000Z'),
      canViewAlarm: true, // 수연 → 나 친구 출처 조회
      noGroupAppointment: false,
    });
    expect(mockFake.opsOf('appointments')).toHaveLength(0); // 일정 이름 · 장소는 안 읽음
  });

  it('기상 조회만 있는 사람(지형, 그룹 조회 없음 · 친구 조회 있음 → 조회 있음 / 준성은 공유 안 함)', async () => {
    mockFake.answerRpc('get_group_wake', ok([row(ME), row(JIHYEONG, { wake_status: 'RINGING' })]));
    const w = await real.getMemberWake(GROUP, JIHYEONG);
    expect(w?.state.text).toBe('울렸어요');
    expect(await real.getMemberWake(GROUP, JUNSEONG)).toBeNull(); // 약속 있는 날 줄이 없음 = 공유 안 함
  });

  it('그룹 약속이 없는 날은 null이 아니라 noGroupAppointment', async () => {
    const w = await real.getMemberWake(GROUP, SUYEON);
    expect(w).toMatchObject({ noGroupAppointment: true, alarmAt: null, confirmedAt: null, state: NO_APPOINTMENT_STATE });
  });

  it('그룹 밖 사람 · 나 자신은 null (함수도 안 부름)', async () => {
    expect(await real.getMemberWake(GROUP, '99999999-0000-4000-8000-000000000009')).toBeNull();
    expect(await real.getMemberWake(GROUP, ME)).toBeNull();
    expect(calls('get_group_wake')).toHaveLength(0);
  });
});

describe('이 사람에게 기상 숨기기 (7-43 · 7-06)', () => {
  it('G02 멤버 줄에 내가 숨긴 사람 표시 — wake_hides에서 내 줄만 읽음', async () => {
    mockFake.answer('wake_hides.select', ok([{ hidden_from_id: JIHYEONG }]));
    const g = await real.getGroup(GROUP);
    expect(g?.members.map((m) => [m.person.name, m.wakeHidden])).toEqual([
      ['나(데모)', false],
      ['수연', false],
      ['준성', false],
      ['지형', true],
    ]);
    expect(mockFake.opsOf('wake_hides', 'select')[0].columns).toBe('hidden_from_id');
  });

  it('set_wake_hidden으로만 씀 — 표에 직접 쓰지 않음', async () => {
    mockFake.answerRpc('set_wake_hidden', ok({ status: 'OK' }));
    await real.setWakeHidden(JIHYEONG, true);
    await real.setWakeHidden(JIHYEONG, false);
    expect(calls('set_wake_hidden').map((c) => c.args)).toEqual([
      { p_user_id: JIHYEONG, p_hidden: true },
      { p_user_id: JIHYEONG, p_hidden: false },
    ]);
    expect(mockFake.opsOf('wake_hides').filter((o) => o.kind !== 'select')).toHaveLength(0);
  });

  it('NOT_FOUND(관계 없음)는 이유 문구, 모르는 값 · 통신 오류는 그대로', async () => {
    mockFake.answerRpc('set_wake_hidden', ok({ status: 'NOT_FOUND' }));
    await expect(real.setWakeHidden(JIHYEONG, true)).rejects.toThrow(new UserError(WAKE_HIDE_FAILED));
    mockFake.answerRpc('set_wake_hidden', ok({ status: 'WHAT' }));
    await expect(real.setWakeHidden(JIHYEONG, true)).rejects.not.toBeInstanceOf(UserError);
    mockFake.answerRpc('set_wake_hidden', { data: null, error: { code: 'XX000', message: 'offline' } });
    await expect(real.setWakeHidden(JIHYEONG, true)).rejects.toMatchObject({ message: 'offline' });
  });

  it('메뉴 글자 · 토스트 — 상대에게 알리지 않는다는 말', () => {
    expect(wakeHideLabel(false)).toBe('이 사람에게 기상 숨기기');
    expect(wakeHideLabel(true)).toBe('이 사람에게 기상 보이기');
    expect(wakeHideToast('지형', true)).toBe('지형님에게 내 기상을 숨겼어요. 상대에게는 알리지 않아요');
    expect(wakeHideToast('지형', false)).toBe('지형님에게 내 기상이 다시 보여요');
  });
});

describe('오프라인 문구 (7-36)', () => {
  it('옛 값을 최신처럼 보이지 않게 하는 한 줄', () => {
    expect(WAKE_STALE_TEXT).toBe('연결이 끊겨 최신 상태가 아닐 수 있어요');
  });
});
