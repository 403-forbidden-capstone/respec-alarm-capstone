import { describe, expect, it } from '@jest/globals';

import { HOME, needsAlarmSync, pushHref } from '../link';

// 알림 누르기 · 받기 (시험케이스 11-23 · 11-24, 세션약속 1절 푸시 종류 표)
const ME = 'me';
const G = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const base = { recipientUserId: ME };

describe('눌렀을 때 갈 화면', () => {
  it('종류별 서버 path → 앱 화면: 내 기상 확인 · 받은 알람 · 친구(그룹 탭) · 그룹 탭', () => {
    expect(pushHref({ ...base, kind: 'WAKE_MISSED', path: '/wake' }, ME)).toBe('/wake');
    expect(pushHref({ ...base, kind: 'ALARM_CHANGED', path: '/alarms' }, ME)).toBe('/alarms');
    expect(pushHref({ ...base, kind: 'FRIEND_REQUEST', path: '/friends' }, ME)).toEqual({ pathname: '/group' });
    expect(pushHref({ ...base, kind: 'FRIEND_ACCEPTED', path: '/friends' }, ME)).toEqual({ pathname: '/group' });
    expect(pushHref({ ...base, kind: 'GROUP_MEMBER_JOINED', path: '/group' }, ME)).toEqual({ pathname: '/group' });
  });

  it('그룹 id가 있으면 그 그룹으로, 미확인 알림(안 일어난 사람)은 그 사람의 기상 확인(G03)으로', () => {
    expect(pushHref({ ...base, kind: 'GROUP_MEMBER_JOINED', path: '/group', groupId: G }, ME)).toEqual({ pathname: '/groups/[id]', params: { id: G } });
    expect(pushHref({ ...base, kind: 'WAKE_NUDGE', path: '/group', groupId: G, subjectUserId: U }, ME)).toEqual({
      pathname: '/groups/[id]/members/[userId]',
      params: { id: G, userId: U },
    });
  });

  it('깨우기는 서버가 준 G03 주소 그대로 (8장)', () => {
    expect(pushHref({ ...base, kind: 'WAKE_PING', path: `/groups/${G}/members/${U}` }, ME)).toEqual({
      pathname: '/groups/[id]/members/[userId]',
      params: { id: G, userId: U },
    });
    expect(pushHref({ ...base, kind: 'WAKE_PING', path: `/groups/${G}` }, ME)).toEqual({ pathname: '/groups/[id]', params: { id: G } });
  });

  it('모양이 이상한 주소 · 모르는 path는 홈 (앱 안 임의 주소로 보내지 않음)', () => {
    expect(pushHref({ ...base, kind: 'WAKE_PING', path: '/groups/x/members/y' }, ME)).toBe(HOME);
    expect(pushHref({ ...base, kind: 'WAKE_PING', path: '/settings' }, ME)).toBe(HOME);
    expect(pushHref({ ...base, kind: 'WAKE_PING' }, ME)).toBe(HOME);
  });

  it('받는 사람이 지금 계정이 아니면 홈 (11-24) · 로그인 전(me null) · 받는 사람 값이 없어도 홈', () => {
    expect(pushHref({ kind: 'WAKE_MISSED', recipientUserId: 'other', path: '/wake' }, ME)).toBe(HOME);
    expect(pushHref({ ...base, kind: 'WAKE_MISSED', path: '/wake' }, null)).toBe(HOME);
    expect(pushHref({ kind: 'WAKE_MISSED', path: '/wake' }, ME)).toBe(HOME);
  });

  it('푸시가 아닌 알림은 null (감지 안내 등 다른 처리가 맡음)', () => {
    expect(pushHref({ url: 'respec://detection' }, ME)).toBeNull();
    expect(pushHref(undefined, ME)).toBeNull();
  });

  it('공동 약속 변경: 확인이 필요하면 확인 화면, 바뀜 · 취소는 그 그룹', () => {
    const d = { ...base, kind: 'GROUP_APPT_CHANGED', path: '/group', groupId: G, appointmentId: 'ap1' };
    expect(pushHref({ ...d, change: 'CHANGED', needsConfirm: true }, ME)).toEqual({ pathname: '/alarm/changed', params: { id: 'ap1' } });
    expect(pushHref({ ...d, change: 'CHANGED', needsConfirm: false }, ME)).toEqual({ pathname: '/groups/[id]', params: { id: G } });
    expect(pushHref({ ...d, change: 'CANCELED' }, ME)).toEqual({ pathname: '/groups/[id]', params: { id: G } });
    expect(pushHref({ ...d, change: 'CHANGED', needsConfirm: true }, 'other')).toBe(HOME);
  });
});

describe('받았을 때 폰 알람을 서버와 맞춰야 하는지', () => {
  it('내 알람이 바뀜 · 공동 약속 바뀜(서버가 맞춘 것) · 취소는 맞춤, 확인이 필요한 것은 확인 화면이 저장하므로 안 맞춤', () => {
    expect(needsAlarmSync({ ...base, kind: 'ALARM_CHANGED' }, ME)).toBe(true);
    const d = { ...base, kind: 'GROUP_APPT_CHANGED', groupId: G, appointmentId: 'ap1' };
    expect(needsAlarmSync({ ...d, change: 'CHANGED', needsConfirm: false }, ME)).toBe(true);
    expect(needsAlarmSync({ ...d, change: 'CANCELED' }, ME)).toBe(true);
    expect(needsAlarmSync({ ...d, change: 'CHANGED', needsConfirm: true }, ME)).toBe(false);
  });

  it('다른 종류 · 다른 계정 · 로그인 전은 안 맞춤', () => {
    expect(needsAlarmSync({ ...base, kind: 'WAKE_PING' }, ME)).toBe(false);
    expect(needsAlarmSync({ kind: 'ALARM_CHANGED', recipientUserId: 'other' }, ME)).toBe(false);
    expect(needsAlarmSync({ ...base, kind: 'ALARM_CHANGED' }, null)).toBe(false);
  });
});
