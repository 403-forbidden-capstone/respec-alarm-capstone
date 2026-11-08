// voice-commit — 대화 끝 정리 (서버 PR 5, docs/screen-data-map.md 'voice-commit'). 앱 [완료] 뒤 부름. 글 · 실시간 음성(Live) 차례는 같은 세션 turns에 쌓이므로 처리는 하나.
//   1) 차지하기: server_state.rev 비교-교체로 commit = RUNNING · ended = true (같은 요청이 겹치면 하나만 진행, 나머지는 RUNNING을 돌려받음) + ended_at
//      앱이 [저장 안 함]을 눌렀는데 voice-turn으로 못 알린 카드(rejected_cards)도 같은 저장에서 카드 버튼 규칙(applyCardAction)으로 REJECTED — 열린 카드만, 모르는 · 끝난 카드는 그대로
//   2) 추출: 대화 전체로 T2 한 번(extract.v2, 모델 출력은 callLlm이 스키마로 검사). 결과는 바로 server_state.commit.extract에 — 저장이 실패해 다시 시도해도 T2를 또 부르지 않음
//   3) 나누기: applyFinal(final-core) — 공개 JSON(structured.v1) 초안 + 저장할 것. 일정 · 알람은 저장하지 않고(카드 몫) 확인 상태만
//   4) 저장: 할 일(todos) · 생활 기록 진술 칸(daily_records의 빈 칸)만 — 단계마다 따로, 다시 해도 같은 결과(겹침 검사 · 빈 칸만 채움)
//      지각 · 출발 · 도착(appointment_participants)과 알람 반응(alarm_events)은 위치 · 원탭 · 알람 담당 칸이라, 일기(daily_journals.ai_summary)는 일기 담당 칸이라 쓰지 않음 — JSON에만
//      사용자 표는 부른 사람의 RLS 클라이언트로 써서 기존 정책을 그대로 탐. conversation_sessions(transcript · extracted_data · apply_status)와 server_state는 서버 키(session.ts와 같음)
//      공개 JSON은 저장 결과(storage · todos[].stored)까지 담아 structured.v1 검사를 통과해야 저장
//   5) 끝: commit = DONE | PARTIAL(실패한 단계 있음 → 같은 요청을 다시 보내면 이어서). 이미 DONE이면 저장한 결과를 그대로 돌려줌
// 이 파일은 Deno API를 안 써서 node --test로 돈다.
import { must } from '../db.ts';
import { HttpError } from '../errors.ts';
import { callPoint, POINTS } from '../prompts/index.ts';
import { Reader } from '../read.ts';
import type { Db } from '../supabase.ts';
import { seoulIso } from './context.ts';
import { applyFinal, dropUnaskedPrep, dropUnstatedScores, finishStructured, isDuplicateTodo, recordDateInRange, type FinalPlan, type Structured, type TodoPlan } from './final-core.ts';
import { structuredProblems } from './structured.v1.ts';
import { toHttpError, type LlmClient } from './llm.ts';
import type { QuotaGate } from './quota.ts';
import { render } from './render.ts';
import { loadSession, recordCalls, saveSession, type CommitState, type ServerState, type SessionDeps, type SessionRow } from './session.ts';
import { applyCardAction } from './turn-core.ts';
import type { FinalExtract } from './types.ts';
import { contextVars, viewTranscript } from './view.ts';
import { ctxOf, toTurnState, turnsOf, withTurnState } from './voice-state.ts';

/** RUNNING이 이만큼 지나면 앞 요청이 죽은 것으로 보고 다시 시도를 받음 (T2 19초 × 다시 시도 1번 + 저장) */
export const COMMIT_STALE_MS = 90_000;

export interface CommitDeps extends SessionDeps {
  /** null이면 키 없음 → NOT_CONFIGURED */
  llm: LlmClient | null;
  model: string;
  now?: () => Date;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  quota?: QuotaGate | null;
  ioUserIds?: string[];
}

export interface VoiceCommitOut {
  session_id: string;
  /** DONE 끝 · PARTIAL 일부 저장 실패(다시 보내면 이어서) · RUNNING 다른 요청이 처리 중 · SKIPPED 사용자 말이 없어 정리할 것 없음 */
  status: 'DONE' | 'PARTIAL' | 'RUNNING' | 'SKIPPED';
  /** todos 새로 넣은 수 · daily_records 칸을 채운 날짜 수 */
  saved: { todos: number; daily_records: number };
  /** 확인이 필요해 저장하지 않은 것 (일정 · 알람 · 준비시간 · 날짜 모름 · 엇갈린 진술 · 어느 일정인지 모르는 지각) — 모두 extracted_data에는 남음 */
  pending: string[];
  /** 실패한 저장 단계 이름 */
  failed: string[];
}

const NOTHING: VoiceCommitOut['saved'] = { todos: 0, daily_records: 0 };
const outOf = (sessionId: string, status: VoiceCommitOut['status']): VoiceCommitOut => ({ session_id: sessionId, status, saved: { ...NOTHING }, pending: [], failed: [] });

/** 이미 끝났거나 다른 요청이 처리 중이면 그 답 — 아니면 null(이번 요청이 처리) */
function settled(row: SessionRow, nowMs: number): VoiceCommitOut | null {
  const c = row.server_state.commit;
  if (c?.status === 'DONE') return c.out as VoiceCommitOut;
  if (c?.status === 'RUNNING' && nowMs - Date.parse(c.started_at) < COMMIT_STALE_MS) return outOf(row.session_id, 'RUNNING');
  return null;
}

const isConflict = (e: unknown): boolean => e instanceof HttpError && e.code === 'CONFLICT';

/** commit 칸만 바꿔 씀 — 그 사이 카드 동작이 rev를 올렸으면 다시 읽어 최대 3번 */
async function writeCommit(deps: SessionDeps, sessionId: string, commit: CommitState): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const row = await loadSession(deps, sessionId);
    const st = row.server_state;
    try {
      await saveSession(deps, sessionId, st.rev, { turns: row.turns, state: { ...st, rev: st.rev + 1, commit } });
      return;
    } catch (e) {
      if (!isConflict(e)) throw e;
    }
  }
  throw new HttpError('CONFLICT', '대화 정리를 저장하지 못했어요. 잠시 후 다시 시도해 주세요');
}

// ───────── 저장 단계 ─────────

type Storage = Structured['storage'];
type TodoResult = Structured['todos'][number]['stored'];

/** 할 일 · 준비물 — 이미 있는 것(같은 키 + 같은 약속 · 날짜, 이 대화가 만든 것)은 건너뜀. 계획 순서대로 결과 */
async function saveTodos(db: Db, userId: string, sessionId: string, todos: TodoPlan[]): Promise<TodoResult[]> {
  if (todos.length === 0) return [];
  // shortcut: 최근 500개와만 비교 — 할 일이 그보다 많아지면 키로 거르는 쿼리로
  const existing = must<{ title: string; appointment_id: string | null; due_date: string | null; source_session_id: string | null }[]>(
    'todos',
    await db.from('todos').select('title, appointment_id, due_date, source_session_id').eq('user_id', userId).order('created_at', { ascending: false }).limit(500),
  ) ?? [];
  const results: TodoResult[] = todos.map((t) => (isDuplicateTodo(t, existing, sessionId) ? 'duplicate' : 'inserted'));
  const fresh = todos.filter((_, i) => results[i] === 'inserted');
  if (fresh.length > 0) {
    must('todos', await db.from('todos').insert(fresh.map((t) => ({ user_id: userId, appointment_id: t.appointment_id, source_session_id: sessionId, title: t.title, todo_type: t.todo_type, due_date: t.due_date }))));
  }
  return results;
}

/**
 * daily_records — 사용자 진술용 칸(sleep_at · sleep_satisfaction · condition_note)의 빈 칸만 채움. 이미 다른 값이 있으면 덮지 않고 kept_existing (JSON 값과 다를 수 있음을 기록)
 * 새 줄이면 data_source AI. 앱의 기상 확인 · 준비 실측은 같은 날 줄이 있으면(23505) 빈 칸만 채우므로 이 줄과 부딪히지 않음 (realWake.ts · participantTimes.ts)
 */
async function saveRecords(db: Db, userId: string, plan: FinalPlan, review: string, storage: Storage): Promise<number> {
  let written = 0;
  for (const r of plan.records) {
    const cols = Object.keys(r.values);
    if (!recordDateInRange(r.record_date, review)) {
      for (const c of cols) storage.push({ table: 'daily_records', key: r.record_date, column: c, result: 'skipped_out_of_range' });
      continue;
    }
    const cur = must<Record<string, unknown> | null>(
      'daily_records',
      await db.from('daily_records').select('record_id, sleep_at, sleep_satisfaction, condition_note').eq('user_id', userId).eq('record_date', r.record_date).maybeSingle(),
    );
    const patch: Record<string, unknown> = {};
    for (const [c, v] of Object.entries(r.values)) {
      const keep = cur != null && cur[c] != null && !sameValue(cur[c], v);
      if (!keep) patch[c] = v;
      storage.push({ table: 'daily_records', key: r.record_date, column: c, result: keep ? 'kept_existing' : 'written' });
    }
    if (Object.keys(patch).length === 0) continue;
    if (cur) must('daily_records', await db.from('daily_records').update(patch).eq('record_id', cur.record_id as string).eq('user_id', userId));
    else must('daily_records', await db.from('daily_records').insert({ user_id: userId, record_date: r.record_date, data_source: 'AI', ...patch }));
    written += 1;
  }
  return written;
}

/** 같은 값인지 — 시각은 DB가 돌려준 글자 모양(+00:00)과 달라도 같은 순간이면 같음 (다시 시도가 자기가 쓴 값을 kept_existing으로 적지 않게) */
const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(b) && Date.parse(a) === Date.parse(b));

/** 이 대화의 입력 방식 — 사용자 말 바로 뒤 AI 줄이 Live(소리로 한 답)면 음성, 아니면 글 */
function inputModes(row: SessionRow): Structured['session']['input_modes'] {
  const modes = new Set<'text' | 'voice'>();
  row.turns.forEach((t, i) => {
    if (t.role === 'user') modes.add(row.turns[i + 1]?.source === 'live' ? 'voice' : 'text');
  });
  return (['text', 'voice'] as const).filter((m) => modes.has(m));
}

const SESSION_TYPE = { BEFORE_SLEEP: 'night', AFTER_WAKE: 'morning', ANYTIME: 'anytime' } as const;

/** transcript 칸 — 말 단위 turns를 글 한 덩어리로 (음성 차례도 받아쓴 글만) */
const transcriptOf = (row: SessionRow): string => row.turns.map((t) => `${t.role === 'user' ? '사용자' : 'AI'}: ${t.text}`).join('\n');

const CARD_ID = /^c\d{1,4}$/;

/** rejected_cards — 카드 번호(c1 …) 배열, 없으면 빈 배열 */
function readRejected(r: Reader): string[] {
  const v = r.json('rejected_cards');
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50 || !v.every((id) => typeof id === 'string' && CARD_ID.test(id))) {
    r.problemAt('rejected_cards', '카드 번호(c1 …) 배열이어야 해요');
    return [];
  }
  return [...new Set(v as string[])];
}

/** 앱이 거절한 카드를 서버 상태에 반영 — 아직 열린 카드만 REJECTED (저장 · 거절이 끝난 카드 · 모르는 카드는 건너뜀) */
function withRejected(st: ServerState, ids: string[], nowIso: string): ServerState {
  let ts = toTurnState(st);
  let changed = false;
  for (const id of ids) {
    const res = applyCardAction(ts, { id, action: 'REJECTED' }, ctxOf(st, nowIso, []), st.counts.user_turns);
    if (res.ok && res.status === 'OK') {
      ts = res.state;
      changed = true;
    }
  }
  return changed ? withTurnState(st, ts, st.awaiting?.client_turn_id ?? '') : st;
}

// ───────── 요청 처리 ─────────

export async function handleVoiceCommit(deps: CommitDeps, body: unknown): Promise<VoiceCommitOut> {
  const r = Reader.root(body);
  const sessionId = r.uuid('session_id', { required: true }) ?? '';
  const rejected = readRejected(r);
  r.finish();
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = seoulIso(now);
  const sd: SessionDeps = { userId: deps.userId, userDb: deps.userDb, service: deps.service };

  const row = await loadSession(sd, sessionId);
  const early = settled(row, now.getTime());
  if (early) return early;
  if (row.server_state.counts.user_turns === 0) return outOf(sessionId, 'SKIPPED'); // 첫 마디만 있는 대화 — 끝내지도 않음(다음에 이어 씀)

  // 1) 차지하기 — 겹친 요청은 rev 비교에서 하나만 이김
  const st = withRejected(row.server_state, rejected, nowIso);
  const prev = st.commit ?? null;
  const commit: CommitState = { status: 'RUNNING', attempts: (prev?.attempts ?? 0) + 1, started_at: nowIso, finished_at: null, extract: prev?.extract ?? null, out: null, error: null };
  try {
    await saveSession(sd, sessionId, st.rev, { turns: row.turns, state: { ...st, rev: st.rev + 1, ended: true, end_reason: st.end_reason ?? 'USER', commit } });
  } catch (e) {
    if (!isConflict(e)) throw e;
    const again = settled(await loadSession(sd, sessionId), now.getTime());
    if (again) return again;
    throw e;
  }
  must('conversation_sessions', await deps.service.from('conversation_sessions').update({ ended_at: nowIso }).eq('session_id', sessionId).eq('user_id', deps.userId).is('ended_at', null));

  // 2) 추출 (앞 시도가 이미 뽑았으면 그대로)
  let extract = commit.extract;
  if (extract === null) {
    const ctx = ctxOf(st, nowIso, []);
    const vars = { ...contextVars(ctx), transcript: viewTranscript(turnsOf(row.turns), { userName: ctx.user.name }) };
    const res = await callPoint<FinalExtract>(deps.llm, 'T2', vars, { model: deps.model, sleep: deps.sleep, now: deps.clock, gate: deps.quota ?? undefined });
    const fillIo = (deps.ioUserIds ?? []).includes(deps.userId);
    await recordCalls(sd, sessionId, [{ call: res.call, io: fillIo ? { input: render(POINTS.T2.prompt.user, vars).trimEnd(), output: res.ok ? res.data : null, error: res.ok ? null : res.reason } : null }], nowIso);
    if (!res.ok) {
      await writeCommit(sd, sessionId, { ...commit, status: 'FAILED', finished_at: nowIso, error: res.code });
      if (res.code === 'NOT_CONFIGURED') throw new HttpError('NOT_CONFIGURED', res.message);
      const base = toHttpError(res); // 공급자 원문은 서버 로그에만
      throw new HttpError('LLM_UNAVAILABLE', base.message, base.details);
    }
    extract = res.data;
    commit.extract = extract;
    await writeCommit(sd, sessionId, commit);
  }

  // 3) 나누기 4) 저장 — 카드는 그 사이 저장됐을 수 있어 지금 상태로
  const latest = (await loadSession(sd, sessionId)).server_state;
  const userTexts = row.turns.filter((t) => t.role === 'user').map((t) => t.text);
  const plan = applyFinal(dropUnaskedPrep(dropUnstatedScores(extract, userTexts), row.turns), latest.ctx, latest.refs, latest.cards);
  const saved = { ...NOTHING };
  const failed: string[] = [];
  const storage: Storage = [];
  let todoResults: TodoResult[] = plan.todos.map(() => null);
  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      console.error(`[voice-commit] ${name} 저장 실패:`, e);
      failed.push(name);
    }
  };
  await step('todos', async () => {
    todoResults = await saveTodos(deps.userDb, deps.userId, sessionId, plan.todos);
    saved.todos = todoResults.filter((r) => r === 'inserted').length;
  });
  if (failed.includes('todos')) todoResults = plan.todos.map(() => 'failed');
  plan.todos.forEach((t, i) => storage.push({ table: 'todos', key: t.title, column: null, result: todoResults[i] ?? 'failed' }));
  await step('daily_records', async () => void (saved.daily_records = await saveRecords(deps.userDb, deps.userId, plan, st.day.review, storage)));
  if (failed.includes('daily_records')) {
    // 실패한 날짜 · 칸도 결과에 남김 (다시 시도하면 채워짐)
    for (const r of plan.records) {
      if (storage.some((x) => x.table === 'daily_records' && x.key === r.record_date)) continue;
      for (const c of Object.keys(r.values)) storage.push({ table: 'daily_records', key: r.record_date, column: c, result: 'failed' });
    }
  }
  await step('conversation_sessions', async () => {
    const structured = finishStructured(
      plan,
      {
        session_id: sessionId, reference_date: st.day.review, session_type: SESSION_TYPE[row.session_type as keyof typeof SESSION_TYPE] ?? 'anytime', input_modes: inputModes(row),
        started_at: row.started_at, ended_at: nowIso, extracted_at: nowIso, extractor: { prompt: `${POINTS.T2.prompt.id}@${POINTS.T2.prompt.version}`, schema: 'extract.v2' },
      },
      storage,
      todoResults,
    );
    const problems = structuredProblems(structured);
    if (problems.length > 0) throw new Error(`structured.v1 검사 실패: ${problems.slice(0, 5).join(' / ')}`);
    must(
      'conversation_sessions',
      await deps.service
        .from('conversation_sessions')
        .update({ transcript: transcriptOf(row), extracted_data: structured, apply_status: failed.length === 0 ? 'APPLIED' : 'PENDING' })
        .eq('session_id', sessionId)
        .eq('user_id', deps.userId),
    );
  });

  // 5) 끝
  const out: VoiceCommitOut = { session_id: sessionId, status: failed.length === 0 ? 'DONE' : 'PARTIAL', saved, pending: plan.draft.pending.map((p) => p.text), failed };
  await writeCommit(sd, sessionId, { ...commit, status: out.status === 'DONE' ? 'DONE' : 'PARTIAL', finished_at: nowIso, out, error: failed.length === 0 ? null : failed.join(',') });
  return out;
}
