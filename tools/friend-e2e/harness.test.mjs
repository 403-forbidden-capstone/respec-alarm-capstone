import assert from 'node:assert/strict';
import { test } from 'node:test';

import { capsFromOpenApi } from './caps.mjs';
import { Fail, must, ok, reportMarkdown, runSteps, skip, statusRow, summarize } from './harness.mjs';
import { isLocalUrl, parseEnvFile } from './env.mjs';
import { RPC, rpcOf } from './rpc-map.mjs';

const step = (n, run, extra = {}) => ({ n, who: 'A', ch: 2, action: `a${n}`, run, ...extra });

test('PASS · FAIL · SKIP을 가른다', async () => {
  const results = await runSteps(
    [
      step(1, async () => {}),
      step(2, async () => skip('아직 없음')),
      step(3, async () => must(false, '안 됨')),
      step(4, async () => {
        throw new Error('뜻밖');
      }),
    ],
    {},
  );
  assert.deepEqual(results.map((r) => r.status), ['PASS', 'SKIP', 'FAIL', 'FAIL']);
  assert.match(results[3].reason, /예기치 않은 오류: 뜻밖/);
});

test('앞 단계가 PASS가 아니면 뒤 단계는 SKIP', async () => {
  const results = await runSteps(
    [step(1, async () => must(false, 'x')), step(2, async () => {}, { deps: [1] }), step(3, async () => {}, { deps: [2] })],
    {},
  );
  assert.deepEqual(results.map((r) => r.status), ['FAIL', 'SKIP', 'SKIP']);
  assert.equal(results[1].reason, '앞 단계 1이(가) FAIL');
});

test('생략한 확인은 notes에 남고 PASS는 그대로', async () => {
  const results = await runSteps([step(1, async (ctx) => ctx.note('푸시 확인 생략'))], {});
  assert.equal(results[0].status, 'PASS');
  assert.deepEqual(results[0].notes, ['푸시 확인 생략']);
});

test('ok()는 오류 응답을 FAIL로 바꾼다', () => {
  assert.throws(() => ok({ error: { message: 'rls' } }, '요청'), Fail);
  assert.equal(ok({ data: 5, error: null }, '요청'), 5);
});

test('요약 · 개발현황 줄 · 보고서', async () => {
  const results = await runSteps([step(1, async () => {}), step(2, async () => skip('없음')), step(3, async () => must(false, '깨짐'))], {});
  const s = summarize(results);
  assert.deepEqual(s.count, { PASS: 1, FAIL: 1, SKIP: 1 });
  assert.equal(s.firstFail.n, 3);
  assert.equal(statusRow(results, { date: '11/8', main: 'abc1234' }), '| 11/8 | abc1234 | PASS 1 / FAIL 1 / SKIP 1 | 2 SKIP: 없음 |');
  assert.match(reportMarkdown(results, { date: '11/8', main: 'abc1234' }), /\| 3 \| A \| 2 \| FAIL \| 깨짐 \|/);
});

test('OpenAPI에서 표 · 칼럼 · 함수를 읽는다', () => {
  const caps = capsFromOpenApi({
    paths: { '/': {}, '/friends': {}, '/rpc/block_user': {} },
    definitions: { friends: { properties: { friend_id: {}, status: {} } } },
  });
  assert.ok(caps.hasTable('friends') && !caps.hasTable('user_blocks'));
  assert.ok(caps.hasCol('friends', 'status') && !caps.hasCol('friends', 'nope'));
  assert.ok(caps.hasRpc('block_user'));
  assert.equal(rpcOf(caps, 'block_user'), 'block_user');
  assert.equal(rpcOf(caps, 'wake_ping'), null); // 이름 없음
  assert.equal(RPC.wake_ping, null);
});

test('로컬 주소만 허용 · env 읽기', () => {
  assert.ok(isLocalUrl('http://127.0.0.1:54321') && isLocalUrl('http://localhost:54321'));
  assert.ok(!isLocalUrl('https://abc.supabase.co') && !isLocalUrl('not a url'));
  assert.deepEqual(parseEnvFile('# c\nA=1\nB="x y"\n'), { A: '1', B: 'x y' });
});
