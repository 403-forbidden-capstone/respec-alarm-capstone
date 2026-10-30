import { describe, expect, it, jest } from '@jest/globals';

import { homeInputOk } from '../home';

jest.mock('@/lib/supabase', () => ({ supabase: {} })); // 순수 검사만 시험 — supabase는 부르지 않음

const ok = { name: '우리집', lat: 37.5, lng: 127 };

describe('homeInputOk', () => {
  it('이름 · 좌표가 맞으면 통과', () => {
    expect(homeInputOk(ok)).toBe(true);
    expect(homeInputOk({ name: 'a', lat: -90, lng: 180 })).toBe(true);
    expect(homeInputOk({ name: 'a', lat: 90, lng: -180 })).toBe(true);
  });

  it('이름이 비거나 공백뿐이면 막음', () => {
    expect(homeInputOk({ ...ok, name: '' })).toBe(false);
    expect(homeInputOk({ ...ok, name: '   ' })).toBe(false);
  });

  it('위도 · 경도가 범위를 벗어나면 막음', () => {
    expect(homeInputOk({ ...ok, lat: 90.1 })).toBe(false);
    expect(homeInputOk({ ...ok, lat: -91 })).toBe(false);
    expect(homeInputOk({ ...ok, lng: 180.1 })).toBe(false);
    expect(homeInputOk({ ...ok, lng: -181 })).toBe(false);
  });

  it('숫자가 아니면 막음', () => {
    expect(homeInputOk({ ...ok, lat: Number.NaN })).toBe(false);
    expect(homeInputOk({ ...ok, lng: Number.POSITIVE_INFINITY })).toBe(false);
  });
});
