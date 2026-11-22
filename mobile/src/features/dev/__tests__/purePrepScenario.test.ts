import { describe, expect, it } from '@jest/globals';

import { calculatePurePrepScenario, DEFAULT_PURE_SCENARIO, kstHm } from '../purePrepScenario';

describe('web pure preparation test bench (no DB / no native alarm)', () => {
  it('10:00 appointment / 30 travel / 10 buffer / 35 pure = 09:20 departure, 08:45 prep, 08:25 wake', () => {
    const rows = calculatePurePrepScenario(DEFAULT_PURE_SCENARIO);
    expect(kstHm(rows.DEPARTURE)).toBe('09:20');
    expect(kstHm(rows.PREPARE)).toBe('08:45');
    expect(kstHm(rows.WAKE)).toBe('08:25');
    expect(kstHm(rows.ARRIVE)).toBe('09:50');
  });

  it('pre-preparation activities move WAKE but not PREPARE', () => {
    const rows = calculatePurePrepScenario({ ...DEFAULT_PURE_SCENARIO, preTaskMinutes: 15 });
    expect(kstHm(rows.WAKE)).toBe('08:10');
    expect(kstHm(rows.PREPARE)).toBe('08:45');
  });

  it('an already-awake schedule has no WAKE alarm and still prepares 35 min before departure', () => {
    const rows = calculatePurePrepScenario({ ...DEFAULT_PURE_SCENARIO, withWake: false });
    expect(rows.WAKE).toBeUndefined();
    expect(kstHm(rows.PREPARE)).toBe('08:45');
    expect(kstHm(rows.DEPARTURE)).toBe('09:20');
  });

  it('rejects invalid pure preparation duration rather than quietly saving it', () => {
    expect(() => calculatePurePrepScenario({ ...DEFAULT_PURE_SCENARIO, pureMinutes: -10 })).toThrow(RangeError);
  });
});
