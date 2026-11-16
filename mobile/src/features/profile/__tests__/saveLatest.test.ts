import { describe, expect, it } from '@jest/globals';

import { saveLatest } from '../saveLatest';

describe('마지막으로 고른 값까지 저장', () => {
  it('저장 중에 두 번 더 바뀌면 마지막 값만 이어서 저장', async () => {
    let want = '중';
    const saved: string[] = [];
    await saveLatest(
      () => want,
      async (v) => {
        if (v === '중') want = '약';
        if (v === '중') want = '강'; // 저장하는 사이 약 → 강
        saved.push(v);
      },
      () => {},
    );
    expect(saved).toEqual(['중', '강']);
  });
  it('실패하면 그 전에 저장된 값만 알리고 오류를 던짐', async () => {
    let want = '중';
    const ok: string[] = [];
    const run = saveLatest(
      () => want,
      async (v) => {
        if (v === '강') throw new Error('network');
        want = '강';
      },
      (v) => ok.push(v),
    );
    await expect(run).rejects.toThrow('network');
    expect(ok).toEqual(['중']);
  });
});
