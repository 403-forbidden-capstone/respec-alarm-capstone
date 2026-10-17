import { describe, expect, it } from '@jest/globals';

import { canSubmitDevLogin } from '../devLogin';

describe('canSubmitDevLogin — 개발 로그인 폼의 버튼 · 엔터 공통 조건', () => {
  it('이메일(공백만이면 없음)과 비밀번호가 모두 있어야 보냄', () => {
    expect(canSubmitDevLogin('demo-me@example.com', 'secret')).toBe(true);
    expect(canSubmitDevLogin('demo-me@example.com', '')).toBe(false);
    expect(canSubmitDevLogin('', 'secret')).toBe(false);
    expect(canSubmitDevLogin('   ', 'secret')).toBe(false);
  });

  it('비밀번호는 다듬지 않음 — 공백도 비밀번호의 일부', () => {
    expect(canSubmitDevLogin('demo-me@example.com', ' ')).toBe(true);
  });
});
