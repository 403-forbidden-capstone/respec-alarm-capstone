import { describe, expect, it } from '@jest/globals';

import { places as catalog, recentMockPlaces } from '@/mocks/data';

import { listPlaces } from '../api';
import { distanceMeters, toPlace, validNear } from '../places';

const names = (list: { name: string }[]) => list.map((p) => p.name);

// 가짜 모드의 장소 목록 (listPlaces) — 검색어로 거르기 · 가까운 순 · category 통과
describe('listPlaces 가짜 모드', () => {
  it('검색어가 없으면 처음부터 있던 4곳(최근 장소)을 그대로, near는 쓰지 않음', async () => {
    const recent = await listPlaces();
    expect(names(recent)).toEqual(['세종대학교', '학교 도서관', '강남역 2번출구', '홍대입구역']);
    expect(names(await listPlaces('  '))).toEqual(names(recent));
    expect(names(await listPlaces('', { lat: 37.4598, lng: 126.9519 }))).toEqual(names(recent)); // 서울대 근처여도 순서 그대로
    expect(recent).toEqual(recentMockPlaces);
  });

  it('가짜 장소는 서울 대학가 10~12곳 — 이름 · 주소 · 좌표 · category가 모두 있음', () => {
    expect(catalog.length).toBeGreaterThanOrEqual(10);
    expect(catalog.length).toBeLessThanOrEqual(12);
    for (const p of catalog) expect([p.name, p.address, p.lat, p.lng, p.category].every((v) => v != null && v !== '')).toBe(true);
    expect(new Set(names(catalog)).size).toBe(catalog.length);
  });

  it('검색어가 있으면 이름 · 주소에 들어간 곳만 (대소문자 · 공백 무시)', async () => {
    expect(names(await listPlaces('세종'))).toEqual(['세종대학교']);
    expect(names(await listPlaces(' 건 대 입구 '))).toEqual(['건대입구역']);
    expect(names(await listPlaces('능동로'))).toEqual(expect.arrayContaining(['세종대학교', '학교 도서관', '건국대학교'])); // 주소로도 찾음
    expect(names(await listPlaces('능동로'))).not.toContain('홍대입구역');
    expect(await listPlaces('없는곳')).toEqual([]);
  });

  it('near를 주면 가까운 순(직선거리), 안 주면 목록 순서', async () => {
    const plain = names(await listPlaces('역'));
    expect(plain).toEqual(['강남역 2번출구', '홍대입구역', '건대입구역', '신촌역']);
    const nearSinchon = await listPlaces('역', { lat: 37.5551, lng: 126.9368 }); // 신촌역 앞
    expect(names(nearSinchon)).toEqual(['신촌역', '홍대입구역', '강남역 2번출구', '건대입구역']); // 목록 순서(강남 · 홍대 · 건대 · 신촌)와 다른 순서
    const from = { lat: 37.5551, lng: 126.9368 };
    const meters = nearSinchon.map((p) => distanceMeters(from, { lat: p.lat as number, lng: p.lng as number }));
    expect(meters).toEqual([...meters].sort((a, b) => a - b));
  });

  it('category는 장소 그대로 통과, 값을 고쳐도 목업 원본은 그대로', async () => {
    const [univ] = await listPlaces('서울대');
    expect(univ).toMatchObject({ name: '서울대학교', category: '교육,학문 > 대학교' });
    univ.category = '바뀜';
    expect((await listPlaces('서울대'))[0].category).toBe('교육,학문 > 대학교');
  });

  it('near의 숫자가 깨져 있으면(NaN) 정렬하지 않고 목록 순서', async () => {
    expect(names(await listPlaces('역', { lat: Number.NaN, lng: 127 }))).toEqual(['강남역 2번출구', '홍대입구역', '건대입구역', '신촌역']);
  });
});

describe('장소 도우미', () => {
  it('toPlace: 서버 category를 그대로 통과, 비어 있으면 칸 자체가 없음', () => {
    expect(toPlace({ name: '세종대학교', lat: '37.55', lng: 127.07, category: '교육 > 대학교' })).toEqual({ name: '세종대학교', lat: 37.55, lng: 127.07, category: '교육 > 대학교' });
    expect(toPlace({ name: '주소만', category: '' })).toEqual({ name: '주소만' });
    expect(toPlace({ name: '널', category: null })).toEqual({ name: '널' });
  });

  it('validNear: 위도 · 경도가 둘 다 숫자일 때만', () => {
    expect(validNear({ lat: 37.5, lng: 127 })).toEqual({ lat: 37.5, lng: 127 });
    expect(validNear(undefined)).toBeUndefined();
    expect(validNear({ lat: Number.NaN, lng: 127 })).toBeUndefined();
    expect(validNear({ lat: 37.5, lng: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(validNear({ lat: 91, lng: 127 })).toBeUndefined();
    expect(validNear({ lat: 37.5, lng: -181 })).toBeUndefined();
  });

  it('distanceMeters: 같은 점은 0, 세종대 ↔ 건국대는 약 1.7km', () => {
    expect(distanceMeters({ lat: 37.5, lng: 127 }, { lat: 37.5, lng: 127 })).toBe(0);
    const m = distanceMeters({ lat: 37.5509, lng: 127.0736 }, { lat: 37.5409, lng: 127.0794 });
    expect(m).toBeGreaterThan(1000);
    expect(m).toBeLessThan(2000);
  });
});
