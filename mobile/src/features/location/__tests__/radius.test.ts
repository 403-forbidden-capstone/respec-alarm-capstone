import { describe, expect, it } from '@jest/globals';

import { clampRadius, DESTINATION_RADIUS_PRESETS, HOME_RADIUS_PRESETS, initialRadius, nearestPreset, presetName, radiusAfterPick } from '../radius';

describe('clampRadius', () => {
  it('100~500m으로 맞추고 소수는 반올림, 숫자가 아니면 200', () => {
    expect(clampRadius(50)).toBe(100);
    expect(clampRadius(150)).toBe(150);
    expect(clampRadius(149.6)).toBe(150);
    expect(clampRadius(900)).toBe(500);
    expect(clampRadius(Number.NaN)).toBe(200);
    expect(clampRadius(Infinity)).toBe(200);
  });
});

describe('nearestPreset', () => {
  it('가장 가까운 프리셋, 같은 거리면 작은 쪽', () => {
    expect(nearestPreset(120, DESTINATION_RADIUS_PRESETS)).toBe(100);
    expect(nearestPreset(200, DESTINATION_RADIUS_PRESETS)).toBe(150);
    expect(nearestPreset(250, DESTINATION_RADIUS_PRESETS)).toBe(300);
    expect(nearestPreset(125, DESTINATION_RADIUS_PRESETS)).toBe(100); // 100과 150의 한가운데
    expect(nearestPreset(150, HOME_RADIUS_PRESETS)).toBe(100); // 100과 200의 한가운데 → 작은 쪽
  });

  it('within을 주면 그 안일 때만, 프리셋이 비었거나 숫자가 아니면 null', () => {
    expect(nearestPreset(160, DESTINATION_RADIUS_PRESETS, 25)).toBe(150);
    expect(nearestPreset(200, DESTINATION_RADIUS_PRESETS, 25)).toBeNull();
    expect(nearestPreset(200, [])).toBeNull();
    expect(nearestPreset(Number.NaN, DESTINATION_RADIUS_PRESETS)).toBeNull();
  });
});

describe('initialRadius', () => {
  it('프리셋과 같거나 25m 안이면 그 칸, 아니면 저장돼 있던 값 그대로(범위만 맞춤)', () => {
    expect(initialRadius(150, DESTINATION_RADIUS_PRESETS)).toBe(150);
    expect(initialRadius(140, DESTINATION_RADIUS_PRESETS)).toBe(150);
    expect(initialRadius(200, DESTINATION_RADIUS_PRESETS)).toBe(200); // 칸에 없는 사용자 지정 값
    expect(initialRadius(450, HOME_RADIUS_PRESETS)).toBe(450);
    expect(initialRadius(900, HOME_RADIUS_PRESETS)).toBe(500);
    expect(initialRadius(200, HOME_RADIUS_PRESETS)).toBe(200);
  });
});

describe('radiusAfterPick', () => {
  const base = { current: 150, touched: false, presets: DESTINATION_RADIUS_PRESETS };

  it('검색 결과를 누르면 그 장소 분류의 기본 반경에 가장 가까운 칸으로 (건물 150 · 역 · 공원 300 · 분류 없음 200 → 150)', () => {
    expect(radiusAfterPick({ ...base, place: { name: '세종대학교 광개토관', category: '교육,학문 > 학교 > 대학교' } })).toBe(150);
    expect(radiusAfterPick({ ...base, place: { name: '건대입구역', category: '교통,수송 > 지하철,전철 > 수도권2호선' } })).toBe(300);
    expect(radiusAfterPick({ ...base, place: { name: '어린이대공원', category: '여행 > 공원 > 도시근린공원' } })).toBe(300);
    expect(radiusAfterPick({ ...base, current: 300, place: { name: '어딘가' } })).toBe(150); // 분류 없음 200 → [100,150,300]에서 150
  });

  it('집 프리셋에서는 같은 기본 반경이 집 칸으로 (분류 없음 200 → 200)', () => {
    expect(radiusAfterPick({ ...base, presets: HOME_RADIUS_PRESETS, place: { name: '어딘가' } })).toBe(200);
  });

  it('사용자가 이미 직접 골랐거나 follow가 false(집)면 그대로', () => {
    expect(radiusAfterPick({ ...base, touched: true, current: 100, place: { name: '건대입구역', category: '교통,수송 > 지하철,전철 > 수도권2호선' } })).toBe(100);
    expect(radiusAfterPick({ ...base, follow: false, current: 200, place: { name: '건대입구역', category: '교통,수송 > 지하철,전철 > 수도권2호선' } })).toBe(200);
  });

  it('프리셋이 비어 있으면 기본 반경 그대로 (범위만 맞춤)', () => {
    expect(radiusAfterPick({ ...base, presets: [], place: { name: '건대입구역', category: '교통,수송 > 지하철,전철 > 수도권2호선' } })).toBe(300);
  });
});

describe('presetName', () => {
  it('3개면 작게 · 보통 · 크게, 아니면 이름 없음', () => {
    expect([0, 1, 2].map((i) => presetName(i, 3))).toEqual(['작게', '보통', '크게']);
    expect(presetName(0, 2)).toBeNull();
    expect(presetName(0, 4)).toBeNull();
  });
});
