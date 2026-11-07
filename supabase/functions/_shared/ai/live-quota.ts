// voice-live-token의 본체 — 하루 한도 확인 → Gemini Live 1회용 토큰 → ai_calls 한 줄(지점 'LV')
//   글 대화 한도(하루 5대화 · voice-session)와 따로 셈: Live는 토큰 하나가 연결 한 번(최대 LIVE_SESSION_MS)이라 발급 수로 막음
//   하루 전체 AI 호출 상한(300)은 같이 지킴 — LV 줄도 그 셈에 들어감
//   순수 TS — node --test로 시험 (live-quota.test.ts). 토큰 본문은 live-token.ts (로컬 도구도 쓰는 곳이라 DB 코드를 넣지 않음)
import { must } from '../db.ts';
import { HttpError } from '../errors.ts';
import { seoulLocal } from './ko.ts';
import { seoulIso, startOf } from './context.ts';
import { createLiveToken, LIVE_MODEL } from './live-token.ts';
import { MAX_AI_CALLS_PER_DAY } from './opening.ts';
import { countCallsSince, recordCalls, type SessionDeps } from './session.ts';

export const LIVE_POINT = 'LV';
// 하루에 음성 대화를 시작할 수 있는 횟수 (ai_calls point 'LV' 줄 수, 발급 성공 · 실패 모두 셈)
export const MAX_LIVE_TOKENS_PER_DAY = 10;

export interface LiveTokenDeps extends SessionDeps {
  apiKey: string;
  now?: () => Date;
  fetchFn?: typeof fetch;
}

export async function handleLiveToken(deps: LiveTokenDeps): Promise<{ token: string; model: string; left_today: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = seoulIso(now);
  const since = startOf(seoulLocal(nowIso).date);
  // 한도는 발급 전에 보고 기록은 발급 뒤에 쌓여서, 동시에 여러 번 부르면 그 몇 번은 함께 통과할 수 있음 (timetable-extract와 같은 방식)
  const [live, all] = await Promise.all([
    deps.userDb.from('ai_calls').select('call_id', { count: 'exact', head: true }).eq('user_id', deps.userId).eq('point', LIVE_POINT).gte('created_at', since),
    countCallsSince(deps, since),
  ]);
  must('ai_calls', { data: null, error: live.error });
  const today = live.count ?? 0;
  if (today >= MAX_LIVE_TOKENS_PER_DAY || all >= MAX_AI_CALLS_PER_DAY) {
    throw new HttpError('RATE_LIMITED', '오늘 음성 대화 횟수를 다 썼어요. 글로 이어 가 주세요', { left_today: 0 });
  }

  const started = Date.now();
  let ok = false;
  try {
    const r = await createLiveToken(deps.apiKey, { fetchFn: deps.fetchFn, now: now.getTime() });
    ok = true;
    return { ...r, left_today: Math.max(0, MAX_LIVE_TOKENS_PER_DAY - today - 1) };
  } finally {
    // 성공 · 실패 모두 한 줄 (한도 셈의 근거). 토큰 · 대화 글은 남기지 않음. 기록 실패는 recordCalls가 로그만 남기고 발급은 그대로
    const call = {
      point: LIVE_POINT, prompt_id: 'LIVE', prompt_version: 'v1', model: LIVE_MODEL, ok, error_code: ok ? null : ('UPSTREAM' as const),
      latency_ms: Date.now() - started, attempts: 1, input_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_write_tokens: null, thinking_tokens: null, cost_usd: null, stop_reason: null, request_id: null, flags: [],
    };
    await recordCalls(deps, null, [{ call, io: null }], nowIso);
  }
}
