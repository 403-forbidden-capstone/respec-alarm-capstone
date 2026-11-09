// voice-session — 대화 시작 · 이어 받기 (설계 메모 1 · 2.1 · 4절). LLM을 부르지 않는다(첫 마디는 서버 템플릿, ai_calls 0줄) — 그래서 ANTHROPIC_API_KEY가 없어도 동작한다.
//   1) 문맥 읽기(context.ts, 쿼리 병렬) → 대화 기준일(dayOf) → 2) KST 달력 오늘의 대화방(안 끝난 세션)이 있으면 이어 받음(resume — [완료]해도 안 끝남)
//      대화방 = KST 달력 날짜, 기록 = 기준일: 방의 기준일이 지금과 같으면 그대로, 다르면(0시 ~ 기상 전에 연 방을 기상 뒤에 엶) 같은 방의 다음 구간 세션을 만듦
//      (prev_session_id로 이음 — 화면 말 · 카드는 이어지고, 정리 · 일기는 구간마다 제 기준일로)
//   3) 하루 5대화(다음 구간은 같은 방이라 안 셈) · 하루 AI 호출 300 넘으면 세션 없이 limits.reached = DAY → 4) context.v1 한 번 만들어 refs와 함께 server_state에 저장(턴마다 다시 안 읽음 — 별칭 번호가 밀리지 않게)
//   5) 확인할 기록 · 서버 질문 고르기 → 첫 마디 템플릿 → turns[0]
import { MAX_SESSIONS_PER_DAY } from './opening.ts';
import { buildContext } from './context-core.ts';
import { readContextRows } from './context.ts';
import { openingMessage } from './opening.ts';
import { POINTS } from '../prompts/index.ts';
import {
  callsCapReached, countCallsSince, countSessionsSince, createSession, findOpenSession, limitsOf, recentQuestions, recordQuestion,
  roomRows, type ServerState, type SessionDeps, type SessionRow, type StoredTurn,
} from './session.ts';
import { initTurnState, pickServerQuestion } from './turn-core.ts';
import type { Card, TurnLimits } from './types.ts';
import type { RefsOut } from './context-core.ts';
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
  /** 같은 대화방의 앞 구간 세션(기준일이 다름) — 앱이 그 구간에서 저장했지만 서버에 못 알린 카드 표시를 이 세션으로 옮김 (카드 번호는 그대로) */
  prev_session_ids: string[];
}

const messagesOf = (turns: StoredTurn[]): VoiceSessionOut['messages'] => turns.map((t) => ({ role: t.role, text: t.text, at: t.at }));

async function outOfRow(deps: SessionDeps, row: SessionRow, resumed: boolean, sessionsToday: number): Promise<VoiceSessionOut> {
  const st = row.server_state;
  const room = await roomRows(deps, row);
  return {
    session_id: row.session_id,
    resumed,
    rev: st.rev,
    turn_seq: st.counts.user_turns,
    day: { review: st.day.review, morning: st.day.morning },
    messages: messagesOf(room.flatMap((r) => r.turns)), // 같은 방의 앞 구간 말까지
    cards: st.cards.map((c) => publicCard(c, st.refs)),
    limits: limitsOf(st, sessionsToday),
    prev_session_ids: room.slice(0, -1).map((r) => r.session_id),
  };
}

export async function handleVoiceSession(deps: VoiceSessionDeps, body: unknown): Promise<VoiceSessionOut> {
  const req = readSessionRequest(body);
  const now = (deps.now ?? (() => new Date()))();
  const rows = await readContextRows(deps, now);
  const { nowIso, days } = rows;

  // 이어 받기 — KST 달력 오늘 0시 뒤에 연 대화방 ([완료] 뒤 다시 열어도 같은 날이면 같은 대화). 자정이 지나면 새 대화
  //   기준일이 다르면 같은 방의 다음 구간 — 앞 구간에 내 말이 없으면(첫 마디만) 이을 것이 없어 그냥 새 세션
  let prev: SessionRow | null = null;
  if (req.resume) {
    const open = await findOpenSession(deps, rows.calendarTodayStart);
    if (open !== null && open.server_state.day.review === days.review) return outOfRow(deps, open, true, await countSessionsSince(deps, rows.calendarTodayStart));
    if (open !== null && open.server_state.counts.user_turns > 0) prev = open;
  }

  // 상한 — 오류가 아니라 limits.reached (설계 메모 0 · 2.1). 다음 구간은 새 방이 아니라 대화 수 상한을 안 봄 (AI 호출 상한은 봄)
  const sessionsToday = await countSessionsSince(deps, rows.calendarTodayStart);
  if ((prev === null && sessionsToday >= MAX_SESSIONS_PER_DAY) || callsCapReached(await countCallsSince(deps, rows.calendarTodayStart))) {
    return {
      session_id: null, resumed: false, rev: 0, turn_seq: 0, day: { review: days.review, morning: days.morning },
      messages: [], cards: [], limits: { turns_left: 0, sessions_left_today: 0, reached: 'DAY' }, prev_session_ids: [],
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
  const carried = prev === null ? [] : carryCards(prev.server_state, built.refs);
  // 이어 받은 카드와 번호가 겹치지 않게 새 카드 번호는 그 뒤부터
  core.pendingSeq = Math.max(core.pendingSeq, ...carried.map((c) => Number(c.id.slice(1))));
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
    cards: [...carried, ...cards],
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
    prev_session_id: prev?.session_id ?? null,
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
  return outOfRow(deps, row, prev !== null, sessionsToday + 1);
}

/** 이어 받은 카드가 아직 열린 알람 바꾸기(ALARM_EDIT)면 — 어제 문맥의 별칭이라 오늘 문맥으로는 저장할 수 없음 */
export const CARRIED_STALE_ERROR = '날짜가 바뀌어 이 카드는 저장할 수 없어요. 다시 말하거나 직접 바꿔 주세요';
const OPEN: readonly Card['status'][] = ['NEEDS_ESTIMATE', 'READY', 'NEEDS_PLACE', 'FAILED'];

/**
 * 같은 방의 앞 구간 카드를 다음 구간으로 — 번호 · 상태 그대로 (화면 카드가 이어지고, 열린 새 일정 카드는 여기서 저장)
 * 약속 별칭(edit.appointment_id)은 앞 구간 풀이표의 값을 'p:a#'로 옮겨 적음 (새 문맥의 a#와 겹치지 않게). 열린 ALARM_EDIT만 FAILED
 */
export function carryCards(prev: ServerState, refs: RefsOut): Card[] {
  return prev.cards.map((c) => {
    const card = structuredClone(c);
    const alias = card.edit?.appointment_id;
    if (card.edit && alias) {
      const hit = prev.refs.appointments[alias];
      if (hit) refs.appointments[`p:${alias}`] = hit;
      card.edit = { ...card.edit, appointment_id: hit ? `p:${alias}` : null };
    }
    if (card.kind === 'ALARM_EDIT' && OPEN.includes(card.status)) Object.assign(card, { status: 'FAILED', highlight: false, error: CARRIED_STALE_ERROR });
    return card;
  });
}
