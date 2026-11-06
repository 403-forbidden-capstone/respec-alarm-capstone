// Gemini 연결 시험 — 가짜 fetch만 씀 (네트워크 · 비용 0). 요청 변환 · 응답 되돌리기 · 오류 분류 · callLlm까지 한 바퀴
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGeminiClient, fromGeminiBody, kindOfStatus, toGeminiBody } from './gemini.ts';
import { buildRequest, callLlm, type CallOpts } from './llm.ts';

const schema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false };
const opts: CallOpts = {
  point: 'T1', promptId: 'T1', promptVersion: 'v1.5', model: 'gemini-3.8-flash',
  system: '시스템', user: '안녕', schema, effort: 'low', maxTokens: 256, timeoutMs: 1000, retryOnTimeout: false,
};

const okBody = (text: string) => ({
  candidates: [{ content: { parts: [{ text: '생각', thought: true }, { text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 5 },
  responseId: 'r1',
});

const fakeFetch = (status: number, body: unknown, seen?: { url?: string; init?: RequestInit }) =>
  (async (url: string, init: RequestInit) => {
    if (seen) Object.assign(seen, { url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

describe('gemini', () => {
  it('요청을 Gemini 본문으로 바꿈 (system · 스키마 · 생각 수준)', () => {
    const body = toGeminiBody(buildRequest(opts)) as any;
    assert.equal(body.systemInstruction.parts[0].text, '시스템');
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: '안녕' }] }]);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.maxOutputTokens, 256);
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  });

  it('응답을 Claude 모양으로 — 생각 조각 빼고, 사용량 맞춤', () => {
    const r = fromGeminiBody(okBody('{"reply":"네"}'), 'm');
    assert.equal(r.stop_reason, 'end_turn');
    assert.deepEqual(r.content, [{ type: 'text', text: '{"reply":"네"}' }]);
    assert.equal(r.usage?.input_tokens, 60);
    assert.equal(r.usage?.output_tokens, 15);
    assert.equal(r.request_id, 'r1');
  });

  it('막힘 · 잘림 → refusal · max_tokens', () => {
    assert.equal(fromGeminiBody({ promptFeedback: { blockReason: 'SAFETY' } }, 'm').stop_reason, 'refusal');
    assert.equal(fromGeminiBody({ candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'm').stop_reason, 'max_tokens');
  });

  it('HTTP 상태 → 오류 종류', () => {
    assert.equal(kindOfStatus(400, 'API key not valid'), 'auth');
    assert.equal(kindOfStatus(400, 'bad schema'), 'bad_request');
    assert.equal(kindOfStatus(429, ''), 'rate_limit');
    assert.equal(kindOfStatus(503, ''), 'overloaded');
  });

  it('callLlm 한 바퀴 — 성공하면 JSON을 스키마로 검사해 돌려줌', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const r = await callLlm(createGeminiClient('k', fakeFetch(200, okBody('{"reply":"네"}'), seen)), opts);
    assert.ok(r.ok);
    assert.deepEqual(r.data, { reply: '네' });
    assert.match(seen.url ?? '', /models\/gemini-3\.8-flash:generateContent$/);
    assert.equal((seen.init?.headers as Record<string, string>)['x-goog-api-key'], 'k');
  });

  it('callLlm — 키가 틀리면 AUTH', async () => {
    const r = await callLlm(createGeminiClient('k', fakeFetch(400, { error: { message: 'API key not valid' } })), opts);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, 'AUTH');
  });
});
