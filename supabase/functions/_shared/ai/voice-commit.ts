// voice-commit — 대화 정리 (서버 PR 5, docs/screen-data-map.md 'voice-commit'). 앱 [완료] 뒤 부름. 글 · 실시간 음성(Live) 차례는 같은 세션 turns에 쌓이므로 처리는 하나.
//   세션을 끝내지 않음 — 같은 날 다시 열면 같은 대화에 이어 말하고, 다음 [완료]가 그때까지의 대화 전체로 다시 정리함 (commit.at_turn보다 말이 늘었을 때만)
//   다시 정리해도 겹치지 않음: 할 일은 같은 대화가 만든 것을 건너뜀(isDuplicateTodo) · 생활 기록은 빈 칸만 · 일정 · 알람은 카드 몫(여기서 안 만듦) · 일기는 고친 것(is_edited)을 안 덮음
//   1) 차지하기: server_state.rev 비교-교체로 commit = RUNNING (같은 요청이 겹치면 하나만 진행, 나머지는 RUNNING을 돌려받음). 그 사이 온 말은 이번 정리에 안 들어가고 STALE로 알림
//      앱이 [저장 안 함]을 눌렀는데 voice-turn으로 못 알린 카드(rejected_cards)도 같은 저장에서 카드 버튼 규칙(applyCardAction)으로 REJECTED — 열린 카드만, 모르는 · 끝난 카드는 그대로
//   2) 추출: 대화 전체로 T2 한 번(extract.v2, 모델 출력은 callLlm이 스키마로 검사). 결과는 바로 server_state.commit.extract에 — 저장이 실패해 다시 시도해도 T2를 또 부르지 않음
//   3) 나누기: applyFinal(final-core) — 공개 JSON(structured.v1) 초안 + 저장할 것. 일정 · 알람은 저장하지 않고(카드 몫) 확인 상태만
//   4) 저장: 할 일(todos) · 생활 기록 진술 칸(daily_records의 빈 칸)만 — 단계마다 따로, 다시 해도 같은 결과(겹침 검사 · 빈 칸만 채움)
//      지각 · 출발 · 도착(appointment_participants)과 알람 반응(alarm_events)은 위치 · 원탭 · 알람 담당 칸이라 쓰지 않음 — JSON에만
//      공개 JSON 저장이 끝나면 하루 일기(daily_journals.ai_summary): 그날 대화들의 JSON으로 T5 한 번 (saveJournal — 고친 일기는 그대로)
//      사용자 표는 부른 사람의 RLS 클라이언트로 써서 기존 정책을 그대로 탐. conversation_sessions(transcript · extracted_data · apply_status)와 server_state는 서버 키(session.ts와 같음)
//      공개 JSON은 저장 결과(storage · todos[].stored)까지 담아 structured.v1 검사를 통과해야 저장
//   5) 끝: commit = DONE | PARTIAL(실패한 단계 있음 → 같은 요청을 다시 보내면 이어서). 이미 DONE이고 그 뒤 말이 없으면 저장한 결과를 그대로 돌려줌
// 이 파일은 Deno API를 안 써서 node --test로 돈다.
import { must } from '../db.ts';
import { HttpError } from '../errors.ts';
import { callPoint, POINTS } from '../prompts/index.ts';
import { Reader } from '../read.ts';
import type { Db } from '../supabase.ts';
import { seoulIso } from './context.ts';
import { dbMs } from './context-core.ts';
import { applyFinal, dropUnaskedPrep, dropUnstatedScores, finishStructured, isDuplicateTodo, recordDateInRange, type FinalPlan, type Structured, type TodoPlan } from './final-core.ts';
import { structuredProblems } from './structured.v1.ts';
import { toHttpError, type LlmClient } from './llm.ts';
import type { QuotaGate } from './quota.ts';
import { render } from './render.ts';
import { loadSession, recordCalls, saveSession, type CommitState, type ServerState, type SessionDeps, type SessionRow } from './session.ts';
import { applyCardAction } from './turn-core.ts';
import type { FinalExtract } from './types.ts';
import { addDays, contextVars, spokenTime, viewTranscript } from './view.ts';
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
  /**
   * DONE 끝 · PARTIAL 일부 저장 실패(다시 보내면 이어서) · RUNNING 다른 요청이 처리 중 · SKIPPED 사용자 말이 없어 정리할 것 없음
   * STALE 정리하는 사이 새 말이 들어옴 — 그 앞까지는 저장했고, 다시 보내면 새 말까지 정리 (앱은 DONE · SKIPPED가 아니면 다시 보낼 목록에 남김)
   */
  status: 'DONE' | 'PARTIAL' | 'RUNNING' | 'SKIPPED' | 'STALE';
  /** todos 새로 넣은 수 · daily_records 칸을 채운 날짜 수 · daily_journals 일기를 쓴 수(0 · 1) */
  saved: { todos: number; daily_records: number; daily_journals: number };
  /** 확인이 필요해 저장하지 않은 것 (일정 · 알람 · 준비시간 · 날짜 모름 · 엇갈린 진술 · 어느 일정인지 모르는 지각) — 모두 extracted_data에는 남음 */
  pending: string[];
  /** 실패한 저장 단계 이름 */
  failed: string[];
}

const NOTHING: VoiceCommitOut['saved'] = { todos: 0, daily_records: 0, daily_journals: 0 };
const outOf = (sessionId: string, status: VoiceCommitOut['status']): VoiceCommitOut => ({ session_id: sessionId, status, saved: { ...NOTHING }, pending: [], failed: [] });

/** 이 정리 뒤에 사용자 말이 늘었는지 — at_turn이 없는 예전 정리는 세션을 끝냈으므로 늘 수 없음 */
const behind = (c: CommitState, row: SessionRow): boolean => c.at_turn !== undefined && c.at_turn < row.server_state.counts.user_turns;

/** 이미 끝났거나(그 뒤 새 말 없음) 다른 요청이 처리 중이면 그 답 — 아니면 null(이번 요청이 처리) */
function settled(row: SessionRow, nowMs: number): VoiceCommitOut | null {
  const c = row.server_state.commit;
  if (c?.status === 'DONE' && !behind(c, row)) return c.out as VoiceCommitOut;
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

/** 할 일 · 준비물 — 이미 있는 것(같은 키 + 같은 약속 · 날짜, 이 대화가 만든 것)은 건너뜀. 계획 순서대로 결과. voice-turn도 대화 중 준비물에 씀 */
export async function saveTodos(db: Db, userId: string, sessionId: string, todos: TodoPlan[]): Promise<TodoResult[]> {
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

/**
 * 하루 일기에 넣을 사실 — 그날(date) 대화들의 structured.v1에서 사용자가 말했거나 확인한 것(inferred 뺌) · 기록된 행동(needs_confirm 뺌) · 날짜가 그날인 것만.
 * 저장된 일정(plans — 카드 [저장]한 것만, 시각이 애매하면 시각 없이) · 저장된 준비물 · 할 일(todos)도 넣음(D31 A): 일정만 저장한 날도 일기가 생김.
 * 날짜는 서버가 '오늘 · 내일'로 바꿔 넣음(모델이 날짜를 세지 않게), 시각은 '오전 10시' 말씨로.
 * 사건 · 기분 · 행동 · 수면 · 일정 결과 · 일정 · 할 일이 하나도 없으면 null (일기를 만들지 않음 — 습관 · 목표만으로는 쓰지 않음)
 */
export function journalFacts(list: Structured[], date: string): JournalFacts | null {
  const told = (x: { source: string }): boolean => x.source !== 'inferred';
  // 위험 판정(other.safety_flag) 대화는 어떤 칸도 일기 입력에 넣지 않음
  const day = list.filter((s) => s.session.reference_date === date && !s.other.safety_flag);
  const events = day.flatMap((s) => s.day_review.events.filter(told).map(({ text, time }) => ({ text, time })));
  // memorable은 출처 칸이 없음 — 같은 대화의 말한 · 확인한 사건 글과 같을 때만 (짐작한 사건이 memorable로 들어오는 것을 막음)
  const flat = (t: string): string => t.replace(/\s+/g, '');
  const memorable = day.flatMap((s) => {
    const m = s.day_review.memorable;
    return m && s.day_review.events.some((e) => told(e) && flat(e.text) === flat(m)) ? [m] : [];
  });
  const mood = day
    .map((s) => s.mood_condition)
    .filter((m) => told(m) && (m.mood.length > 0 || m.fatigue !== null || m.stress !== null || m.condition_note !== null))
    .map(({ mood, fatigue, stress, causes, condition_note }) => ({ mood, fatigue, stress, causes, condition_note }));
  const behavior = day.flatMap((s) =>
    s.behavior.filter((b) => b.status === 'recorded' && told(b) && b.date === date).map((b) => ({ kind: b.kind, time: b.time, minutes: b.minutes, appointment: b.appointment?.title ?? null, reasons: b.reasons, note: b.note })),
  );
  const sleep_wake = day.flatMap((s) =>
    s.sleep_wake.filter((w) => told(w) && w.date === date).map(({ sleep_at, wake_at, wake_delay_minutes, overslept, sleep_satisfaction }) => ({ sleep_at, wake_at, wake_delay_minutes, overslept, sleep_satisfaction })),
  );
  const schedule_outcomes = day.flatMap((s) =>
    s.schedule_outcomes.filter((o) => o.status === 'recorded' && told(o) && o.date === date).map(({ appointment_title, is_late, late_minutes, causes }) => ({ appointment_title, is_late, late_minutes, causes })),
  );
  const habits = day.flatMap((s) => s.habit_signals.filter((h) => told(h) && h.date === date).map(({ habit, note }) => ({ habit, note })));
  const goals = day.flatMap((s) => s.goals_routine.goals.filter(told).map((g) => g.goal_text));
  // D31 A — 실제로 저장된 것만: 일정은 카드 [저장](saved), 할 일 · 준비물은 넣었거나(inserted) 이미 있던 것(duplicate). 여러 대화에 같은 것이 나오면 한 번만
  const plans = uniq(
    day.flatMap((s) => s.appointments.filter((a) => told(a) && a.status === 'saved').map((a) => ({ title: a.title, day: dayLabel(a.date, date), time: a.time && !a.unclear ? spokenOf(a.time) : null }))),
    (p) => `${p.title.replace(/\s+/g, '')}|${p.day}|${p.time}`,
  );
  const todos = uniq(
    day.flatMap((s) =>
      s.todos
        .filter((t) => told(t) && (t.stored === 'inserted' || t.stored === 'duplicate'))
        .map((t) => ({ title: t.title, kind: t.type === 'ITEM' ? ('준비물' as const) : ('할 일' as const), day: dayLabel(t.due_date, date), for_plan: t.appointment_title })),
    ),
    (t) => `${t.title.replace(/\s+/g, '')}|${t.kind}|${t.day}`,
  );
  if (events.length + memorable.length + mood.length + behavior.length + sleep_wake.length + schedule_outcomes.length + plans.length + todos.length === 0) return null;
  return { events, memorable, mood, behavior, sleep_wake, schedule_outcomes, habits, goals, plans, todos };
}

export interface JournalFacts {
  events: { text: string; time: string | null }[];
  memorable: string[];
  mood: { mood: string[]; fatigue: number | null; stress: number | null; causes: string[]; condition_note: string | null }[];
  behavior: unknown[];
  sleep_wake: unknown[];
  schedule_outcomes: unknown[];
  habits: unknown[];
  goals: string[];
  plans: { title: string; day: string | null; time: string | null }[];
  todos: { title: string; kind: '준비물' | '할 일'; day: string | null; for_plan: string | null }[];
}

/** 같은 키는 처음 것만 */
function uniq<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(key(x)) && !!seen.add(key(x)));
}

/** 일기 날짜 기준 '오늘 · 내일 · 모레' — 그 밖은 날짜 그대로, 모르면 null */
function dayLabel(d: string | null, date: string): string | null {
  if (d === null) return null;
  return { [date]: '오늘', [addDays(date, 1)]: '내일', [addDays(date, 2)]: '모레' }[d] ?? d;
}
const spokenOf = (hhmm: string): string => spokenTime(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)));

const MOOD_KO: Record<string, [string, string]> = {
  good: ['좋고', '좋은'], calm: ['차분하고', '차분한'], tired: ['피곤하고', '피곤한'], stressed: ['스트레스가 많고', '스트레스가 많은'],
  anxious: ['불안하고', '불안한'], sad: ['슬프고', '슬픈'], angry: ['화가 나고', '화가 난'], mixed: ['마음이 복잡하고', '마음이 복잡한'],
};
/** 받침이 있으면 a, 없으면 b (한글이 아니면 a) */
const josa = (w: string, a: string, b: string): string => {
  const c = w.charCodeAt(w.length - 1) - 0xac00;
  return c >= 0 && c < 11172 && c % 28 === 0 ? b : a;
};

/**
 * T5가 쓸 사실이 있는데 빈 글을 줬을 때의 대체 일기 — 사실 목록의 값만 이어 붙임(지어내지 않음).
 * 오늘 기분 · 사건 → 일정 → 준비물 · 할 일 순, 두세 문장.
 */
export function fallbackDiary(f: JournalFacts): string {
  const out: string[] = [];
  const moods = [...new Set(f.mood.flatMap((m) => m.mood))].filter((m) => MOOD_KO[m]);
  if (moods.length > 0) out.push(`오늘은 ${moods.map((m, i) => (MOOD_KO[m] as [string, string])[i === moods.length - 1 ? 1 : 0]).join(' ')} 하루였다.`);
  if (f.events.length > 0) out.push(`${f.events.map((e) => e.text).join(', ')}.`);
  for (const p of f.plans.slice(0, 2)) out.push(`${[p.day, p.time && `${p.time}에`].filter(Boolean).join(' ')} ${p.title}${josa(p.title, '이', '가')} 예정되어 있다.`.trimStart());
  const items = f.todos.filter((t) => t.kind === '준비물').map((t) => t.title);
  const tasks = f.todos.filter((t) => t.kind === '할 일').map((t) => t.title);
  if (items.length > 0) out.push(`${items.join(', ')}${josa(items[items.length - 1] as string, '을', '를')} 챙기기로 했다.`);
  if (tasks.length > 0) out.push(`${tasks.join(', ')}${josa(tasks[tasks.length - 1] as string, '을', '를')} 하기로 했다.`);
  return out.join(' ');
}

/**
 * daily_journals — 그날 대화 전부(같은 reference_date)의 structured.v1로 T5 일기 1~2문장을 만들어 ai_summary에 (하루 한 줄, source_session_id = 이번 대화).
 * 사용자가 고친 일기(is_edited)는 건드리지 않음 · 이번 추출(extractedAt) 뒤에 이 대화로 이미 만든 일기는 다시 만들지 않음(다시 시도) · 쓸 사실이 없거나 모델이 빈 글을 주면 쓰지 않음.
 * 같은 대화에 말이 늘어 다시 추출했으면 그 전에 만든 이 대화의 일기는 새 말을 모르므로 다시 씀.
 * 모델 실패는 던짐 → 이 단계만 실패(PARTIAL, 다음 대화 열기 때 다시) — 앞 단계 저장 결과는 그대로
 */
async function saveJournal(deps: CommitDeps, sessionId: string, date: string, nowIso: string, extractedAt: string | null): Promise<number> {
  const db = deps.userDb;
  const cur = must<{ journal_id: string; is_edited: boolean; source_session_id: string | null; ai_summary: string | null; generated_at: string | null } | null>(
    'daily_journals',
    await db.from('daily_journals').select('journal_id, is_edited, source_session_id, ai_summary, generated_at').eq('user_id', deps.userId).eq('record_date', date).maybeSingle(),
  );
  // extractedAt 없음 = 예전 정리 — 이 대화의 일기가 있으면 그대로
  const upToDate = cur?.source_session_id === sessionId && !!cur.ai_summary && (extractedAt === null || (cur.generated_at !== null && dbMs(cur.generated_at) >= Date.parse(extractedAt)));
  if (cur?.is_edited || upToDate) return 0;
  const sessions = must<{ extracted_data: Structured }[]>(
    'conversation_sessions',
    await deps.service.from('conversation_sessions').select('extracted_data').eq('user_id', deps.userId).eq('extracted_data->session->>reference_date', date).order('started_at', { ascending: true }),
  ) ?? [];
  const facts = journalFacts(sessions.map((s) => s.extracted_data).filter((d) => d?.schema_version === 'structured.v1'), date);
  if (facts === null) return 0;
  const vars = { date_line: date, facts: JSON.stringify(facts, null, 2) };
  const res = await callPoint<{ diary: string }>(deps.llm, 'T5', vars, { model: deps.model, sleep: deps.sleep, now: deps.clock, gate: deps.quota ?? undefined });
  const fillIo = (deps.ioUserIds ?? []).includes(deps.userId);
  await recordCalls(deps, sessionId, [{ call: res.call, io: fillIo ? { input: render(POINTS.T5.prompt.user, vars).trimEnd(), output: res.ok ? res.data : null, error: res.ok ? null : res.reason } : null }], nowIso);
  if (!res.ok) throw new Error(`T5 실패: ${res.code}`);
  let diary = res.data.diary.trim();
  if (diary === '') {
    // 쓸 사실이 있는데 빈 글 — 예전엔 0을 돌려 DONE인데 일기가 없었음. 사실 값만으로 만든 문장으로 저장 (로그엔 개수만, 글은 안 남김)
    diary = fallbackDiary(facts);
    console.warn('[voice-commit] T5 빈 일기 → 대체 문장', { session_id: sessionId, counts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, (v as unknown[]).length])), fallback: diary !== '' });
    if (diary === '') return 0;
  }
  const row = { ai_summary: diary, source_session_id: sessionId, generated_at: nowIso };
  // is_edited = false 조건 — 읽은 뒤 사용자가 고쳤으면 덮지 않음(0줄 → 쓴 수 0)
  if (cur) {
    const updated = must<{ journal_id: string }[]>('daily_journals', await db.from('daily_journals').update(row).eq('journal_id', cur.journal_id).eq('user_id', deps.userId).eq('is_edited', false).select('journal_id'));
    return updated?.length ?? 0;
  }
  must('daily_journals', await db.from('daily_journals').insert({ user_id: deps.userId, record_date: date, ...row }));
  return 1;
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
  return commitRoom(deps, sessionId, rejected, (deps.now ?? (() => new Date()))());
}

/**
 * 대화방 정리 — 같은 방의 앞 구간(prev_session_id, 기준일이 다른 세션)을 먼저 그 구간의 기준일로 정리하고 이 세션을 정리.
 * 앞 구간을 못 끝냈으면 이 세션 결과를 PARTIAL(failed에 previous_session)로 — 앱이 다시 보낼 목록에 남겨 다음에 둘 다 이어서.
 * 카드 번호는 구간을 넘어 그대로라(carryCards) rejected_cards를 앞 구간에도 같이 넘김 (모르는 번호는 건너뜀)
 */
export async function commitRoom(deps: CommitDeps, sessionId: string, rejected: string[], now: Date): Promise<VoiceCommitOut> {
  const sd: SessionDeps = { userId: deps.userId, userDb: deps.userDb, service: deps.service };
  const row = await loadSession(sd, sessionId);
  const prevId = row.server_state.prev_session_id;
  let prevDone = true;
  if (prevId) {
    try {
      const p = await commitRoom(deps, prevId, rejected, now);
      prevDone = p.status === 'DONE' || p.status === 'SKIPPED';
    } catch (e) {
      console.error('[voice-commit] 앞 구간 정리 실패:', e);
      prevDone = false;
    }
  }
  const out = await commitSession(deps, row, rejected, now);
  if (prevDone || out.status === 'RUNNING') return out;
  return { ...out, status: 'PARTIAL', failed: [...out.failed, 'previous_session'] };
}

async function commitSession(deps: CommitDeps, row: SessionRow, rejected: string[], now: Date): Promise<VoiceCommitOut> {
  const sessionId = row.session_id;
  const nowIso = seoulIso(now);
  const sd: SessionDeps = { userId: deps.userId, userDb: deps.userDb, service: deps.service };
  const early = settled(row, now.getTime());
  if (early) return early;
  if (row.server_state.counts.user_turns === 0) return outOf(sessionId, 'SKIPPED'); // 첫 마디만 있는 대화 — 끝내지도 않음(다음에 이어 씀)

  // 1) 차지하기 — 겹친 요청은 rev 비교에서 하나만 이김. 세션은 끝내지 않음(ended · ended_at 그대로) — 같은 날 이어 말할 수 있게
  const st = withRejected(row.server_state, rejected, nowIso);
  const prev = st.commit ?? null;
  const atTurn = st.counts.user_turns; // 이번 정리가 다루는 말 수 — row.turns 그대로 추출하므로 그 뒤 온 말은 다음 정리 몫
  // 앞 시도의 추출은 같은 말까지 뽑은 것일 때만 다시 씀 (at_turn 없는 예전 정리는 끝난 세션이라 말이 늘지 않음)
  const reuse = prev?.extract != null && !behind(prev, row);
  const commit: CommitState = {
    status: 'RUNNING', attempts: (prev?.attempts ?? 0) + 1, started_at: nowIso, finished_at: null, at_turn: atTurn,
    extracted_at: reuse ? prev?.extracted_at ?? null : null, extract: reuse ? prev?.extract ?? null : null, out: null, error: null,
  };
  try {
    await saveSession(sd, sessionId, st.rev, { turns: row.turns, state: { ...st, rev: st.rev + 1, commit } });
  } catch (e) {
    if (!isConflict(e)) throw e;
    const again = settled(await loadSession(sd, sessionId), now.getTime());
    if (again) return again;
    throw e; // 그 사이 말 · 카드가 바뀜 — 앱이 다음 열기 때 다시 보냄
  }

  // 2) 추출 (앞 시도가 같은 말까지 이미 뽑았으면 그대로)
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
    commit.extracted_at = nowIso;
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
  let structuredSaved = false;
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
    structuredSaved = true;
  });
  // 일기는 공개 JSON이 저장된 뒤에만 — 저장 못 했으면 이번엔 만들지 않음(PARTIAL이라 다시 시도 때 만듦)
  // 이번 대화가 위험 판정이면 일기 단계를 건너뜀 — 그 대화로 기존 일기를 다시 쓰지 않음
  if (structuredSaved && !plan.draft.other.safety_flag) await step('daily_journals', async () => void (saved.daily_journals = await saveJournal(deps, sessionId, st.day.review, nowIso, commit.extracted_at ?? null)));

  // 5) 끝 — 저장한 답은 at_turn까지의 결과. 정리하는 사이 새 말이 왔으면 이 요청에는 STALE (저장 상태는 DONE이지만 at_turn이 뒤처져 다음 요청이 다시 정리)
  const out: VoiceCommitOut = { session_id: sessionId, status: failed.length === 0 ? 'DONE' : 'PARTIAL', saved, pending: plan.draft.pending.map((p) => p.text), failed };
  await writeCommit(sd, sessionId, { ...commit, status: out.status === 'DONE' ? 'DONE' : 'PARTIAL', finished_at: nowIso, out, error: failed.length === 0 ? null : failed.join(',') });
  if (out.status === 'DONE' && (await loadSession(sd, sessionId)).server_state.counts.user_turns > atTurn) return { ...out, status: 'STALE' };
  return out;
}
