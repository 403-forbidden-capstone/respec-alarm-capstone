import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keyCandidates, matchesAnyKey, parseKeyDictionary, timingSafeEqual } from './keys.ts';

test('키 사전(JSON)에서 값만 꺼냄, 깨진 값은 단일 키로 봄', () => {
  assert.deepEqual(parseKeyDictionary('{"default":"sb_secret_a","other":"sb_secret_b"}'), ['sb_secret_a', 'sb_secret_b']);
  assert.deepEqual(parseKeyDictionary(undefined), []);
  assert.deepEqual(parseKeyDictionary(''), []);
  assert.deepEqual(parseKeyDictionary('sb_secret_plain'), ['sb_secret_plain']);
  assert.deepEqual(parseKeyDictionary('{"a":1,"b":""}'), []);
});

test('같은 글자만 같다고 봄 (길이가 달라도 거절)', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
});

test('apikey 머리글 · Authorization Bearer 어느 쪽에 실어도 받음 (배치는 둘 다, 새 키는 apikey만)', () => {
  const keys = ['service-key'];
  assert.equal(matchesAnyKey(new Headers({ apikey: 'service-key' }), keys), true);
  assert.equal(matchesAnyKey(new Headers({ authorization: 'Bearer service-key' }), keys), true);
  assert.equal(matchesAnyKey(new Headers({ authorization: 'Bearer service-key', apikey: 'service-key' }), keys), true);
  assert.equal(matchesAnyKey(new Headers({ authorization: 'Bearer user-token', apikey: 'anon-key' }), keys), false);
  assert.equal(matchesAnyKey(new Headers(), keys), false);
});

test('서버에 키가 하나도 없으면 아무도 통과 못 함 (빈 키로 뚫리지 않음)', () => {
  assert.equal(matchesAnyKey(new Headers({ apikey: '' }), ['']), false);
  assert.equal(matchesAnyKey(new Headers({ apikey: 'x' }), []), false);
  assert.deepEqual(keyCandidates(new Headers({ authorization: 'Basic abc' })), []);
});
