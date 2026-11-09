import { describe, expect, it } from '@jest/globals';

import { isPushData, isSilentPush, showsInForeground } from '../kinds';

describe('푸시 데이터 판별', () => {
  it('서버가 싣는 kind만 푸시 — 감지 안내 같은 로컬 알림 · 모르는 종류 · 모양이 다른 값은 아님', () => {
    expect(isPushData({ kind: 'WAKE_PING', recipientUserId: 'me', path: '/wake' })).toBe(true);
    expect(isPushData({ kind: 'GROUP_APPT_CHANGED' })).toBe(true);
    expect(isPushData({ kind: 'WAKE_NUDGE_UP' })).toBe(true);
    expect(isPushData({ url: 'respec://detection?...' })).toBe(false);
    expect(isPushData({ kind: 'SOMETHING_NEW' })).toBe(false);
    expect(isPushData({ kind: 3 })).toBe(false);
    expect(isPushData(null)).toBe(false);
    expect(isPushData('WAKE_PING')).toBe(false);
  });

  it('조용한 푸시(silent true · "true")는 앞에 떠 있어도 배너를 안 띄움', () => {
    expect(isSilentPush({ silent: true })).toBe(true);
    expect(isSilentPush({ silent: 'true' })).toBe(true);
    expect(isSilentPush({ silent: false })).toBe(false);
    expect(isSilentPush(undefined)).toBe(false);
    expect(showsInForeground({ kind: 'FRIEND_REQUEST' })).toBe(true);
    expect(showsInForeground({ kind: 'GROUP_APPT_CHANGED', silent: true })).toBe(false);
    expect(showsInForeground({ url: 'x' })).toBe(false);
  });
});
