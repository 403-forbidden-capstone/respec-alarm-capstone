// voice-session — 대화 시작 · 이어 받기 (설계 메모 1 · 2.1 · 4절). LLM을 부르지 않는다(첫 마디는 서버 템플릿, ai_calls 0줄) — 그래서 ANTHROPIC_API_KEY가 없어도 동작한다.
//   1) 문맥 읽기(context.ts, 쿼리 병렬) → 대화 기준일(dayOf) → 2) 오늘 안 끝난 같은 기준일 세션이 있으면 그대로(resume, 하루 대화 수에 안 셈)
//   3) 하루 5대화 · 하루 AI 호출 300 넘으면 세션 없이 limits.reached = DAY → 4) context.v1 한 번 만들어 refs와 함께 server_state에 저장(턴마다 다시 안 읽음 — 별칭 번호가 밀리지 않게)
//   5) 확인할 기록 · 서버 질문 고르기 → 첫 마디 템플릿 → turns[0]
import { MAX_SESSIONS_PER_DAY } from './opening.ts';
import { buildContext } from './context-core.ts';
import { readContextRows, startOf } from './context.ts';
import { openingMessage } from './opening.ts';
import { POINTS } from '../prompts/index.ts';
import {
  callsCapReached, countCallsSince, countSessionsSince, createSession, findOpenSession, limitsOf, recentQuestions, recordQuestion,
  type ServerState, type SessionDeps, type SessionRow, type StoredTurn,
} from './session.ts';
import { initTurnState, pickServerQuestion } from './turn-core.ts';
import type { TurnLimits } from './types.ts';
import { readSessionRequest } from './voice-requests.ts';
import { publicCard, type PublicCard } from './voice-state.ts';
import { SERVER_CONFIRM_OPTS, VIEW_VERSION, pickConfirmFacts } from './view.ts';
import { addDays } from './view.ts';
import { seoulLocal } from './ko.ts';

export interface VoiceSessionDeps extends SessionDeps {
  now?: () => Date;
}

export interface VoiceSessionOut {
  session_id: string | null;
  resumed: boolean;
  rev: number;
  turn_seq: number;
  day: { review: string; morning: string };
  messages: { role: 'ai' | 'user'; text: string; at: string }[];
  cards: PublicCard[];
  limits: TurnLimits;
}

const messagesOf = (turns: StoredTurn[]): VoiceSessionOut['messages'] => turns.map((t) => ({ role: t.role, text: t.text, at: t.at }));

function outOfRow(row: SessionRow, resumed: boolean, sessionsToday: number): VoiceSessionOut {
  const st = row.server_state;
  return {
    session_id: row.session_id,
    resumed,
    rev: st.rev,
    turn_seq: st.counts.user_turns,
    day: { review: st.day.review, morning: st.day.morning },
    messages: messagesOf(row.turns),
    cards: st.cards.map((c) => publicCard(c, st.refs)),
    limits: limitsOf(st, sessionsToday),
  };
}

export async function handleVoiceSession(deps: VoiceSessionDeps, body: unknown): Promise<VoiceSessionOut> {
  const req = readSessionRequest(body);
  const now = (deps.now ?? (() => new Date()))();
  const rows = await readContextRows(deps, now);
  const { nowIso, days } = rows;

  // 이어 받기 — 돌아볼 날 0시 뒤에 시작했고 안 끝난 같은 기준일 세션 (A02를 다시 열어도 대화 유지)
  if (req.resume) {
    const open = await findOpenSession(deps, startOf(days.review), days.review);
    if (open !== null) return outOfRow(open, true, await countSessionsSince(deps, rows.calendarTodayStart));
  }

  // 상한 — 오류가 아니라 limits.reached (설계 메모 0 · 2.1)
  const sessionsToday = await countSessionsSince(deps, rows.calendarTodayStart);
  if (sessionsToday >= MAX_SESSIONS_PER_DAY || callsCapReached(await countCallsSince(deps, rows.calendarTodayStart))) {
    return {
      session_id: null, resumed: false, rev: 0, turn_seq: 0, day: { review: days.review, morning: days.morning },
      messages: [], cards: [], limits: { turns_left: 0, sessions_left_today: 0, reached: 'DAY' },
    };
  }

  // 문맥 한 번 — 확인할 기록 · 서버 질문 고르기 (두 번 만드는 까닭: 질문 · 확인할 기록이 여는 방식(opening)을 정함)
  const recent = await recentQuestions(deps, `${addDays(seoulLocal(nowIso).date, -7)}T00:00:00+09:00`);
  const first = buildContext(rows.input);
  const confirm = pickConfirmFacts(first.context, SERVER_CONFIRM_OPTS);
  const picked = pickServerQuestion(first.context, { askedInConversation: false, recent }, nowIso);
  const built = buildContext({ ...rows.input, question: picked?.question ?? null, confirmFactIds: confirm });
  const opening = openingMessage(built.context, picked?.question ?? null, confirm);

  const { events, cards, fixes, awaiting, ...core } = initTurnState(built.context);
  const state: ServerState = {
    v: 1,
    rev: 1,
    view_version: VIEW_VERSION,
    prompts: { T1: POINTS.T1.prompt.version, T2F: POINTS.T2F.prompt.version, T2: POINTS.T2.prompt.version },
    day: { review: days.review, morning: days.morning, tz: days.tz, tz_supported: days.tzSupported },
    ctx: built.context,
    refs: built.refs,
    confirm,
    core,
    events,
    cards,
    fixes,
    awaiting: awaiting === null ? null : { client_turn_id: '', after_turn: awaiting.after_turn, cards: awaiting.cards, fixes: awaiting.fixes },
    owed: null,
    replies: {},
    question: picked === null
      ? null
      : { id: picked.question.id, kind: picked.question.kind, target: picked.question.target_ref, subject_key: picked.subject_key, asked_at: opening.asksQuestion ? nowIso : null },
    counts: { user_turns: 0, llm_calls: 0 },
    ended: false,
    end_reason: null,
  };
  const turns: StoredTurn[] = [{ n: 0, role: 'ai', text: opening.text, at: nowIso, after_turn: 0, source: 'template', trigger: 'session', acts: opening.acts, end: false, flags: [], guard: [] }];
  const row = await createSession(deps, { startedAt: nowIso, turns, state });

  if (opening.asksQuestion && picked !== null) {
    try {
      await recordQuestion(deps, { sessionId: row.session_id, kind: picked.question.kind, subjectKey: picked.subject_key, askedAt: nowIso });
    } catch (e) {
      console.error('[user_questions] 기록 실패:', e); // 대화는 이미 만들어졌음 — 예산 셈에서만 빠짐
    }
  }
  return outOfRow(row, false, sessionsToday + 1);
}
