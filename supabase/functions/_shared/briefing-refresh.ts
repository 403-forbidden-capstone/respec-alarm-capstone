// 백그라운드 브리핑 갱신(#515) — 이 기상 알람의 전날 대화가 아직 새벽 정리(구조화) 전인지 보고, 그렇다면 폰이 다시 받을 시각을 정함
//   정리 전이면 대본에 어제 다짐 · 늦잠 기록이 없음 → 폰(BriefingRefreshWorker)이 refresh_at에 alarm-briefing-device를 한 번 더 부름
//   "정리 전" 판단은 자동 정리(ai/auto-commit.ts)와 같은 식 (needsCommit · dueAt · retryAt) — 그 배치가 실제로 정리할 구간만 기다림
//   기상 5분 전 마감은 폰이 정함 (BriefingRules.refreshDeadline). 여기는 언제 다시 보면 되는지만
// 이 파일은 Deno API를 안 써서 node --test로 돈다 (briefing-refresh.test.ts)
import { dueAt, needsCommit, retryAt } from './ai/auto-commit.ts';
import type { ServerState } from './ai/session.ts';
import { must } from './db.ts';
import type { Db } from './supabase.ts';

// 자동 정리는 pg_cron 10분마다 + 정리 한 번 T2 · T5 1분 안팎 → 정리 예정 시각 10분 뒤에 다시 봄 (04:00 정리 → 04:10)
export const COMMIT_LAG_MS = 10 * 60_000;

/**
 * 기준일 review(= 알람 날 − 1)의 대화 중 자동 정리를 기다리는 구간이 있으면 다시 받을 시각(ms), 없으면 null
 *   정리 예정(기준일 끝 04:00, 실패 뒤 쉬는 중이면 그 끝) + 10분. 예정이 이미 지났는데 아직이면(배치가 밀림) 지금 + 10분
 *   여러 구간이면 가장 늦은 것 (모두 정리된 뒤 한 번에)
 */
export async function briefingRefreshAt(service: Db, userId: string, review: string, nowMs: number): Promise<number | null> {
  const rows = must<{ server_state: ServerState | null }[]>(
    'refresh sessions',
    await service
      .from('conversation_sessions')
      .select('server_state')
      .eq('user_id', userId)
      .eq('session_type', 'BEFORE_SLEEP')
      .is('ended_at', null)
      .eq('server_state->day->>review', review),
  ) ?? [];
  let at: number | null = null;
  for (const { server_state: st } of rows) {
    if (st?.v !== 1 || !needsCommit(st)) continue;
    const next = Math.max(Math.max(dueAt(st.day.review), retryAt(st)) + COMMIT_LAG_MS, nowMs + COMMIT_LAG_MS);
    at = Math.max(at ?? next, next);
  }
  return at;
}

/**
 * 지금 Gemini(대본 · 음성)를 아직 부르지 않을지 — 알람 날 새벽 4시(전날 대화 정리 시각) 전이거나, 정리를 기다리는 대화가 있으면(refreshAt) true
 *   알람을 만들 · 고칠 때(전날 밤 · 며칠 전)는 문장만 주고, 그날 4:10 백그라운드 갱신 · 그 뒤 앱 맞추기가 대본 · 음성을 만듦
 *   4시 전에 울리는 알람은 늘 true → 예비 WAV · Android TTS (잘못 만든 새벽 알람이 그날 한도를 쓰지 않게)
 */
export const holdGemini = (review: string, nowMs: number, refreshAt: number | null): boolean => nowMs < dueAt(review) || refreshAt != null;
