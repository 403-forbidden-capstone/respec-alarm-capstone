// Anthropic(Claude) SDK 연결 — Deno 전용. 서버에서 npm:@anthropic-ai/sdk를 가져오는 곳은 이 파일 하나뿐 (supabase.ts와 같은 방식, 버전 관리 한 곳).
// 버전은 실험실(ai-lab/package.json)이 실험에 쓴 것과 같은 정확한 버전으로 고정 — 배포 시점마다 다른 0.x가 묶이지 않게. 올릴 때는 실험실과 같이.
// SDK 오류를 자체 오류(LlmClientError)로 바꾸는 분류는 SDK 클래스(instanceof)를 알아야 해서 여기에만 있음. llm.ts는 SDK를 모름.
// 비밀값: Edge Function 비밀값 ANTHROPIC_API_KEY (supabase/functions/.env.example). 없으면 anthropicClient()가 null → 호출 0번으로 NOT_CONFIGURED.
// 모델: ANTHROPIC_MODEL로 바꿀 수 있고 기본은 실험실에서 쓴 claude-haiku-5-5. 다른 모델이면 단가를 몰라 ai_calls.cost_usd가 NULL.
// 이 파일은 node --test로 못 불러옴(npm: 가져오기) — 시험은 llm.ts의 가짜 클라이언트로 하고, 여기는 타입 확인(deno check)과 실제 배포 때 눈으로 확인.
import Anthropic from 'npm:@anthropic-ai/sdk@0.132.1';

import { getEnv } from '../env.ts';
import { DEFAULT_MODEL, LlmClientError, llmClientFrom, type LlmClient, type LlmErrorKind, type LlmRequest, type LlmResponse } from './llm.ts';

// 쓸 모델 이름. ANTHROPIC_MODEL(선택)이 없으면 실험실과 같은 Haiku 5.5
export function model(): string {
  return getEnv('ANTHROPIC_MODEL') ?? DEFAULT_MODEL;
}

// retry-after-ms(밀리초) 또는 retry-after(초 숫자)를 ms로. 날짜 꼴이나 못 읽는 값은 null (llm.ts가 기본 기다림을 씀)
function retryAfterMs(headers: Headers | undefined): number | null {
  if (!headers) return null;
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const sec = Number(headers.get('retry-after'));
  if (headers.get('retry-after') && Number.isFinite(sec) && sec >= 0) return sec * 1000;
  return null;
}

// SDK 오류 → 자체 오류. SDK 밖의 오류(우리 코드 버그 등)는 'unknown' (다시 시도하지 않음)
export function toClientError(err: unknown): LlmClientError {
  if (err instanceof LlmClientError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // 우리가 건 시간 초과는 llm.ts가 race로 먼저 처리하므로 여기 오는 abort는 같은 원인 — 시간 초과로 봄
  if (err instanceof Anthropic.APIUserAbortError) return new LlmClientError('timeout', message, { cause: err });
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmClientError('timeout', message, { cause: err });
  if (err instanceof Anthropic.APIConnectionError) return new LlmClientError('connection', message, { cause: err });
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    let kind: LlmErrorKind = 'unknown';
    if (err.type === 'billing_error') kind = 'billing';
    else if (err instanceof Anthropic.RateLimitError) kind = 'rate_limit';
    else if (status === 529 || err.type === 'overloaded_error') kind = 'overloaded';
    else if (err instanceof Anthropic.BadRequestError) kind = 'bad_request';
    else if (err instanceof Anthropic.AuthenticationError) kind = 'auth';
    else if (err instanceof Anthropic.PermissionDeniedError) kind = 'permission';
    else if (err instanceof Anthropic.NotFoundError) kind = 'not_found';
    else if (status === 413) kind = 'too_large';
    else if (status !== null && status >= 500) kind = 'server';
    return new LlmClientError(kind, message, { status, requestId: err.requestID ?? null, retryAfterMs: retryAfterMs(err.headers), cause: err });
  }
  return new LlmClientError('unknown', message, { cause: err });
}

// 재시도는 llm.ts가 직접 하므로 SDK 재시도는 끔(maxRetries 0) — 안 그러면 시도 횟수 · 시간 초과가 이중으로 늘어남
export function createAnthropicClient(apiKey: string): LlmClient {
  const sdk = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    async create(params: LlmRequest, options: { signal: AbortSignal }): Promise<LlmResponse> {
      try {
        const { data, request_id } = await sdk.messages.create(params, { signal: options.signal }).withResponse();
        return {
          content: data.content,
          stop_reason: data.stop_reason,
          stop_details: data.stop_details,
          usage: data.usage,
          model: data.model,
          request_id,
        };
      } catch (e) {
        throw toClientError(e);
      }
    },
  };
}

// 키가 없으면 null. 호출하는 쪽은 callPoint(anthropicClient(), …)처럼 그대로 넘김
export function anthropicClient(): LlmClient | null {
  return llmClientFrom(getEnv('ANTHROPIC_API_KEY'), createAnthropicClient);
}
