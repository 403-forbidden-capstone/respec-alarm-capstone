// ③ 자기 전 대화 — 실데이터(서버 함수 voice-session · voice-turn) 구현. api.ts의 함수가 `if (!isMock()) return real.<함수>(...)`로 넘겨 줌
// 설계: capstone/docs/운영_1029/L4_자기전_설계메모.md 1 · 2 · 5절 (요청 · 응답 모양은 2절 그대로)
//   · 서버는 카드 재료(초안 · 고칠 값)와 말만. 알람 계산 · 저장 · 기록 정정은 앱이 L1 · L2 함수로 하고, 결과 요약만 voice-turn에 돌려줌 (D5 — 이동 분은 서버에 안 남김)
//   · 2단 턴: voice-turn {text} → next = APP_TASKS면 카드마다 일(estimateAppointment · previewAlarms · 정정)을 하고 → voice-turn {results}(같은 client_turn_id, rev는 응답의 rev) → 마지막 reply
//   · 카드 버튼: 저장 = createAppointment(estimate, '자기 전 대화') → voice-turn {card_action: SAVED, appointment_id, alarms}. 준비 +N · 강도는 실제로 바뀐 때만 saveAlarmSettings 한 번 더(L1 답 L1-1 — alarm-commit이 길찾기를 다시 부름)
//   · 실패(LLM_UNAVAILABLE · NOT_CONFIGURED · 네트워크 · 시간 초과)면 대화 · 카드는 남기고 같은 요청을 [다시 시도] (같은 client_turn_id라 말이 두 번 쌓이지 않음). CONFLICT면 세션을 다시 읽음
//   · 대화 상태(세션 번호 · rev · 카드 · 계산한 Estimate)는 이 모듈 메모리에만 — 앱을 다시 열면 voice-session resume으로 말 · 카드 상태를 서버에서 받음 (Estimate는 안 남으니 저장 때 다시 계산)
import { adjustEstimate, orderError } from '@/features/alarm/adjust';
import { createAppointment, createStandaloneAlarm, estimateAppointment, getAppointment, listPlaces, previewAlarms, saveAlarmSettings } from '@/features/alarm/api';
import { draftAt } from '@/features/alarm/schedule';
import {
  RING_KINDS,
  defaultAlarms,
  type AlarmEdits,
  type AlarmKind,
  type AlarmSettingsDraft,
  type AppointmentDetail,
  type AppointmentDraft,
  type Estimate,
  type Importance,
  type IntensityAxis,
  type Level,
  type RingKind,
  type Transport,
} from '@/features/alarm/types';
import { now } from '@/lib/clock';
import { EdgeError, callEdge } from '@/lib/edge';
import { UserError, userMessage } from '@/lib/errors';
import { currentUserId } from '@/lib/user';
import type { Weekday } from '@/lib/weekday';

import { applyFix, type Fix } from './fixes';
import type { ChatMessage, CardAlarm, CardKind, CardStatus, Conversation, ConversationCard, FixResult, Limits, Unavailable } from './types';

// ---------------------------------------------------------------------------
// 서버 응답 모양 (설계 메모 2절 · 14절) — 서버: supabase/functions/_shared/ai/voice-state.ts(응답) · voice-requests.ts(요청 검사)
// ---------------------------------------------------------------------------

type ServerDraft = {
  title: string;
  date: string; // 2026-10-30
  time: string; // 10:00
  place: string; // 서버가 늘 글자로 줌 — 장소를 못 들었으면 ''
  importance?: Importance | null;
  transport?: Transport | null;
  repeat?: Weekday[];
  items?: string[];
  alarms?: Partial<Record<RingKind, boolean>>;
};

// 카드의 고칠 값 — ALARM_EDIT는 설계 2.2 그대로. APPT_NEW에도 같은 칸(times · levels · prepare_delta)이 올 수 있다고 가정 (서버 PR이 맞출 것)
type ServerEdit = {
  appointment_id?: string | null; // DB 약속 id (서버가 별칭을 풀어 줌, 모르면 null)
  times?: Partial<Record<RingKind, string>>;
  levels?: Partial<Record<IntensityAxis, number | null>>;
  enabled?: Partial<Record<RingKind, boolean>>;
  prepare_delta?: number | null; // 더 = +분, 덜 = −분, 원래대로 = 0, 없음 · null = 준비시간 말 없음
  at?: string; // ALARM_NEW
  level?: number | null; // ALARM_NEW
};

type ServerCard = {
  id: string;
  kind: CardKind;
  status: CardStatus;
  first_of_day?: boolean;
  highlight?: boolean;
  summary?: string;
  draft?: ServerDraft | null;
  edit?: ServerEdit | null;
  appointment_id?: string | null; // 저장한 약속 (서버가 SAVED 뒤 채움)
  error?: string | null;
};

type ServerFix = { id: string; fact?: string; kind: string; participant_id: string /* 늘 글자 (모르면 '') */; action: 'CORRECT' | 'DENY'; to: string | null };

type ServerLimits = { turns_left?: number | null; sessions_left_today?: number | null; reached?: 'TURN' | 'DAY' | null };

type ServerMessage = { role: string; text: string; at?: string };

type SessionResponse = {
  session_id: string | null;
  resumed?: boolean;
  rev: number;
  messages?: ServerMessage[];
  cards?: ServerCard[];
  limits?: ServerLimits;
};

type TurnResponse = {
  rev: number;
  next: 'USER' | 'APP_TASKS';
  reply: { text: string } | null;
  cards?: ServerCard[];
  fixes?: ServerFix[];
  limits?: ServerLimits;
};

type ResultCard = { id: string; status: 'READY' | 'NEEDS_PLACE' | 'FAILED'; estimate: { alarms: { kind: string; at: string; enabled: boolean }[]; level: number; with_wake: boolean } | null; error: string | null };

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

export const TURN_TIMEOUT_MS = 25_000; // voice-turn — 서버 마감 18초 + 왕복 (설계 11절, lib/edge 기본 20초로는 모자람)
const MAX_PREPARE_DELTA = 60; // 이번만 준비 +N 상한 (설계 5절, 실험실 stub 60분)
const SAVE_SOURCE = '자기 전 대화';
// 앱이 L1 estimateAppointment에서 "장소 위치를 몰라" 던진 문구를 장소 필요로 가름 (alarm/realPlan.ts) — 그 문구가 바뀌면 같이 고침
const UNKNOWN_PLACE_HINT = '위치를 몰라';
// 대화는 남기고 [다시 시도]를 보일 오류 (LLM 실패 · 키 없음 · 네트워크 · 시간 초과 · 서버 일시 오류)
const UNAVAILABLE_CODES: readonly string[] = ['LLM_UNAVAILABLE', 'NOT_CONFIGURED', 'NETWORK', 'TIMEOUT', 'INTERNAL'];

// ---------------------------------------------------------------------------
// 상태 (메모리)
// ---------------------------------------------------------------------------

type ResolvedPlace = { name: string; lat: number; lng: number };

type CardRec = {
  server: ServerCard;
  status: CardStatus;
  estimate: Estimate | null; // 저장 전 계산 결과 (APPT_NEW)
  alarms: CardAlarm[];
  error: string | null;
  place: ResolvedPlace | null; // 사용자가 [장소 고르기]로 고른 곳
  appointmentId: string | null;
};

type Pending = { phase: 'TEXT' | 'RESULTS' | 'CARD'; body: Record<string, unknown>; turnId: string };

type State = {
  userId: string | null;
  sessionId: string | null;
  rev: number;
  started: boolean; // voice-session을 한 번 불렀음 (한도 DAY로 세션이 없어도 true)
  messages: ChatMessage[];
  cards: Map<string, CardRec>;
  limits: Limits | null;
  unavailable: Unavailable | null;
  pending: Pending | null; // 보냈지만 답을 못 받은 요청 — [다시 시도]가 같은 것을 다시 보냄
  seq: number;
};

function freshState(userId: string | null): State {
  return { userId, sessionId: null, rev: 0, started: false, messages: [], cards: new Map(), limits: null, unavailable: null, pending: null, seq: 0 };
}

let state: State = freshState(null);

// 시험용 — 모듈 상태 비우기
export function resetVoiceState() {
  state = freshState(null);
  chain = Promise.resolve();
}

// 서버 요청은 한 번에 하나 — rev가 어긋나지 않게 (말 · 카드 버튼 · 다시 시도가 겹치면 차례로)
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function pushMessage(who: ChatMessage['who'], text: string, at: Date, cardId?: string) {
  state.messages.push({ id: `m${state.seq++}`, who, text, at, ...(cardId ? { cardId } : {}) });
}

// ---------------------------------------------------------------------------
// 읽기 모양 만들기
// ---------------------------------------------------------------------------

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayOf(value: string): Date | null {
  const m = DAY.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function cardView(id: string, rec: CardRec): ConversationCard {
  const s = rec.server;
  const d = s.draft;
  const day = d ? dayOf(d.date) : null;
  const at = s.kind === 'ALARM_NEW' && s.edit?.at ? new Date(s.edit.at) : day && d && TIME.test(d.time) ? draftAt(day, d.time) : null;
  return {
    id,
    kind: s.kind,
    status: rec.status,
    firstOfDay: s.first_of_day ?? false,
    highlight: s.highlight ?? false,
    summary: s.summary ?? '',
    title: d?.title ?? '',
    at: at && !Number.isNaN(at.getTime()) ? at : null,
    place: rec.place?.name ?? d?.place ?? '',
    importance: d?.importance ?? null,
    items: d?.items ?? [],
    alarms: rec.alarms,
    question: null,
    error: rec.error ?? s.error ?? null,
    appointmentId: rec.appointmentId ?? s.appointment_id ?? s.edit?.appointment_id ?? null,
  };
}

function snapshot(): Conversation {
  const reached = state.limits?.reached ?? null;
  return {
    source: 'REAL',
    messages: state.messages.map((m) => ({ ...m })),
    next: !state.sessionId || reached || state.pending ? null : { who: 'me', text: '' },
    cards: [...state.cards].map(([id, rec]) => cardView(id, rec)),
    limits: state.limits ? { ...state.limits } : null,
    unavailable: state.unavailable,
  };
}

const limitsOf = (l: ServerLimits | undefined): Limits | null =>
  l ? { turnsLeft: l.turns_left ?? null, sessionsLeftToday: l.sessions_left_today ?? null, reached: l.reached ?? null } : null;

// ---------------------------------------------------------------------------
// 서버 응답 반영
// ---------------------------------------------------------------------------

// 카드 목록 합치기 — 서버 상태가 기준. 단 우리가 이미 저장 · 저장 안 함으로 끝낸 카드는 서버가 늦게 알아도 그대로. 처음 보는 카드는 대화 줄에 끼움
function mergeCards(cards: ServerCard[] | undefined, at: Date) {
  for (const sc of cards ?? []) {
    const rec = state.cards.get(sc.id);
    if (!rec) {
      state.cards.set(sc.id, { server: sc, status: sc.status, estimate: null, alarms: [], error: null, place: null, appointmentId: null });
      pushMessage('card', '', at, sc.id);
      continue;
    }
    const done = rec.status === 'SAVED' || rec.status === 'REJECTED';
    // 서버가 다시 계산을 시킨 카드(고친 값 · 새 초안)는 앞 계산을 버림
    const recompute = sc.status === 'NEEDS_ESTIMATE' || sc.status === 'NEEDS_PLACE';
    rec.server = sc;
    if (!done) {
      rec.status = sc.status;
      if (recompute) {
        rec.estimate = null;
        rec.alarms = [];
        if (sc.status === 'NEEDS_ESTIMATE') rec.error = null;
      }
    }
  }
}

// 응답 한 번을 상태에 넣음. 앱 일(next = APP_TASKS)이면 그 일을 하고 다음에 보낼 요청(results)을 돌려줌
async function absorb(res: TurnResponse, turnId: string): Promise<Pending | null> {
  const at = now();
  state.rev = res.rev;
  state.limits = limitsOf(res.limits) ?? state.limits;
  if (res.reply?.text) pushMessage('ai', res.reply.text, at);
  mergeCards(res.cards, at);
  if (res.next !== 'APP_TASKS') return null;
  const results = await runTasks(res);
  return { phase: 'RESULTS', turnId, body: { session_id: state.sessionId, rev: res.rev, client_turn_id: turnId, results } };
}

// ---------------------------------------------------------------------------
// 앱 일 — 카드 계산 · 정정
// ---------------------------------------------------------------------------

type Outcome = { status: 'READY' | 'NEEDS_PLACE' | 'FAILED'; estimate?: Estimate; alarms?: CardAlarm[]; level?: number; withWake?: boolean; error?: string };

// 장소 이름이 내가 쓴 곳(listPlaces)에 똑같이 하나면 그 좌표 (L1 답 L1-6) — 아니면 null (카드의 [장소 고르기])
async function placeByName(name: string): Promise<ResolvedPlace | null> {
  const wanted = name.trim();
  if (!wanted) return null;
  const same = (await listPlaces(wanted)).filter((p) => p.name.trim() === wanted);
  const only = same.length === 1 ? same[0] : null;
  return only && typeof only.lat === 'number' && typeof only.lng === 'number' ? { name: only.name, lat: only.lat, lng: only.lng } : null;
}

const toLevel = (n: unknown): Level | null => (n === 0 || n === 1 || n === 2 ? n : null);
const ringAlarms = (alarms: readonly { kind: AlarmKind; at: Date; enabled: boolean }[]): CardAlarm[] => alarms.filter((a) => a.kind !== 'ARRIVE').map((a) => ({ kind: a.kind, at: a.at, enabled: a.enabled }));

// 새 약속 카드 계산 — 좌표를 풀고 estimateAppointment, 카드의 시각 고침(times)은 adjustEstimate로
async function estimateNew(rec: CardRec): Promise<Outcome> {
  const d = rec.server.draft;
  if (!d) return { status: 'FAILED', error: '일정 내용을 읽지 못했어요' };
  const day = dayOf(d.date);
  if (!day || !TIME.test(d.time)) return { status: 'FAILED', error: '날짜나 시각을 알 수 없어요' };
  try {
    // 장소를 못 들었으면('') 찾아 보지 않고 바로 장소 필요
    const heard = d.place.trim();
    const place = rec.place ?? (heard ? await placeByName(heard) : null);
    if (!place) return { status: 'NEEDS_PLACE', error: heard ? `'${heard}'의 위치를 골라 주세요` : '장소를 골라 주세요' };
    const draft: AppointmentDraft = {
      title: d.title,
      date: day,
      time: d.time,
      repeat: d.repeat ?? [],
      place: place.name,
      placeLat: place.lat,
      placeLng: place.lng,
      transport: d.transport ?? 'TRANSIT',
      importance: d.importance ?? 'LOW',
      items: (d.items ?? []).join(','),
      alarms: { ...defaultAlarms(), ...(d.alarms ?? {}) },
    };
    let estimate = await estimateAppointment(draft);
    for (const kind of RING_KINDS) {
      const to = rec.server.edit?.times?.[kind];
      if (to) estimate = adjustEstimate(estimate, kind, new Date(to));
    }
    const blocked = orderError(estimate.appointment.alarms); // 순서 뒤집힘(기상 ≤ 준비 ≤ 출발) → 실패 + 이유를 서버에 (처리 결과 "되물을 것")
    if (blocked) return { status: 'FAILED', error: blocked };
    const level = toLevel(rec.server.edit?.levels?.sound) ?? estimate.appointment.level;
    return { status: 'READY', estimate, alarms: ringAlarms(estimate.appointment.alarms), level, withWake: estimate.appointment.withWake };
  } catch (e) {
    if (e instanceof UserError && e.message.includes(UNKNOWN_PLACE_HINT)) return { status: 'NEEDS_PLACE', error: e.message };
    return { status: 'FAILED', error: userMessage(e, '알람을 계산하지 못했어요') };
  }
}

const LEVEL_AXES = ['sound', 'voice', 'vibration'] as const;

// 서버 prepare_delta — 숫자면 −60~+60분(0 = 원래대로), 없음 · null이면 null = 준비시간 말 없음
function prepDeltaOf(edit: ServerEdit | null | undefined): number | null {
  const d = edit?.prepare_delta;
  if (typeof d !== 'number' || !Number.isFinite(d)) return null;
  return Math.max(-MAX_PREPARE_DELTA, Math.min(MAX_PREPARE_DELTA, Math.round(d)));
}

// 바뀔 준비 시간 — 말 없음이면 지금 값 그대로, 0이면 자동(null)으로 되돌림, 그 밖엔 자동 준비 시간 + delta (0분 미만은 0분)
function prepareOf(detail: AppointmentDetail, delta: number | null): number | null {
  if (delta == null) return detail.edits.prepareMinutes;
  if (delta === 0) return null;
  return Math.max(0, detail.auto.predictedPrepMinutes + delta);
}

// 한 축의 서버 값 — undefined = 강도 말 없음(그대로), null = "보통으로"(자동으로 되돌림), 숫자 = 그 강도
function wantedLevelOf(edit: ServerEdit | null | undefined, axis: IntensityAxis): Level | null | undefined {
  const v = edit?.levels?.[axis];
  if (v === null) return null;
  return toLevel(v) ?? undefined;
}

// 저장된 약속에 고칠 값을 얹은 알람 설정 초안 — 미리 보기 · 저장이 같이 씀. 준비 시간은 자동 + delta (음수 = 줄이기, 0 = 자동으로)
//   changed = 알람 시각이 움직일 값(시각 · 준비)이 지금과 다른지, levelChanged = 강도가 지금과 다른지
function editsOf(
  detail: AppointmentDetail,
  edit: ServerEdit | null | undefined,
): { edits: AlarmEdits; draft: AlarmSettingsDraft; changed: boolean; levelChanged: boolean } {
  const times: AlarmEdits['times'] = { ...detail.edits.times };
  let timesChanged = false;
  for (const kind of RING_KINDS) {
    const to = edit?.times?.[kind];
    if (to) {
      times[kind] = new Date(to);
      timesChanged = true;
    }
  }
  const prepareMinutes = prepareOf(detail, prepDeltaOf(edit));
  const levels = {} as AlarmSettingsDraft['levels'];
  let levelChanged = false;
  for (const axis of LEVEL_AXES) {
    const wanted = wantedLevelOf(edit, axis);
    const axisNow = detail.intensity.axes[axis];
    levels[axis] = wanted !== undefined ? wanted : axisNow.manual ? axisNow.level : null;
    if (wanted === null && axisNow.manual) levelChanged = true; // 수동 → 자동
    if (wanted != null && wanted !== axisNow.level) levelChanged = true;
  }
  const edits: AlarmEdits = { ...detail.edits, times, prepareMinutes };
  const changed = timesChanged || prepareMinutes !== detail.edits.prepareMinutes;
  return { edits, draft: { ...edits, kinds: { ...(edit?.enabled ?? {}) }, levels }, changed, levelChanged };
}

// 있는 약속의 알람 고치기 카드 계산 — 시각 · 준비가 바뀔 때만 previewAlarms (길찾기를 불러서), 켜기 · 강도만이면 지금 알람 그대로
async function previewEdit(rec: CardRec): Promise<Outcome> {
  const edit = rec.server.edit;
  const id = edit?.appointment_id;
  if (!id) return { status: 'FAILED', error: '바꿀 일정을 찾지 못했어요' };
  try {
    const detail = await getAppointment(id);
    if (!detail) return { status: 'FAILED', error: '바꿀 일정을 찾지 못했어요' };
    const { edits, changed } = editsOf(detail, edit);
    let alarms = detail.alarms;
    if (changed) {
      alarms = (await previewAlarms(id, edits)).alarms;
      const blocked = orderError(alarms);
      if (blocked) return { status: 'FAILED', error: blocked };
    }
    const shown = ringAlarms(alarms).map((a) => (edit?.enabled && typeof edit.enabled[a.kind as RingKind] === 'boolean' ? { ...a, enabled: edit.enabled[a.kind as RingKind] as boolean } : a));
    const sound = wantedLevelOf(edit, 'sound'); // null = 보통으로 → 자동 강도
    return { status: 'READY', alarms: shown, level: sound === undefined ? detail.level : (sound ?? detail.intensity.auto), withWake: detail.withWake };
  } catch (e) {
    return { status: 'FAILED', error: userMessage(e, '알람을 계산하지 못했어요') };
  }
}

async function runCard(rec: CardRec): Promise<Outcome> {
  if (rec.server.kind === 'APPT_NEW') return estimateNew(rec);
  if (rec.server.kind === 'ALARM_EDIT') return previewEdit(rec);
  return { status: 'READY' }; // ALARM_NEW · APPT_OPEN — 계산 없음
}

function resultCard(id: string, o: Outcome): ResultCard {
  return {
    id,
    status: o.status,
    estimate:
      o.status === 'READY'
        ? { alarms: (o.alarms ?? []).map((a) => ({ kind: a.kind, at: a.at.toISOString(), enabled: a.enabled })), level: o.level ?? 1, with_wake: o.withWake ?? false }
        : null,
    error: o.error ?? null,
  };
}

function applyOutcome(rec: CardRec, o: Outcome) {
  rec.status = o.status;
  rec.estimate = o.estimate ?? null;
  rec.alarms = o.alarms ?? [];
  rec.error = o.error ?? null;
}

// 앱 일 — 계산이 필요한 카드(NEEDS_ESTIMATE)마다, 정정마다. 하나가 실패해도 나머지는 계속 (실패는 결과에 담아 서버가 되묻게)
async function runTasks(res: TurnResponse): Promise<{ cards: ResultCard[]; fixes: FixResult[] }> {
  const cards: ResultCard[] = [];
  for (const sc of res.cards ?? []) {
    const rec = state.cards.get(sc.id);
    if (!rec || rec.status !== 'NEEDS_ESTIMATE') continue;
    rec.status = 'ESTIMATING';
    const outcome = await runCard(rec);
    applyOutcome(rec, outcome);
    cards.push(resultCard(sc.id, outcome));
  }
  const fixes: FixResult[] = [];
  for (const f of res.fixes ?? []) {
    if (!f.participant_id) {
      fixes.push({ id: f.id, ok: false, error: '대상 없음' }); // 서버가 대상을 못 풀었음
      continue;
    }
    const fix: Fix = { id: f.id, kind: f.kind, participantId: f.participant_id, action: f.action, to: f.to ? new Date(f.to) : null };
    try {
      fixes.push(await applyFix(fix));
    } catch (e) {
      fixes.push({ id: f.id, ok: false, error: userMessage(e, '반영하지 못함') });
    }
  }
  return { cards, fixes };
}

// ---------------------------------------------------------------------------
// 서버 부르기 — 오류 가름
// ---------------------------------------------------------------------------

const unavailableOf = (e: EdgeError): Unavailable => ({ code: e.code, message: e.message, canRetry: true });

// 오류가 났을 때 — 대화를 남기고 [다시 시도]를 보일 것이면 상태에 적고 true, 아니면 던짐 (CONFLICT는 세션을 다시 읽은 뒤 던짐)
async function onError(e: unknown): Promise<void> {
  if (!(e instanceof EdgeError)) throw e;
  if (UNAVAILABLE_CODES.includes(e.code)) {
    // LLM 실패는 서버가 상태를 details로 줌 ({ cards, fixes, rev, turn_seq, limits }) — 카드 · rev · 한도를 받아 둠
    //   rev가 올라가 있어도 [다시 시도]는 처음 보낸 rev · client_turn_id 그대로 (서버가 같은 client_turn_id는 rev를 안 봄)
    const d = e.details as { cards?: ServerCard[]; rev?: number; limits?: ServerLimits } | null | undefined;
    if (Array.isArray(d?.cards)) mergeCards(d.cards, now());
    if (typeof d?.rev === 'number') state.rev = d.rev;
    state.limits = limitsOf(d?.limits) ?? state.limits;
    state.unavailable = unavailableOf(e);
    return;
  }
  state.pending = null;
  // CONFLICT = rev 어긋남, NOT_FOUND = 세션 · 카드를 모름 — 서버 상태를 다시 읽음 (세션이 없어졌으면 resume이 새로 시작)
  if (e.code === 'CONFLICT' || e.code === 'NOT_FOUND') await readSession(true);
  throw e;
}

// 보낼 요청을 끝까지 — 앱 일이 있으면 results까지. 답을 못 받으면 pending을 남기고 unavailable
async function drive(): Promise<void> {
  while (state.pending) {
    const p = state.pending;
    let res: TurnResponse;
    try {
      res = await callEdge<TurnResponse>('voice-turn', p.body, { timeoutMs: TURN_TIMEOUT_MS });
    } catch (e) {
      await onError(e);
      return;
    }
    state.unavailable = null;
    state.pending = null;
    state.pending = await absorb(res, p.turnId);
  }
}

// ---------------------------------------------------------------------------
// 세션
// ---------------------------------------------------------------------------

async function readSession(resume: boolean): Promise<void> {
  const res = await callEdge<SessionResponse>('voice-session', { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume });
  const at = now();
  // 앱에서 이미 저장 · 저장 안 함으로 끝낸 카드는 서버가 아직 몰라도 그대로 — 다시 저장해 일정이 두 벌 생기지 않게
  const done = [...state.cards].filter(([, rec]) => rec.status === 'SAVED' || rec.status === 'REJECTED');
  state.sessionId = res.session_id ?? null;
  state.rev = res.rev ?? 0;
  state.limits = limitsOf(res.limits);
  state.started = true;
  state.unavailable = null;
  state.pending = null;
  state.messages = [];
  state.cards = new Map();
  for (const m of res.messages ?? []) pushMessage(m.role === 'ai' ? 'ai' : 'me', m.text, m.at ? new Date(m.at) : at);
  mergeCards(res.cards, at);
  for (const [id, old] of done) {
    const rec = state.cards.get(id);
    if (rec && res.session_id && rec.status !== 'SAVED' && rec.status !== 'REJECTED') {
      rec.status = old.status;
      rec.appointmentId = old.appointmentId;
      rec.alarms = old.alarms;
    }
  }
}

// 대화 시작 — 오늘 안 끝난 세션이 있으면 그대로(resume), 없으면 새로. 첫 마디는 서버 템플릿이라 messages에 옴. 하루 한도면 세션 없이 limits.reached = DAY
export async function startConversation(_opts: { type: 'BEFORE_SLEEP' } = { type: 'BEFORE_SLEEP' }): Promise<void> {
  try {
    await readSession(true);
  } catch (e) {
    await onError(e);
  }
}

// 사용자가 바뀌었으면(로그아웃 · 다른 계정) 앞 대화를 버림
async function guardUser() {
  const userId = await currentUserId();
  if (state.userId !== userId) state = freshState(userId);
}

async function ensureSession(): Promise<void> {
  await guardUser();
  if (state.started || state.unavailable) return; // 시작 실패는 [다시 시도](retry)만 다시 부름
  await startConversation({ type: 'BEFORE_SLEEP' });
}

// ---------------------------------------------------------------------------
// 화면이 부르는 함수
// ---------------------------------------------------------------------------

export function getConversation(): Promise<Conversation> {
  return serial(async () => {
    await ensureSession();
    return snapshot();
  });
}

// 말하기 — 글을 보내고 AI 답(필요하면 앱 일 뒤 마지막 답)까지. 못 보내면 말은 남고 [다시 시도]
export function say(text?: string): Promise<Conversation> {
  return serial(async () => {
    await ensureSession();
    const typed = text?.trim();
    if (!typed || !state.sessionId || state.pending || state.limits?.reached) return snapshot();
    const turnId = newId();
    pushMessage('me', typed, now());
    const sent = state.messages[state.messages.length - 1];
    state.pending = { phase: 'TEXT', turnId, body: { session_id: state.sessionId, rev: state.rev, client_turn_id: turnId, text: typed } };
    try {
      await drive();
    } catch (e) {
      state.messages = state.messages.filter((m) => m !== sent); // 못 보낸 말은 입력칸으로 돌아감
      throw e;
    }
    return snapshot();
  });
}

// [다시 시도] — 세션을 못 시작했으면 다시 시작, 보낸 요청이 남았으면 같은 요청(같은 client_turn_id)을 다시
export function retry(): Promise<Conversation> {
  return serial(async () => {
    await guardUser();
    if (!state.sessionId && !state.limits?.reached) {
      state.unavailable = null;
      state.started = false;
      await startConversation({ type: 'BEFORE_SLEEP' });
    } else if (state.pending) {
      state.unavailable = null;
      await drive();
    }
    return snapshot();
  });
}

function recOf(id: string): CardRec {
  const rec = state.cards.get(id);
  if (!rec) throw new UserError('찾을 수 없는 카드예요');
  return rec;
}

// 카드 상태를 서버에 알림 — 이미 저장한 일은 되돌리지 않으므로 실패해도 던지지 않고 [다시 시도] 자리(pending)로
async function notifyCard(action: Record<string, unknown>): Promise<void> {
  if (!state.sessionId) return;
  const turnId = newId();
  state.pending = { phase: 'CARD', turnId, body: { session_id: state.sessionId, rev: state.rev, client_turn_id: turnId, card_action: action } };
  try {
    await drive();
  } catch {
    // 서버가 거절해도(CONFLICT는 세션을 다시 읽음 — 카드 상태는 서버 값) 앱에서 한 저장은 그대로
    state.pending = null;
  }
}

// 저장 뒤 알람 한 줄씩 — 서버가 말할 숫자 (종류 · 시각 · 켜짐 · 강도만, 이동 분은 안 보냄 — D5)
const alarmSummary = (alarms: readonly { kind: AlarmKind; at: Date; enabled: boolean }[], level: number) =>
  ringAlarms(alarms).map((a) => ({ kind: a.kind, at: a.at.toISOString(), enabled: a.enabled, level }));

// 새 약속 저장 뒤 준비 +N · 강도 — 실제로 바뀔 때만 saveAlarmSettings 한 번 더 (L1 답 L1-1). 바꾼 뒤의 약속을 돌려줌
async function adjustAfterSave(id: string, edit: ServerEdit | null | undefined): Promise<AppointmentDetail | null> {
  const delta = prepDeltaOf(edit);
  if (delta == null && LEVEL_AXES.every((axis) => wantedLevelOf(edit, axis) === undefined)) return null; // 고칠 말 없음
  const detail = await getAppointment(id);
  if (!detail) return null;
  const { draft, changed, levelChanged } = editsOf(detail, { prepare_delta: delta ?? undefined, levels: edit?.levels });
  if (!changed && !levelChanged) return null; // 이미 그 값 — 길찾기를 또 부르지 않음
  await saveAlarmSettings(id, draft);
  return getAppointment(id);
}

// 카드 [저장] · [바꾸기] — 돌려주는 글은 토스트. 일정 · 알람을 L1 함수로 저장한 뒤 서버에 SAVED
export function saveCard(cardId: string): Promise<string> {
  return serial(async () => {
    const rec = recOf(cardId);
    if (rec.status === 'SAVED' || rec.status === 'REJECTED') throw new UserError('이미 확인한 카드예요');
    if (rec.status !== 'READY') throw new UserError('아직 저장할 수 없는 카드예요');
    const kind = rec.server.kind;
    let appointmentId: string;
    let alarms: { kind: AlarmKind; at: Date; enabled: boolean }[];
    let level: number;
    let toast = '알람을 맞췄어요';
    let partial: string | null = null;

    if (kind === 'APPT_NEW') {
      // 앱을 다시 열어 계산 결과(Estimate)가 없으면 저장 전에 다시 계산
      let estimate = rec.estimate;
      if (!estimate) {
        const o = await estimateNew(rec);
        applyOutcome(rec, o);
        if (o.status !== 'READY' || !o.estimate) throw new UserError(o.error ?? '알람을 계산하지 못했어요');
        estimate = o.estimate;
      }
      const saved = await createAppointment(estimate, SAVE_SOURCE);
      appointmentId = saved.id;
      alarms = saved.alarms;
      level = saved.level;
      toast = `${saved.title} 알람을 맞췄어요`;
      rec.status = 'SAVED'; // 일정은 저장됨 — 아래 두 번째 저장이 실패해도 카드는 저장으로
      rec.appointmentId = saved.id;
      try {
        const after = await adjustAfterSave(saved.id, rec.server.edit);
        if (after) {
          alarms = after.alarms;
          level = after.level;
        }
      } catch {
        partial = `${saved.title}은 저장했지만 준비 시간 · 강도는 바꾸지 못했어요. 알람 설정에서 바꿔 주세요`;
      }
    } else if (kind === 'ALARM_EDIT') {
      const id = rec.server.edit?.appointment_id;
      const detail = id ? await getAppointment(id) : null;
      if (!id || !detail) throw new UserError('바꿀 일정을 찾지 못했어요');
      await saveAlarmSettings(id, editsOf(detail, rec.server.edit).draft);
      const after = await getAppointment(id);
      appointmentId = id;
      alarms = after?.alarms ?? detail.alarms;
      level = after?.level ?? detail.level;
      toast = '알람을 바꿨어요';
      rec.status = 'SAVED';
      rec.appointmentId = id;
    } else if (kind === 'ALARM_NEW') {
      const at = rec.server.edit?.at ? new Date(rec.server.edit.at) : null;
      if (!at || Number.isNaN(at.getTime())) throw new UserError('알람 시각을 알 수 없어요');
      const lv = toLevel(rec.server.edit?.level);
      const saved = await createStandaloneAlarm({ at, ...(lv != null ? { level: lv } : {}) });
      appointmentId = saved.id;
      alarms = saved.alarms;
      level = saved.level;
      rec.status = 'SAVED';
      rec.appointmentId = saved.id;
    } else {
      throw new UserError('이 카드는 저장할 게 없어요');
    }

    await notifyCard({ id: cardId, action: 'SAVED', appointment_id: appointmentId, alarms: alarmSummary(alarms, level) });
    return partial ?? toast;
  });
}

// 카드 [저장 안 함] — 되돌릴 게 없어 앱 상태를 먼저 바꾸고 서버에 알림 (서버는 T1을 안 부름)
export function rejectCard(cardId: string): Promise<void> {
  return serial(async () => {
    const rec = recOf(cardId);
    if (rec.status === 'SAVED' || rec.status === 'REJECTED') return;
    rec.status = 'REJECTED';
    await notifyCard({ id: cardId, action: 'REJECTED' });
  });
}

// 카드 [장소 고르기] — 고른 곳으로 다시 계산해 READY로, 결과를 서버에 알림 (새 client_turn_id로 results만 — 서버가 받아 줘야 함, 서버 PR이 맞출 것)
export function pickCardPlace(cardId: string, place: { name: string; lat?: number; lng?: number }): Promise<void> {
  return serial(async () => {
    const rec = recOf(cardId);
    if (typeof place.lat !== 'number' || typeof place.lng !== 'number') throw new UserError('이 장소는 위치를 몰라요. 다른 곳을 골라 주세요');
    rec.place = { name: place.name, lat: place.lat, lng: place.lng };
    rec.status = 'ESTIMATING';
    const outcome = await runCard(rec);
    applyOutcome(rec, outcome);
    if (!state.sessionId) return;
    const turnId = newId();
    state.pending = {
      phase: 'RESULTS',
      turnId,
      body: { session_id: state.sessionId, rev: state.rev, client_turn_id: turnId, results: { cards: [resultCard(cardId, outcome)], fixes: [] } },
    };
    try {
      await drive();
    } catch {
      state.pending = null; // 서버가 받지 않아도 이 카드는 앱에서 계산한 상태 그대로
    }
  });
}
