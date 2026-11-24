import { afterEach, describe, expect, it } from '@jest/globals';

import { db } from '@/mocks/data';

import { checkRoutineStep, getRoutineLiveToken, getTodayRoutine } from '../api';

// 아침 루틴 음성 진행 — 가짜 데이터의 단계 기록 (실데이터는 realCheckStep.test.ts)
const before = { ...db.morningRoutine, steps: [...db.morningRoutine.steps] };
afterEach(() => {
  Object.assign(db.morningRoutine, { ...before, steps: [...before.steps] });
});

describe('checkRoutineStep (가짜 데이터)', () => {
  it('그 단계까지 끝낸 것으로 — 뒤로 가지 않음, 다른 루틴 · 없는 단계는 null', async () => {
    const r = await getTodayRoutine();
    expect(r).not.toBeNull();
    const id = r!.id;
    db.morningRoutine.done = 0;
    expect((await checkRoutineStep(id, 2, 'VOICE'))?.done).toBe(2);
    expect((await checkRoutineStep(id, 1, 'BUTTON'))?.done).toBe(2);
    expect(await checkRoutineStep('other', 1, 'VOICE')).toBeNull();
    expect(await checkRoutineStep(id, r!.steps.length + 1, 'VOICE')).toBeNull();
  });

  it('가짜 데이터에서는 음성 토큰을 받지 않음 (대본으로 진행)', async () => {
    await expect(getRoutineLiveToken('r1')).rejects.toThrow('대본');
  });
});
