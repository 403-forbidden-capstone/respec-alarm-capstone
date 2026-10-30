// 시험 도우미: 가짜 Claude — 지점(T1 · T2F · T2)별로 미리 정한 출력을 순서대로 돌려주고, 받은 화면 글(user 메시지)을 남긴다.
// *.test.ts만 불러 쓴다(서버 코드는 가져오지 않음). 네트워크 · 키 없음. 출력은 JSON 글 하나로 text 블록에 담아 callLlm의 검증(스키마)을 그대로 통과시킨다.
//   fakeClaude({ T2F: [출력 | Error | (화면 글) => 출력, …], T1: […] })
//   · 지점 구별: 요청의 system 글이 어느 프롬프트의 것인지로
//   · 준비된 출력이 떨어지면 오류(지점 이름 포함) — 시험이 호출 수를 틀리게 셌다는 뜻
import { LlmClientError, type LlmClient, type LlmRequest, type LlmResponse } from './llm.ts';
import { POINTS, type PointId } from '../prompts/index.ts';

export type FakeStep = unknown | Error | ((screen: string) => unknown);
export type FakeScript = Partial<Record<PointId, FakeStep[]>>;

const USAGE: Record<string, { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }> = {
  T1: { input_tokens: 1480, output_tokens: 190, cache_read_input_tokens: 3282, cache_creation_input_tokens: 0 },
  T2F: { input_tokens: 1210, output_tokens: 160, cache_read_input_tokens: 2900, cache_creation_input_tokens: 0 },
  T2: { input_tokens: 2100, output_tokens: 420, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
};

const systemText = (s: LlmRequest['system']): string => (typeof s === 'string' ? s : s.map((b) => b.text).join(''));

export interface FakeClaude {
  client: LlmClient;
  /** 지점별로 받은 화면 글(user 메시지) */
  seen: Record<string, string[]>;
  /** 호출 순서 (지점 이름) */
  order: string[];
  /** 아직 안 쓴 준비 출력 수 */
  left(point: PointId): number;
}

export function fakeClaude(script: FakeScript): FakeClaude {
  const queues: Record<string, FakeStep[]> = {};
  for (const [k, v] of Object.entries(script)) queues[k] = [...(v ?? [])];
  const seen: Record<string, string[]> = {};
  const order: string[] = [];
  const bySystem = new Map<string, PointId>(Object.entries(POINTS).map(([id, cfg]) => [cfg.prompt.system, id as PointId]));
  const client: LlmClient = {
    create(params): Promise<LlmResponse> {
      const point = bySystem.get(systemText(params.system));
      if (point === undefined) return Promise.reject(new Error('가짜 Claude: 모르는 프롬프트'));
      const screen = params.messages[0]?.content ?? '';
      (seen[point] ??= []).push(screen);
      order.push(point);
      const step = (queues[point] ??= []).shift();
      if (step === undefined) return Promise.reject(new Error(`가짜 Claude: ${point} 준비된 출력이 없음`));
      const value = typeof step === 'function' ? (step as (s: string) => unknown)(screen) : step;
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(value) }],
        stop_reason: 'end_turn',
        usage: USAGE[point] ?? USAGE.T1,
        model: 'claude-haiku-5-5',
        request_id: `req_fake_${point}_${order.length}`,
      });
    },
  };
  return { client, seen, order, left: (p) => (queues[p] ?? []).length };
}

/** 던지면 호출 쪽이 UPSTREAM(서버 오류 5xx)으로 보는 오류 — 재시도도 같은 오류가 나오게 같은 자리에 둘 만큼 넣을 것 */
export const upstreamError = (): LlmClientError => new LlmClientError('server', 'fake 5xx', { status: 500 });
