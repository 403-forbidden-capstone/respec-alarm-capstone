// appointment-edit 요청 읽기 (edit-request.ts) — 모양 검증은 requests.test.ts와 같은 방식
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readEditRequest } from './edit-request.ts';
import { HttpError } from './errors.ts';
import { Reader } from './read.ts';

const ID = '11111111-1111-4111-8111-111111111111';

const read = (body: unknown) => {
  const r = Reader.root(body);
  const request = readEditRequest(r);
  r.finish();
  return request;
};
const issuesOf = (body: unknown): string[] => {
  try {
    read(body);
  } catch (e) {
    if (e instanceof HttpError) return (e.details as { issues: { path: string }[] }).issues.map((i) => i.path);
    throw e;
  }
  return [];
};

test('UPDATE: 앱 AppointmentPatch에 해당하는 칸을 읽음 (제목 · 시각 · 장소+좌표 · 중요도 · 반복 규칙), scope 기본은 this', () => {
  const r = read({
    action: 'UPDATE',
    appointment_id: ID,
    patch: { title: ' 발표 ', appointment_at: '2026-10-29T10:00:00+09:00', destination: { name: '강남역', lat: 37.4979, lng: 127.0276 }, importance: 'HIGH', recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU' },
  });
  assert.equal(r.action, 'UPDATE');
  if (r.action !== 'UPDATE') return;
  assert.equal(r.scope, 'this');
  assert.equal(r.confirmed, false);
  assert.equal(r.patch.title, '발표');
  assert.equal(r.patch.at?.toISOString(), '2026-10-29T01:00:00.000Z');
  assert.deepEqual(r.patch.destination, { name: '강남역', lat: 37.4979, lng: 127.0276 });
  assert.equal(r.patch.importance, 'HIGH');
  assert.equal(r.patch.recurrenceRule, 'FREQ=WEEKLY;BYDAY=TU');
});

test('UPDATE: 안 넣은 칸은 그대로(키 없음), 반복 규칙 null은 반복 끔, 좌표 없는 장소는 이름만, confirmed · following', () => {
  const r = read({ action: 'UPDATE', appointment_id: ID, scope: 'following', confirmed: true, patch: { recurrence_rule: null, destination: { name: '도서관' } } });
  assert.equal(r.action, 'UPDATE');
  if (r.action !== 'UPDATE') return;
  assert.deepEqual(r.patch, { recurrenceRule: null, destination: { name: '도서관' } });
  assert.equal(r.scope, 'following');
  assert.equal(r.confirmed, true);
  const empty = read({ action: 'UPDATE', appointment_id: ID, patch: {} });
  assert.deepEqual(empty.action === 'UPDATE' ? empty.patch : null, {});
});

test('DELETE · RESTORE · LEAVE: id (+ scope)만 받음', () => {
  assert.deepEqual(read({ action: 'DELETE', appointment_id: ID, scope: 'following' }), { action: 'DELETE', appointmentId: ID, scope: 'following' });
  assert.deepEqual(read({ action: 'DELETE', appointment_id: ID }), { action: 'DELETE', appointmentId: ID, scope: 'this' });
  assert.deepEqual(read({ action: 'RESTORE', appointment_id: ID }), { action: 'RESTORE', appointmentId: ID });
  assert.deepEqual(read({ action: 'LEAVE', appointment_id: ID }), { action: 'LEAVE', appointmentId: ID });
});

test('필수 값이 없거나 틀리면 어느 칸인지 알려 줌: action · appointment_id · patch · scope', () => {
  assert.deepEqual(issuesOf({}), ['action', 'appointment_id']);
  assert.deepEqual(issuesOf({ action: 'MOVE', appointment_id: ID }), ['action']);
  assert.deepEqual(issuesOf({ action: 'UPDATE', appointment_id: 'nope', patch: {} }), ['appointment_id']);
  assert.deepEqual(issuesOf({ action: 'UPDATE', appointment_id: ID }), ['patch']);
  assert.deepEqual(issuesOf({ action: 'DELETE', appointment_id: ID, scope: 'all' }), ['scope']);
  assert.deepEqual(issuesOf({ action: 'DELETE', appointment_id: ID, scope: 'THIS' }), ['scope']); // 앱 EditScope와 같은 소문자만
});

test('patch 칸 검사: 빈 제목 · 오프셋 없는 시각 · 모르는 중요도 · 두 모양 밖 반복 규칙 · 이름 없는 장소 · 좌표 한쪽만', () => {
  const issues = (patch: unknown) => issuesOf({ action: 'UPDATE', appointment_id: ID, patch });
  assert.deepEqual(issues({ title: '   ' }), ['patch.title']);
  assert.deepEqual(issues({ title: 'x'.repeat(101) }), ['patch.title']);
  assert.deepEqual(issues({ appointment_at: '2026-10-29T10:00:00' }), ['patch.appointment_at']);
  assert.deepEqual(issues({ importance: 'URGENT' }), ['patch.importance']);
  assert.deepEqual(issues({ recurrence_rule: 'FREQ=MONTHLY' }), ['patch.recurrence_rule']);
  assert.deepEqual(issues({ recurrence_rule: 'FREQ=WEEKLY' }), ['patch.recurrence_rule']);
  assert.deepEqual(issues({ destination: {} }), ['patch.destination.name']);
  assert.deepEqual(issues({ destination: { name: '강남역', lat: 37.4 } }), ['patch.destination.lng']);
  assert.ok(issues({ destination: { name: '강남역', lat: 91, lng: 127 } }).includes('patch.destination.lat')); // 범위 밖
});

test('본문이 객체가 아니면 VALIDATION_FAILED', () => {
  assert.throws(() => Reader.root([]), (e: unknown) => e instanceof HttpError && e.code === 'VALIDATION_FAILED');
});
