// voice-turn 한 턴 (설계 메모 1 · 2.2 · 5 · 6 · 11절). DB 읽기 · 쓰기와 모델 호출을 묶고, 계산은 모두 PR 3의 순수 함수(turn-core · guards · view)가 한다.
//
// 요청 세 가지:
//   text        사용자 말 — T2F(빠른 추출) ∥ T1 미리(처리 결과 "바뀐 것 없음") 동시 → applyFast → 분기
//                 앱 일(카드 계산 · 기록 정정) 있음 → T1 미리 답 버림, next = APP_TASKS, reply 없음
//                 처리 결과 없음 → 미리 부른 T1 답 → 가드          처리 결과 있음 · 앱 일 없음 → T1 다시 → 가드
//   results     앱이 계산한 카드 상태 · 정정 결과 — applyTaskResults → T1 → 가드. 대기 중인 앱 일이 없어도 받음(장소 고르기 뒤 새 client_turn_id)
//   card_action 카드 [저장] · [저장 안 함] — applyCardAction. 저장(SAVED) 뒤 T1 한 번, REJECTED는 상태만(reply null)
// 동시 요청 · 재시도: server_state.rev 비교(CONFLICT), client_turn_id가 이미 있으면 저장한 답을 그대로 / 답이 아직 없던 요청이면 T1만 다시 (말이 두 번 쌓이지 않음).
// 시간: 서버 전체 18초 마감(T2F 5초 · T1 13초, 다시 부르기는 남은 시간 7초 넘을 때만). T2F가 못 오면 그 턴은 "처리 결과 없음".
// 모델 호출마다 ai_calls 한 줄(서버 키). 모델 호출 · 키 읽기는 deps.llm(null이면 NOT_CONFIGURED)만 통한다 — 이 파일은 Deno API를 안 써서 node --test로 돈다.
import { HttpError } from '../errors.ts';
import type { Db } from '../supabase.ts';
import { toHttpError, type LlmClient, type LlmFailure, type LlmResult } from './llm.ts';
import { POINTS, callPoint, type PointId } from '../prompts/index.ts';
import { render } from './render.ts';
import { applyGuards, eventsForView, safetyInfoFrom } from './guards.ts';
import { seoulIso, startOf } from './context.ts';
import { LIMIT_DAY_TEXT, LIMIT_TURN_TEXT, MAX_USER_TURNS } from './opening.ts';
import {
  callsCapReached, countCallsSince, countSessionsSince, limitsOf, loadSession, recordCalls, recordQuestion, saveSession,
  type CallLog, type ServerState, type SessionRow, type StoredTurn,
} from './session.ts';
import { applyCardAction, applyFast, applyTaskResults, needKinds, eventAt, type Rejected, type TurnState } from './turn-core.ts';
import type { Act, CardAction, Context, FastExtract, Fix, ServerEvent, T1Output, TaskResults, TurnLimits } from './types.ts';
import { readTurnRequest, type TurnRequest } from './voice-requests.ts';
import { ctxOf, publicCard, publicFix, toTurnState, turnsOf, withTurnState, type PublicCard, type PublicFix } from './voice-state.ts';
import { contextVars, viewTranscript } from './view.ts';
import { seoulLocal } from './ko.ts';

/** 서버 전체 마감(ms) · 다시 부르기에 필요한 남은 시간 (설계 메모 6 · 11절) */
export const TURN_DEADLINE_MS = 18_000;
export const REGEN_MIN_REMAINING_MS = 7_000;

export interface VoiceDeps {
  userId: string;
  userDb: Db;
  service: Db;
  /** null이면 키 없음 → NOT_CONFIGURED */
  llm: LlmClient | null;
  model: string;
  now?: () => Date;
  /** 단조 시계(ms) — 마감 · 지연 계산. 기본 performance.now */
  clock?: () => number;
  /** ai_calls.io(호출 입력 · 출력 글)를 채울 사용자 id — 비면 아무도 안 채움 (AI_LOG_IO_USER_IDS) */
  ioUserIds?: string[];
  sleep?: (ms: number) => Promise<void>;
}

export interface VoiceTurnOut {
  rev: number;
  turn_seq: number;
  next: 'USER' | 'APP_TASKS';
  reply: { text: string; acts: Act[]; end: boolean } | null;
  cards: PublicCard[];
  fixes: PublicFix[];
  limits: TurnLimits;
}

// ───────── 한 요청의 작업대 ─────────

class Run {
  readonly deps: VoiceDeps;
  readonly now: Date;
  readonly nowIso: string;
  readonly logs: CallLog[] = [];
  private readonly clock: () => number;
  private readonly t0: number;

  constructor(deps: VoiceDeps) {
    this.deps = deps;
    this.now = (deps.now ?? (() => new Date()))();
    this.nowIso = seoulIso(this.now);
    this.clock = deps.clock ?? (() => performance.now());
    this.t0 = this.clock();
  }

  remaining(): number {
    return TURN_DEADLINE_MS - (this.clock() - this.t0);
  }

  /** 모델 한 번 — 실패해도 던지지 않는 값. 호출 기록(ai_calls)을 모아 둠 */
  async call<T>(point: PointId, vars: Record<string, unknown>): Promise<LlmResult<T>> {
    const rem = this.remaining();
    const r = await callPoint<T>(this.deps.llm, point, vars, {
      model: this.deps.model,
      timeoutMs: Math.max(1, Math.min(POINTS[point].timeoutMs, rem)),
      deadlineMs: Math.max(1, rem),
      sleep: this.deps.sleep,
      now: this.deps.clock,
    });
    const fillIo = (this.deps.ioUserIds ?? []).includes(this.deps.userId);
    this.logs.push({
      call: r.call,
      io: fillIo ? { input: render(POINTS[point].prompt.user, vars).trimEnd(), output: r.ok ? r.data : null, error: r.ok ? null : r.reason } : null,
    });
    return r;
  }

  /** 이 호출 기록에 규칙 걸림(flags)을 적음 */
  flag(r: LlmResult, flags: string[]): void {
    const log = this.logs.find((l) => l.call === r.call);
    if (log) log.call.flags = flags;
  }
}

const emptyEvent = (afterTurn: number): ServerEvent => ({ after_turn: afterTurn, applied: [], pending: [], rejected: [], clarify: [], alarms: [] });

// 순수 함수가 앱이 보낸 값이 이상하다고 {ok:false, reason}을 돌려주면 VALIDATION_FAILED로 (PR 3 리뷰 #261). 진입점(voice-requests)이 먼저 모양을 검사해 보통 여기까지 안 옴
function accepted<T>(res: T | Rejected): T {
  if ((res as Rejected).ok === false) {
    const reason = (res as Rejected).reason;
    throw new HttpError('VALIDATION_FAILED', '앱이 보낸 값을 쓸 수 없어요', { issues: [{ path: 'body', message: reason }] });
  }
  return res as T;
}

// ───────── 화면 만들기 ─────────

function screenFast(st: ServerState, nowIso: string, stored: StoredTurn[]): Record<string, unknown> {
  // 기본 화면: 확인할 기록 줄 없음 · 24시간 · "서버 처리 결과 없음" (06-서버지침.md 37번)
  const ctx = ctxOf(st, nowIso, []);
  return { ...contextVars(ctx), transcript: viewTranscript(turnsOf(stored), { userName: ctx.user.name }) };
}

function screenT1(st: ServerState, nowIso: string, stored: StoredTurn[], events: ServerEvent[]): { vars: Record<string, unknown>; ctx: Context } {
  // T1 화면: 확인할 기록 줄 + 시각을 말로 + 서버 처리 결과
  const ctx = ctxOf(st, nowIso, events);
  return { ctx, vars: { ...contextVars(ctx, { confirmFacts: st.confirm, spokenTimes: true }), transcript: viewTranscript(turnsOf(stored), { userName: ctx.user.name }) } };
}

// ───────── T1 답 + 가드 ─────────

type T1Done = { ok: true; line: Omit<StoredTurn, 'n' | 'at'> } | { ok: false; fail: LlmFailure };

async function t1Reply(
  run: Run, st: ServerState, ts: TurnState, stored: StoredTurn[], j: number, trigger: string, preview: LlmResult<T1Output> | null,
): Promise<T1Done> {
  const visible = eventsForView(ts.events, ts);
  const { ctx, vars } = screenT1(st, run.nowIso, stored, visible);
  const turns = turnsOf(stored);
  const cardSummaries = [...ts.events.flatMap((e) => e.pending.map((p) => p.summary)), ...ts.cards.map((c) => c.summary)];
  const view = (retried: boolean) => ({ ctx, eventsVisible: visible, numberEvents: ts.events, turnsBefore: turns, safety: safetyInfoFrom(ts.events, j), cardSummaries, retried });

  let res: LlmResult<T1Output> = preview !== null && preview.ok ? preview : await run.call<T1Output>('T1', vars);
  if (!res.ok) return { ok: false, fail: res };
  let g = applyGuards({ reply: res.data.reply, acts: res.data.acts, end: res.data.end }, view(false));
  let source: NonNullable<StoredTurn['source']> = 't1';
  const redone = g.redo;
  if (g.redo) {
    // 다시 부르기는 턴당 1번, 마감까지 7초 넘게 남았을 때만. 다시 못 부르면(또는 실패) 첫 답에서 문장을 지우거나 템플릿으로
    run.flag(res, g.flags);
    if (run.remaining() > REGEN_MIN_REMAINING_MS) {
      const again = await run.call<T1Output>('T1', vars);
      if (again.ok) {
        res = again;
        source = 't1_regen';
      }
    } else {
      source = 't1_regen';
    }
    if (res.ok) g = applyGuards({ reply: res.data.reply, acts: res.data.acts, end: res.data.end }, view(true));
  }
  if (g.actions.includes('template')) source = 'fallback';
  run.flag(res, g.flags);
  return { ok: true, line: { role: 'ai', after_turn: j, source, trigger, text: g.reply, acts: g.acts, end: g.end, flags: g.flags, guard: redone && !g.actions.includes('regen') ? ['regen', ...g.actions] : g.actions } };
}

// ───────── 응답 만들기 ─────────

function outOf(st: ServerState, line: StoredTurn | null, fixes: (Fix | PublicFix)[], limits: TurnLimits, tasks: boolean): VoiceTurnOut {
  return {
    rev: st.rev,
    turn_seq: st.counts.user_turns,
    next: tasks ? 'APP_TASKS' : 'USER',
    reply: line === null ? null : { text: line.text, acts: line.acts ?? [], end: line.end ?? false },
    cards: st.cards.map((c) => publicCard(c, st.refs)),
    fixes: fixes.map((f) => publicFix(f as Fix, st.refs)),
    limits,
  };
}

function unavailable(fail: LlmFailure, details: object): HttpError {
  if (fail.code === 'NOT_CONFIGURED') return new HttpError('NOT_CONFIGURED', fail.message, details);
  const base = toHttpError(fail); // 공급자 원문은 서버 로그에만 (코드 · 요청 번호만 응답에)
  return new HttpError('LLM_UNAVAILABLE', base.message, { ...(base.details as object), ...details });
}

// ───────── 한 요청의 결말 ─────────

interface Outcome {
  ts: TurnState;
  stored: StoredTurn[]; // 이번 요청에서 늘린 줄까지(AI 답 전)
  userTurns: number;
  j: number; // 이 요청이 답하는 사용자 말 번호
  trigger: string; // text · results · card:c1
  fixes: Fix[]; // 앱이 해야 할 정정 (APP_TASKS)
  needReply: boolean;
  preview: LlmResult<T1Output> | null;
  /** 이미 있는 owed를 푸는 요청인지 */
  owed?: boolean;
}

async function conclude(run: Run, row: SessionRow, st: ServerState, o: Outcome, ctid: string, limitsFor: (s: ServerState) => Promise<TurnLimits>): Promise<VoiceTurnOut> {
  const { deps } = run;
  const sessionDeps = { userId: deps.userId, userDb: deps.userDb, service: deps.service };
  let next = withTurnState(st, o.ts, ctid);
  next.counts.user_turns = o.userTurns;
  next.rev = st.rev + 1;

  let line: StoredTurn | null = null;
  let failure: LlmFailure | null = null;
  const stored = o.stored;
  if (o.needReply) {
    const r = await t1Reply(run, st, o.ts, stored, o.j, o.trigger, o.preview);
    if (r.ok) line = { n: stored.length, at: run.nowIso, ...r.line };
    else failure = r.fail;
  }
  next.counts.llm_calls += run.logs.length;
  const turns = line === null ? stored : [...stored, line];
  if (line !== null) {
    next.replies[ctid] = line.n;
    next.owed = null;
    if (next.question !== null && next.question.asked_at === null && (line.acts ?? []).some((a) => a.type === 'SERVER_Q')) next.question.asked_at = run.nowIso;
  } else if (failure !== null) {
    next.owed = { client_turn_id: ctid, after_turn: o.j, trigger: o.trigger };
  } else if (o.ts.awaiting === null) {
    next.replies[ctid] = null; // 답 없이 처리를 마친 요청(카드 거절 · 바뀐 것 없는 results)
    next.owed = null;
  }

  // 호출 기록 먼저 — 아래 저장이 CONFLICT여도 쓴 호출은 남음
  await recordCalls(sessionDeps, row.session_id, run.logs, run.nowIso);
  await saveSession(sessionDeps, row.session_id, st.rev, { turns, state: next });
  if (line !== null && next.question !== null && next.question.asked_at === run.nowIso && st.question?.asked_at === null) {
    try {
      await recordQuestion(sessionDeps, { sessionId: row.session_id, kind: next.question.kind, subjectKey: next.question.subject_key, askedAt: run.nowIso });
    } catch (e) {
      console.error('[user_questions] 기록 실패:', e); // 답은 이미 나갔음 — 예산 셈에서만 빠짐
    }
  }

  const limits = await limitsFor(next);
  const out = outOf(next, line, o.ts.awaiting === null ? [] : o.fixes, limits, o.ts.awaiting !== null);
  if (failure !== null) {
    throw unavailable(failure, { cards: out.cards, fixes: o.fixes.map((f) => publicFix(f, next.refs)), rev: next.rev, turn_seq: next.counts.user_turns, limits });
  }
  return out;
}

// ───────── 요청 처리 ─────────

export async function handleVoiceTurn(deps: VoiceDeps, body: unknown): Promise<VoiceTurnOut> {
  const req = readTurnRequest(body);
  const run = new Run(deps);
  const sessionDeps = { userId: deps.userId, userDb: deps.userDb, service: deps.service };
  const row = await loadSession(sessionDeps, req.session_id);
  const st = row.server_state;
  const ctid = req.client_turn_id;
  const calToday = startOf(seoulLocal(run.nowIso).date);

  const limitsFor = async (s: ServerState, reached: TurnLimits['reached'] = null): Promise<TurnLimits> => limitsOf(s, await countSessionsSince(sessionDeps, calToday), reached);

  // 1) 같은 요청이 다시 옴 — 저장한 답을 그대로 (rev는 안 봄: 첫 시도가 이미 rev를 올렸을 수 있음)
  if (Object.hasOwn(st.replies, ctid)) {
    const n = st.replies[ctid];
    const line = n === null || n === undefined ? null : row.turns[n] ?? null;
    return outOf(st, line, [], await limitsFor(st), false);
  }
  if (req.kind === 'text' && st.awaiting !== null && st.awaiting.client_turn_id === ctid) {
    const ts = toTurnState(st);
    return outOf(st, null, ts.fixes.filter((f) => f.status === 'SENT'), await limitsFor(st), true);
  }
  const owed = st.owed !== null && st.owed.client_turn_id === ctid ? st.owed : null;
  if (owed === null && req.rev !== st.rev) throw new HttpError('CONFLICT', '대화가 다른 곳에서 바뀌었어요. 다시 불러와 주세요');
  if (st.ended && req.kind !== 'card') throw new HttpError('CONFLICT', '이미 끝난 대화예요');

  // 2) 답이 밀린 요청(상태는 저장했는데 T1이 실패했음) — T1만 다시
  if (owed !== null) {
    const ts = toTurnState(st);
    return conclude(run, row, st, { ts, stored: row.turns, userTurns: st.counts.user_turns, j: owed.after_turn, trigger: owed.trigger, fixes: [], needReply: !st.ended || !owed.trigger.startsWith('card:'), preview: null, owed: true }, ctid, limitsFor);
  }

  if (req.kind === 'text') return handleText(run, row, st, req, limitsFor);
  if (req.kind === 'results') return handleResults(run, row, st, req.results, ctid, limitsFor);
  return handleCard(run, row, st, req.card_action, ctid, limitsFor);
}

type LimitsFor = (s: ServerState, reached?: TurnLimits['reached']) => Promise<TurnLimits>;

async function handleText(run: Run, row: SessionRow, st: ServerState, req: Extract<TurnRequest, { kind: 'text' }>, limitsFor: LimitsFor): Promise<VoiceTurnOut> {
  const { deps } = run;
  const sessionDeps = { userId: deps.userId, userDb: deps.userDb, service: deps.service };
  if (deps.llm === null) throw new HttpError('NOT_CONFIGURED', 'AI가 아직 준비되지 않았어요'); // 말을 쌓지 않고 거절 — 키가 생긴 뒤 같은 요청을 다시 보내면 됨
  // 상한: 대화당 사용자 말 20 · 하루 AI 호출 300 — LLM을 안 부르고 템플릿 한 줄(저장도 안 함: 말이 쌓이지 않음)
  const calToday = startOf(seoulLocal(run.nowIso).date);
  const capped = st.counts.user_turns >= MAX_USER_TURNS ? 'TURN' : callsCapReached(await countCallsSince(sessionDeps, calToday)) ? 'DAY' : null;
  if (capped !== null) {
    const text = capped === 'TURN' ? LIMIT_TURN_TEXT : LIMIT_DAY_TEXT;
    return outOf(st, { n: row.turns.length, role: 'ai', text, at: run.nowIso, acts: [], end: false }, [], await limitsFor(st, capped), false);
  }

  const j = st.counts.user_turns + 1;
  const userLine: StoredTurn = { n: row.turns.length, role: 'user', text: req.text, at: run.nowIso, client_turn_id: req.client_turn_id };
  const stored = [...row.turns, userLine];
  const ts0 = toTurnState(st);
  const ctx = ctxOf(st, run.nowIso, []);

  // T2F ∥ T1 미리 — 둘 다 같은 시각에 시작 (T1 미리 화면 = T1 화면 + "사용자 말 j 뒤: 바뀐 것 없음")
  const previewEvents = [...eventsForView(ts0.events, ts0), emptyEvent(j)];
  const [fastRes, preview] = await Promise.all([
    run.call<FastExtract>('T2F', screenFast(st, run.nowIso, stored)),
    run.call<T1Output>('T1', screenT1(st, run.nowIso, stored, previewEvents).vars),
  ]);

  let ts: TurnState = ts0;
  let tasks = false;
  let fixes: Fix[] = [];
  if (fastRes.ok) {
    const fr = applyFast(ts0, fastRes.data, ctx, j);
    ts = fr.state;
    tasks = fr.tasks;
    fixes = fr.fixes;
  } else {
    // T2F가 5초 안에 못 오거나 실패 — 그 턴은 처리 결과 없음 (다음 턴 T2F가 현재 상태를 따라잡음)
    ts = structuredClone(ts0);
    ts.events = [...ts.events.filter((e) => e.after_turn !== j), emptyEvent(j)];
  }
  const noNeed = needKinds(eventAt(ts.events, j)).length === 0;
  return conclude(
    run, row, st,
    { ts, stored, userTurns: j, j, trigger: 'text', fixes, needReply: !tasks, preview: tasks ? null : noNeed ? preview : null },
    req.client_turn_id, limitsFor,
  );
}

async function handleResults(run: Run, row: SessionRow, st: ServerState, results: TaskResults, ctid: string, limitsFor: LimitsFor): Promise<VoiceTurnOut> {
  // 기다리던 앱 일이 있으면 그 말 번호로, 없으면(장소 고르기 뒤 results만) 가장 최근 사용자 말 번호로
  const j = st.awaiting?.after_turn ?? st.counts.user_turns;
  if (j < 1) throw new HttpError('VALIDATION_FAILED', '말이 없는 대화에는 결과를 보낼 수 없어요');
  const ts0 = toTurnState(st);
  const out = accepted(applyTaskResults(ts0, results, ctxOf(st, run.nowIso, []), j));
  if (out.unknown.length > 0) throw new HttpError('NOT_FOUND', '모르는 카드나 정정 번호예요', { ids: out.unknown });
  const changed = out.cards.length + out.fixes.length > 0;
  const waiting = out.state.awaiting !== null;
  return conclude(
    run, row, st,
    { ts: out.state, stored: row.turns, userTurns: st.counts.user_turns, j, trigger: 'results', fixes: out.state.fixes.filter((f) => f.status === 'SENT'), needReply: changed && !waiting, preview: null },
    ctid, limitsFor,
  );
}

async function handleCard(run: Run, row: SessionRow, st: ServerState, action: CardAction, ctid: string, limitsFor: LimitsFor): Promise<VoiceTurnOut> {
  const j = st.counts.user_turns;
  const ts0 = toTurnState(st);
  const out = accepted(applyCardAction(ts0, action, ctxOf(st, run.nowIso, []), j));
  if (out.status === 'NOT_FOUND') throw new HttpError('NOT_FOUND', '카드를 찾을 수 없어요');
  if (out.status === 'NOOP') return outOf(st, null, [], await limitsFor(st), false); // 이미 끝난 카드 · 저장 없는 카드 — 바뀐 것 없음
  return conclude(
    run, row, st,
    { ts: out.state, stored: row.turns, userTurns: st.counts.user_turns, j, trigger: `card:${action.id}`, fixes: [], needReply: out.needsReply && !st.ended, preview: null },
    ctid, limitsFor,
  );
}

