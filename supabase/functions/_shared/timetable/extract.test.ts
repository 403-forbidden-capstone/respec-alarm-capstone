// timetable-extract 시험 — 가짜 Claude(녹화한 척한 답 fixture)와 가짜 DB만 씀. 네트워크 · 키 · 비용 0.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildRequest, LlmClientError, type CallOpts, type LlmClient, type LlmRequest, type LlmResponse } from '../ai/llm.ts';
import { HttpError } from '../errors.ts';
import { FakeDb } from '../fake-db.ts';
import type { Db } from '../supabase.ts';
import { handleTimetableExtract, MAX_IMAGE_BYTES, MAX_ROWS, MAX_TIMETABLE_CALLS_PER_DAY, normalizeRows, parseRequest } from './extract.ts';
import { TIMETABLE_SCHEMA, type TimetableRow } from './schema.ts';

const ME = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-30T10:00:00+09:00');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/answer-everytime.json', import.meta.url), 'utf8')) as { answer: unknown };

// ───── 도우미 ─────

const bytesB64 = (head: number[], total = 300): string => Buffer.from([...head, ...new Array(total - head.length).fill(7)]).toString('base64');
const JPEG = bytesB64([0xff, 0xd8, 0xff, 0xe0]);
const PNG = bytesB64([0x89, 0x50, 0x4e, 0x47]);
const WEBP = bytesB64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const okBody = { media_type: 'image/jpeg', image_base64: JPEG };

function fakeModel(answer: unknown | Error) {
  const seen: LlmRequest[] = [];
  const client: LlmClient = {
    create(params): Promise<LlmResponse> {
      seen.push(params);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1500, output_tokens: 260, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        model: 'claude-haiku-5-5',
        request_id: 'req_fake_tt_1',
      });
    },
  };
  return { client, seen };
}

function setup(answer: unknown | Error | null = fixture.answer) {
  const db = new FakeDb();
  db.now = NOW;
  const model = answer === null ? null : fakeModel(answer);
  const deps = { userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: model?.client ?? null, model: 'claude-haiku-5-5', now: () => NOW };
  return { db, model, deps };
}

const rejected = async (p: Promise<unknown>, code: string): Promise<HttpError> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof HttpError, `HttpError여야 함: ${String(e)}`);
    assert.equal(e.code, code);
    return e;
  }
  throw new assert.AssertionError({ message: `${code}로 거절돼야 함` });
};

const row = (over: Partial<TimetableRow> = {}): TimetableRow => ({ title: '자료구조', weekdays: ['월'], start: '10:00', end: '11:00', place: null, ...over });

// ───── 요청 검사 ─────

describe('요청 검사', () => {
  it('jpeg · png · webp를 받음', () => {
    assert.equal(parseRequest({ media_type: 'image/jpeg', image_base64: JPEG }).image.media_type, 'image/jpeg');
    assert.equal(parseRequest({ media_type: 'image/png', image_base64: PNG }).image.media_type, 'image/png');
    assert.equal(parseRequest({ media_type: 'image/webp', image_base64: WEBP }).image.media_type, 'image/webp');
  });

  it('빠진 칸 · 모르는 종류 · 객체가 아닌 본문은 VALIDATION_FAILED', () => {
    for (const bad of [null, [], {}, { media_type: 'image/jpeg' }, { image_base64: JPEG }, { media_type: 'image/gif', image_base64: JPEG }, { media_type: 'image/jpeg', image_base64: 'abc' }]) {
      assert.throws(() => parseRequest(bad), (e: unknown) => e instanceof HttpError && e.code === 'VALIDATION_FAILED');
    }
  });

  it('data: 머리말 · base64가 아닌 글 · 길이가 4의 배수가 아닌 글은 거절', () => {
    for (const data of [`data:image/jpeg;base64,${JPEG}`, `${JPEG}!!`, `${JPEG}A`]) {
      assert.throws(() => parseRequest({ media_type: 'image/jpeg', image_base64: data }), (e: unknown) => e instanceof HttpError && e.code === 'VALIDATION_FAILED');
    }
  });

  it('말한 종류와 파일 첫 바이트가 다르면 거절 (png라 하고 jpeg를 보낸 경우)', () => {
    assert.throws(() => parseRequest({ media_type: 'image/png', image_base64: JPEG }), /사진 종류/);
    assert.throws(() => parseRequest({ media_type: 'image/jpeg', image_base64: bytesB64([1, 2, 3, 4]) }), /사진 종류/);
  });

  it(`원본 ${MAX_IMAGE_BYTES}바이트를 넘으면 거절, 안이면 통과`, () => {
    const big = bytesB64([0xff, 0xd8, 0xff, 0xe0], MAX_IMAGE_BYTES + 3);
    assert.throws(() => parseRequest({ media_type: 'image/jpeg', image_base64: big }), /너무 커요/);
    const fit = bytesB64([0xff, 0xd8, 0xff, 0xe0], MAX_IMAGE_BYTES);
    assert.equal(parseRequest({ media_type: 'image/jpeg', image_base64: fit }).image.data.length, fit.length);
  });
});

// ───── 요청 모양 ─────

describe('모델 요청 모양', () => {
  const base: CallOpts = {
    point: 'TT', promptId: 'TT', promptVersion: 'v1', model: 'm', system: 's', user: '읽어 줘', schema: TIMETABLE_SCHEMA,
    effort: 'low', maxTokens: 100, timeoutMs: 1000, retryOnTimeout: false,
  };

  it('사진은 user 글 앞 image 블록으로 감', () => {
    const r = buildRequest({ ...base, images: [{ media_type: 'image/png', data: 'QUJD' }] });
    assert.deepEqual(r.messages[0].content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'text', text: '읽어 줘' },
    ]);
  });

  it('사진이 없으면 예전처럼 글 하나', () => {
    assert.equal(buildRequest(base).messages[0].content, '읽어 줘');
  });
});

// ───── 출력 정리 ─────

describe('출력 정리', () => {
  it('요일은 월요일부터 순서 · 이름 공백 정리 · 장소 비면 null', () => {
    const { rows } = normalizeRows([row({ title: ' 자료\n구조 ', weekdays: ['수', '월', '수'], place: '  ' })]);
    assert.deepEqual(rows, [row({ title: '자료 구조', weekdays: ['월', '수'], place: null })]);
  });

  it('이름이 빈 줄 · 끝이 시작보다 늦지 않은 줄 · 똑같은 줄은 버리고 버린 수를 셈', () => {
    const r = normalizeRows([row(), row(), row({ title: ' ' }), row({ start: '12:00', end: '12:00' }), row({ weekdays: [] }), row({ title: '다른 수업' })]);
    assert.equal(r.rows.length, 2);
    assert.equal(r.dropped, 4);
  });

  it(`${MAX_ROWS}줄까지만`, () => {
    const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => row({ title: `수업${i}` }));
    const r = normalizeRows(many);
    assert.equal(r.rows.length, MAX_ROWS);
    assert.equal(r.dropped, 5);
  });

  it('이모지를 반으로 자르지 않고, 글자 방향 · 폭 없는 문자는 공백으로', () => {
    const r = normalizeRows([row({ title: '가'.repeat(39) + '😀😀', place: 'a‮b​c\u0085d' })]);
    assert.equal(Array.from(r.rows[0].title).length, 40);
    assert.ok(!/[\ud800-\udfff]/.test(r.rows[0].title.replace('😀', '')));
    assert.equal(r.rows[0].place, 'a b c d');
  });

  it('글자 길이 상한 (이름 · 장소 40자)', () => {
    const r = normalizeRows([row({ title: '가'.repeat(60), place: '나'.repeat(60) })]);
    assert.equal(r.rows[0].title.length, 40);
    assert.equal(r.rows[0].place?.length, 40);
  });
});

// ───── 본체 ─────

describe('timetable-extract 본체', () => {
  it('성공: 사진을 모델에 보내고 정리된 줄을 돌려줌, 호출은 TT로 한 줄 기록(io · session 없음)', async () => {
    const { db, model, deps } = setup();
    const out = await handleTimetableExtract(deps, okBody);

    assert.deepEqual(out.rows.map((r) => [r.title, r.weekdays.join(''), r.start, r.end, r.place]), [
      ['자료구조', '월수', '10:30', '12:00', '공학관 301'],
      ['운영체제', '화목', '13:00', '14:30', '정보관 B102'],
      ['캡스톤디자인', '금', '09:00', '11:50', null],
    ]);
    assert.equal(out.confidence, 'MEDIUM'); // 버린 줄 3개(중복 · 시간 역전 · 이름 없음) → HIGH에서 한 단계 내림
    assert.equal(out.left_today, MAX_TIMETABLE_CALLS_PER_DAY - 1);

    // 모델에 간 요청: image 블록 하나 + 글
    assert.equal(model!.seen.length, 1);
    const content = model!.seen[0].messages[0].content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0].type, 'image');
    assert.equal(content[1].type, 'text');

    // 호출 기록
    const calls = db.rows('ai_calls');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].point, 'TT');
    assert.equal(calls[0].prompt_id, 'TT');
    assert.equal(calls[0].prompt_version, 'v1');
    assert.equal(calls[0].user_id, ME);
    assert.equal(calls[0].session_id, null);
    assert.equal(calls[0].io, null);
    assert.equal(calls[0].ok, true);
    assert.equal(calls[0].input_tokens, 1500);
    // 사진 글자가 어느 표에도 남지 않음
    assert.ok(!JSON.stringify(db.tables).includes(JPEG.slice(0, 40)));
  });

  it('또렷하게 읽고 버린 줄도 없으면 HIGH 그대로', async () => {
    const { deps } = setup({ rows: [row()], confidence: 'HIGH' });
    const out = await handleTimetableExtract(deps, okBody);
    assert.equal(out.confidence, 'HIGH');
  });

  it('시간표가 아니라 읽은 줄이 없으면 빈 줄 + LOW (오류 아님)', async () => {
    const { db, deps } = setup({ rows: [], confidence: 'HIGH' });
    const out = await handleTimetableExtract(deps, okBody);
    assert.deepEqual(out, { rows: [], confidence: 'LOW', left_today: MAX_TIMETABLE_CALLS_PER_DAY - 1 });
    assert.equal(db.rows('ai_calls').length, 1);
  });

  it('요청이 틀리면 모델을 부르지 않고 기록도 없음', async () => {
    const { db, model, deps } = setup();
    await rejected(handleTimetableExtract(deps, { media_type: 'image/jpeg' }), 'VALIDATION_FAILED');
    assert.equal(model!.seen.length, 0);
    assert.equal(db.rows('ai_calls').length, 0);
  });

  it('키가 없으면 NOT_CONFIGURED, 기록 없음', async () => {
    const { db, deps } = setup(null);
    await rejected(handleTimetableExtract(deps, okBody), 'NOT_CONFIGURED');
    assert.equal(db.rows('ai_calls').length, 0);
  });

  it('하루 한도: 오늘 TT 호출이 한도만큼 있으면 RATE_LIMITED, 모델 호출 없음 (어제 것은 안 셈)', async () => {
    const { db, model, deps } = setup();
    for (let i = 0; i < MAX_TIMETABLE_CALLS_PER_DAY - 1; i++) db.rows('ai_calls').push({ call_id: db.newId(), user_id: ME, point: 'TT', created_at: '2026-10-30T00:30:00+09:00' });
    db.rows('ai_calls').push({ call_id: db.newId(), user_id: ME, point: 'TT', created_at: '2026-10-29T23:59:00+09:00' }); // 어제
    const last = await handleTimetableExtract(deps, okBody); // 마지막 한 번은 통과
    assert.equal(last.left_today, 0);

    const e = await rejected(handleTimetableExtract(deps, okBody), 'RATE_LIMITED');
    assert.deepEqual(e.details, { left_today: 0 });
    assert.equal(model!.seen.length, 1);
  });

  it('다른 사람의 호출은 내 한도에 안 셈', async () => {
    const { db, deps } = setup();
    for (let i = 0; i < MAX_TIMETABLE_CALLS_PER_DAY; i++) db.rows('ai_calls').push({ call_id: db.newId(), user_id: '22222222-2222-4222-8222-222222222222', point: 'TT', created_at: '2026-10-30T09:00:00+09:00' });
    await handleTimetableExtract(deps, okBody);
  });

  it('하루 전체 AI 호출 상한(300)에 닿아도 거절', async () => {
    const { db, deps } = setup();
    for (let i = 0; i < 300; i++) db.rows('ai_calls').push({ call_id: db.newId(), user_id: ME, point: 'T1', created_at: '2026-10-30T09:00:00+09:00' });
    await rejected(handleTimetableExtract(deps, okBody), 'RATE_LIMITED');
  });

  it('모델 오류(5xx)는 LLM_UNAVAILABLE이고 실패 호출도 한 줄 남아 한도에 셈', async () => {
    const { db, deps } = setup(new LlmClientError('server', 'fake 5xx', { status: 500 }));
    const e = await rejected(handleTimetableExtract({ ...deps, model: 'claude-haiku-5-5' }, okBody), 'LLM_UNAVAILABLE');
    assert.equal((e.details as { code: string }).code, 'UPSTREAM');
    const calls = db.rows('ai_calls');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ok, false);
    assert.equal(calls[0].point, 'TT');
    assert.equal(calls[0].io, null);
  });

  it('스키마에 안 맞는 모델 출력(시각 9:00 · 모르는 요일)은 BAD_OUTPUT → LLM_UNAVAILABLE', async () => {
    for (const bad of [
      { rows: [{ ...row(), start: '9:00' }], confidence: 'HIGH' },
      { rows: [{ ...row(), weekdays: ['Mon'] }], confidence: 'HIGH' },
      { rows: [row()], confidence: 'SURE' },
      { rows: [row()] },
    ]) {
      const { db, deps } = setup(bad);
      const e = await rejected(handleTimetableExtract(deps, okBody), 'LLM_UNAVAILABLE');
      assert.equal((e.details as { code: string }).code, 'BAD_OUTPUT');
      assert.equal(db.rows('ai_calls')[0].error_code, 'BAD_OUTPUT');
    }
  });

  it('기록이 실패해도(DB 오류) 읽은 결과는 돌려줌', async () => {
    const { db, deps } = setup();
    db.failOn.push({ table: 'ai_calls', op: 'insert' });
    const out = await handleTimetableExtract(deps, okBody);
    assert.equal(out.rows.length, 3);
  });
});
