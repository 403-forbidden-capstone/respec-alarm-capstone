// alarm-commit 요청 키 메모리 표 (commitKey.ts) — 같은 본문 재시도 = 같은 키 · 성공 뒤 = 새 키 · 다른 본문 = 다른 키 · 10분 지나면 새 키
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { clearCommitKeys, COMMIT_KEY_TTL_MS, commitKeyFor, forgetCommitKey } from '../commitKey';

let mockCounter = 0;
jest.mock('@capstone/alarm-core', () => ({ makeUuid: () => `00000000-0000-4000-8000-${String(++mockCounter).padStart(12, '0')}` }));

const T0 = 1_700_000_000_000;
const body = (title: string) => ({ appointment: { title }, edits: [] });

beforeEach(() => {
  mockCounter = 0;
  clearCommitKeys();
});

describe('commitKey', () => {
  it('같은 본문으로 다시 부르면(실패 뒤 다시 누름) 같은 키 — uuid 모양', () => {
    const first = commitKeyFor(body('수업'), T0);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(commitKeyFor(body('수업'), T0 + 60_000)).toBe(first);
    expect(commitKeyFor(body('수업'), T0 + COMMIT_KEY_TTL_MS - 1)).toBe(first);
  });

  it('본문이 다르면 다른 키, 서로의 키는 그대로', () => {
    const a = commitKeyFor(body('수업'), T0);
    const b = commitKeyFor(body('회식'), T0);
    expect(b).not.toBe(a);
    expect(commitKeyFor(body('수업'), T0 + 1_000)).toBe(a);
    expect(commitKeyFor(body('회식'), T0 + 1_000)).toBe(b);
  });

  it('저장이 성공해 지우면 같은 본문도 새 키', () => {
    const a = commitKeyFor(body('수업'), T0);
    forgetCommitKey(body('수업'));
    expect(commitKeyFor(body('수업'), T0 + 1_000)).not.toBe(a);
  });

  it('10분이 지나면 같은 본문도 새 키 — 실패를 되풀이해도 처음 만든 시각 기준', () => {
    const a = commitKeyFor(body('수업'), T0);
    expect(commitKeyFor(body('수업'), T0 + 9 * 60_000)).toBe(a); // 안 지남 (만든 시각은 그대로)
    const b = commitKeyFor(body('수업'), T0 + COMMIT_KEY_TTL_MS);
    expect(b).not.toBe(a);
    expect(commitKeyFor(body('수업'), T0 + COMMIT_KEY_TTL_MS + 1_000)).toBe(b);
  });

  it('쌓이는 키는 50개까지 — 넘으면 가장 오래된 것부터 버림', () => {
    const first = commitKeyFor(body('0'), T0);
    for (let i = 1; i <= 50; i += 1) commitKeyFor(body(String(i)), T0);
    expect(commitKeyFor(body('0'), T0)).not.toBe(first);
  });
});
