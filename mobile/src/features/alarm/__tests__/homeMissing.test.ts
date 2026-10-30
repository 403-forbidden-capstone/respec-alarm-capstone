import { describe, expect, it } from '@jest/globals';

import { UserError } from '@/lib/errors';

import { isHomeMissing } from '../homeMissing';

const NO_PLACE_LOCATION = new UserError('이 장소의 위치를 몰라 이동시간을 구하지 못했어요. 장소를 검색해서 다시 골라 주세요');
const NO_LOCATION_H03 = new UserError('이 장소의 위치를 몰라 이동시간을 구하지 못했어요. 예상 이동을 직접 입력해 주세요');

describe('isHomeMissing', () => {
  it('집 없음 + 장소 좌표 있음이면 원인이 집', () => {
    expect(isHomeMissing({ error: NO_PLACE_LOCATION, hasHome: false, placeHasCoords: true })).toBe(true);
    expect(isHomeMissing({ error: NO_LOCATION_H03, hasHome: false, placeHasCoords: true })).toBe(true);
  });

  it('집이 있으면 아님', () => {
    expect(isHomeMissing({ error: NO_PLACE_LOCATION, hasHome: true, placeHasCoords: true })).toBe(false);
  });

  it('장소 좌표도 없으면 아님 (장소를 다시 고르는 안내 그대로)', () => {
    expect(isHomeMissing({ error: NO_PLACE_LOCATION, hasHome: false, placeHasCoords: false })).toBe(false);
  });

  it('UserError가 아니면 아님', () => {
    expect(isHomeMissing({ error: new Error('위치를 몰라'), hasHome: false, placeHasCoords: true })).toBe(false);
    expect(isHomeMissing({ error: '위치를 몰라', hasHome: false, placeHasCoords: true })).toBe(false);
    expect(isHomeMissing({ error: null, hasHome: false, placeHasCoords: true })).toBe(false);
  });

  it('다른 문구의 UserError면 아님', () => {
    expect(isHomeMissing({ error: new UserError('장소를 먼저 골라 주세요'), hasHome: false, placeHasCoords: true })).toBe(false);
  });
});
