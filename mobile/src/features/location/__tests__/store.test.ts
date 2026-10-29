import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { clearLocationStore, commit, emptyPlan, getLocationAuto, loadActions, loadPlan, loadRegions, loadState, setLocationAuto } from '../store';
import { initialGeoState } from '../transitions';

// 폰 보관함 — 깨진 값에 너그럽고, 저장소 오류는 던지고, 로그아웃 정리는 스위치만 남김
const REGION = { id: 'home', lat: 37.5, lng: 127, radiusM: 200, home: true, originOf: [], destOf: [] };
const TRACKED = { participantId: 'p1', appointmentAt: 2, departAt: 1, fromHome: true, near: false, departedAt: null, arrivedAt: null };

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('읽기 — 깨진 값은 빈 값으로', () => {
  it('아무것도 없으면 빈 상태 · 빈 계획 · 빈 목록', async () => {
    expect(await loadState()).toEqual(initialGeoState());
    expect(await loadPlan()).toEqual(emptyPlan());
    expect(await loadRegions()).toEqual([]);
    expect(await loadActions()).toEqual([]);
  });

  it.each(['state', 'plan', 'regions', 'actions'])('%s: JSON이 깨졌거나 모양이 다르면 빈 값', async (key) => {
    for (const garbage of ['{깨진', 'null', '42', '"text"', '[1,2]', '{"v":99}']) {
      await AsyncStorage.setItem(`location:v1:${key}`, garbage);
      expect(await loadState()).toEqual(initialGeoState());
      expect(await loadPlan()).toEqual(emptyPlan());
      expect(await loadRegions()).toEqual([]);
      expect(await loadActions()).toEqual([]);
    }
  });

  it('계획 · 목록 · 기록은 모양이 틀린 항목만 빼고 나머지는 살림', async () => {
    await AsyncStorage.setItem('location:v1:plan', JSON.stringify({ regions: [REGION, { id: 'x' }, 'text'], participants: [TRACKED, { participantId: 'p2' }], untracked: 'oops' }));
    expect(await loadPlan()).toEqual({ regions: [REGION], participants: [TRACKED], untracked: [] });
    await AsyncStorage.setItem('location:v1:regions', JSON.stringify([REGION, null, { id: 1 }]));
    expect(await loadRegions()).toEqual([REGION]);
    await AsyncStorage.setItem(
      'location:v1:actions',
      JSON.stringify([{ type: 'DEPART', participantId: 'p1', at: 1 }, { type: 'DEPART_PENDING', participantId: 'p1', at: 2 }, { type: 'ARRIVE', at: 3 }, { type: 'RETRACT_DEPART', participantId: 'p1', at: 4 }]),
    );
    expect((await loadActions()).map((a) => a.type)).toEqual(['DEPART']); // 안내용 · 모양 틀린 것 · 없어진 종류(RETRACT_DEPART)는 뺌
  });

  it('저장소 자체 오류는 던짐 — 못 읽은 걸 빈 값으로 보고 덮어쓰지 않게', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk')); // 한 번만 — 되돌리기(mockRestore)는 AsyncStorage 가짜의 구현까지 지움
    await expect(loadState()).rejects.toThrow('disk');
  });
});

describe('쓰기', () => {
  it('commit: 상태 · 계획 · 목록을 한 번에, 쓸 기록은 뒤에 더함', async () => {
    await commit({ plan: { regions: [REGION], participants: [TRACKED], untracked: [] }, regions: [REGION], append: [{ type: 'DEPART', participantId: 'p1', at: 1 }] });
    await commit({ append: [{ type: 'ARRIVE', participantId: 'p1', at: 2 }] });
    expect((await loadPlan()).regions).toEqual([REGION]);
    expect(await loadRegions()).toEqual([REGION]);
    expect((await loadActions()).map((a) => a.type)).toEqual(['DEPART', 'ARRIVE']);
    await commit({ actions: [] });
    expect(await loadActions()).toEqual([]);
  });

  it('좌표는 계획 · 등록 목록에만 있고 (폰 안), 판정 기억 · 쓸 기록에는 없음', async () => {
    await commit({ plan: { regions: [REGION], participants: [], untracked: [] }, regions: [REGION], state: initialGeoState(), append: [{ type: 'ARRIVE', participantId: 'p1', at: 2 }] });
    expect(await AsyncStorage.getItem('location:v1:state')).not.toContain('37.5');
    expect(await AsyncStorage.getItem('location:v1:actions')).not.toContain('37.5');
  });
});

describe('로그아웃 정리와 자동 기록 스위치', () => {
  it('판정 기억 · 계획 · 등록 목록 · 못 쓴 기록 네 가지를 지우고 스위치는 남김', async () => {
    await commit({ state: initialGeoState(), plan: emptyPlan(), regions: [REGION], actions: [{ type: 'DEPART', participantId: 'p1', at: 1 }] });
    await setLocationAuto(false);
    await clearLocationStore();
    expect((await AsyncStorage.getAllKeys()).filter((k) => k.startsWith('location:v1:'))).toEqual(['location:v1:auto']);
    expect(await getLocationAuto()).toBe(false);
  });
});
