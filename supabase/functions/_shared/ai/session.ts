// 대화 세션 저장 · 읽기 (DB 쪽) — conversation_sessions 한 줄이 한 대화. turns(말) · server_state(서버만 쥐는 값)의 안쪽 모양은 여기서 정한다 (설계 메모 3절).
// 읽기 = 부른 사람의 RLS 클라이언트(userDb), 쓰기 = 서버 키(service) — alarm-commit과 같은 방식. 두 클라이언트 모두 user_id를 직접 걸어 남의 줄에 닿지 않게 한다(남의 세션 = NOT_FOUND).
// 동시 요청 · 재시도: server_state.rev 비교-교체(UPDATE … WHERE server_state->>rev = 기대값)로 하고, 0줄이면 CONFLICT. 이 파일은 순수 TS(Deno API 없음) — node --test로 돈다.
import { must } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { Db } from '../supabase.ts';
import type { AiCallRecord } from './llm.ts';
import type { AskedQuestion, FixRecord, TurnState } from './turn-core.ts';
import { dbMs, type RefsOut } from './context-core.ts';
import { seoulIso } from './context.ts';
import { MAX_AI_CALLS_PER_DAY, MAX_SESSIONS_PER_DAY, MAX_USER_TURNS } from './opening.ts';
import type { Act, Card, Context, ServerEvent, TurnLimits } from './types.ts';

export interface SessionDeps {
  userId: string;
  /** 부른 사람의 RLS — 읽기 */
  userDb: Db;
  /** 서버 키(RLS 건너뜀) — 쓰기. 쓰기 전에 user_id를 직접 확인한다 */
  service: Db;
}

// ───────── 저장 모양 ─────────

/** turns 한 줄 (설계 메모 3절) — 말만, 오래된 것부터 */
export interface StoredTurn {
  n: number; // 몇 번째 줄(0부터)
  role: 'user' | 'ai';
  text: string; // 사용자 말은 받은 글 그대로(지침 3)
  at: string; // ISO
  client_turn_id?: string; // user 줄 — 재시도 판별
  after_turn?: number; // ai 줄 — 몇 번째 사용자 말에 대한 답(0 = 첫 마디)
  source?: 'template' | 't1' | 't1_regen' | 'fallback';
  trigger?: string; // ai 줄 — text · results · card:c1
  acts?: Act[];
  end?: boolean;
  flags?: string[]; // ai 줄 — AUTO_FLAGS 이름 그대로
  guard?: string[]; // ai 줄 — 서버 조치(drop_sentence · regen · cut_question · append_alarm · spoken_times · template …)
}

export type CoreState = Omit<TurnState, 'events' | 'cards' | 'fixes' | 'awaiting'>;

export interface QuestionState {
  id: string; // q1
  kind: string;
  target: string | null;
  subject_key: string;
  /** 사용자에게 물은 때 — 아직 안 물었으면 null (물으면 user_questions에도 한 줄 남김) */
  asked_at: string | null;
}

export interface ServerState {
  v: 1;
  rev: number;
  view_version: string;
  prompts: { T1: string; T2F: string; T2: string };
  day: { review: string; morning: string; tz: string; tz_supported: boolean };
  /** context.v1 스냅숏 — 대화 시작 때 한 번 읽음, events는 비움(처리 결과는 아래 events) */
  ctx: Context;
  /** 별칭 → DB id. 모델이 낸 별칭은 여기서만 풂 */
  refs: RefsOut;
  /** 서버가 고른 확인할 기록 f# (T1 화면의 한 줄) */
  confirm: string[];
  core: CoreState;
  events: ServerEvent[];
  cards: Card[];
  fixes: FixRecord[];
  /** 앱 일(카드 계산 · 기록 정정) 결과를 기다리는 중 */
  awaiting: { client_turn_id: string; after_turn: number; cards: string[]; fixes: string[] } | null;
  /** 상태는 저장했지만 AI 답이 아직 없는 요청 — 같은 client_turn_id가 다시 오면 T1만 다시 부름 */
  owed: { client_turn_id: string; after_turn: number; trigger: string } | null;
  /** client_turn_id → 답한 ai 줄 n (답 없이 처리한 요청 = null) — 재시도하면 그대로 돌려줌 */
  replies: Record<string, number | null>;
  question: QuestionState | null;
  counts: { user_turns: number; llm_calls: number };
  ended: boolean;
  end_reason: string | null;
}

export interface SessionRow {
  session_id: string;
  user_id: string;
  session_type: string;
  input_mode: string;
  started_at: string;
  ended_at: string | null;
  turns: StoredTurn[];
  server_state: ServerState;
}

const SESSION_COLUMNS = 'session_id, user_id, session_type, input_mode, started_at, ended_at, turns, server_state';

const isState = (v: unknown): v is ServerState => typeof v === 'object' && v !== null && (v as { v?: unknown }).v === 1 && typeof (v as { rev?: unknown }).rev === 'number';

function toRow(raw: Record<string, unknown>): SessionRow | null {
  if (!Array.isArray(raw.turns) || !isState(raw.server_state)) return null; // 서버가 만든 줄이 아님(앱이 연 빈 세션 등)
  return raw as unknown as SessionRow;
}

// ───────── 읽기 ─────────

/** 세션 한 줄. 내 것이 아니거나 없거나 서버 상태가 없으면 NOT_FOUND */
export async function loadSession(deps: SessionDeps, sessionId: string): Promise<SessionRow> {
  const raw = must<Record<string, unknown> | null>(
    'conversation_sessions',
    await deps.userDb.from('conversation_sessions').select(SESSION_COLUMNS).eq('session_id', sessionId).eq('user_id', deps.userId).maybeSingle(),
  );
  const row = raw === null ? null : toRow(raw);
  if (row === null) throw new HttpError('NOT_FOUND', '대화를 찾을 수 없어요');
  return row;
}

/** 이어 쓸 세션 — sinceIso 뒤에 시작했고 아직 안 끝났고 같은 대화 기준일(돌아볼 날)인 것 중 가장 최근 (설계 메모 2.1 resume) */
export async function findOpenSession(deps: SessionDeps, sinceIso: string, review: string): Promise<SessionRow | null> {
  const rows = must<Record<string, unknown>[]>(
    'conversation_sessions',
    await deps.userDb
      .from('conversation_sessions')
      .select(SESSION_COLUMNS)
      .eq('user_id', deps.userId)
      .eq('session_type', 'BEFORE_SLEEP')
      .is('ended_at', null)
      .gte('started_at', sinceIso)
      .order('started_at', { ascending: false }),
  );
  for (const raw of rows ?? []) {
    const row = toRow(raw);
    if (row !== null && row.server_state.day.review === review && !row.server_state.ended) return row;
  }
  return null;
}

async function countSince(db: Db, table: string, userId: string, column: string, sinceIso: string, untilIso?: string): Promise<number> {
  let q = db.from(table).select(column, { count: 'exact', head: true }).eq('user_id', userId).gte(column, sinceIso);
  if (untilIso !== undefined) q = q.lt(column, untilIso);
  const res = await q;
  if (res.error) must(table, { data: null, error: res.error });
  return res.count ?? 0;
}

/** 오늘(사용자 시간대 0시부터) 시작한 대화 수 — 하루 5대화 상한. 앱이 줄을 지워 줄이는 허점은 아래 AI 호출 수 상한이 막음 */
export function countSessionsSince(deps: SessionDeps, sinceIso: string): Promise<number> {
  return countSince(deps.userDb, 'conversation_sessions', deps.userId, 'started_at', sinceIso);
}

/** 오늘 AI 호출 수 — ai_calls는 서버 키만 쓰는 표라 앱이 못 줄임 */
export function countCallsSince(deps: SessionDeps, sinceIso: string): Promise<number> {
  return countSince(deps.userDb, 'ai_calls', deps.userId, 'created_at', sinceIso);
}

/** 최근 질문 기록(모든 채널) — 질문 예산 셈: pickServerQuestion이 하루 1 · 7일 3 · 같은 대상 24시간을 이 목록으로 가름 */
export async function recentQuestions(deps: SessionDeps, sinceIso: string): Promise<AskedQuestion[]> {
  const rows = must<{ kind: string; subject_key: string; asked_at: string }[]>(
    'user_questions',
    await deps.userDb.from('user_questions').select('kind, subject_key, asked_at').eq('user_id', deps.userId).gte('asked_at', sinceIso).order('asked_at', { ascending: false }),
  );
  // DB가 준 시각 글자('…+00' 등)를 서울 ISO로 맞춰 줌 — 질문 예산 셈(turn-core)은 서울 ISO만 읽음
  return (rows ?? []).map((r) => ({ kind: r.kind as AskedQuestion['kind'], subject_key: r.subject_key, asked_at: seoulIso(new Date(dbMs(r.asked_at))) }));
}

// ───────── 쓰기 (서버 키) ─────────

/** 새 세션 줄. 하루 상한 확인은 부르는 쪽 몫 */
export async function createSession(deps: SessionDeps, input: { startedAt: string; turns: StoredTurn[]; state: ServerState }): Promise<SessionRow> {
  const raw = must<Record<string, unknown>>(
    'conversation_sessions',
    await deps.service
      .from('conversation_sessions')
      .insert({
        user_id: deps.userId,
        session_type: 'BEFORE_SLEEP',
        input_mode: 'TEXT',
        started_at: input.startedAt,
        turns: input.turns,
        server_state: input.state,
      })
      .select(SESSION_COLUMNS)
      .single(),
  );
  const row = toRow(raw);
  if (row === null) throw new HttpError('INTERNAL', '대화를 만들지 못했어요. 잠시 후 다시 시도해 주세요');
  return row;
}

/**
 * turns · server_state를 쓴다. 기대한 rev와 다르면(그 사이 다른 요청이 썼음) CONFLICT — 앱이 세션을 다시 읽음.
 * state.rev는 부르는 쪽이 +1 해서 넘긴다.
 */
export async function saveSession(
  deps: SessionDeps,
  sessionId: string,
  expectedRev: number,
  next: { turns: StoredTurn[]; state: ServerState },
): Promise<void> {
  const rows = must<{ session_id: string }[]>(
    'conversation_sessions',
    await deps.service
      .from('conversation_sessions')
      .update({ turns: next.turns, server_state: next.state })
      .eq('session_id', sessionId)
      .eq('user_id', deps.userId)
      .eq('server_state->>rev', String(expectedRev))
      .select('session_id'),
  );
  if ((rows ?? []).length === 0) throw new HttpError('CONFLICT', '대화가 다른 곳에서 바뀌었어요. 다시 불러와 주세요');
}

/** 서버 질문을 물었다는 기록 (질문 예산 셈) */
export async function recordQuestion(deps: SessionDeps, input: { sessionId: string; kind: string; subjectKey: string; askedAt: string }): Promise<void> {
  must(
    'user_questions',
    await deps.service.from('user_questions').insert({
      user_id: deps.userId,
      channel: 'CHAT',
      kind: input.kind,
      subject_key: input.subjectKey,
      session_id: input.sessionId,
      asked_at: input.askedAt,
    }),
  );
}

export interface CallLog {
  call: AiCallRecord;
  /** 호출 입력 · 출력 글 — 일반 사용자는 null(L6 안건후보 "대화 기록 보관" 기본안 B). 시드 · 팀 계정만 채움 */
  io: unknown;
}

/**
 * 모델 호출 기록(ai_calls) — 호출마다 한 줄. 기록이 실패해도 사용자의 턴은 막지 않는다(로그만).
 * 칸은 AiCallRecord 그대로(llm.ts) + user_id · session_id · io · created_at. 대화에 속하지 않는 호출(시간표 사진 읽기)은 sessionId null.
 */
export async function recordCalls(deps: SessionDeps, sessionId: string | null, logs: CallLog[], createdAt: string): Promise<void> {
  if (logs.length === 0) return;
  try {
    const res = await deps.service.from('ai_calls').insert(
      logs.map((l) => ({
        user_id: deps.userId,
        session_id: sessionId,
        point: l.call.point,
        prompt_id: l.call.prompt_id,
        prompt_version: l.call.prompt_version,
        model: l.call.model,
        ok: l.call.ok,
        error_code: l.call.error_code,
        latency_ms: l.call.latency_ms,
        attempts: l.call.attempts,
        input_tokens: l.call.input_tokens,
        output_tokens: l.call.output_tokens,
        cache_read_tokens: l.call.cache_read_tokens,
        cache_write_tokens: l.call.cache_write_tokens,
        thinking_tokens: l.call.thinking_tokens,
        cost_usd: l.call.cost_usd,
        stop_reason: l.call.stop_reason,
        request_id: l.call.request_id,
        flags: l.call.flags,
        io: l.io,
        created_at: createdAt,
      })),
    );
    if (res.error) console.error('[ai_calls] 기록 실패:', res.error.code ?? '', res.error.message);
  } catch (e) {
    console.error('[ai_calls] 기록 실패:', e);
  }
}

// ───────── 상한 ─────────

export function limitsOf(state: ServerState, sessionsToday: number, reached: TurnLimits['reached'] = null): TurnLimits {
  const turnsLeft = Math.max(0, MAX_USER_TURNS - state.counts.user_turns);
  return {
    turns_left: turnsLeft,
    sessions_left_today: Math.max(0, MAX_SESSIONS_PER_DAY - sessionsToday),
    reached: reached ?? (turnsLeft === 0 ? 'TURN' : null),
  };
}

export const callsCapReached = (callsToday: number): boolean => callsToday >= MAX_AI_CALLS_PER_DAY;
