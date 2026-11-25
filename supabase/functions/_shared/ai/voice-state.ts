// voice-session · voice-turn이 같이 쓰는 모양 바꾸기 (순수 TS):
//   · TurnState(turn-core) ↔ server_state의 core · events · cards · fixes · awaiting 칸 (설계 메모 3절)
//   · 앱에 내보내는 카드 · 정정 모양 (설계 메모 2.2 · 14절) — 모델이 쓴 별칭(a# · f#)을 DB id로 풀어서
//   · turns → 프롬프트 화면용 Turn[]
import type { RefsOut } from './context-core.ts';
import type { ServerState, StoredTurn } from './session.ts';
import type { FixRecord, TurnState } from './turn-core.ts';
import type { ApptDraft, Card, CardEdit, CardGroup, Context, Fix, PreTask, ServerEvent, Turn } from './types.ts';

// ───────── TurnState ↔ server_state ─────────

/** server_state → turn-core가 다루는 한 덩어리. 입력을 안 바꾸도록 복사해서 줌 */
export function toTurnState(st: ServerState): TurnState {
  const copy = structuredClone(st);
  return {
    ...copy.core,
    events: copy.events,
    cards: copy.cards,
    fixes: copy.fixes,
    awaiting: copy.awaiting === null ? null : { after_turn: copy.awaiting.after_turn, cards: copy.awaiting.cards, fixes: copy.awaiting.fixes },
  };
}

/** turn-core 결과를 server_state에 담은 새 상태 (rev · counts 등 나머지는 그대로 복사). awaiting에는 이번 요청의 client_turn_id를 붙임 */
export function withTurnState(st: ServerState, ts: TurnState, clientTurnId: string): ServerState {
  const next = structuredClone(st);
  const { events, cards, fixes, awaiting, ...core } = structuredClone(ts);
  next.core = core;
  next.events = events;
  next.cards = cards;
  next.fixes = fixes;
  next.awaiting = awaiting === null ? null : { client_turn_id: clientTurnId, after_turn: awaiting.after_turn, cards: awaiting.cards, fixes: awaiting.fixes };
  // 카드로 저장한 약속 · 알람의 DB id를 별칭 풀이표(refs)에 옮겨 적음 — 앱이 알려 준 값 (turn-core bound)
  for (const [alias, id] of Object.entries(core.bound)) {
    if (/^a\d+$/.test(alias) && next.refs.appointments[alias] === undefined) next.refs.appointments[alias] = { appointment_id: id, participant_id: '' };
    else if (/^al\d+$/.test(alias) && next.refs.alarms[alias] === undefined) next.refs.alarms[alias] = { alarm_id: id };
  }
  // 기록 정정 대상(참여 행 id)을 사실 별칭에서 풀어 채움
  for (const f of next.fixes) f.participant_id ??= next.refs.facts[f.fact]?.participant_id ?? null;
  return next;
}

/** 이번 요청 시각의 컨텍스트 — 저장한 스냅숏에 지금 시각과 보여 줄 처리 결과만 바꿔 끼움 */
export function ctxOf(st: ServerState, nowIso: string, events: ServerEvent[]): Context {
  return { ...structuredClone(st.ctx), session: { ...st.ctx.session, now: nowIso }, events: structuredClone(events) };
}

/**
 * 모델 화면(T2F · T1)의 일정 · 알람을 대화의 지금 상태(카드로 저장 · 변경한 값)로 바꿔 끼움.
 * 세션 시작 스냅숏(st.ctx)만 보여 주면 대화 중 만든 일정은 '일정 없음', 바꾼 일정은 옛 시각으로 보여
 * 같은 일정의 두 번째 변경('오후 2시로 바꿔줘')을 T2F가 대화 글만으로 짐작해야 함 — 별칭(a#)도 상태와 같게.
 */
export function withSchedule(ctx: Context, s: Pick<TurnState, 'appointments' | 'alarms'>): Context {
  const { today, tomorrow } = ctx.dates;
  const dayOf = (date: string): 'today' | 'tomorrow' | 'later' => (date <= today ? 'today' : date === tomorrow ? 'tomorrow' : 'later');
  const apptDay = new Map(s.appointments.map((a) => [a.ref, dayOf(a.date)]));
  const pick = <T>(xs: T[], day: (x: T) => string) => ({
    today: xs.filter((x) => day(x) === 'today'),
    tomorrow: xs.filter((x) => day(x) === 'tomorrow'),
    later: xs.filter((x) => day(x) === 'later'),
  });
  const ap = pick(structuredClone(s.appointments), (a) => dayOf(a.date));
  const al = pick(structuredClone(s.alarms), (a) => (a.appointment_ref !== null && apptDay.get(a.appointment_ref)) || dayOf(a.date));
  const { later: _old, ...rest } = ctx;
  return {
    ...rest,
    today: { ...ctx.today, appointments: ap.today, alarms: al.today },
    tomorrow: { ...ctx.tomorrow, appointments: ap.tomorrow, alarms: al.tomorrow },
    ...(ap.later.length > 0 || al.later.length > 0 ? { later: { appointments: ap.later, alarms: al.later } } : {}),
  };
}

export function turnsOf(stored: StoredTurn[]): Turn[] {
  return stored.map((t, i): Turn => ({ index: i, role: t.role, text: t.text, ...(t.role === 'ai' ? { acts: t.acts ?? [] } : {}) }));
}

// ───────── 앱에 내보내는 모양 ─────────

export interface PublicCard {
  id: string;
  kind: Card['kind'];
  status: Card['status'];
  first_of_day: boolean;
  highlight: boolean;
  summary: string;
  draft: (Omit<ApptDraft, 'place'> & { place: string }) | null;
  edit: CardEdit | null;
  appointment_id: string | null;
  error: string | null;
  /** 카드를 만든 때 — 없으면(예전 카드) null */
  at: string | null;
  /** 카드를 만든 사용자 말 번호 — 한 번의 요청에서 일정 카드는 하나만 저장(앱 saveCard). 없으면(예전 카드) null */
  turn: number | null;
  /** 나가기 전 할 일 · 기상 확인 — ASK면 앱이 저장하지 않음, SET이면 앱이 기상만 옮김(준비 · 출발 그대로). 없으면 null */
  pre_task: PreTask | null;
  group: CardGroup | null;
}

export interface PublicFix {
  id: string;
  fact: string;
  kind: Fix['kind'];
  participant_id: string;
  action: Fix['action'];
  to: string | null;
}

/**
 * 카드 하나 — 계산 요약(digest)은 서버 안에만 둔다. 앱이 쓰는 값만:
 *   · draft.place는 늘 글자(장소를 못 들었으면 '') — 앱이 장소 이름으로 좌표를 찾음(NEEDS_PLACE)
 *   · edit.appointment_id는 DB 약속 id로 풂(모르는 별칭이면 null)
 */
export function publicCard(c: Card, refs: RefsOut): PublicCard {
  let edit = c.edit === null ? null : structuredClone(c.edit);
  if (edit !== null && edit.appointment_id !== undefined && edit.appointment_id !== null) {
    edit = { ...edit, appointment_id: refs.appointments[edit.appointment_id]?.appointment_id ?? null };
  }
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    first_of_day: c.first_of_day,
    highlight: c.highlight,
    summary: c.summary,
    draft: c.draft === null ? null : { ...structuredClone(c.draft), place: c.draft.place ?? '' },
    edit,
    appointment_id: c.appointment_id,
    error: c.error,
    at: c.at ?? null,
    turn: c.turn ?? null,
    pre_task: c.pre_task ? { ...c.pre_task } : null,
    group: c.group ? structuredClone(c.group) : null,
  };
}

export function publicFix(f: Fix | FixRecord, refs: RefsOut): PublicFix {
  return { id: f.id, fact: f.fact, kind: f.kind, participant_id: f.participant_id ?? refs.facts[f.fact]?.participant_id ?? '', action: f.action, to: f.to };
}
