import { describe, expect, it } from '@jest/globals';

import cases from '../../spec/cases.json';
import {
  buildRingPlan,
  canSnooze,
  DEFAULT_SNOOZE_LIMIT,
  isPastRing,
  isSnoozeLate,
  isSnoozeMinutesAllowed,
  ringStartTimes,
  SNOOZE_LATE_LABEL,
  SNOOZE_MILLIS,
  SNOOZE_MINUTES_OPTIONS,
  snoozeCountLabel,
  snoozeLimitNotice,
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
      const input = item.input as { type: AlarmType; intensity: AlarmIntensity; soundKey?: string; volumeAdjust?: number; notice?: string; snoozeLimit?: number };
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
      expect(snoozeRingAt(plan, item.nowMillis, (item as { snoozeMinutes?: number }).snoozeMinutes)).toBe(item.nextRingAt);
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

describe('공통 케이스 — 미루기 횟수 한도 · 시간 고르기 (D3 기본안 A)', () => {
  for (const item of cases.snoozeLimits) {
    it(item.name, () => {
      expect(canSnooze(item.snoozeCount, item.snoozeLimit)).toBe(item.canSnooze);
    });
  }

  for (const item of cases.snoozeLate) {
    it(item.name, () => {
      expect(isSnoozeLate(item.nowMillis, item.snoozeMinutes, item.departAtMillis)).toBe(item.late);
    });
  }

  it('글자 · 고를 수 있는 분이 spec과 같음', () => {
    expect([...SNOOZE_MINUTES_OPTIONS]).toEqual(cases.snoozeTexts.options);
    expect(SNOOZE_LATE_LABEL).toBe(cases.snoozeTexts.lateLabel);
    for (const item of cases.snoozeTexts.counts) expect(snoozeCountLabel(item.snoozeCount, item.snoozeLimit)).toBe(item.label);
    for (const item of cases.snoozeTexts.limitNotices) expect(snoozeLimitNotice(item.departLabel)).toBe(item.text);
  });

  it('기상 알람 계획에 고를 분 목록과 한도가 실리고, 기본 미루기(10분)는 목록 안에 있음', () => {
    const plan = buildRingPlan({ type: 'WAKE', intensity: 'NORMAL', snoozeLimit: 3 });
    expect(plan.snoozeMinutesOptions).toEqual([5, 10, 15]);
    expect(plan.snoozeLimit).toBe(3);
    expect(plan.snoozeMinutesOptions).toContain(plan.snoozeMillis / 60_000);
    expect(SNOOZE_MILLIS).toBe(600_000);
    expect(DEFAULT_SNOOZE_LIMIT).toBe(3);
  });

  it('보통 알림은 미루기가 없어 목록 · 한도가 비어 있음', () => {
    const plan = buildRingPlan({ type: 'DEPARTURE', intensity: 'NORMAL', snoozeLimit: 3 });
    expect([plan.snoozeMillis, plan.snoozeMinutesOptions, plan.snoozeLimit]).toEqual([0, [], 0]);
  });

  it('목록에 없는 분은 못 고름', () => {
    const plan = buildRingPlan({ type: 'WAKE', intensity: 'NORMAL' });
    expect([5, 10, 15].map((m) => isSnoozeMinutesAllowed(plan, m))).toEqual([true, true, true]);
    expect([0, 7, 20].map((m) => isSnoozeMinutesAllowed(plan, m))).toEqual([false, false, false]);
  });

  it('plan에 담긴 한도가 네이티브 글자로 그대로 감', () => {
    const pkg: RingPackage = { ...basePackage, snoozeLimit: 2, departAt: 2_000_000 };
    const payload = JSON.parse(toNativePayload(pkg, buildRingPlan(pkg)));
    expect(payload.plan.snoozeLimit).toBe(2);
    expect(payload.plan.snoozeMinutesOptions).toEqual([5, 10, 15]);
    expect(payload.departAt).toBe(2_000_000);
  });
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

describe('알림 문구(notice)', () => {
  it('notice가 있으면 heading이 되고, 알림음 여부 · 원탭 버튼은 종류대로 그대로', () => {
    const plan = buildRingPlan({ type: 'DEPARTURE', intensity: 'NORMAL', notice: '지금 나가면 오전 9:50 도착 · 여유 10분' });
    expect(plan.heading).toBe('지금 나가면 오전 9:50 도착 · 여유 10분');
    expect([plan.sound, plan.oneTapLabel, plan.oneTapEventType]).toEqual([false, '출발했어요', 'ACKNOWLEDGED']);
  });

  it('기상 알람은 서버가 notice를 안 줘서 화면 줄이 그대로 (voiceText는 저장만)', () => {
    expect(buildRingPlan({ type: 'WAKE', intensity: 'NORMAL' }).heading).toBe('일어날 시간이에요');
  });

  it('notice는 plan.heading에 담겨 네이티브로 가고, 꾸러미 칸으로는 따로 안 넘어감 (voiceText는 넘어감)', () => {
    const pkg: RingPackage = { ...basePackage, type: 'PREPARE', notice: '오전 8:40 출발까지 30분', voiceText: '좋은 아침이에요.' };
    const payload = JSON.parse(toNativePayload(pkg, buildRingPlan(pkg)));
    expect(payload.plan.heading).toBe('오전 8:40 출발까지 30분');
    expect(payload).not.toHaveProperty('notice');
    expect(payload.voiceText).toBe('좋은 아침이에요.');
  });

  it('앱 쪽에서만 쓰는 칸(맞추기용 묶음 키 groupKey)이 꾸러미에 붙어 있어도 네이티브 글자에는 안 들어감', () => {
    const pkg = { ...basePackage, groupKey: 'participant-1' } as RingPackage;
    const payload = JSON.parse(toNativePayload(pkg, buildRingPlan(pkg)));
    expect(payload).not.toHaveProperty('groupKey');
    expect(JSON.stringify(payload)).not.toContain('participant-1');
  });
});

describe('알림 문구(notice) — 글자가 아닌 값', () => {
  it('notice가 글자가 아니거나 비어 있으면 던지지 않고 종류별 기본 줄 (알람은 걸려야 함)', () => {
    for (const notice of [5, null, {}, ['a'], true, '', '   ']) {
      for (const [type, heading] of [['WAKE', '일어날 시간이에요'], ['PREPARE', '준비할 시간이에요'], ['DEPARTURE', '출발할 시간이에요']] as const) {
        expect(buildRingPlan({ type, intensity: 'NORMAL', notice: notice as unknown as string }).heading).toBe(heading);
      }
    }
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
