import { describe, expect, it } from '@jest/globals';

import { UserError, userMessage } from '../errors';

describe('userMessage', () => {
  it('UserError면 그 이유를 보여 줌', () => {
    expect(userMessage(new UserError('이미 적용한 제안이에요'))).toBe('이미 적용한 제안이에요');
  });

  it('그 밖의 오류는 기본 문구 — 영어 원문 · 내부 칼럼 이름이 든 DB 문구를 숨김', () => {
    expect(userMessage(new Error('new row violates row-level security policy'))).toBe('하지 못했어요. 다시 해 주세요');
    expect(userMessage(new Error('alarms.owner_id 칼럼은 바꿀 수 없음'))).toBe('하지 못했어요. 다시 해 주세요');
    expect(userMessage('문자열', '저장하지 못했어요')).toBe('저장하지 못했어요');
  });
});
