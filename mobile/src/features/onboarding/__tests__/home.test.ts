import { describe, expect, it } from '@jest/globals';

import { hasHome, homePatchOf } from '../home';

describe('homePatchOf — 고른 장소를 집으로 정할 수 있나', () => {
  it('좌표가 있으면 프로필에 쓸 값', () => {
    expect(homePatchOf({ name: '우리 집', lat: 37.5, lng: 127.03 })).toEqual({ home_name: '우리 집', home_lat: 37.5, home_lng: 127.03 });
  });

  it('좌표가 없으면 null (둘 중 하나만 없어도)', () => {
    expect(homePatchOf({ name: '학교 도서관' })).toBeNull();
    expect(homePatchOf({ name: '학교 도서관', lat: 37.5 })).toBeNull();
    expect(homePatchOf({ name: '학교 도서관', lng: 127.03 })).toBeNull();
  });

  it('0은 있는 좌표로 봄', () => {
    expect(homePatchOf({ name: '적도', lat: 0, lng: 0 })).toEqual({ home_name: '적도', home_lat: 0, home_lng: 0 });
  });

  it('숫자가 아니거나 범위 밖이면 null', () => {
    expect(homePatchOf({ name: '이상한 곳', lat: Number.NaN, lng: 127 })).toBeNull();
    expect(homePatchOf({ name: '이상한 곳', lat: 91, lng: 127 })).toBeNull();
    expect(homePatchOf({ name: '이상한 곳', lat: 37, lng: 181 })).toBeNull();
  });

  it('이름이 비면 null, 앞뒤 공백은 뗌', () => {
    expect(homePatchOf({ name: '  ', lat: 37, lng: 127 })).toBeNull();
    expect(homePatchOf({ name: ' 우리 집 ', lat: 37, lng: 127 })?.home_name).toBe('우리 집');
  });
});

describe('hasHome — 시간표 단계가 이동시간을 구할 수 있나', () => {
  it('이 단계에서 집을 저장했으면 true', () => {
    expect(hasHome(true, null)).toBe(true);
  });

  it('저장은 안 했어도 프로필에 집 좌표가 있으면 true (0도 있는 좌표)', () => {
    expect(hasHome(false, { home_lat: 37.5, home_lng: 127 })).toBe(true);
    expect(hasHome(false, { home_lat: 0, home_lng: 0 })).toBe(true);
  });

  it('둘 다 없으면 false — 좌표가 하나만 있어도', () => {
    expect(hasHome(false, null)).toBe(false);
    expect(hasHome(false, { home_lat: null, home_lng: null })).toBe(false);
    expect(hasHome(false, { home_lat: 37.5, home_lng: null })).toBe(false);
  });
});
