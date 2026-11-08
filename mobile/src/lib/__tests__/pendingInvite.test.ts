import { describe, expect, it } from '@jest/globals';

import { setPendingInvite, takePendingInvite } from '../pendingInvite';

describe('pendingInvite — 로그인 전에 연 친구 링크 이어가기 (친구 2장 2-20)', () => {
  it('적어 둔 토큰을 한 번만 읽을 수 있음', () => {
    setPendingInvite('ABCDEFGH2345');
    expect(takePendingInvite()).toBe('ABCDEFGH2345');
    expect(takePendingInvite()).toBeNull();
  });

  it('빈 토큰은 기억하지 않음', () => {
    setPendingInvite('');
    expect(takePendingInvite()).toBeNull();
  });
});
