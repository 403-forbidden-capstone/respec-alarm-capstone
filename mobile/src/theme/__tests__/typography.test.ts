import { describe, expect, it } from '@jest/globals';

import { font, typeScale } from '../typography';

// 단위 테스트 틀 확인용 첫 테스트 — 알람 계산(#32) 같은 순수 함수 테스트를 이 자리에 이어서 씀
describe('font', () => {
  it('굵기마다 Pretendard 파일을 고름', () => {
    expect(font(300)).toEqual({ fontFamily: 'Pretendard-Light' });
    expect(font(400)).toEqual({ fontFamily: 'Pretendard-Regular' });
    expect(font(600)).toEqual({ fontFamily: 'Pretendard-SemiBold' });
    expect(font(700)).toEqual({ fontFamily: 'Pretendard-Bold' });
  });

  it('파일이 없는 500은 Regular로 대신함', () => {
    expect(font(500).fontFamily).toBe('Pretendard-Regular');
  });
});

describe('typeScale', () => {
  it('모든 글자 크기가 Pretendard 글꼴과 크기를 가짐', () => {
    for (const style of Object.values(typeScale)) {
      expect(style.fontFamily).toMatch(/^Pretendard-/);
      expect(style.fontSize).toBeGreaterThan(0);
    }
  });
});
