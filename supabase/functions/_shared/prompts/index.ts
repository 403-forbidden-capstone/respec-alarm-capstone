// 프롬프트 지점 설정 — 서버가 AI를 부르는 7개 지점의 "어느 글 · 어느 스키마 · 어떤 설정"을 이 파일 한 곳에 모음.
// 근거: 실험실 채택 실행 설정(docs/ai-lab/프롬프트카드/ + 인계.md)과 실험실 장부(runs/ledger.jsonl)의 지연. 모델은 Claude Haiku 5.5(실험에 쓴 계열).
//
// 판 관리 규칙
//   1. 프롬프트 글은 docs/ai-lab/prompts/<ID>.<판>.md가 원본이고, gen.mjs가 같은 이름의 .ts 모듈로 굳힘 (서버 함수에는 md가 안 실림).
//   2. 한번 쓴 판 파일은 덮어쓰지 않는다. 글이 바뀌면 새 판 파일(T1.v1.4.ts)을 만들고, 옛 판 파일은 남김 (ai_calls.prompt_version으로 판마다 비교하려고).
//   3. 지금 쓰는 판은 아래 POINTS 한 곳만 가리킨다. 판을 바꾸는 일 = 아래 import와 prompt 줄을 새 판으로 바꾸는 한 번의 고침.
//   4. 스키마도 같다 (ai/schemas/, 새 판은 .v2 파일 + schemas/index.ts 한 줄).
//   5. 글이 실험실 실행본과 같은지는 prompts.test.ts가 md 글자와 지문(FNV-1a)으로 대조한다.
//
// 앱에는 프롬프트가 없다 — 글 · 숫자 · 시각 · 저장은 모두 서버. 모델 출력은 믿지 않는 입력이라 callLlm이 기준 스키마로 다시 검사한다.
import { callLlm, DEFAULT_MODEL, type CallGate, type Effort, type LlmClient, type LlmResult } from '../ai/llm.ts';
import { render } from '../ai/render.ts';
import { schemaOf, type SchemaId } from '../ai/schemas/index.ts';
import ASSIST_E4 from './ASSIST_E4.v1.1.ts';
import T1 from './T1.v1.5.ts';
import T2 from './T2.v2.ts';
import T2F from './T2F.v2-b.ts';
import T3 from './T3.v1.ts';
import T4 from './T4.v1.1.ts';
import T5 from './T5.v1.2.ts';

// ai_calls.point 값과 같은 이름 (DB check 제약 'T1' · 'T2F' · 'T2' · 'T3' · 'T4' · 'T5' · 'E4')
export type PointId = 'T1' | 'T2F' | 'T2' | 'T3' | 'T4' | 'T5' | 'E4';

export interface PromptModule {
  id: string; // ai_calls.prompt_id
  version: string; // ai_calls.prompt_version
  meta: Readonly<Record<string, string>>; // 머리말의 나머지 (model · effort · schema · thinking)
  system: string; // 모델에 보내는 그대로
  user: string; // {{변수}} 템플릿 원문
}

export interface PointConfig {
  prompt: PromptModule;
  schema: SchemaId;
  effort: Effort;
  maxTokens: number;
  thinking: { type: 'adaptive' } | null; // null = 안 보냄 (Haiku 5.5 기본 = 켜짐, effort로 조절)
  // 시도 하나의 제한 시간 = 장부(실험실 runs/ledger.jsonl) 지연 p95 × 2. 재시도 때는 시도마다 다시 잼
  timeoutMs: number;
  // 시간 초과도 한 번 다시 시도할지. 429 · 5xx · 연결 오류는 늘 1번 다시 시도함 (llm.ts)
  retryOnTimeout: boolean;
  cacheSystem: boolean; // system 글에 캐시 표시 (5분)
}

export const POINTS: Record<PointId, PointConfig> = {
  // 대화 답. 장부 n=1530(오류 · 생각 끔 제외): p50 3.9초 / p95 6.5초 → 13초
  T1: { prompt: T1, schema: 't1-reply.v1', effort: 'low', maxTokens: 2048, thinking: null, timeoutMs: 13_000, retryOnTimeout: true, cacheSystem: true },
  // 빠른 추출. 장부 n=156: p50 2.4초 / p95 5.3초. 제한 5초는 카드 ⑥ 34번 — 5초 안에 안 오면 "처리할 게 없음"으로 보고 미리 부른 T1 답을 쓴다
  //   (다음 턴 T2F가 따라잡음). 그래서 다시 시도하지 않음: 다시 기다리면 T1을 미리 부른 이득이 없어짐. 적응형 생각 켬(카드 ⑥ 31번, 끄면 오류 3배)
  T2F: { prompt: T2F, schema: 'extract-fast.v1', effort: 'low', maxTokens: 4096, thinking: { type: 'adaptive' }, timeoutMs: 5_000, retryOnTimeout: false, cacheSystem: true },
  // 대화 끝 전체 추출. 장부 n=724: p50 5.6초 / p95 9.4초 → 19초
  T2: { prompt: T2, schema: 'extract.v1', effort: 'medium', maxTokens: 4096, thinking: null, timeoutMs: 19_000, retryOnTimeout: true, cacheSystem: true },
  // 이유 태그. 장부 n=594: p50 1.4초 / p95 1.6초 → ×2는 3.2초지만 네트워크 흔들림 여유로 4초 바닥
  T3: { prompt: T3, schema: 't3-reason.v1', effort: 'low', maxTokens: 1024, thinking: null, timeoutMs: 4_000, retryOnTimeout: true, cacheSystem: true },
  // 대화 없는 날 일기. 장부 n=84: p50 2.1초 / p95 5.1초 → ×2는 10.2초를 올려 11초
  T4: { prompt: T4, schema: 't4-diary.v1', effort: 'medium', maxTokens: 4096, thinking: null, timeoutMs: 11_000, retryOnTimeout: true, cacheSystem: true },
  // 일기 · 코칭 · 응원. 장부 n=82: p50 9.1초 / p95 12.8초 → 26초
  T5: { prompt: T5, schema: 't5-journal.v1', effort: 'medium', maxTokens: 6000, thinking: null, timeoutMs: 26_000, retryOnTimeout: true, cacheSystem: true },
  // 추천 비서(하루 한 번 밤에 계산해 저장). 장부 n=132: p50 9.1초 / p95 14.2초 → ×2는 28.4초라 28초
  E4: { prompt: ASSIST_E4, schema: 'assist-e4.v1', effort: 'medium', maxTokens: 8000, thinking: null, timeoutMs: 28_000, retryOnTimeout: true, cacheSystem: true },
};

// 시험 · 운영에서 바꿔 끼우는 값
export interface PointExtra {
  model?: string; // 기본 DEFAULT_MODEL. 서버 함수는 anthropic.ts의 model()(ANTHROPIC_MODEL)을 넘김
  timeoutMs?: number;
  deadlineMs?: number; // 전체 마감(callLlm 참고) — 기본 없음
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  gate?: CallGate; // 사용량 관문(ai/quota.ts) — 요청마다 통과해야 보냄
}

// 한 지점을 부른다: user 템플릿을 vars로 채워(빠진 변수는 RenderError — 코드 버그라 던짐) callLlm에 넘김.
// client가 null(키 없음)이면 호출 0번으로 NOT_CONFIGURED 값을 돌려줌.
export async function callPoint<T = unknown>(
  client: LlmClient | null,
  point: PointId,
  vars: Record<string, unknown>,
  extra: PointExtra = {},
): Promise<LlmResult<T>> {
  const cfg = POINTS[point];
  return callLlm<T>(client, {
    point,
    promptId: cfg.prompt.id,
    promptVersion: cfg.prompt.version,
    model: extra.model ?? DEFAULT_MODEL,
    system: cfg.prompt.system,
    user: render(cfg.prompt.user, vars).trimEnd(),
    schema: schemaOf(cfg.schema),
    effort: cfg.effort,
    maxTokens: cfg.maxTokens,
    thinking: cfg.thinking,
    cacheSystem: cfg.cacheSystem,
    timeoutMs: extra.timeoutMs ?? cfg.timeoutMs,
    retryOnTimeout: cfg.retryOnTimeout,
    deadlineMs: extra.deadlineMs,
    sleep: extra.sleep,
    now: extra.now,
    gate: extra.gate,
  });
}
