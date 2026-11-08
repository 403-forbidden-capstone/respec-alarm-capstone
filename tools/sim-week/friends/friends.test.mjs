// 난수와 규칙 검사기 시험 (DB 없음). 검사기가 실제로 위반을 잡는지 일부러 틀린 상태를 넣어 확인함
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkGroups, checkGroupVisibility, checkMemberRows, checkSharedRead, checkState, isServerFault } from './oracle.mjs';
import { makeRng } from './rng.mjs';

const A = 'a';
const B = 'b';
const C = 'c';
const fr = (id, x, y, status = 'ACCEPTED') => ({ friend_id: id, requester_id: x, addressee_id: y, status, accepted_at: status === 'ACCEPTED' ? 't' : null });

test('난수: 같은 씨앗은 같은 열, 다른 씨앗은 다름', () => {
  const run = (seed) => { const r = makeRng(seed); return Array.from({ length: 8 }, () => r.int(1000)); };
  assert.deepEqual(run('x'), run('x'));
  assert.notDeepEqual(run('x'), run('y'));
  const r = makeRng('w');
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 2000; i += 1) counts[r.weighted([{ w: 3, k: 'a' }, { w: 1, k: 'b' }]).k] += 1;
  assert.ok(counts.a > counts.b * 2);
});

test('깨끗한 상태는 위반 0', () => {
  const friends = [fr('f1', A, B)];
  const perms = [{ permission_id: 'p1', owner_id: A, grantee_id: B, source_type: 'FRIEND', source_id: 'f1', can_view_alarm: true }];
  assert.deepEqual(checkState({ friends, blocks: [], perms, hasBlocksTable: true }), []);
});

test('두 사람 사이 두 행 · 수락 시각 없음 · 자기 자신 · 100명 초과를 잡음', () => {
  const rules = (s) => checkState({ ...s, hasBlocksTable: true }).map((v) => v.rule);
  assert.ok(rules({ friends: [fr('f1', A, B), fr('f2', B, A)] }).includes('F-두 사람 사이 한 행'));
  assert.ok(rules({ friends: [{ ...fr('f1', A, B), accepted_at: null }] }).includes('F-수락 시각'));
  assert.ok(rules({ friends: [fr('f1', A, A)] }).includes('F-자기 자신'));
  const many = Array.from({ length: 101 }, (_, i) => fr(`f${i}`, A, `u${i}`));
  assert.ok(rules({ friends: many }).includes('F-친구 100명 상한'));
  assert.ok(rules({ friends: [fr('f1', A, B, 'BLOCKED')] }).includes('F-상태 값'));
});

test('차단 쌍에 친구 행 · 권한이 남으면 잡음', () => {
  const blocks = [{ blocker_id: A, blocked_id: B }];
  const perms = [{ permission_id: 'p1', owner_id: B, grantee_id: A, source_type: 'GROUP', source_id: 'g', can_view_alarm: true }];
  const rules = checkState({ friends: [fr('f1', B, A)], blocks, perms, hasBlocksTable: true }).map((v) => v.rule);
  assert.ok(rules.includes('B-차단 쌍에 친구 행'));
  assert.ok(rules.includes('B-차단 쌍에 공유 권한'));
});

test('친구 출처 권한: 친구 행이 없거나 친구가 아니거나 다른 두 사람이면 잡음', () => {
  const p = (src) => ({ permission_id: 'p1', owner_id: A, grantee_id: B, source_type: 'FRIEND', source_id: src, can_view_alarm: true });
  const rules = (friends, src) => checkState({ friends, perms: [p(src)], hasBlocksTable: true }).map((v) => v.rule);
  assert.ok(rules([], 'f1').includes('P-친구 출처 권한의 친구 행 없음'));
  assert.ok(rules([fr('f1', A, B, 'PENDING')], 'f1').includes('P-친구 출처 권한인데 친구 아님'));
  assert.ok(rules([fr('f1', A, C)], 'f1').includes('P-권한 출처 친구 행이 다른 두 사람'));
});

test('공유 알람 조회: 권한 없는데 보이면 위반, 권한 있는데 안 보이면 이상, 차단 쌍이면 위반', () => {
  const friends = [fr('f1', A, B)];
  const perm = { permission_id: 'p1', owner_id: A, grantee_id: B, source_type: 'FRIEND', source_id: 'f1', can_view_alarm: true };
  const read = (over) => checkSharedRead({ owner: A, grantee: B, rows: [{ x: 1 }], perms: [perm], friends, blocks: [], ...over });
  assert.deepEqual(read({}), []);
  assert.equal(read({ perms: [] })[0].kind, 'VIOLATION');
  assert.equal(read({ perms: [{ ...perm, can_view_alarm: false }] })[0].kind, 'VIOLATION');
  assert.equal(read({ rows: [] })[0].kind, 'ANOMALY');
  assert.deepEqual(read({ rows: [], perms: [] }), []);
  assert.equal(read({ blocks: [{ blocker_id: B, blocked_id: A }] })[0].kind, 'VIOLATION');
});

test('그룹 노출: 멤버 아닌 그룹은 위반, 그룹장이라 보이는 건 알려진 동작', () => {
  const members = [{ user_id: A, group_id: 'g1', invite_status: 'JOINED' }, { user_id: B, group_id: 'g2', invite_status: 'LEFT' }];
  const groups = [{ group_id: 'g1', owner_id: A }, { group_id: 'g2', owner_id: B }, { group_id: 'g3', owner_id: C }];
  assert.deepEqual(checkGroupVisibility({ me: A, visibleGroupIds: ['g1'], members, groups }), []);
  assert.equal(checkGroupVisibility({ me: A, visibleGroupIds: ['g3'], members, groups })[0].kind, 'VIOLATION');
  assert.equal(checkGroupVisibility({ me: B, visibleGroupIds: ['g2'], members, groups })[0].kind, 'KNOWN');
  assert.equal(checkGroupVisibility({ me: B, visibleGroupIds: ['g1'], members, groups })[0].kind, 'VIOLATION');
});

test('서버 오류와 정상 거절을 가름', () => {
  assert.equal(isServerFault({ code: 'XX000', message: 'x' }), true);
  assert.equal(isServerFault({ code: '42501', message: 'denied' }), false);
  assert.equal(isServerFault({ code: '23505', message: 'dup' }), false);
  assert.equal(isServerFault(null), false);
});

test('5장 그룹 노출(strict): 초대만 받은 그룹이 보이면 위반, 만든 직후 예외는 알려진 동작', () => {
  const members = [{ user_id: A, group_id: 'g1', invite_status: 'INVITED' }, { user_id: B, group_id: 'g1', invite_status: 'JOINED' }];
  const groups = [{ group_id: 'g1', owner_id: B }];
  assert.deepEqual(checkGroupVisibility({ me: A, visibleGroupIds: ['g1'], members, groups }), []); // 옛 규칙은 초대 중도 허용
  assert.equal(checkGroupVisibility({ me: A, visibleGroupIds: ['g1'], members, groups, strict: true })[0].kind, 'VIOLATION');
  assert.deepEqual(checkGroupVisibility({ me: B, visibleGroupIds: ['g1'], members, groups, strict: true }), []);
  const mine = [{ user_id: A, group_id: 'g2', invite_status: 'LEFT' }];
  assert.equal(checkGroupVisibility({ me: A, visibleGroupIds: ['g2'], members: mine, groups: [{ group_id: 'g2', owner_id: A }], strict: true })[0].kind, 'KNOWN');
});

test('5장 구성원 행 노출: 초대만 받은 사람은 내 행 말고 다른 사람 행을 못 봄', () => {
  const members = [{ user_id: A, group_id: 'g1', invite_status: 'INVITED' }, { user_id: B, group_id: 'g1', invite_status: 'JOINED' }];
  const rows = [{ group_id: 'g1', user_id: A }, { group_id: 'g1', user_id: B }];
  assert.equal(checkMemberRows({ me: A, rows, members })[0].kind, 'VIOLATION');
  assert.deepEqual(checkMemberRows({ me: B, rows, members }), []);
  assert.deepEqual(checkMemberRows({ me: A, rows: [rows[0]], members }), []);
});

test('5장 그룹 정적 규칙: 참여 중 0명 · 20명 초과 · 한 사람 10개 초과를 잡음', () => {
  const j = (u, g) => ({ user_id: u, group_id: g, invite_status: 'JOINED' });
  const rules = (groups, members) => checkGroups({ groups, members }).map((v) => v.rule);
  assert.ok(rules([{ group_id: 'g1' }], [{ user_id: A, group_id: 'g1', invite_status: 'LEFT' }]).includes('G-참여 중인 사람이 없는데 그룹이 남음'));
  const many = Array.from({ length: 21 }, (_, i) => j(`u${i}`, 'g1'));
  assert.ok(rules([{ group_id: 'g1' }], many).includes('G-참여 중이 20명을 넘음'));
  const tenPlus = Array.from({ length: 11 }, (_, i) => j(A, `g${i}`));
  assert.ok(rules(tenPlus.map((m) => ({ group_id: m.group_id })), tenPlus).includes('G-한 사람이 참여 그룹 10개를 넘음'));
  assert.deepEqual(rules([{ group_id: 'g1' }], [j(A, 'g1')]), []);
});
