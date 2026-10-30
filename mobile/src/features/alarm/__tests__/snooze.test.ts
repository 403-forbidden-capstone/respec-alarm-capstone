import { describe, expect, it } from '@jest/globals';

import { getRing } from '../api';
import { snoozeView } from '../snooze';
import type { RingInfo } from '../types';

const MINUTE = 60_000;
const late = (view: ReturnType<typeof snoozeView>) => view.chips.map((chip) => [chip.minutes, chip.lateMinutes]);

// 가짜 데이터의 팀 주간회의: 기상 8:00 · 출발 9:00
async function ring(alarm: string, patch: Partial<RingInfo> = {}): Promise<RingInfo> {
  return { ...(await getRing(alarm))!, ...patch };
}

describe('H07 미루기 칸 — 웹 미리보기가 그리는 값 (네이티브 울림 화면과 같은 규칙)', () => {
  it('출발 한참 전 기상 알람은 어느 칩도 안 늦고 경고 띠도 없음', async () => {
    const view = snoozeView(await ring('a1:WAKE'));
    expect(view.allowed).toBe(true);
    expect(late(view)).toEqual([[5, 0], [10, 0], [15, 0]]);
    expect(view.wakeNow).toBe(false);
  });

  it('칩마다 출발보다 몇 분 늦는지가 달라짐 (출발 시각에 울린 알람: 5 · 10 · 15분)', async () => {
    const view = snoozeView(await ring('a1:DEPARTURE'));
    expect(late(view)).toEqual([[5, 5], [10, 10], [15, 15]]);
    expect(view.wakeNow).toBe(false); // 기상 알람이 아니면 "지금 일어나야" 띠는 없음
  });

  it('기상 알람이 출발 3분 전에 울리면 5분만 미뤄도 늦음 → 늦는 분이 2 · 7 · 12분이고 경고 띠가 뜸', async () => {
    const base = await ring('a1:WAKE');
    const view = snoozeView({ ...base, at: new Date(base.departAt!.getTime() - 3 * MINUTE) });
    expect(late(view)).toEqual([[5, 2], [10, 7], [15, 12]]);
    expect(view.wakeNow).toBe(true);
  });

  it('5분은 안 늦고 10 · 15분만 늦으면 띠는 없고 그 칩만 늦음', async () => {
    const base = await ring('a1:WAKE');
    const view = snoozeView({ ...base, at: new Date(base.departAt!.getTime() - 7 * MINUTE) });
    expect(late(view)).toEqual([[5, 0], [10, 3], [15, 8]]);
    expect(view.wakeNow).toBe(false);
  });

  it('한도에 닿으면 미루기를 못 하고 늦어요 표시도 없음', async () => {
    const base = await ring('a1:WAKE');
    const view = snoozeView({ ...base, at: new Date(base.departAt!.getTime() - 3 * MINUTE), snoozeCount: 3 });
    expect(view.allowed).toBe(false);
    expect(late(view)).toEqual([[5, 0], [10, 0], [15, 0]]);
    expect(view.wakeNow).toBe(false);
  });

  it('출발 시각을 모르면 늦는지 판단하지 않음', async () => {
    const view = snoozeView(await ring('a1:WAKE', { departAt: null }));
    expect(late(view)).toEqual([[5, 0], [10, 0], [15, 0]]);
    expect(view.wakeNow).toBe(false);
  });
});
