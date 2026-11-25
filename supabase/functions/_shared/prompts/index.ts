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
import T1 from './T1.v1.6.ts';
import T2 from './T2.v3.3.ts';
import T2F from './T2F.v2-f.ts';
import T3 from './T3.v1.ts';
import T4 from './T4.v1.1.ts';
import T5 from './T5.v3.ts';

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
  // 대화 답. 장부 n=1530(Claude, 오류 · 생각 끔 제외): p50 3.9초 / p95 6.5초 → 13초였음
  //   Gemini Flash-Lite 실측(11/7) 4.7 · 11.5 · 12.4초 → 16초. 다시 시도는 원래 18초 마감 안에 안 들어가 일어나지 않으므로 늘려도 호출 수 · 마감은 그대로
  //   11/12 다시 잼(Flash-Lite, 모델 그대로): 정상 답 대부분 1.4~4.6초지만 과부하 때 9~23초 꼬리 · 503 — 20초 (턴 마감 30초 안에서 남은 시간으로 잘림)
  T1: { prompt: T1, schema: 't1-reply.v1', effort: 'low', maxTokens: 2048, thinking: null, timeoutMs: 20_000, retryOnTimeout: true, cacheSystem: true },
  // 빠른 추출. 장부 n=156(Claude Haiku): p50 2.4초 / p95 5.3초. 제한 시간 안에 안 오면 "처리할 게 없음"으로 보고 T1 답을 쓴다
  //   (다음 턴 T2F가 따라잡음). 그래서 다시 시도하지 않음. 적응형 생각 켬(카드 ⑥ 31번, 끄면 오류 3배 — Gemini는 effort low = thinkingLevel low)
  //   Gemini Flash-Lite는 5초에 시간 초과(11/7 실측, 같은 크기 T1이 4.7~11.5초) → 9초. T2F 9초 + T1 9초 남음 = 턴 마감 18초 · REGEN_MIN 7초 안
  //   11/12 실측 17번(정상 답): 1.4 · 1.4 · 1.4 · 1.6 · 1.7 · 1.9 · 2.3 · 2.9 · 4.6 · 9.0 · 9.2 · 9.3 · 11.8 · 18.4 · 20.7 · 22.8초 — 9초면 1/3쯤을 버림 → 15초.
  //   일정일 수도 있는 말은 실패하면 [다시 시도](turn.ts)라 더 길게 잡지 않음. T2F 15초 + T1 15초 = 턴 마감 30초. v2-d = 준비물(items)도 뽑음, v2-e = 나가기 전 할 일(pre_tasks) · 기상 시각 답(wake_reply)도 뽑음, v2-f = 알람 상대 변경 분(alarm_changes.shift, #625)
  T2F: { prompt: T2F, schema: 'extract-fast.v4', effort: 'low', maxTokens: 4096, thinking: { type: 'adaptive' }, timeoutMs: 15_000, retryOnTimeout: false, cacheSystem: true },
  // 대화 끝 전체 추출(voice-commit). 장부 n=724(v2): p50 5.6초 / p95 9.4초 → 19초. v3 = v2 + 행동 · 알람 평가 · 돌아보기 칸(extract.v2), v3.1 = 피로 · 스트레스 점수는 숫자로 말했을 때만, v3.2 = 감정 원인 · 습관 출처는 직접 말한 것만
  T2: { prompt: T2, schema: 'extract.v2', effort: 'medium', maxTokens: 4096, thinking: null, timeoutMs: 19_000, retryOnTimeout: true, cacheSystem: true },
  // 이유 태그. 장부 n=594: p50 1.4초 / p95 1.6초 → ×2는 3.2초지만 네트워크 흔들림 여유로 4초 바닥
  T3: { prompt: T3, schema: 't3-reason.v1', effort: 'low', maxTokens: 1024, thinking: null, timeoutMs: 4_000, retryOnTimeout: true, cacheSystem: true },
  // 대화 없는 날 일기. 장부 n=84: p50 2.1초 / p95 5.1초 → ×2는 10.2초를 올려 11초
  T4: { prompt: T4, schema: 't4-diary.v1', effort: 'medium', maxTokens: 4096, thinking: null, timeoutMs: 11_000, retryOnTimeout: true, cacheSystem: true },
  // 하루 일기(voice-commit 끝, 구조화 JSON → 1~2문장). v3 = v2 + 일정 · 준비물 · 할 일도 쓰고 사실이 있으면 비우지 않음. v1.2(대화 원문 → 일기 · 코칭 · 응원, 26초)는 서버에서 안 씀. v2는 장부 없음 —
  //   출력이 한두 문장이라 T2F와 같은 9초, 다시 시도 안 함(앱 voice-commit 45초 안에 T2와 같이 들어가게. 실패하면 PARTIAL → 다음 대화 열 때 다시)
  T5: { prompt: T5, schema: 't4-diary.v1', effort: 'low', maxTokens: 1024, thinking: null, timeoutMs: 9_000, retryOnTimeout: false, cacheSystem: true },
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
