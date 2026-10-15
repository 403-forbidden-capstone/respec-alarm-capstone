import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_DEVICE_ID,
  DEVICES,
  FRAME_MIN_EXTRA,
  MIN_SCALE,
  PANEL_COLLAPSED_WIDTH,
  PANEL_WIDTH,
  STAGE_MARGIN,
  fitScale,
  frameSize,
  getDevice,
  isDeviceId,
  showFrame,
} from '../devices';

const panel = { width: PANEL_WIDTH, margin: STAGE_MARGIN };

describe('기종 목록', () => {
  it('기본 기종은 Galaxy S24 360x780', () => {
    const d = getDevice(DEFAULT_DEVICE_ID);
    expect(d.id).toBe('s24');
    expect(d.name).toBe('Galaxy S24');
    expect([d.width, d.height]).toEqual([360, 780]);
  });

  it('모르는 id · 빈 값은 기본 기종', () => {
    expect(getDevice('nope').id).toBe('s24');
    expect(getDevice(null).id).toBe('s24');
    expect(getDevice(undefined).id).toBe('s24');
  });

  it('id가 겹치지 않음', () => {
    const ids = DEVICES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(isDeviceId)).toBe(true);
    expect(isDeviceId('nope')).toBe(false);
  });

  it('모든 기종의 폭 · 높이 · 반지름 · 베젤 · inset이 양수이고 inset이 화면 안에 듦', () => {
    for (const d of DEVICES) {
      expect(d.width).toBeGreaterThan(0);
      expect(d.height).toBeGreaterThan(0);
      expect(d.radius).toBeGreaterThan(0);
      expect(d.bezel).toBeGreaterThan(0);
      expect(d.insetTop).toBeGreaterThan(0);
      expect(d.insetBottom).toBeGreaterThan(0);
      expect(d.insetTop + d.insetBottom).toBeLessThan(d.height);
      expect(d.radius).toBeLessThanOrEqual(d.width / 2);
    }
  });

  it('프레임 크기는 화면 + 베젤 양쪽', () => {
    const d = getDevice('s24');
    expect(frameSize(d)).toEqual({ width: 380, height: 800 });
  });
});

describe('프레임 표시', () => {
  it('창 폭이 기종 폭 + 100보다 좁으면 프레임 없음', () => {
    const d = getDevice('s24');
    expect(showFrame(d.width + FRAME_MIN_EXTRA - 1, d)).toBe(false);
    expect(showFrame(d.width + FRAME_MIN_EXTRA, d)).toBe(true);
    expect(showFrame(390, d)).toBe(false); // 390x844 에뮬레이션
    expect(showFrame(1280, d)).toBe(true);
  });
});

describe('fitScale', () => {
  const s24 = getDevice('s24');

  it('넉넉한 창은 비율 1', () => {
    expect(fitScale({ width: 1440, height: 900 }, s24, panel)).toBe(1);
  });

  it('높이가 모자라면 줄임 (1 이하 · 양수)', () => {
    const scale = fitScale({ width: 1440, height: 600 }, s24, panel);
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1);
    expect(frameSize(s24).height * scale).toBeLessThanOrEqual(600 - STAGE_MARGIN + 0.001);
  });

  it('폭이 모자라면 줄임', () => {
    const scale = fitScale({ width: 600, height: 1000 }, s24, panel);
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1);
    expect(frameSize(s24).width * scale + PANEL_WIDTH + STAGE_MARGIN).toBeLessThanOrEqual(600 + 0.001);
  });

  it('패널을 접으면 같은 창에서 더 크게 보임', () => {
    const win = { width: 600, height: 1000 };
    const open = fitScale(win, s24, panel);
    const folded = fitScale(win, s24, { width: PANEL_COLLAPSED_WIDTH, margin: STAGE_MARGIN });
    expect(folded).toBeGreaterThan(open);
  });

  it('모든 기종 · 여러 창 크기에서 MIN_SCALE 이상 1 이하', () => {
    const windows = [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 800, height: 500 },
      { width: 480, height: 300 },
      { width: 100, height: 100 },
      { width: 0, height: 0 },
    ];
    for (const d of DEVICES) {
      for (const w of windows) {
        const scale = fitScale(w, d, panel);
        expect(scale).toBeGreaterThanOrEqual(MIN_SCALE);
        expect(scale).toBeLessThanOrEqual(1);
      }
    }
  });
});
