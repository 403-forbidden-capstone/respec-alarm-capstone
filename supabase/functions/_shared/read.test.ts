import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from './errors.ts';
import { Reader, parseIso, readJson } from './read.ts';

test('ISO 8601은 오프셋이 있어야 함 (5장 5.2)', () => {
  assert.equal(parseIso('2026-10-20T10:00:00+09:00')?.toISOString(), '2026-10-20T01:00:00.000Z');
  assert.equal(parseIso('2026-10-20T10:00Z')?.toISOString(), '2026-10-20T10:00:00.000Z');
  assert.equal(parseIso('2026-10-20T10:00:00'), undefined); // 오프셋 없음
  assert.equal(parseIso('2026-10-20'), undefined);
  assert.equal(parseIso('2026-13-40T10:00:00Z'), undefined);
});

test('필드를 읽으면서 문제를 모았다가 한 번에 던짐 (VALIDATION_FAILED + details.issues)', () => {
  const r = Reader.root({ title: 3, minutes: 'x', transport: 'ROCKET', when: 'soon', nested: { n: -1 } });
  r.string('title', { required: true });
  r.int('minutes');
  r.oneOf('transport', ['WALK', 'CAR'] as const);
  r.date('when');
  r.object('nested')?.int('n', { min: 0 });
  r.string('missing', { required: true });
  assert.throws(
    () => r.finish(),
    (e: unknown) => {
      assert.ok(e instanceof HttpError);
      assert.equal(e.code, 'VALIDATION_FAILED');
      assert.equal(e.status, 400);
      const paths = (e.details as { issues: { path: string }[] }).issues.map((i) => i.path);
      assert.deepEqual(paths, ['title', 'minutes', 'transport', 'when', 'nested.n', 'missing']);
      return true;
    },
  );
});

test('맞는 값은 그대로 읽음 · 글자는 앞뒤 공백 제거 · null은 없음', () => {
  const r = Reader.root({ title: '  팀 회의 ', n: 5, ok: true, id: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', when: '2026-10-20T10:00:00+09:00', skipped: null, kinds: ['WAKE', 'WAKE', 'DEPARTURE'] });
  assert.equal(r.string('title', { max: 100 }), '팀 회의');
  assert.equal(r.int('n', { min: 0, max: 10 }), 5);
  assert.equal(r.bool('ok'), true);
  assert.equal(r.uuid('id'), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(r.date('when')?.getTime(), Date.parse('2026-10-20T01:00:00Z'));
  assert.equal(r.string('skipped'), undefined);
  assert.equal(r.isNull('skipped'), true);
  assert.deepEqual(r.stringList('kinds', ['WAKE', 'PREPARE', 'DEPARTURE'] as const), ['WAKE', 'DEPARTURE']);
  r.finish();
});

test('범위를 벗어나면 문제로 기록', () => {
  const r = Reader.root({ a: 600.5, b: 700, c: 'x'.repeat(101), kinds: ['WAKE', 'ARRIVE'], items: [1] });
  r.int('a');
  r.int('b', { max: 600 });
  r.string('c', { max: 100 });
  r.stringList('kinds', ['WAKE', 'PREPARE', 'DEPARTURE'] as const);
  r.objects('items');
  assert.equal(r.issues.length, 5);
});

test('본문이 객체가 아니면 바로 거절', () => {
  assert.throws(() => Reader.root([]), HttpError);
  assert.throws(() => Reader.root('x'), HttpError);
  assert.throws(() => Reader.root(null), HttpError);
});

test('JSON 본문 읽기: 비었거나 깨졌으면 거절', async () => {
  const post = (body: string) => new Request('http://x', { method: 'POST', body });
  assert.deepEqual(await readJson(post('{"a":1}')), { a: 1 });
  await assert.rejects(() => readJson(post('')), HttpError);
  await assert.rejects(() => readJson(post('{bad')), HttpError);
  await assert.rejects(() => readJson(post('x'.repeat(100_001))), HttpError);
});

test('user_edit_logs 값처럼 아무 JSON이나 받되 너무 크면 거절', () => {
  const r = Reader.root({ small: { a: 1 }, big: 'x'.repeat(3000) });
  assert.deepEqual(r.json('small'), { a: 1 });
  assert.equal(r.json('big'), undefined);
  assert.equal(r.issues.length, 1);
});
