// 자동 정리 — [완료]를 안 눌러도 서버가 지난 기준일의 대화를 정리 (voice-commit 배치 길, pg_cron 10분마다). 앱이 꺼져 있어도 돎
//   대상: 정리 안 됐거나 정리 뒤 말이 는 세션 구간 — findUncommitted와 같은 조건(BEFORE_SLEEP · 안 끝남 · 사용자 말 있음), 최근 8일에 시작한 것
//   언제: 구간의 기준일(server_state.day.review = D)이 끝난 뒤 — 아침(D+1, KST)에 켜진 기상 알람이 있으면 가장 이른 것의 2시간 전(D+1 0시보다 앞이면 0시), 없으면 D+1 04:00
//         그리고 마지막 사용자 말 + 60분이 지난 뒤 (대화 중이면 미룸 · 04:00 뒤에 D 대화를 했으면 다음 04:00을 기다리지 않고 60분 뒤)
//         Live 음성은 사용자 말마다 voice-turn으로 turns에 쌓이고 한 번이 최대 10분(LIVE_SESSION_MS)이라 60분 안에 듦. 그래도 겹치면 rev 비교로 한쪽만 · 앱은 CONFLICT면 다시 읽음
//   정리: voice-commit과 같은 commitRoom — 겹침 · 다시 시도 · STALE · 일기 규칙 그대로. 쓰기는 서버 키 + user_id 직접 걸기 (세션 · 저장 함수가 모두 user_id로 좁힘)
//   한 번에: 정리 3개(T2 + T5 = 최대 6호출, 기본 RPM 8 안) · 새 정리는 60초 안에만 시작 (T2 19초 × 2 + T5 — 함수 시간 150초 안). 남은 것은 다음 실행
//   실패 · 일부 실패(FAILED · PARTIAL)는 30분 → 1 · 2 · 4 · 8시간 쉬었다 다시 (같은 실패에 Gemini를 계속 부르지 않게). 대상이 없으면 Gemini를 안 부름
// 이 파일은 Deno API를 안 써서 node --test로 돈다.
import { must } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { Db } from '../supabase.ts';
import { seoulIso, startOf } from './context.ts';
import { dbMs } from './context-core.ts';
import { seoulLocal } from './ko.ts';
import type { LlmClient } from './llm.ts';
import type { QuotaGate } from './quota.ts';
import type { ServerState, StoredTurn } from './session.ts';
import { addDays } from './view.ts';
import { COMMIT_STALE_MS, commitRoom, type VoiceCommitOut } from './voice-commit.ts';

export const IDLE_MS = 60 * 60_000;
export const WAKE_LEAD_MS = 2 * 60 * 60_000;
export const MAX_COMMITS_PER_RUN = 3;
export const RUN_BUDGET_MS = 60_000;
const LOOKBACK_DAYS = 8;
const RETRY_BASE_MS = 30 * 60_000;
const RETRY_MAX_MS = 8 * 60 * 60_000;

export interface AutoCommitDeps {
  service: Db;
  /** null이면 키 없음 — 아무것도 안 함(FAILED로 적지 않음) */
  llm: LlmClient | null;
  model: string;
  quota?: QuotaGate | null;
  ioUserIds?: string[];
  now?: () => Date;
  /** 이번 실행이 시작한 뒤 지난 ms (시험용) */
  elapsed?: () => number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AutoCommitOut {
  /** 정리가 필요한 구간 수 */
  pending: number;
  /** 아직 때가 아니거나(기준일 안 끝남 · 대화 중) 다시 시도를 쉬는 중 */
  waiting: number;
  done: { session_id: string; status: VoiceCommitOut['status'] }[];
  errors: { session_id: string; code: string }[];
  /** 때가 됐지만 이번 실행 한도(개수 · 시간)로 다음 실행에 넘긴 수 */
  left: number;
}

interface Row {
  session_id: string;
  user_id: string;
  started_at: string;
  turns: StoredTurn[];
  server_state: ServerState;
}

/** 기준일 review의 정리 시각(ms) — 다음 아침(review + 1)의 가장 이른 켜진 기상 알람 2시간 전, 없으면 그 아침 04:00 (KST) */
export function dueAt(review: string, wakeAts: string[]): number {
  const morning = addDays(review, 1);
  const wakes = wakeAts.map(dbMs).filter((ms) => seoulLocal(seoulIso(new Date(ms))).date === morning);
  if (wakes.length === 0) return Date.parse(`${morning}T04:00:00+09:00`);
  return Math.max(Math.min(...wakes) - WAKE_LEAD_MS, Date.parse(startOf(morning)));
}

/** 정리할 말이 남았는지 — findUncommitted와 같은 판단 */
export function needsCommit(st: ServerState): boolean {
  if (st.ended || st.counts.user_turns === 0) return false;
  const c = st.commit;
  return !(c?.status === 'DONE' && (c.at_turn ?? Infinity) >= st.counts.user_turns);
}

/** 앞 시도가 아직 도는 중이거나 실패 뒤 쉬는 중이면 다시 시도해도 되는 때(ms), 아니면 0 */
export function retryAt(st: ServerState): number {
  const c = st.commit;
  if (c?.status === 'RUNNING') return Date.parse(c.started_at) + COMMIT_STALE_MS;
  if (c?.status !== 'FAILED' && c?.status !== 'PARTIAL') return 0;
  const wait = Math.min(RETRY_BASE_MS * 2 ** (Math.min(c.attempts, 5) - 1), RETRY_MAX_MS);
  return Date.parse(c.finished_at ?? c.started_at) + wait;
}

const lastUserAt = (turns: StoredTurn[]): number => Math.max(...turns.filter((t) => t.role === 'user').map((t) => Date.parse(t.at)));

export async function runAutoCommit(deps: AutoCommitDeps): Promise<AutoCommitOut> {
  const out: AutoCommitOut = { pending: 0, waiting: 0, done: [], errors: [], left: 0 };
  if (deps.llm === null) return out;
  const now = (deps.now ?? (() => new Date()))();
  const t0 = Date.now();
  const elapsed = deps.elapsed ?? (() => Date.now() - t0);
  const today = seoulLocal(seoulIso(now)).date;

  // shortcut: 최근 8일 구간을 모두 읽고 정리 여부는 여기서 가름 — 사용자가 많아지면 server_state 조건을 쿼리로 옮김
  const raw = must<Row[]>(
    'conversation_sessions',
    await deps.service
      .from('conversation_sessions')
      .select('session_id, user_id, started_at, turns, server_state')
      .eq('session_type', 'BEFORE_SLEEP')
      .is('ended_at', null)
      .gte('started_at', startOf(addDays(today, -LOOKBACK_DAYS)))
      .order('started_at', { ascending: true }),
  ) ?? [];
  const rows = raw.filter((r) => Array.isArray(r.turns) && r.server_state?.v === 1 && needsCommit(r.server_state));
  out.pending = rows.length;
  if (rows.length === 0) return out;

  // 아침마다 켜진 기상 알람 — 대상 사용자 · 대상 아침 날짜 범위만
  const mornings = rows.map((r) => addDays(r.server_state.day.review, 1)).sort();
  const alarms = must<{ user_id: string; scheduled_at: string }[]>(
    'alarms',
    await deps.service
      .from('alarms')
      .select('user_id, scheduled_at')
      .in('user_id', [...new Set(rows.map((r) => r.user_id))])
      .eq('alarm_type', 'WAKE')
      .eq('is_enabled', true)
      .gte('scheduled_at', startOf(mornings[0]))
      .lt('scheduled_at', startOf(addDays(mornings[mornings.length - 1], 1))),
  ) ?? [];

  const ready = rows.filter((r) => {
    const st = r.server_state;
    const wakes = alarms.filter((a) => a.user_id === r.user_id).map((a) => a.scheduled_at);
    const at = Math.max(dueAt(st.day.review, wakes), lastUserAt(r.turns) + IDLE_MS, retryAt(st));
    return now.getTime() >= at;
  });
  out.waiting = rows.length - ready.length;

  // 오래된 구간부터 — 같은 방의 앞 구간이 먼저 정리돼 뒤 구간의 commitRoom이 앞 구간을 다시 안 부름
  for (const [i, r] of ready.entries()) {
    if (out.done.length + out.errors.length >= MAX_COMMITS_PER_RUN || elapsed() >= RUN_BUDGET_MS) {
      out.left = ready.length - i;
      break;
    }
    try {
      const res = await commitRoom(
        { userId: r.user_id, userDb: deps.service, service: deps.service, llm: deps.llm, model: deps.model, quota: deps.quota, ioUserIds: deps.ioUserIds, clock: deps.clock, sleep: deps.sleep },
        r.session_id,
        [],
        now,
      );
      out.done.push({ session_id: r.session_id, status: res.status });
    } catch (e) {
      // 실패는 세션의 commit(FAILED)에 남아 다음 실행이 쉬었다 다시 · CONFLICT는 그 사이 말이 들어온 것(다음 실행)
      console.error('[auto-commit] 정리 실패:', r.session_id, e);
      out.errors.push({ session_id: r.session_id, code: e instanceof HttpError ? e.code : 'INTERNAL' });
    }
  }
  return out;
}

export interface AutoCommitStarted {
  accepted: true;
  run_id: string;
}

/**
 * 배치를 응답 뒤로 미룸 — pg_net은 10초만 기다리고 끊어서, 정리(T2 · T5)가 끝나기를 기다리면 응답이 잘림.
 * 응답(202)은 "시작했다"일 뿐 — 성공 · 실패는 로그로: 시작 → 완료(errors 있으면 error 로그) 또는 실패. 같은 run_id로 묶임
 * waitUntil = EdgeRuntime.waitUntil (함수 최대 실행 시간까지 살려 둠). 시작했는데 완료 · 실패 로그가 없으면 실행 시간 한도로 끊긴 것
 */
export function startAutoCommit(
  deps: AutoCommitDeps,
  waitUntil: (p: Promise<unknown>) => void,
  log: Pick<Console, 'log' | 'error'> = console,
): AutoCommitStarted {
  const runId = crypto.randomUUID();
  log.log(`[auto-commit] 시작 run=${runId}`);
  const job = runAutoCommit(deps).then(
    (out) => (out.errors.length > 0 ? log.error : log.log)(`[auto-commit] 완료 run=${runId}`, JSON.stringify(out)),
    (e) => log.error(`[auto-commit] 실패 run=${runId}`, e),
  );
  waitUntil(job);
  return { accepted: true, run_id: runId };
}
