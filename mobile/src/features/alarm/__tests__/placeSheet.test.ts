import { describe, expect, it } from '@jest/globals';

import { places as catalog } from '@/mocks/data';

import { categoryLeaf, homeOf, noResultTitle, placeSubtitle } from '../placeSheet';

// 장소 검색 시트의 글자 · 기준점 — 화면 없이 확인
describe('categoryLeaf', () => {
  it('"A > B > C" 꼴이면 마지막 칸만', () => {
    expect(categoryLeaf('교육,학문 > 대학교')).toBe('대학교');
    expect(categoryLeaf('교통,수송 > 지하철,전철 > 수도권2호선')).toBe('수도권2호선');
    expect(categoryLeaf('음식점 > 카페 > 커피전문점 > 스타벅스')).toBe('스타벅스');
  });

  it('">"가 없으면 그대로, 앞뒤 공백 · 빈 칸은 무시', () => {
    expect(categoryLeaf('대학교')).toBe('대학교');
    expect(categoryLeaf('  교육,학문 >대학교  ')).toBe('대학교');
    expect(categoryLeaf('교육,학문 > 대학교 > ')).toBe('대학교');
    expect(categoryLeaf('교육,학문')).toBe('교육,학문'); // 쉼표는 한 분류 이름 안의 구분이라 자르지 않음
  });

  it('없거나 비면 빈 글자', () => {
    expect(categoryLeaf(undefined)).toBe('');
    expect(categoryLeaf(null)).toBe('');
    expect(categoryLeaf('')).toBe('');
    expect(categoryLeaf(' > ')).toBe('');
  });
});

describe('placeSubtitle', () => {
  it('주소 · 분류 마지막 칸', () => {
    expect(placeSubtitle({ address: '서울 광진구 능동로 209', category: '교육,학문 > 대학교' })).toBe('서울 광진구 능동로 209 · 대학교');
  });

  it('한쪽만 있으면 그것만, 둘 다 없으면 빈 글자', () => {
    expect(placeSubtitle({ address: '서울 광진구 능동로 209' })).toBe('서울 광진구 능동로 209');
    expect(placeSubtitle({ category: '교육,학문 > 대학교' })).toBe('대학교');
    expect(placeSubtitle({ address: '  ', category: '' })).toBe('');
    expect(placeSubtitle({})).toBe('');
  });

  it('가짜 대학가 장소는 모두 아래 글자가 나옴', () => {
    for (const p of catalog) expect(placeSubtitle(p)).toMatch(/ · /);
  });
});

describe('noResultTitle', () => {
  it('검색어를 따옴표로 감쌈 (앞뒤 공백 뺌)', () => {
    expect(noResultTitle('없는곳')).toBe("'없는곳' 검색 결과가 없어요");
    expect(noResultTitle('  없는 곳 ')).toBe("'없는 곳' 검색 결과가 없어요");
  });
});

describe('homeOf', () => {
  it('위도 · 경도가 둘 다 숫자일 때만 기준점', () => {
    expect(homeOf({ home_lat: 37.55, home_lng: 127.07 })).toEqual({ lat: 37.55, lng: 127.07 });
    expect(homeOf({ home_lat: 0, home_lng: 0 })).toEqual({ lat: 0, lng: 0 }); // 0도 숫자
  });

  it('하나라도 없거나 숫자가 아니면 undefined', () => {
    expect(homeOf({ home_lat: 37.55, home_lng: null })).toBeUndefined();
    expect(homeOf({ home_lat: null, home_lng: 127.07 })).toBeUndefined();
    expect(homeOf({ home_lat: null, home_lng: null })).toBeUndefined();
    expect(homeOf({ home_lat: Number.NaN, home_lng: 127.07 })).toBeUndefined();
    expect(homeOf({ home_lat: 37.55, home_lng: Infinity })).toBeUndefined();
    expect(homeOf({})).toBeUndefined();
    expect(homeOf(null)).toBeUndefined();
    expect(homeOf(undefined)).toBeUndefined();
  });
});
