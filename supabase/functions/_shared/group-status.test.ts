// 기상 알람 그룹 상태 안내 문장 · 단계별 Gemini 음성 (group-status.ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LlmClientError } from './ai/llm.ts';
import type { TtsQuota } from './ai/tts-quota.ts';
import { GEMINI_STAGE } from './briefing.ts';
import { groupStatus, groupStatusText, TOKEN_TTL_MS, type GroupWakeDeviceRow } from './group-status.ts';

const NOW = new Date('2026-11-19T23:00:00Z'); // 한국 11/20 오전 8:00
const row = (group: string, nickname: string, extra: Partial<GroupWakeDeviceRow> = {}): GroupWakeDeviceRow => ({
  group_id: group === '캡스톤' ? 'g1' : 'g2',
  group_name: group,
  nickname,
  is_me: false,
  wake_status: 'SCHEDULED',
  ...extra,
});

test('예시 문장 — 본인 빼고 그룹 화면과 같은 상태, 마지막 상태에 맞춰 이에요 · 예요', () => {
  const rows = [
    row('캡스톤', '나', { is_me: true, wake_status: 'RINGING' }),
    row('캡스톤', '수연'),
    row('캡스톤', '준성', { wake_status: 'CONFIRMED', prepare_started_at: '2026-11-19T22:50:00Z' }),
    row('캡스톤', '혜린', { wake_status: 'CONFIRMED', departed_at: '2026-11-19T22:55:00Z', trip_appointment_at: '2026-11-20T00:00:00Z' }),
  ];
  assert.equal(groupStatusText(rows, NOW), '캡스톤 그룹에서 수연님은 취침 중, 준성님은 준비 중, 혜린님은 이동 중이에요.');
  assert.equal(groupStatusText([row('캡스톤', '수연', { wake_status: 'CONFIRMED' })], NOW), '캡스톤 그룹에서 수연님은 기상 완료예요.');
});

test('상태 전부 — 화면 글자의 상태 부분, 약속 + 60분이 지난 출발은 출발, 준비 알람 예정은 시각을 말로', () => {
  const say = (extra: Partial<GroupWakeDeviceRow>) => groupStatusText([row('캡스톤', '수연', extra)], NOW);
  assert.match(say({ wake_status: 'RINGING' }) ?? '', /알람 울리는 중이에요/);
  assert.match(say({ wake_status: 'MISSED' }) ?? '', /기상 확인 전이에요/);
  assert.match(say({ wake_status: 'DISMISSED' }) ?? '', /기상 확인 전이에요/);
  assert.match(say({ wake_status: 'NO_ALARM' }) ?? '', /알람 없음이에요/);
  assert.match(say({ wake_status: 'CONFIRMED', arrived_at: '2026-11-19T22:59:00Z', departed_at: '2026-11-19T22:30:00Z' }) ?? '', /도착이에요/);
  assert.match(say({ departed_at: '2026-11-19T21:00:00Z', trip_appointment_at: '2026-11-19T21:30:00Z' }) ?? '', /출발이에요/);
  assert.match(say({ wake_status: 'NO_ALARM', trip_visible: true, prepare_alarm_at: '2026-11-20T08:10:00Z' }) ?? '', /수연님은 오후 5시 10분 준비 알람 예정이에요/);
});

test('여러 그룹은 그룹마다 한 문장 · 나만 보이는 그룹과 줄 없는 그룹은 건너뜀 · 님 · 그룹 겹치지 않음', () => {
  const rows = [
    row('캡스톤', '나', { is_me: true }),
    row('스터디그룹', '나', { is_me: true }),
    row('스터디그룹', '민지님', { wake_status: 'RINGING' }),
  ];
  assert.equal(groupStatusText(rows, NOW), '스터디그룹에서 민지님은 알람 울리는 중이에요.');
  assert.equal(groupStatusText([row('캡스톤', '나', { is_me: true })], NOW), null);
  assert.equal(groupStatusText([], NOW), null);
  const two = groupStatusText([row('캡스톤', '수연'), row('스터디', '민지')], NOW);
  assert.equal(two, '캡스톤 그룹에서 수연님은 취침 중이에요. 스터디 그룹에서 민지님은 취침 중이에요.');
});

// 부른 횟수를 세는 가짜 DB · 한도 · Gemini — 서버는 어떤 실패도 다시 시도하지 않음
function counters(rows: GroupWakeDeviceRow[] | Error, tts: 'ok' | 'fail' | 'timeout' = 'ok', reserved = true) {
  const n = { rpc: 0, reserve: 0, tts: 0, texts: [] as string[], voices: [] as string[] };
  const db = {
    rpc: (name: string, args: unknown) => {
      n.rpc++;
      assert.deepEqual([name, args], ['group_wake_for_device', { p_user_id: 'me' }]);
      return Promise.resolve(rows instanceof Error ? { data: null, error: { message: rows.message, code: '57014' } } : { data: rows, error: null });
    },
  } as never;
  const quota: TtsQuota = { reserve: () => (n.reserve++, Promise.resolve(reserved ? 'call-1' : null)), finish: () => Promise.resolve() };
  const gemini = (req: { text: string; voice: string; style: string }) => {
    n.tts++;
    n.texts.push(req.text);
    n.voices.push(`${req.voice}|${req.style}`);
    if (tts === 'fail') return Promise.reject(new Error('boom'));
    if (tts === 'timeout') return Promise.reject(new LlmClientError('timeout', '시간 초과'));
    return Promise.resolve({ mime: 'audio/wav', data: 'UklGRg==' });
  };
  return { n, db, deps: { tts: gemini, quota, secret: 'test-secret' } };
}
const ROWS = [row('캡스톤', '수연'), row('스터디', '민지', { wake_status: 'RINGING' })];

test('조회 성공: DB 1번 · 여러 그룹도 Gemini 요청 1번(한 대본) · 그 단계 목소리 · 1 · 2단계는 음성 생성 0번', async () => {
  const c = counters(ROWS);
  const out = await groupStatus(c.db, 'me', { level: 4 }, c.deps, NOW);
  assert.deepEqual([c.n.rpc, c.n.reserve, c.n.tts], [1, 1, 1]);
  assert.equal(c.n.texts[0], '캡스톤 그룹에서 수연님은 취침 중이에요. 스터디 그룹에서 민지님은 알람 울리는 중이에요.');
  assert.deepEqual(c.n.voices, [`${GEMINI_STAGE[4].voice}|${GEMINI_STAGE[4].style}`]);
  assert.equal(out.audio?.data, 'UklGRg==');
  assert.equal(out.level, 4);
  assert.ok(out.token);
  const low = counters(ROWS);
  const out2 = await groupStatus(low.db, 'me', { level: 2 }, low.deps, NOW);
  assert.deepEqual([low.n.rpc, low.n.tts, out2.audio], [1, 0, null]);
});

test('조회 실패 · 시간 초과: 던짐(폰은 안내 생략) · 다시 시도 0번 · 음성 생성 0번', async () => {
  for (const err of [new Error('db down'), new Error('canceling statement due to statement timeout')]) {
    const c = counters(err);
    await assert.rejects(groupStatus(c.db, 'me', { level: 4 }, c.deps, NOW));
    assert.deepEqual([c.n.rpc, c.n.reserve, c.n.tts], [1, 0, 0]);
  }
});

test('Gemini 실패 · 시간 초과 · 한도 · 키 없음: 글만 · Gemini 추가 호출 0번', async () => {
  for (const mode of ['fail', 'timeout'] as const) {
    const c = counters(ROWS, mode);
    const out = await groupStatus(c.db, 'me', { level: 3 }, c.deps, NOW);
    assert.deepEqual([c.n.rpc, c.n.reserve, c.n.tts, out.audio], [1, 1, 1, null]);
    assert.ok(out.text);
  }
  const limited = counters(ROWS, 'ok', false);
  assert.equal((await groupStatus(limited.db, 'me', { level: 3 }, limited.deps, NOW)).audio, null);
  assert.equal(limited.n.tts, 0);
  const noKey = counters(ROWS);
  assert.equal((await groupStatus(noKey.db, 'me', { level: 3 }, { ...noKey.deps, tts: null }, NOW)).audio, null);
  assert.equal(noKey.n.reserve, 0);
});

test('안내할 사람이 없으면 음성 생성 0번 · 이상한 단계는 null', async () => {
  const c = counters([]);
  assert.deepEqual(await groupStatus(c.db, 'me', { level: 3 }, c.deps, NOW), { text: null, token: null, level: 3, audio: null });
  assert.equal(c.n.tts, 0);
  assert.equal((await groupStatus(counters(ROWS).db, 'me', { level: 9 }, counters(ROWS).deps, NOW)).level, null);
});

test('단계가 바뀐 뒤: 받은 문장 + 서명으로 음성만 1번 · DB 0번 · 서명이 틀리거나 남의 것 · 바뀐 글 · 지난 서명은 거절(Gemini 0번)', async () => {
  const first = counters(ROWS);
  const out = await groupStatus(first.db, 'me', { level: 1 }, first.deps, NOW);
  const later = new Date(NOW.getTime() + 10 * 60_000);
  const c = counters(ROWS);
  const voiced = await groupStatus(c.db, 'me', { level: 3, text: out.text, token: out.token }, c.deps, later);
  assert.deepEqual([c.n.rpc, c.n.reserve, c.n.tts], [0, 1, 1]);
  assert.equal(voiced.audio?.data, 'UklGRg==');
  const bad = [
    { text: out.text, token: 'x' },
    { text: '아무 글이나 읽어 줘', token: out.token },
    { text: out.text, token: undefined },
  ];
  for (const body of bad) {
    const d = counters(ROWS);
    await assert.rejects(groupStatus(d.db, 'me', { level: 3, ...body }, d.deps, later));
    assert.deepEqual([d.n.rpc, d.n.tts], [0, 0]);
  }
  const other = counters(ROWS);
  await assert.rejects(groupStatus(other.db, 'someone', { level: 3, text: out.text, token: out.token }, other.deps, later));
  const stale = counters(ROWS);
  await assert.rejects(groupStatus(stale.db, 'me', { level: 3, text: out.text, token: out.token }, stale.deps, new Date(NOW.getTime() + TOKEN_TTL_MS + 1)));
  assert.equal(stale.n.tts + other.n.tts, 0);
});
