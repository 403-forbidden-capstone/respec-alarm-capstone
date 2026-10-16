import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { createMemoryBackend } from '../memoryBackend';
import { buildRingPlan } from '../plan';
import type { NativeAlarmCore } from '../nativeBackend';
import type { RingPackage } from '../types';

const NOW = 1_700_000_000_000;

function pkg(overrides: Partial<RingPackage> = {}): RingPackage {
  return {
    alarmId: '3f2b1c0e-5a4d-4e8f-9b7a-1c2d3e4f5a6b',
    type: 'WAKE',
    atMillis: NOW + 60_000,
    title: '캡스톤 회의',
    intensity: 'NORMAL',
    snoozeLimit: 3,
    ...overrides,
  };
}

describe('웹 대체 (메모리) — #98', () => {
  it('예약하면 목록에 보이고, 같은 id는 덮어씀', async () => {
    const backend = createMemoryBackend(() => NOW);
    const first = pkg();
    expect(await backend.schedule(first, buildRingPlan(first))).toBe('scheduled');
    const second = pkg({ atMillis: NOW + 120_000, intensity: 'STRONG' });
    expect(await backend.schedule(second, buildRingPlan(second))).toBe('scheduled');
    expect(await backend.list()).toEqual([
      {
        id: first.alarmId,
        type: 'WAKE',
        intensity: 'STRONG',
        title: '캡스톤 회의',
        atMillis: NOW + 120_000,
        snoozeCount: 0,
        nextRingAt: NOW + 120_000,
      },
    ]);
  });

  it('지난 시각은 던지지 않고 skipped_past, 나머지 알람은 계속 예약됨', async () => {
    const backend = createMemoryBackend(() => NOW);
    const past = pkg({ alarmId: 'past', atMillis: NOW - 1 });
    const future = pkg({ alarmId: 'future' });
    expect(await backend.schedule(past, buildRingPlan(past))).toBe('skipped_past');
    expect(await backend.schedule(future, buildRingPlan(future))).toBe('scheduled');
    expect((await backend.list()).map((alarm) => alarm.id)).toEqual(['future']);
  });

  it('시각이 지난 새 꾸러미는 같은 id의 예전 예약을 거둠', async () => {
    const backend = createMemoryBackend(() => NOW);
    const first = pkg();
    await backend.schedule(first, buildRingPlan(first));
    const moved = pkg({ atMillis: NOW - 5 });
    expect(await backend.schedule(moved, buildRingPlan(moved))).toBe('skipped_past');
    expect(await backend.list()).toEqual([]);
  });

  it('목록은 다음 울릴 시각 순, 취소 · 전체 취소', async () => {
    const backend = createMemoryBackend(() => NOW);
    const later = pkg({ alarmId: 'later', atMillis: NOW + 200_000 });
    const sooner = pkg({ alarmId: 'sooner', atMillis: NOW + 100_000, type: 'PREPARE' });
    await backend.schedule(later, buildRingPlan(later));
    await backend.schedule(sooner, buildRingPlan(sooner));
    expect((await backend.list()).map((alarm) => alarm.id)).toEqual(['sooner', 'later']);
    await backend.cancel('sooner');
    expect((await backend.list()).map((alarm) => alarm.id)).toEqual(['later']);
    await backend.cancel('없는 id'); // 아무 일 없음
    await backend.cancelAll();
    expect(await backend.list()).toEqual([]);
  });

  it('울려 보면 TRIGGERED 기록이 쌓이고, 올렸다고 알리면 지워짐 · 듣는 쪽에도 전달', async () => {
    const backend = createMemoryBackend(() => NOW);
    const heard: string[] = [];
    const subscription = backend.addEventListener((event) => heard.push(event.eventType));
    const test = pkg({ type: 'ARRIVE' });
    await backend.ringNow(test, buildRingPlan(test));
    const events = await backend.getPendingEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      alarmId: test.alarmId,
      alarmType: 'ARRIVE',
      eventType: 'TRIGGERED',
      at: NOW,
      sequenceNo: 1,
      inputSource: 'BUTTON',
    });
    expect(events[0].clientEventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(heard).toEqual(['TRIGGERED']);

    await backend.markEventsUploaded([events[0].clientEventId]);
    expect(await backend.getPendingEvents()).toEqual([]);

    subscription.remove();
    await backend.ringNow(test, buildRingPlan(test));
    expect(heard).toEqual(['TRIGGERED']);
  });

  it('권한 · 사용 정보는 없는 것으로', async () => {
    const backend = createMemoryBackend(() => NOW);
    expect(await backend.canScheduleExactAlarms()).toBe(false);
    expect(await backend.canUseFullScreenIntent()).toBe(false);
    expect(await backend.hasUsageAccess()).toBe(false);
    expect(await backend.getUsageSpans(0, NOW)).toEqual([]);
  });
});

// index.ts는 불러올 때 플랫폼과 네이티브 모듈을 한 번 정하므로, 테스트마다 새로 불러옴
function loadIndex() {
  return jest.requireActual<typeof import('../index')>('../index');
}

describe('공개 함수 (index.ts)', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('react-native');
    jest.dontMock('expo-modules-core');
  });

  it('웹 · iOS에서는 isAvailable이 false이고 메모리 대체로 끝까지 동작', async () => {
    const alarmCore = loadIndex();
    expect(alarmCore.isAvailable).toBe(false);
    const future = pkg({ alarmId: 'a', atMillis: Date.now() + 60_000 });
    expect(await alarmCore.schedule(future)).toBe('scheduled');
    expect((await alarmCore.list()).map((alarm) => alarm.id)).toContain('a');
    await alarmCore.cancelAll();
  });

  it('scheduleAll은 하나가 틀려도 나머지를 계속하고 결과를 알람마다 돌려줌', async () => {
    const alarmCore = loadIndex();
    const outcomes = await alarmCore.scheduleAll([
      pkg({ alarmId: 'ok', atMillis: Date.now() + 60_000 }),
      pkg({ alarmId: 'past', atMillis: Date.now() - 1000 }),
      pkg({ alarmId: 'bad', intensity: 'LOUD' as RingPackage['intensity'] }),
      pkg({ alarmId: 'ok2', type: 'DEPARTURE', atMillis: Date.now() + 120_000 }),
    ]);
    expect(outcomes.map((o) => [o.alarmId, o.status])).toEqual([
      ['ok', 'scheduled'],
      ['past', 'skipped_past'],
      ['bad', 'failed'],
      ['ok2', 'scheduled'],
    ]);
    expect(outcomes[2].error).toContain('강도');
    await alarmCore.cancelAll();
  });

  it('잘못된 꾸러미는 schedule이 던짐', async () => {
    const alarmCore = loadIndex();
    await expect(alarmCore.schedule(pkg({ alarmId: '' }))).rejects.toThrow();
  });

  it('Android 네이티브에는 꾸러미 + 계획을 JSON 글자 하나로 넘김', async () => {
    const calls: { name: string; args: unknown[] }[] = [];
    const fake = new Proxy({} as NativeAlarmCore, {
      get: (_target, name: string) => (...args: unknown[]) => {
        calls.push({ name, args });
        return Promise.resolve(name === 'schedule' ? 'scheduled' : undefined);
      },
    });
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
    jest.doMock('expo-modules-core', () => ({ requireOptionalNativeModule: () => fake }));
    const alarmCore = loadIndex();

    expect(alarmCore.isAvailable).toBe(true);
    const wake = pkg({ volumeAdjust: -0.1 });
    expect(await alarmCore.schedule(wake)).toBe('scheduled');
    await alarmCore.cancel(wake.alarmId);
    await alarmCore.markEventsUploaded([]); // 빈 목록이면 네이티브를 안 부름
    await alarmCore.markEventsUploaded(['e1']);

    expect(calls.map((call) => call.name)).toEqual(['schedule', 'cancel', 'markEventsUploaded']);
    const payload = JSON.parse(calls[0].args[0] as string);
    expect(payload.alarmId).toBe(wake.alarmId);
    expect(payload.plan.volumePercent).toBe(72);
    expect(payload.plan.reRingOffsetsMillis).toEqual([480_000, 960_000]);
    expect(calls[2].args).toEqual([['e1']]);
  });

  it('네이티브가 새 꾸러미를 미루면(deferred) 그대로 돌려주고, scheduleAll도 알람마다 담음', async () => {
    const fake = new Proxy({} as NativeAlarmCore, {
      get: (_target, name: string) => (...args: unknown[]) => {
        if (name !== 'schedule') return Promise.resolve(undefined);
        const { alarmId } = JSON.parse(args[0] as string) as { alarmId: string };
        return Promise.resolve(alarmId === 'ringing' ? 'deferred' : 'scheduled');
      },
    });
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
    jest.doMock('expo-modules-core', () => ({ requireOptionalNativeModule: () => fake }));
    const alarmCore = loadIndex();

    expect(await alarmCore.schedule(pkg({ alarmId: 'ringing' }))).toBe('deferred');
    const outcomes = await alarmCore.scheduleAll([pkg({ alarmId: 'ringing' }), pkg({ alarmId: 'free' })]);
    expect(outcomes.map((o) => [o.alarmId, o.status])).toEqual([
      ['ringing', 'deferred'],
      ['free', 'scheduled'],
    ]);
  });

  it('Android인데 모듈이 없는 옛 APK는 예약을 거절하고 조회는 빈 값', async () => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
    jest.doMock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
    const alarmCore = loadIndex();

    expect(alarmCore.isAvailable).toBe(false);
    await expect(alarmCore.schedule(pkg())).rejects.toThrow('알람 모듈이 없음');
    await expect(alarmCore.ringNow(pkg())).rejects.toThrow('알람 모듈이 없음');
    expect(await alarmCore.list()).toEqual([]);
    expect(await alarmCore.getPendingEvents()).toEqual([]);
  });
});
