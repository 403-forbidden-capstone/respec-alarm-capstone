import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { forgetGeoDetection, restoreGeoDetection } from '../correct';
import * as lock from '../lock';
import { commit, loadActions, loadState } from '../store';
import { initialGeoState, type GeoState } from '../transitions';

// [아니에요] 정정을 폰 판정 기억에 맞춤 — 실제 보관함(AsyncStorage 가짜) 위에서
const at = (hhmm: string) => Date.parse(`2025-05-22T${hhmm}:00+09:00`);
const APPT = at('10:00');

const pending = (participantId = 'p1', when = at('08:30')) => ({ participantId, regionId: 'home', at: when, appointmentAt: APPT });
const seeded = (patch: Partial<GeoState>): GeoState => ({ ...initialGeoState(), ...patch });

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

describe('forgetGeoDetection — 지운 판정을 폰 기억에서 잊음', () => {
  it('5분 대기 중이던 출발: 대기에서 빼고 voided로 둠 (서버 값이 아직 없어도 기억에 있으니 잊음 = true)', async () => {
    await commit({ state: seeded({ pending: [pending()] }) });
    expect(await forgetGeoDetection({ kind: 'DEPART', participantId: 'p1', at: at('08:30') })).toBe(true);
    const state = await loadState();
    expect(state.pending).toEqual([]);
    expect(state.voided).toEqual([{ kind: 'DEPART', participantId: 'p1', at: at('08:30'), appointmentAt: APPT }]); // 약속 시각은 기억에서 찾음
  });

  it('확정한 출발 · 잡은 도착도 잊음', async () => {
    await commit({ state: seeded({ departed: [pending()], arrived: [{ participantId: 'p1', at: at('09:52'), appointmentAt: APPT }] }) });
    expect(await forgetGeoDetection({ kind: 'DEPART', participantId: 'p1', at: at('08:30') })).toBe(true);
    expect((await loadState()).departed).toEqual([]);
    expect((await loadState()).arrived).toHaveLength(1); // 도착은 그대로
    expect(await forgetGeoDetection({ kind: 'ARRIVE', participantId: 'p1', at: at('09:52') })).toBe(true);
    expect((await loadState()).arrived).toEqual([]);
  });

  it('아직 서버에 못 쓴 같은 기록도 보관함에서 뺌 (안 빼면 지운 값이 나중에 다시 써짐), 다른 기록은 그대로', async () => {
    await commit({
      state: seeded({ departed: [pending()] }),
      actions: [
        { type: 'DEPART', participantId: 'p1', at: at('08:30') },
        { type: 'DEPART', participantId: 'p2', at: at('08:30') },
      ],
    });
    await forgetGeoDetection({ kind: 'DEPART', participantId: 'p1', at: at('08:30') });
    expect(await loadActions()).toEqual([{ type: 'DEPART', participantId: 'p2', at: at('08:30') }]);
  });

  it('폰 기억에 없고 서버 값도 안 지웠으면 아무것도 저장하지 않음 (지난 알림이 더 새 판정을 건드리지 않게) → false', async () => {
    await commit({ state: seeded({ pending: [pending('p1', at('08:45'))] }) }); // 다른 시각의 대기
    expect(await forgetGeoDetection({ kind: 'DEPART', participantId: 'p1', at: at('08:30') })).toBe(false);
    const state = await loadState();
    expect(state.pending).toHaveLength(1);
    expect(state.voided).toEqual([]);
  });

  it('voidAlways: 서버 값을 지웠으면 폰 기억에 없어도 voided로 둠 (계획에 남은 옛 DB 값이 셈되지 않게), 반환은 false', async () => {
    expect(await forgetGeoDetection({ kind: 'ARRIVE', participantId: 'p1', at: at('09:52') }, { voidAlways: true })).toBe(false);
    // 약속 시각을 모르면 감지 시각으로
    expect((await loadState()).voided).toEqual([{ kind: 'ARRIVE', participantId: 'p1', at: at('09:52'), appointmentAt: at('09:52') }]);
  });

  it('줄(withLock) 안에서 읽고 씀', async () => {
    const spy = jest.spyOn(lock, 'withLock');
    await forgetGeoDetection({ kind: 'DEPART', participantId: 'p1', at: 1 });
    await restoreGeoDetection({ kind: 'DEPART', participantId: 'p1', at: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('보관함을 못 읽으면 던지지 않고 false (정정 자체는 서버에서 끝난 일)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    await expect(forgetGeoDetection({ kind: 'DEPART', participantId: 'p1', at: 1 }, { voidAlways: true })).resolves.toBe(false);
  });
});

describe('restoreGeoDetection — 5초 안에 되돌림', () => {
  it('forget로 둔 voided를 뺌, 두 번 불러도 같은 결과', async () => {
    await commit({ state: seeded({ pending: [pending()] }) });
    await forgetGeoDetection({ kind: 'DEPART', participantId: 'p1', at: at('08:30') });
    expect((await loadState()).voided).toHaveLength(1);
    expect(await restoreGeoDetection({ kind: 'DEPART', participantId: 'p1', at: at('08:30') })).toBe(true);
    expect((await loadState()).voided).toEqual([]);
    expect(await restoreGeoDetection({ kind: 'DEPART', participantId: 'p1', at: at('08:30') })).toBe(true);
    expect((await loadState()).voided).toEqual([]);
  });

  it('다른 판정의 voided는 건드리지 않음', async () => {
    await commit({
      state: seeded({
        voided: [
          { kind: 'DEPART', participantId: 'p1', at: at('08:30'), appointmentAt: APPT },
          { kind: 'DEPART', participantId: 'p2', at: at('08:30'), appointmentAt: APPT },
        ],
      }),
    });
    await restoreGeoDetection({ kind: 'DEPART', participantId: 'p1', at: at('08:30') });
    expect((await loadState()).voided.map((v) => v.participantId)).toEqual(['p2']);
  });

  it('보관함을 못 읽으면 던지지 않고 false', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    await expect(restoreGeoDetection({ kind: 'DEPART', participantId: 'p1', at: 1 })).resolves.toBe(false);
  });
});
