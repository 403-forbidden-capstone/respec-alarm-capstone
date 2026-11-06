import { describe, expect, it } from '@jest/globals';

import { mergeFollowUps, saveNotice } from '../saveNotice';

describe('saveNotice — 저장은 됐는데 뒤처리가 못 한 것', () => {
  it('뒤처리가 다 됐으면 null (화면은 원래 저장 문구)', () => {
    expect(saveNotice(undefined)).toBeNull();
    expect(saveNotice({ phoneFailed: 0, itemsFailed: false })).toBeNull();
  });

  it('폰에 못 건 알람 — 홈 안내(빨간 줄)로 보냄', () => {
    expect(saveNotice({ phoneFailed: 2, itemsFailed: false })).toBe('일정은 저장했지만 알람 2개를 폰에 걸지 못했어요. 홈 안내를 확인해 주세요');
  });

  it('준비물만 못 넣음 · 둘 다 못 함', () => {
    expect(saveNotice({ phoneFailed: 0, itemsFailed: true })).toBe('일정은 저장했지만 준비물은 저장하지 못했어요');
    expect(saveNotice({ phoneFailed: 1, itemsFailed: true })).toBe('일정은 저장했지만 알람 1개를 폰에 걸지 못했고 준비물도 저장하지 못했어요. 홈 안내를 확인해 주세요');
  });

  it('앞말은 부르는 화면이 정함 (알람 설정 "저장했지만")', () => {
    expect(saveNotice({ phoneFailed: 1, itemsFailed: false }, '저장했지만')).toBe('저장했지만 알람 1개를 폰에 걸지 못했어요. 홈 안내를 확인해 주세요');
  });
});

describe('mergeFollowUps — 여러 번 저장한 결과 (시간표 수업 여러 개)', () => {
  it('못 건 수는 더하고, 준비물은 하나라도 못 넣었으면', () => {
    expect(mergeFollowUps([undefined, { phoneFailed: 1, itemsFailed: false }, { phoneFailed: 2, itemsFailed: true }])).toEqual({ phoneFailed: 3, itemsFailed: true });
  });

  it('다 됐으면 undefined', () => {
    expect(mergeFollowUps([])).toBeUndefined();
    expect(mergeFollowUps([undefined, undefined])).toBeUndefined();
  });
});
