import { describe, expect, it } from '@jest/globals';

import cases from '../../spec/cases.json';
import {
  buildRingPlan,
  isPastRing,
  ringStartTimes,
  snoozeRingAt,
  toNativePayload,
  unansweredSpanMillis,
  validateRingPackage,
  volumePercentFor,
} from '../plan';
import type { AlarmFeedback, AlarmIntensity, AlarmType, RingPackage } from '../types';
import { volumeAdjustFromRatings } from '../volumeAdjust';

const basePackage: RingPackage = {
  alarmId: '3f2b1c0e-5a4d-4e8f-9b7a-1c2d3e4f5a6b',
  type: 'WAKE',
  atMillis: 1_000_000,
  title: '캡스톤 회의',
  intensity: 'NORMAL',
  snoozeLimit: 3,
};

describe('공통 케이스 (spec/cases.json) — 울림 계획', () => {
  for (const item of cases.plans) {
    it(item.name, () => {
      const input = item.input as { type: AlarmType; intensity: AlarmIntensity; soundKey?: string; volumeAdjust?: number };
      expect(buildRingPlan(input)).toEqual(item.plan);
    });
  }
});

describe('공통 케이스 — 볼륨', () => {
  for (const item of cases.volumes) {
    it(item.name, () => {
      expect(volumePercentFor(item.intensity as AlarmIntensity, item.volumeAdjust as number)).toBe(item.volumePercent);
    });
  }
});

describe('공통 케이스 — 다시 울림 시각', () => {
  for (const item of cases.ringStarts) {
    it(item.name, () => {
      const plan = buildRingPlan({ type: item.type as AlarmType, intensity: item.intensity as AlarmIntensity });
      const starts = ringStartTimes(plan, item.firstRingAt);
      expect(starts).toEqual(item.starts);
      // 쉬는 시간 = 다음 울림 시작 - (이전 울림 시작 + 최대 울림 시간)
      expect(starts.slice(1).map((start, index) => start - starts[index] - plan.maxRingMillis)).toEqual(item.silenceGapsMillis);
      expect(unansweredSpanMillis(plan)).toBe(item.unansweredSpanMillis);
    });
  }
});

describe('공통 케이스 — 미루기 · 지난 시각 · 평가 보정', () => {
  for (const item of cases.snooze) {
    it(item.name, () => {
      const plan = buildRingPlan({ type: 'WAKE', intensity: item.intensity as AlarmIntensity });
      expect(snoozeRingAt(plan, item.nowMillis)).toBe(item.nextRingAt);
    });
  }

  for (const item of cases.past) {
    it(`지난 시각 판정 ${item.atMillis} / 지금 ${item.nowMillis}`, () => {
      expect(isPastRing(item.atMillis, item.nowMillis)).toBe(item.isPast);
    });
  }

  for (const item of cases.volumeAdjustRules) {
    it(item.name, () => {
      expect(volumeAdjustFromRatings(item.ratings as AlarmFeedback[])).toBe(item.volumeAdjust);
    });
  }
});

describe('울림 계획 규칙', () => {
  it('다시 울림은 미루기가 아니라 따로 셈 — 계획에 미루기 횟수 칸이 없고 시각만 있음', () => {
    const plan = buildRingPlan({ type: 'WAKE', intensity: 'STRONG' });
    expect(plan.reRingOffsetsMillis).toHaveLength(3);
    expect(Object.keys(plan)).not.toContain('snoozeCount');
  });

  it('한 번 울림은 최대 3분이고, 다시 울림 사이에는 늘 쉬는 시간이 있음 (이어 울리지 않음)', () => {
    for (const intensity of ['SOFT', 'NORMAL', 'STRONG'] as const) {
      const plan = buildRingPlan({ type: 'WAKE', intensity });
      expect(plan.maxRingMillis).toBe(180_000);
      const starts = ringStartTimes(plan, 0);
      starts.slice(1).forEach((start, index) => {
        expect(start - starts[index] - plan.maxRingMillis).toBeGreaterThan(0);
      });
    }
  });

  it('마지막 울림이 끝나기까지 약 11분 · 보통 19분 · 강 21분 (서버가 놓침 시각을 셀 때 같은 값을 씀)', () => {
    const minutes = (intensity: 'SOFT' | 'NORMAL' | 'STRONG') =>
      unansweredSpanMillis(buildRingPlan({ type: 'WAKE', intensity })) / 60_000;
    expect([minutes('SOFT'), minutes('NORMAL'), minutes('STRONG')]).toEqual([11, 19, 21]);
  });

  it('소리 키가 비어 있으면 기본 소리', () => {
    expect(buildRingPlan({ type: 'WAKE', intensity: 'SOFT', soundKey: '  ' }).soundKey).toBe('default');
  });
});

describe('꾸러미 확인', () => {
  it('정상 꾸러미는 통과', () => {
    expect(() => validateRingPackage(basePackage)).not.toThrow();
  });

  it('지난 시각은 오류가 아님 (schedule이 skipped_past로 돌려줌)', () => {
    expect(() => validateRingPackage({ ...basePackage, atMillis: 1 })).not.toThrow();
  });

  it('틀린 칸은 던짐', () => {
    expect(() => validateRingPackage({ ...basePackage, alarmId: '' })).toThrow();
    expect(() => validateRingPackage({ ...basePackage, type: 'NAP' as AlarmType })).toThrow();
    expect(() => validateRingPackage({ ...basePackage, intensity: 'LOUD' as AlarmIntensity })).toThrow();
    expect(() => validateRingPackage({ ...basePackage, atMillis: Number.NaN })).toThrow();
    expect(() => validateRingPackage({ ...basePackage, snoozeLimit: -1 })).toThrow();
    expect(() => validateRingPackage({ ...basePackage, snoozeLimit: 1.5 })).toThrow();
  });
});

describe('네이티브로 넘기는 글자', () => {
  it('꾸러미 칸 + 계획을 담고, 값 없는 칸과 안 읽는 자리는 빠짐', () => {
    const pkg: RingPackage = {
      ...basePackage,
      subtitle: '오전 10:00 · 세종대학교',
      volumeAdjust: -0.1,
      departAt: 2_000_000,
      vibration: 'SHORT_REPEAT',
      snoozeMinutesOptions: [5, 10, 15],
    };
    const plan = buildRingPlan(pkg);
    const payload = JSON.parse(toNativePayload(pkg, plan));
    expect(payload).toEqual({
      alarmId: pkg.alarmId,
      type: 'WAKE',
      atMillis: 1_000_000,
      title: '캡스톤 회의',
      subtitle: '오전 10:00 · 세종대학교',
      intensity: 'NORMAL',
      snoozeLimit: 3,
      volumeAdjust: -0.1,
      departAt: 2_000_000,
      plan,
    });
    expect(payload.plan.volumePercent).toBe(72);
    expect(payload).not.toHaveProperty('vibration');
    expect(payload).not.toHaveProperty('snoozeMinutesOptions');
    expect(payload).not.toHaveProperty('voiceText');
  });
});
