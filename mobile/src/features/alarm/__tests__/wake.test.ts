import { describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';
import { kst } from '@/mocks/data';

import { evaluateWake, formatUsage, judgeLines, pickAlarmId, pickDismissedAt, thetaReachedAt, usedMinutes, usageSummary, WAKE_THETA_MINUTES, type UseSpan } from '../wake';

const dismissed = kst(22, 480); // 오전 8:00에 해제
const demo: UseSpan[] = [
  [0.5, 1.5],
  [2.5, 3.3],
  [6, 7],
  [8.6, 9],
]; // 시연: 폰을 보며 일어남

describe('H08 화면 사용 합', () => {
  it('시연 구간 = 누적 3.2분 · 뒤쪽 5분 1.4분 (목업 simUse)', () => {
    expect(usageSummary(demo)).toEqual({ usage: 3.2, recent: 1.4 });
  });

  it('구간이 걸치면 걸친 만큼만 셈', () => {
    expect(usedMinutes([[4, 6]], 5, 10)).toBe(1);
    expect(usedMinutes([[9, 12]], 0, 10)).toBe(1); // 관찰 10분 뒤는 안 셈
  });

  it('겹치는 구간은 한 번만, 순서가 섞여도 같음', () => {
    expect(usedMinutes([[2, 4], [1, 3]], 0, 10)).toBe(3);
  });

  it('사용이 없으면 0', () => {
    expect(usageSummary([])).toEqual({ usage: 0, recent: 0 });
  });
});

describe('H08 기상 확정 시각 = 누적 사용이 θ를 넘은 시각 (D14)', () => {
  it('θ 1분이면 첫 구간이 끝나는 해제 1.5분 뒤', () => {
    const at = thetaReachedAt(dismissed, demo, 1);
    expect(at!.getTime() - dismissed.getTime()).toBe(90_000);
    expect(formatTime(at!)).toBe('오전 8:01'); // 초는 버림
  });

  it('θ 2분이면 셋째 구간에서 넘음 (1 + 0.8 + 0.2 → 해제 6.2분 뒤)', () => {
    const at = thetaReachedAt(dismissed, demo, 2);
    expect(at!.getTime() - dismissed.getTime()).toBeCloseTo(6.2 * 60_000, -1);
  });

  it('θ가 누적 사용보다 크면 null', () => {
    expect(thetaReachedAt(dismissed, demo, 3.5)).toBeNull();
    expect(thetaReachedAt(dismissed, [], 1)).toBeNull();
  });

  it('관찰 10분 뒤 사용은 안 셈', () => {
    expect(thetaReachedAt(dismissed, [[9.5, 12]], 1)).toBeNull();
    expect(thetaReachedAt(dismissed, [[9.5, 12]], 0.5)!.getTime() - dismissed.getTime()).toBe(600_000);
  });

  it('구간 순서가 섞여도 이른 구간부터 셈', () => {
    const at = thetaReachedAt(dismissed, [[3, 4], [1, 1.5]], 1);
    expect(at!.getTime() - dismissed.getTime()).toBe(3.5 * 60_000);
  });
});

describe('H08 화면 글자 — 소수 분 대신 분 · 초, 내부 용어 대신 일상 말', () => {
  it('사용 시간은 초까지 자연수로', () => {
    expect(formatUsage(3.2)).toBe('3분 12초');
    expect(formatUsage(1.4)).toBe('1분 24초');
    expect(formatUsage(0.4)).toBe('24초');
    expect(formatUsage(0)).toBe('0초');
    expect(formatUsage(2)).toBe('2분');
  });

  it('판정 조건 — 채웠으면 썼어요, 아직이면 써야 해요', () => {
    expect(judgeLines(3.2, 1.4, 1)).toEqual(['알람 뒤 1분 넘게 폰을 썼어요', '최근 5분 동안에도 사용했어요']);
    expect(judgeLines(0.4, 0, 1)).toEqual(['알람 뒤 1분 넘게 폰을 써야 해요', '최근 5분 동안에도 사용해야 해요']);
  });

  it('θ · 소수 분 같은 내부 표기가 글자에 없음', () => {
    for (const line of [...judgeLines(0.4, 0, 1), ...judgeLines(3.2, 1.4, 1), formatUsage(3.2)]) {
      expect(line).not.toMatch(/θ|\d\.\d|뒤쪽/);
    }
  });
});

describe('H08 주소에서 알람 id 읽기', () => {
  it('알람 코어 딥링크(alarmId)와 앱 안 길(alarm)을 둘 다 읽고, 둘 다 있으면 딥링크가 먼저', () => {
    expect(pickAlarmId({ alarmId: 'native-1' })).toBe('native-1');
    expect(pickAlarmId({ alarm: 'in-app-1' })).toBe('in-app-1');
    expect(pickAlarmId({ alarmId: 'native-1', alarm: 'in-app-1' })).toBe('native-1');
  });

  it('배열이면 첫 값, 비었으면 없음', () => {
    expect(pickAlarmId({ alarmId: ['a', 'b'] })).toBe('a');
    expect(pickAlarmId({ alarmId: '', alarm: 'in-app-1' })).toBe('in-app-1');
    expect(pickAlarmId({})).toBeUndefined();
    expect(pickAlarmId({ alarmId: [] })).toBeUndefined();
  });
});

describe('H08 실데이터 판정 (evaluateWake)', () => {
  const at = (minutesAfterDismiss: number) => new Date(dismissed.getTime() + minutesAfterDismiss * 60_000);

  it('θ는 1분 (목업 기본값 · 7장 T_active)', () => {
    expect(WAKE_THETA_MINUTES).toBe(1);
  });

  it('관찰 10분 동안은 관찰 중 — 조건을 채웠어도 끝나야 판정', () => {
    const result = evaluateWake({ dismissedAt: dismissed, now: at(6), spans: demo });
    expect(result).toEqual({ phase: 'observing', usage: 3.2, recent: 1.4, reachedAt: null });
  });

  it('10분이 끝났고 누적 사용 ≥ θ 그리고 뒤쪽 5분 사용 > 0이면 자동 확정, 기록 시각은 θ를 넘은 시각 (D14)', () => {
    const result = evaluateWake({ dismissedAt: dismissed, now: at(10), spans: demo });
    expect(result.phase).toBe('auto');
    expect(result.reachedAt!.getTime() - dismissed.getTime()).toBe(90_000);
  });

  it('나중에 열어도 같은 결과 (OS가 보관한 사용 구간으로 판정)', () => {
    expect(evaluateWake({ dismissedAt: dismissed, now: at(180), spans: demo })).toEqual(evaluateWake({ dismissedAt: dismissed, now: at(10), spans: demo }));
  });

  it('누적 사용이 모자라면 확인 알림(prompt)', () => {
    expect(evaluateWake({ dismissedAt: dismissed, now: at(11), spans: [[0.2, 0.6]] })).toMatchObject({ phase: 'prompt', usage: 0.4, recent: 0, reachedAt: null });
  });

  it('누적은 채웠어도 뒤쪽 5분에 사용이 없으면 확인 알림 (알람 끄고 잠깐 보고 다시 잠든 경우)', () => {
    expect(evaluateWake({ dismissedAt: dismissed, now: at(11), spans: [[0.5, 2.5]] })).toMatchObject({ phase: 'prompt', usage: 2, recent: 0 });
  });

  it('사용 구간을 읽을 수 없으면(권한 없음) 바로 확인 알림 — 일어났어요 버튼만', () => {
    expect(evaluateWake({ dismissedAt: dismissed, now: at(1), spans: null })).toEqual({ phase: 'prompt', usage: 0, recent: 0, reachedAt: null });
  });

  it('소수 첫째 자리로 줄인 값이 아니라 실제 합으로 θ와 비교', () => {
    // 0.96분 사용: 화면에는 1.0으로 보여도 θ(1분)에는 못 미침
    expect(evaluateWake({ dismissedAt: dismissed, now: at(11), spans: [[7, 7.96]] }).phase).toBe('prompt');
  });

  it('θ를 바꿔 넘길 수 있음', () => {
    expect(evaluateWake({ dismissedAt: dismissed, now: at(11), spans: demo, theta: 4 }).phase).toBe('prompt');
  });
});

describe('H08 해제 기록이 여러 개일 때 (pickDismissedAt)', () => {
  const t = (m: number) => kst(22, 480 + m);

  it('확정 전이면 마지막 해제 — 다시 울린 뒤 끄면 그 시각부터 10분', () => {
    expect(pickDismissedAt([t(0), t(8)], null)).toEqual(t(8));
    expect(pickDismissedAt([t(8), t(0)], null)).toEqual(t(8));
  });

  it('확정 뒤면 확정 직전의 해제 — 확정 뒤 다른 울림이 있어도 판정이 안 바뀜', () => {
    expect(pickDismissedAt([t(0), t(8), t(30)], t(12))).toEqual(t(8));
  });

  it('확정보다 앞선 해제가 없으면 마지막 해제', () => {
    expect(pickDismissedAt([t(20)], t(5))).toEqual(t(20));
  });

  it('해제 기록이 없으면 null', () => {
    expect(pickDismissedAt([], null)).toBeNull();
    expect(pickDismissedAt([], t(5))).toBeNull();
  });
});
