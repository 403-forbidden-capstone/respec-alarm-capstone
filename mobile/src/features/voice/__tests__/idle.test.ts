import { describe, expect, it } from '@jest/globals';

import { IDLE_MS, idleArm, idleExpired, idleHeard, idleOff, idleVad, NOISE_MAX_MS, VAD_GRACE_MS } from '../idle';

// 30초 무발화 판정 — 시각(ms)을 직접 넘겨 봄
describe('30초 무발화 판정 (idle)', () => {
  it('재지 않는 동안(AI가 말하는 중 · 연결 전)은 몇 초가 지나도 끝내지 않음', () => {
    expect(idleExpired(idleOff(), 40_000)).toBe(false);
    expect(idleExpired(idleOff(), 10 * 60_000)).toBe(false);
  });

  it('듣기 시작부터 30초 무발화면 끝냄, 29.9초는 아님', () => {
    const w = idleArm(1_000);
    expect(idleExpired(w, 1_000 + IDLE_MS - 100)).toBe(false);
    expect(idleExpired(w, 1_000 + IDLE_MS)).toBe(true);
  });

  it('20초에 받아쓰기(사용자 말)가 오면 새 30초', () => {
    const w = idleHeard(idleArm(0), 20_000);
    expect(idleExpired(w, 30_000)).toBe(false);
    expect(idleExpired(w, 49_999)).toBe(false);
    expect(idleExpired(w, 50_000)).toBe(true);
  });

  it('29초에 말하기 시작하면 말하는 동안은 끝내지 않고, 끝난 뒤 받아쓰기 · 답이 올 시간을 남김', () => {
    let w = idleVad(idleArm(0), 29_000, true);
    expect(idleExpired(w, 31_000)).toBe(false); // 말하는 중
    w = idleVad(w, 33_000, false); // 4초 말함
    expect(idleExpired(w, 33_000 + VAD_GRACE_MS - 1)).toBe(false);
    expect(idleExpired(w, 33_000 + VAD_GRACE_MS)).toBe(true); // 받아쓰기도 AI 답도 없으면 끝냄
    // 늦게 온 받아쓰기는 새 30초
    expect(idleExpired(idleHeard(w, 36_000), 60_000)).toBe(false);
  });

  it('주변 소음(받아쓰기 없는 소리 감지)으로는 끝없이 늘지 않음 — 이어지는 소음도, 끊어지는 소음도', () => {
    // 이어지는 소음: 소음 한도까지만 기다림
    const on = idleVad(idleArm(0), 25_000, true);
    expect(idleExpired(on, 25_000 + NOISE_MAX_MS)).toBe(false);
    expect(idleExpired(on, IDLE_MS + NOISE_MAX_MS)).toBe(true);
    // 끊어지는 소음: 1초짜리 소리가 5초마다 — 합이 한도를 넘으면 더 늘리지 않음
    let w = idleArm(0);
    let t = 0;
    for (; t < 10 * 60_000 && !idleExpired(w, t); t += 1_000) {
      if (t % 5_000 === 0) w = idleVad(w, t, true);
      if (t % 5_000 === 1_000) w = idleVad(w, t, false);
    }
    expect(t).toBeLessThanOrEqual(IDLE_MS + NOISE_MAX_MS);
  });

  it('AI가 말하는 동안(재지 않음)에 온 받아쓰기 · 소리 감지는 무시 — AI 목소리가 사용자 말로 셈되지 않음', () => {
    expect(idleHeard(idleOff(), 1_000)).toEqual(idleOff());
    expect(idleVad(idleOff(), 1_000, true)).toEqual(idleOff());
  });
});
