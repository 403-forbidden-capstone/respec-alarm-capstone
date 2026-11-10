// 새 일정 중요도 자동 — 기본 LOW, 시험 · 면접처럼 명확한 것만 HIGH. 요청에 중요도가 있으면 그 값(수동 우선)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { autoImportance } from './importance.ts';
import { Reader } from '../read.ts';
import { readCommitRequest } from '../requests.ts';

test('기본 LOW, 시험 · 면접 · 고사만 HIGH, 공부 · 준비 일정은 LOW', () => {
  assert.equal(autoImportance('스터디'), 'LOW');
  assert.equal(autoImportance(''), 'LOW');
  assert.equal(autoImportance(null), 'LOW');
  assert.equal(autoImportance('자료구조 중간고사'), 'HIGH');
  assert.equal(autoImportance('카카오 면접'), 'HIGH');
  assert.equal(autoImportance('토익 시험'), 'HIGH');
  assert.equal(autoImportance('시험 공부'), 'LOW');
  assert.equal(autoImportance('면접 준비 스터디'), 'LOW');
});

test('요청: 중요도를 안 보내면 제목으로 자동, 보내면 그 값 (사용자 수동 우선)', () => {
  const body = (importance?: string) => ({
    appointment: { title: '카카오 면접', appointment_at: '2026-10-20T10:00:00+09:00', destination: { name: '판교', lat: 37.4, lng: 127.1 }, ...(importance ? { importance } : {}) },
    participant: { origin: { name: '집', lat: 37.5, lng: 127 }, transport_type: 'TRANSIT', buffer_minutes: 10 },
    kinds: ['WAKE'],
  });
  assert.equal(readCommitRequest(Reader.root(body())).draft.importance, 'HIGH');
  assert.equal(readCommitRequest(Reader.root(body('LOW'))).draft.importance, 'LOW');
});
