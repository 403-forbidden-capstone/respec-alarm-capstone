import { afterEach, describe, expect, it } from '@jest/globals';

import { aiDb, suggestedRoutine } from '@/mocks/ai';
import { db } from '@/mocks/data';

import { getEveningRoutine, saveRoutine } from '../api';

afterEach(() => {
  aiDb.routines.length = 0;
  db.events.length = 0;
});

describe('H01 저녁 루틴 카드', () => {
  it('저장한 루틴이 없으면 null', async () => {
    expect(await getEveningRoutine()).toBeNull();
  });

  it('가장 최근에 저장한 루틴 — 이미 있는 루틴을 고쳐 저장해도 그 루틴', async () => {
    const first = await saveRoutine(suggestedRoutine(null));
    const second = await saveRoutine({ ...suggestedRoutine(null), title: '주말 준비' });
    expect((await getEveningRoutine())!.id).toBe(second.id);
    await saveRoutine({ ...first, title: '회의 전날 준비 (고침)' });
    const card = await getEveningRoutine();
    expect([card!.id, card!.title, card!.stepCount]).toEqual([first.id, '회의 전날 준비 (고침)', 3]);
    expect(aiDb.routines.map((r) => r.id)).toEqual([second.id, first.id]);
  });
});
