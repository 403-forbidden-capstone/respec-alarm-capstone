import { describe, expect, it } from '@jest/globals';

import type { UserPlace } from '@/features/location/userPlaces';

import { selectedUserPlaceLabel, validDestRadius, withDestination, withUserPlace } from '../destinationPick';

// 새 일정 장소 줄 — 지도 시트 · 자주 가는 곳 칩이 고른 장소를 초안에 담는 규칙
const base = { place: '세종대학교', placeLat: 37.55, placeLng: 127.07, destRadiusM: 300, title: '스터디' };

describe('validDestRadius', () => {
  it('100~500 정수만 — 소수는 반올림, 밖이면 없음', () => {
    expect(validDestRadius(150)).toBe(150);
    expect(validDestRadius(100)).toBe(100);
    expect(validDestRadius(500)).toBe(500);
    expect(validDestRadius(149.6)).toBe(150);
    expect(validDestRadius(99)).toBeUndefined();
    expect(validDestRadius(501)).toBeUndefined();
    expect(validDestRadius(Number.NaN)).toBeUndefined();
    expect(validDestRadius(undefined)).toBeUndefined();
    expect(validDestRadius(null)).toBeUndefined();
  });
});

describe('withDestination', () => {
  it('고른 장소의 이름 · 좌표 · 반경을 한 번에 담음', () => {
    expect(withDestination(base, { name: '홍대입구역', lat: 37.5572, lng: 126.9245, radiusM: 150 })).toEqual({
      title: '스터디',
      place: '홍대입구역',
      placeLat: 37.5572,
      placeLng: 126.9245,
      destRadiusM: 150,
    });
  });

  it('반경이 없는 장소로 바꾸면 옛 반경을 지움 (키도 남기지 않음)', () => {
    const next = withDestination(base, { name: '도서관', lat: 37.5, lng: 127 });
    expect(next.destRadiusM).toBeUndefined();
    expect('destRadiusM' in next).toBe(false);
    expect(next.place).toBe('도서관');
  });

  it('범위 밖 반경은 담지 않음', () => {
    expect('destRadiusM' in withDestination(base, { name: 'A', lat: 1, lng: 2, radiusM: 900 })).toBe(false);
  });
});

describe('withUserPlace (칩)', () => {
  const school: UserPlace = { label: '학교', name: '서울 광진구 능동로 209', lat: 37.5509, lng: 127.0736, radiusM: 300 };
  const job: UserPlace = { label: '알바', name: '건대입구역', lat: 37.54, lng: 127.07 };

  it('칩을 누르면 그 곳의 이름 · 좌표 · 반경이 담김', () => {
    expect(withUserPlace(base, school)).toMatchObject({ place: school.name, placeLat: 37.5509, placeLng: 127.0736, destRadiusM: 300 });
  });

  it('반경이 저장되지 않은 곳이면 이전 반경이 남지 않음', () => {
    expect(withUserPlace(base, job).destRadiusM).toBeUndefined();
  });

  it('지금 장소가 어느 칩인지 — 이름 · 좌표가 같을 때만', () => {
    const picked = withUserPlace(base, school);
    expect(selectedUserPlaceLabel(picked, [job, school])).toBe('학교');
    expect(selectedUserPlaceLabel(base, [job, school])).toBeUndefined();
    expect(selectedUserPlaceLabel({ place: school.name }, [school])).toBeUndefined(); // 좌표 없으면 안 켬
    expect(selectedUserPlaceLabel(picked, undefined)).toBeUndefined();
  });
});
