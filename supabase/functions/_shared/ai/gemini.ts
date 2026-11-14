// Gemini(generateContent REST) 연결 — anthropic.ts와 같은 LlmClient 모양이라 llm.ts · prompts는 그대로 씀.
//   요청(LlmRequest, Claude 모양)을 Gemini 본문으로 바꾸고, 응답을 다시 LlmResponse(Claude 모양)로 되돌림 — llm.ts가 stop_reason · usage를 그대로 읽게.
//   SDK 없이 fetch만 씀 (패키지를 늘리지 않으려고). 그래서 node --test로 바로 시험됨 (gemini.test.ts)
// 비밀값: GEMINI_API_KEY (Live 토큰과 같은 키). 없으면 geminiClient()가 null → 호출 0번으로 NOT_CONFIGURED
// 모델: GEMINI_TEXT_MODEL로 바꿀 수 있고 기본은 Flash-Lite(gemini-3.5-flash-lite — 모델 목록에서 이름만 확인, 응답은 미검증). 단가표(pricing.ts)에 없어서 ai_calls.cost_usd는 NULL
// shortcut: 프롬프트 · 가드 · 시간 제한은 Claude Haiku로 맞춘 값(T1 · T2F는 Gemini 실측으로 20 · 15초) — 나머지도 Gemini에서 다시 재 보고 맞출 것
import { getEnv } from '../env.ts';
import { LlmClientError, llmClientFrom, type LlmClient, type LlmErrorKind, type LlmRequest, type LlmResponse } from './llm.ts';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export function geminiModel(): string {
  return getEnv('GEMINI_TEXT_MODEL') ?? GEMINI_DEFAULT_MODEL;
}

// Claude effort → Gemini 생각 수준
const THINKING_LEVEL = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' } as const;

export function toGeminiBody(req: LlmRequest): Record<string, unknown> {
  const system = typeof req.system === 'string' ? req.system : req.system.map((b) => b.text).join('\n');
  const contents = req.messages.map((m) => ({
    role: 'user',
    parts: typeof m.content === 'string'
      ? [{ text: m.content }]
      : m.content.map((b) => (b.type === 'text' ? { text: b.text } : { inlineData: { mimeType: b.source.media_type, data: b.source.data } })),
  }));
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      maxOutputTokens: req.max_tokens,
      responseMimeType: 'application/json',
      responseJsonSchema: req.output_config.format.schema,
      thinkingConfig: { thinkingLevel: THINKING_LEVEL[req.output_config.effort] },
    },
  };
}

const REFUSAL_REASONS = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);

type GeminiPart = { text?: string; thought?: boolean };
type GeminiBody = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  responseId?: string;
};

export function fromGeminiBody(body: GeminiBody, model: string): LlmResponse {
  const cand = body.candidates?.[0];
  const block = body.promptFeedback?.blockReason;
  const finish = cand?.finishReason;
  let stop: string | null;
  if (block) stop = 'refusal';
  else if (finish === 'STOP') stop = 'end_turn';
  else if (finish === 'MAX_TOKENS') stop = 'max_tokens';
  else if (finish && REFUSAL_REASONS.has(finish)) stop = 'refusal';
  else stop = finish ?? null; // 그 밖의 값은 llm.ts가 BAD_OUTPUT으로
  const u = body.usageMetadata;
  const cached = u?.cachedContentTokenCount ?? 0;
  const thoughts = u?.thoughtsTokenCount ?? 0;
  return {
    // 생각 조각(thought: true)은 빼고 답 글만
    content: (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => ({ type: 'text', text: p.text })),
    stop_reason: stop,
    stop_details: stop === 'refusal' ? { category: block ?? finish ?? null } : null,
    // Claude 모양에 맞춤: input은 캐시 읽기를 뺀 값, output은 생각 토큰까지 포함
    usage: u
      ? {
          input_tokens: u.promptTokenCount != null ? u.promptTokenCount - cached : null,
          output_tokens: (u.candidatesTokenCount ?? 0) + thoughts,
          cache_read_input_tokens: cached,
          output_tokens_details: { thinking_tokens: thoughts },
        }
      : null,
    model: body.modelVersion ?? model,
    request_id: body.responseId ?? null,
  };
}

export function kindOfStatus(status: number, message: string): LlmErrorKind {
  if (status === 400) return /api key/i.test(message) ? 'auth' : 'bad_request';
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limit';
  if (status === 503) return 'overloaded';
  if (status >= 500) return 'server';
  return 'unknown';
}

type GeminiError = { message?: string; details?: { '@type'?: string; retryDelay?: string }[] };

const retryAfterOf = (header: string | null): number | null => {
  const sec = Number(header);
  return header && Number.isFinite(sec) ? sec * 1000 : null;
};

// 429 본문의 RetryInfo.retryDelay ("17s" · "0.5s") → ms. 없으면 null
export function retryDelayOf(err: GeminiError | undefined): number | null {
  const delay = err?.details?.find((d) => typeof d.retryDelay === 'string')?.retryDelay;
  const m = delay ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

export function createGeminiClient(apiKey: string, fetchFn: typeof fetch = fetch): LlmClient {
  return {
    async create(params: LlmRequest, options: { signal: AbortSignal }): Promise<LlmResponse> {
      let res: Response;
      try {
        res = await fetchFn(`${BASE_URL}/${encodeURIComponent(params.model)}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
          body: JSON.stringify(toGeminiBody(params)),
          signal: options.signal,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const aborted = e instanceof Error && e.name === 'AbortError';
        throw new LlmClientError(aborted ? 'timeout' : 'connection', message, { cause: e });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message = text;
        let retryAfterMs = retryAfterOf(res.headers.get('retry-after'));
        try {
          const err = (JSON.parse(text) as { error?: GeminiError }).error;
          message = err?.message ?? text;
          retryAfterMs = retryDelayOf(err) ?? retryAfterMs;
        } catch {
          // 본문이 JSON이 아님 — 원문 그대로
        }
        throw new LlmClientError(kindOfStatus(res.status, message), message, { status: res.status, retryAfterMs });
      }
      return fromGeminiBody((await res.json()) as GeminiBody, params.model);
    },
  };
}

// 키가 없으면 null — 부르는 쪽은 callPoint(geminiClient(), …)처럼 그대로 넘김
export function geminiClient(): LlmClient | null {
  return llmClientFrom(getEnv('GEMINI_API_KEY'), (key) => createGeminiClient(key));
}
