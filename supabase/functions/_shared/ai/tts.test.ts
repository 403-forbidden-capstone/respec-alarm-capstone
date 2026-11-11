// Gemini TTS 요청 모양 · 응답 읽기 — 가짜 fetch만 (실제 API 호출 없음)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LlmClientError } from './llm.ts';
import { audioOf, createTts, ttsBody } from './tts.ts';

const REQ = { model: 'gemini-3.8-flash-tts', text: '일어나!!', voice: 'Kore', style: 'panicked shouting' };

test('요청 본문: 글 + speech_metadata 지시 + 목소리 + 오디오 응답', () => {
  assert.deepEqual(ttsBody(REQ), {
    model: 'gemini-3.8-flash-tts',
    input: [{ type: 'user_input', content: [{ type: 'text', text: '일어나!!', annotations: [{ type: 'speech_metadata', style: 'panicked shouting' }] }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: 'Kore' }] },
  });
});

test('응답에서 model_output의 마지막 오디오 조각', () => {
  assert.deepEqual(audioOf({ steps: [{ type: 'user_input', content: [] }, { type: 'model_output', content: [{ type: 'text' }, { type: 'audio', data: 'QUJD' }] }] }), { mime: 'audio/wav', data: 'QUJD' });
  assert.equal(audioOf({ steps: [{ type: 'model_output', content: [{ type: 'text' }] }] }), null);
  assert.equal(audioOf({}), null);
});

test('성공 · HTTP 오류 · 음성 없음', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const ok = createTts('k', (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'UklGRg==' }] }] }));
  }) as unknown as typeof fetch);
  assert.deepEqual(await ok(REQ), { mime: 'audio/wav', data: 'UklGRg==' });
  assert.match(seen!.url, /\/v1beta\/interactions$/);
  assert.equal((seen!.init.headers as Record<string, string>)['x-goog-api-key'], 'k');

  const busy = createTts('k', (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch);
  await assert.rejects(busy(REQ), (e: unknown) => e instanceof LlmClientError && e.kind === 'overloaded');

  const empty = createTts('k', (async () => new Response('{}')) as unknown as typeof fetch);
  await assert.rejects(empty(REQ), LlmClientError);
});
