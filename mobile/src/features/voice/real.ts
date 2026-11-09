// ③ 자기 전 대화 — 실데이터(서버 함수 voice-session · voice-turn) 구현. api.ts의 함수가 `if (!isMock()) return real.<함수>(...)`로 넘겨 줌
// 설계: capstone/docs/운영_1029/L4_자기전_설계메모.md 1 · 2 · 5절 (요청 · 응답 모양은 2절 그대로)
//   · 서버는 카드 재료(초안 · 고칠 값)와 말만. 알람 계산 · 저장 · 기록 정정은 앱이 L1 · L2 함수로 하고, 결과 요약만 voice-turn에 돌려줌 (D5 — 이동 분은 서버에 안 남김)
//   · 2단 턴: voice-turn {text} → next = APP_TASKS면 카드마다 일(estimateAppointment · previewAlarms · 정정)을 하고 → voice-turn {results}(같은 client_turn_id, rev는 응답의 rev) → 마지막 reply
//   · 카드 버튼: 저장 = createAppointment(estimate, '자기 전 대화') → voice-turn {card_action: SAVED, appointment_id, alarms}. 준비 +N · 강도는 실제로 바뀐 때만 saveAlarmSettings 한 번 더(L1 답 L1-1 — alarm-commit이 길찾기를 다시 부름)
//   · 실패(LLM_UNAVAILABLE · NOT_CONFIGURED · 네트워크 · 시간 초과)면 대화 · 카드는 남기고 같은 요청을 [다시 시도] (같은 client_turn_id라 말이 두 번 쌓이지 않음). CONFLICT면 세션을 다시 읽음
//   · 대화 상태(세션 번호 · rev · 카드 · 계산한 Estimate)는 이 모듈 메모리에만 — 앱을 다시 열면 voice-session resume으로 말 · 카드 상태를 서버에서 받음 (Estimate는 안 남으니 저장 때 다시 계산)
//     다시 열 때 계산이 안 끝난 카드(NEEDS_ESTIMATE)는 이어서 계산해 results만 보냄. 저장한 카드는 서버에 SAVED를 알리기 전에 로컬(savedMarks.ts)에 적어 두어, 알림이 안 가고 꺼져도 일정이 두 벌 생기지 않게 함
//   · 서버 요청은 pending 하나 + 카드 요청 큐 — 실패한 요청(pending)이 있으면 카드 동작은 앱 일만 바로 하고 서버 알림은 큐에서 기다렸다가 그 요청이 성공한 뒤 차례로 보냄
import { adjustEstimate, orderError } from '@/features/alarm/adjust';
import { createAppointment, createStandaloneAlarm, estimateAppointment, getAppointment, listPlaces, previewAlarms, saveAlarmSettings } from '@/features/alarm/api';
import { saveNotice } from '@/features/alarm/saveNotice';
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
  type SaveFollowUp,
  type Transport,
} from '@/features/alarm/types';
import { now } from '@/lib/clock';
import { EdgeError, callEdge } from '@/lib/edge';
import { UserError, userMessage } from '@/lib/errors';
import { currentUserId } from '@/lib/user';
import type { Weekday } from '@/lib/weekday';

import { applyFix, type Fix } from './fixes';
import { addPendingCommit, isFinished, pendingCommits, removePendingCommit } from './finishedSessions';
import { clearSaved, markSaved, pruneExpired, pruneOtherSessions, readSavedMarks } from './savedMarks';
import type { ChatMessage, CardAlarm, CardKind, CardStatus, Conversation, ConversationCard, FixResult, Limits, TurnNotice, Unavailable } from './types';

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

// 카드의 고칠 값 — ALARM_EDIT는 설계 2.2 그대로. APPT_NEW 카드도 서버가 같은 칸(times · levels · prepare_delta)을 채움 (#265)
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
  prev_session_ids?: string[]; // 같은 대화방의 앞 구간 세션(기준일이 달라 기록만 나뉨) — 화면 말 · 카드는 이미 이어서 옴
};

type TurnResponse = {
  rev: number;
  next: 'USER' | 'APP_TASKS';
  reply: { text: string } | null;
  cards?: ServerCard[];
  fixes?: ServerFix[];
  limits?: ServerLimits;
  notice?: TurnNotice; // 이 말의 일정 추출(T2F)을 못 함 — 사용량 상한 · 시간 초과 · 오류
  ask?: string[]; // 음성 차례만: 되물을 것 — Live가 소리로 물음
};

type ResultCard = { id: string; status: 'READY' | 'NEEDS_PLACE' | 'FAILED'; estimate: { alarms: { kind: string; at: string; enabled: boolean }[]; level: number; with_wake: boolean; basis?: Basis } | null; error: string | null };

// 기상 알람 계산 근거(분) — 서버가 "왜 이 시각이야?"에 답하려고 받음. 서버는 믿지 않고 합(기상 = 약속 − 이동 − 준비 − 여유)이 맞을 때만 씀
type Basis = { travel_minutes: number; prepare_minutes: number; buffer_minutes: number };

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

// 카드 동작(저장 · 반려 · 장소 고른 뒤 results)이 서버에 알릴 요청 — 앞 요청이 끝나야 rev를 알 수 있어 보낼 때 body를 만듦
//   saved = 저장됨 로컬 표시를 달고 있는 SAVED 알림 — 서버가 받으면(또는 카드를 모르면) 그 표시를 지움
type Queued = {
  phase: 'RESULTS' | 'CARD';
  turnId: string;
  make: (sessionId: string, rev: number) => Record<string, unknown>;
  retried?: boolean;
  saved?: { userId: string; sessionId: string; cardId: string };
};

// quiet = 카드에서 시작한 요청 — 서버가 거절해도 던지지 않음(앱에서 한 일은 그대로). src = 그 요청의 큐 항목(CONFLICT 때 새 rev로 한 번 더)
type Pending = { phase: 'TEXT' | 'RESULTS' | 'CARD'; body: Record<string, unknown>; turnId: string; quiet?: boolean; src?: Queued };

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
  queue: Queued[]; // pending이 끝나길 기다리는 카드 요청 — 앞 요청이 성공하면 차례로 보냄 (pending을 덮어쓰지 않음)
  seq: number;
  notice: TurnNotice | null; // 지금 처리 중인 말의 추출을 못 함 — 말마다 비움
  ask: string[]; // 지금 처리 중인 음성 말에서 되물을 것 — 말마다 비움
};

function freshState(userId: string | null): State {
  return { userId, sessionId: null, rev: 0, started: false, messages: [], cards: new Map(), limits: null, unavailable: null, pending: null, queue: [], seq: 0, notice: null, ask: [] };
}

let state: State = freshState(null);

// 시험용 — 모듈 상태 비우기
export function resetVoiceState() {
  state = freshState(null);
  chain = Promise.resolve();
  progress = null;
  flushing = null;
}

// 말 하나를 처리하는 도중의 대화 — 화면이 끝을 기다리지 않고 그때그때 그림 (내 말 · 카드 계산 시작 · 계산 끝). say · sayVoice가 도는 동안만
let progress: ((c: Conversation) => void) | null = null;
const report = () => progress?.(snapshot());

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
    notice: state.notice,
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
  if (res.notice) state.notice = res.notice;
  if (res.ask?.length) state.ask = res.ask;
  if (res.reply?.text) pushMessage('ai', res.reply.text, at);
  mergeCards(res.cards, at);
  if (res.next !== 'APP_TASKS') return null;
  report(); // 카드 계산 시작 — 화면은 "일정 카드를 생성하고 있어요"
  const results = await runTasks(res);
  report(); // 계산 끝 — 카드를 바로 보여 줌 (안내 답 T1은 results 응답으로 뒤에 옴)
  return { phase: 'RESULTS', turnId, body: { session_id: state.sessionId, rev: res.rev, client_turn_id: turnId, results } };
}

// ---------------------------------------------------------------------------
// 앱 일 — 카드 계산 · 정정
// ---------------------------------------------------------------------------

type Outcome = { status: 'READY' | 'NEEDS_PLACE' | 'FAILED'; estimate?: Estimate; alarms?: CardAlarm[]; level?: number; withWake?: boolean; basis?: Basis; error?: string };

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

// L1 결과에 실제로 있는 값만 근거로 — 하나라도 없거나 숫자가 아니면 생략 (서버는 근거가 없으면 "모른다"고 함). 준비 = 기상~준비 알람 + 준비 알람~출발
function basisOf(a: { travelMinutes?: unknown; prepMinutes?: unknown; beforePrepMinutes?: unknown; bufferMinutes?: unknown; withWake?: unknown }): Basis | undefined {
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  if (a.withWake !== true) return undefined;
  const travel = n(a.travelMinutes);
  const prep = n(a.prepMinutes);
  const before = a.beforePrepMinutes === undefined ? 0 : n(a.beforePrepMinutes);
  const buffer = n(a.bufferMinutes);
  if (travel === null || prep === null || before === null || buffer === null) return undefined;
  return { travel_minutes: travel, prepare_minutes: prep + before, buffer_minutes: buffer };
}

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
    return { status: 'READY', estimate, alarms: ringAlarms(estimate.appointment.alarms), level, withWake: estimate.appointment.withWake, basis: basisOf(estimate.appointment) };
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
        ? { alarms: (o.alarms ?? []).map((a) => ({ kind: a.kind, at: a.at.toISOString(), enabled: a.enabled })), level: o.level ?? 1, with_wake: o.withWake ?? false, ...(o.basis ? { basis: o.basis } : {}) }
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

// 분당 사용량에 막힘(서버 관문 RPM · TPM · 동시 요청, Gemini 429) — LLM_UNAVAILABLE의 details.code RATE_LIMITED
const unavailableOf = (e: EdgeError): Unavailable => ({
  code: e.code,
  message: e.message,
  canRetry: true,
  ...((e.details as { code?: unknown } | null | undefined)?.code === 'RATE_LIMITED' ? { rateLimited: true } : {}),
});

// 오류가 났을 때 — 대화를 남기고 [다시 시도]를 보일 것이면 상태에 적고 돌아옴(그 요청 p는 pending에 남음), 아니면 던짐 (CONFLICT는 세션을 다시 읽은 뒤 던짐)
//   p = 실패한 요청 (세션 시작이면 없음). unavailable은 p가 pending에 남아 [다시 시도]가 다시 보낼 때만 적음 — 죽은 안내가 남지 않게
async function onError(e: unknown, p: Pending | null = null): Promise<void> {
  if (!(e instanceof EdgeError)) {
    if (p) state.pending = null;
    throw e;
  }
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
  state.unavailable = null;
  if (e.code === 'NOT_FOUND' && p?.src?.saved) await clearSaved(p.src.saved.userId, p.src.saved.sessionId, p.src.saved.cardId); // 서버가 모르는 카드 — 다시 알릴 수 없음
  // CONFLICT = rev 어긋남, NOT_FOUND = 세션 · 카드를 모름 — 서버 상태를 다시 읽음 (세션이 없어졌으면 resume이 새로 시작). 기다리는 큐는 그대로 — 새 rev로 보냄
  if (e.code === 'CONFLICT' || e.code === 'NOT_FOUND') await readSession(true);
  // 카드 요청이 rev 어긋남으로 거절됐으면 서버가 받지 않았으니 새 rev로 한 번 더 (같은 client_turn_id)
  if (e.code === 'CONFLICT' && p?.src && !p.src.retried) {
    p.src.retried = true;
    state.queue.unshift(p.src);
  }
  throw e;
}

// 큐의 다음 요청을 pending으로 — 지금 sessionId · rev로 body를 만듦
function startNext(): boolean {
  const q = state.queue.shift();
  if (!q) return false;
  if (!state.sessionId) {
    state.queue = [];
    return false;
  }
  state.pending = { phase: q.phase, turnId: q.turnId, body: q.make(state.sessionId, state.rev), quiet: true, src: q };
  return true;
}

// 보낼 요청을 끝까지 — 앱 일이 있으면 results까지, 이어서 큐의 카드 요청을 차례로. 답을 못 받으면 그 요청을 pending에 남기고 unavailable (큐는 그 뒤에 기다림)
//   카드에서 시작한 요청(quiet)의 거절은 삼키고 다음 요청으로, 말(TEXT)의 거절은 큐를 다 보낸 뒤 던짐
async function drive(): Promise<void> {
  let failed: { error: unknown } | null = null;
  while (state.pending || state.queue.length > 0) {
    if (!state.pending && !startNext()) break;
    const p = state.pending as Pending;
    let res: TurnResponse;
    try {
      res = await callEdge<TurnResponse>('voice-turn', p.body, { timeoutMs: TURN_TIMEOUT_MS });
    } catch (e) {
      try {
        await onError(e, p);
        break; // unavailable — p는 pending에 남음, [다시 시도]가 이어 감
      } catch (err) {
        if (!p.quiet && !failed) failed = { error: err };
        continue;
      }
    }
    state.unavailable = null;
    state.pending = null;
    if (p.src?.saved) await clearSaved(p.src.saved.userId, p.src.saved.sessionId, p.src.saved.cardId); // 서버가 SAVED를 받음 — 로컬 표시는 이제 필요 없음
    const next = await absorb(res, p.turnId);
    if (next && p.quiet) next.quiet = true;
    state.pending = next;
  }
  if (failed) throw failed.error;
}

// 카드 요청을 큐에 넣고, 앞에 못 끝난 요청(pending)이 없으면 바로 보냄 — 있으면 그 요청의 [다시 시도]가 성공한 뒤 차례로 (pending을 덮어쓰지 않음)
async function submitCard(item: Queued): Promise<void> {
  if (!state.sessionId) return;
  state.queue.push(item);
  if (state.pending) return;
  try {
    await drive();
  } catch {
    // 카드 요청의 거절은 삼킴 — 앱에서 한 일은 그대로
  }
}

// ---------------------------------------------------------------------------
// 세션
// ---------------------------------------------------------------------------

// 저장은 했는데 서버에 SAVED를 못 알린 카드(로컬 '저장됨' 표시)를 저장됨으로 복원 — 서버가 READY · NEEDS_*로 줘도 createAppointment를 또 부르지 않게.
//   서버가 이미 SAVED · REJECTED로 알면 표시를 지움. renotify(앱을 다시 연 때)면 서버에 SAVED만 다시 알림(큐). 서버가 모르는 카드는 건드리지 않음
//   prevSessionIds = 같은 대화방의 앞 구간 세션(서버 prev_session_ids) — 그 구간에서 저장하고 못 알린 표시는 지우지 않고 지금 세션으로 옮김 (카드 번호가 구간을 넘어 그대로라)
async function restoreSaved(sessionId: string, renotify: boolean, prevSessionIds: readonly string[] = []): Promise<void> {
  const userId = state.userId;
  if (!userId) return; // 로그인 전 — 표시를 쓰지 않음 (저장 · 대화는 그대로)
  for (const prev of prevSessionIds) {
    const current = await readSavedMarks(userId, sessionId);
    for (const [cardId, mark] of Object.entries(await readSavedMarks(userId, prev))) {
      if (!(cardId in current)) await markSaved(userId, sessionId, cardId, mark);
    }
  }
  await pruneOtherSessions(userId, sessionId);
  const marks = await readSavedMarks(userId, sessionId);
  for (const [cardId, mark] of Object.entries(marks)) {
    const rec = state.cards.get(cardId);
    if (!rec) continue;
    if (rec.status === 'SAVED' || rec.status === 'REJECTED') {
      await clearSaved(userId, sessionId, cardId);
      continue;
    }
    rec.status = 'SAVED';
    rec.estimate = null;
    rec.error = null;
    rec.appointmentId = mark.appointmentId;
    rec.alarms = mark.alarms.map((a) => ({ kind: a.kind as AlarmKind, at: new Date(a.at), enabled: a.enabled }));
    if (!renotify || state.queue.some((q) => q.saved?.cardId === cardId) || state.pending?.src?.saved?.cardId === cardId) continue;
    const turnId = newId();
    state.queue.push({
      phase: 'CARD',
      turnId,
      saved: { userId, sessionId, cardId },
      make: (session_id, rev) => ({
        session_id,
        rev,
        client_turn_id: turnId,
        card_action: { id: cardId, action: 'SAVED', appointment_id: mark.appointmentId, alarms: mark.alarms },
      }),
    });
  }
}

// fresh = 앱을 (다시) 열어 시작하는 읽기 — 저장 표시가 남은 카드는 서버에 SAVED를 다시 알림. 오류 뒤 다시 읽기(CONFLICT · NOT_FOUND)는 복원만
async function readSession(resume: boolean, fresh = false): Promise<void> {
  let res = await callEdge<SessionResponse>('voice-session', { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume });
  // 예전 방식으로 [완료]한 세션(정리 실패로 서버에 안 끝난 채 남음)을 resume이 돌려주면 무시하고 새 세션 — 옛 세션을 합치지 않음.
  //   지금은 [완료]가 완료 표시를 적지 않으므로(같은 날 같은 대화를 이어 씀) 업데이트 전에 적힌 표시에만 걸림
  if (resume && res.resumed && res.session_id && state.userId && (await isFinished(state.userId, res.session_id))) {
    res = await callEdge<SessionResponse>('voice-session', { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: false });
  }
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
  if (fresh) await pruneExpired(now()); // 앱을 열 때 — 모든 사용자의 7일 지난 표시 · 옛 형식 키 정리
  if (fresh) void flushCommits(state.userId); // 지난번에 못 보낸 대화 끝 정리
  if (res.session_id) await restoreSaved(res.session_id, fresh, res.prev_session_ids ?? []);
  for (const [id, old] of done) {
    const rec = state.cards.get(id);
    if (rec && res.session_id && rec.status !== 'SAVED' && rec.status !== 'REJECTED') {
      rec.status = old.status;
      rec.appointmentId = old.appointmentId;
      rec.alarms = old.alarms;
    }
  }
}

// 앱을 다시 열었더니 계산이 안 끝난 카드(NEEDS_ESTIMATE)가 있으면 — 계산 중에 앱이 꺼져 서버는 results를 기다리는 중 — 이어서 계산해
//   새 client_turn_id로 results만 보냄 (장소 고른 뒤와 같은 길). 장소가 필요한 카드는 NEEDS_PLACE로 알려 카드의 [장소 고르기]가 이어 감
//   서버가 계산 요청에 정정(fixes)도 기다리면 results 응답이 next = APP_TASKS로 그 정정을 다시 줌 — drive가 이어서 함
async function continueAfterOpen(): Promise<void> {
  const results: ResultCard[] = [];
  for (const [id, rec] of state.cards) {
    if (rec.status !== 'NEEDS_ESTIMATE') continue;
    rec.status = 'ESTIMATING';
    const outcome = await runCard(rec);
    applyOutcome(rec, outcome);
    results.push(resultCard(id, outcome));
  }
  if (results.length > 0) await sendResults(results);
  else if (state.queue.length > 0 && !state.pending) await drive();
}

// 대화 시작 — 오늘(KST) 연 세션이 있으면 그대로(resume, [완료]한 뒤에도), 없으면 새로. 첫 마디는 서버 템플릿이라 messages에 옴. 하루 한도면 세션 없이 limits.reached = DAY
export async function startConversation(_opts: { type: 'BEFORE_SLEEP' } = { type: 'BEFORE_SLEEP' }): Promise<void> {
  try {
    await readSession(true, true);
    await continueAfterOpen();
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

// 말 하나를 처리하는 동안만 진행 상황을 화면에 알림
async function withProgress<T>(onProgress: ((c: Conversation) => void) | undefined, task: () => Promise<T>): Promise<T> {
  progress = onProgress ?? null;
  state.notice = null;
  state.ask = [];
  try {
    return await task();
  } finally {
    progress = null;
  }
}

// 말하기 — 글을 보내고 AI 답(필요하면 앱 일 뒤 마지막 답)까지. 못 보내면 말은 남고 [다시 시도]
//   onProgress — 끝을 기다리지 않고 도중의 대화를 받음 (카드 계산 중 · 계산 끝 카드). 안내 답(T1)이 늦어도 카드는 먼저 보이게
export function say(text?: string, onProgress?: (c: Conversation) => void): Promise<Conversation> {
  return serial(() =>
    withProgress(onProgress, async () => {
      await ensureSession();
      const typed = text?.trim();
      if (!typed || !state.sessionId || state.pending || state.queue.length > 0 || state.limits?.reached) return snapshot();
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
    }),
  );
}

// 실시간 음성(Gemini Live) 한 차례 — 내가 한 말과 Live가 소리로 한 답을 같은 대화에 남김 (서버는 일정 추출만, 되물을 게 있을 때만 글 답)
//   일정이면 글과 같은 길: 카드 계산(APP_TASKS) → results → 카드 안내 답. kept = 대화에 넣었음 — 화면은 음성 임시 말풍선을 내림
//   못 넣으면 kept false + reason (LIMIT 대화 한도 · BUSY 앞 요청이 [다시 시도]를 기다림) — 음성 말풍선은 화면에만 남고 화면이 까닭을 알림
//   notice = 넣었지만 일정 추출을 못 함 (사용량 상한 · 시간 초과)
//   ask = 일정에서 아직 모르는 것 — 화면이 Live에 넣어 Live가 소리로 되물음 (T1 글 질문 없음)
export type VoiceKept = { kept: boolean; reason?: 'LIMIT' | 'BUSY'; notice?: TurnNotice | null; ask?: string[] };
const MAX_VOICE_CHARS = 1000; // 서버가 받는 한 말의 최대 글자 수 (voice-turn MAX_TEXT_CHARS)
export function sayVoice(heard: string, spoken: string, onProgress?: (c: Conversation) => void): Promise<VoiceKept> {
  return serial(() =>
    withProgress(onProgress, async (): Promise<VoiceKept> => {
      await ensureSession();
      const me = heard.trim().slice(0, MAX_VOICE_CHARS);
      const ai = spoken.trim().slice(0, MAX_VOICE_CHARS);
      if (!me || !state.sessionId) return { kept: false };
      if (state.limits?.reached) return { kept: false, reason: 'LIMIT' };
      if (state.pending || state.queue.length > 0) return { kept: false, reason: 'BUSY' };
      const turnId = newId();
      const at = now();
      pushMessage('me', me, at);
      const sent = state.messages.slice(-1);
      if (ai) {
        pushMessage('ai', ai, at);
        sent.push(state.messages[state.messages.length - 1]);
      }
      state.pending = { phase: 'TEXT', turnId, body: { session_id: state.sessionId, rev: state.rev, client_turn_id: turnId, text: me, spoken_reply: ai } };
      try {
        await drive();
      } catch (e) {
        state.messages = state.messages.filter((m) => !sent.includes(m)); // 못 남겼으면 음성 말풍선으로 남김
        throw e;
      }
      return { kept: true, notice: state.notice, ...(state.ask.length > 0 ? { ask: state.ask } : {}) };
    }),
  );
}

// 지금 대화방 id — Live 토큰을 받을 때 서버가 앞 대화를 지침에 붙이게 (없으면 null)
export const liveSessionId = (): string | null => state.sessionId;

// [다시 시도] — 세션을 못 시작했으면 다시 시작, 보낸 요청이 남았으면 같은 요청(같은 client_turn_id)을 다시 (성공하면 뒤에 쌓인 카드 요청도 차례로)
export function retry(): Promise<Conversation> {
  return serial(async () => {
    await guardUser();
    if (!state.sessionId && !state.limits?.reached) {
      state.unavailable = null;
      state.started = false;
      await startConversation({ type: 'BEFORE_SLEEP' });
    } else if (state.pending || state.queue.length > 0) {
      state.unavailable = null;
      await drive();
    }
    return snapshot();
  });
}

// 대화 끝 정리(서버 voice-commit — T2 전체 추출 → 할 일 · 준비물 · 생활 기록 저장, 일정 · 알람은 카드로만) — 적어 둔 세션을 차례로 보냄
//   DONE · SKIPPED(정리할 것 없음) · 다시 해도 안 되는 오류(NOT_FOUND · VALIDATION_FAILED)면 목록에서 지움. PARTIAL · RUNNING · 실패는 남겨 다음 대화 열기 때 다시 (서버가 한 번만 저장)
//   STALE(정리하는 사이 같은 대화에 새 말이 들어옴)도 남김 — 다음 열기 때 다시 보내 새 말까지 정리 (이미 저장한 것은 서버가 건너뜀)
//   서버가 T2를 부르므로(19초 · 다시 시도 1번) 대화 화면의 직렬 큐 밖에서 — 새 대화 열기를 막지 않게. 동시에 두 번 돌지 않음
export const COMMIT_TIMEOUT_MS = 45_000;
let flushing: Promise<void> | null = null;
export function flushCommits(userId: string | null): Promise<void> {
  if (!userId) return Promise.resolve();
  flushing ??= (async () => {
    try {
      for (const { sessionId, rejected } of await pendingCommits(userId)) {
        try {
          const body = rejected.length > 0 ? { session_id: sessionId, rejected_cards: rejected } : { session_id: sessionId };
          const res = await callEdge<{ status?: string }>('voice-commit', body, { timeoutMs: COMMIT_TIMEOUT_MS });
          if (res?.status === 'DONE' || res?.status === 'SKIPPED') await removePendingCommit(userId, sessionId);
        } catch (e) {
          if (e instanceof EdgeError && (e.code === 'NOT_FOUND' || e.code === 'VALIDATION_FAILED')) await removePendingCommit(userId, sessionId);
        }
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

// [완료] — 하루 기록 정리(voice-commit)를 적어 두고 화면 상태를 비움. 세션은 끝내지 않음: 같은 날 다시 열면 서버 resume이 같은 대화(말 · 카드)를 돌려주고,
//   이어 말한 뒤 다시 [완료]하면 서버가 새 말까지 다시 정리함. 날짜(KST)가 바뀌면 서버가 새 대화를 엶
//   서버로 가야 할 카드 알림(SAVED 등)이 큐에 남았으면 비우기 전에 한 번 보내 봄 (실패해도 삼킴). 그 뒤 정리를 기다리지 않고 보냄
export function finishConversation(): Promise<{ recordDate: string | null }> {
  return serial(async () => {
    await guardUser();
    if (!state.started) return { recordDate: null };
    // 한 마디도 안 한 대화는 정리할 것이 없음
    const spoke = state.messages.some((m) => m.who === 'me');
    if (spoke && state.userId && state.sessionId) {
      // [저장 안 함]한 카드 — 그 알림이 실패했거나 앞 요청([다시 시도] 대기)에 막혀 큐에서 사라져도 정리 요청에 실어 보내 서버가 REJECTED로
      const rejected = [...state.cards].filter(([, rec]) => rec.status === 'REJECTED').map(([id]) => id);
      await addPendingCommit(state.userId, state.sessionId, rejected);
    }
    if (state.sessionId && !state.pending && state.queue.length > 0) {
      try {
        await drive();
      } catch {
        // 이미 앱에서 한 일은 그대로
      }
    }
    state = freshState(state.userId); // 세션 · 말 · 카드까지 비움 — 다음 열기가 서버에서 다시 읽음 (같은 날이면 같은 대화)
    // 카드 알림을 먼저 보낸 뒤(위 drive) 정리 — 정리는 그 순간의 카드 상태로 일정 확인 상태를 정함
    if (spoke) void flushCommits(state.userId);
    return { recordDate: null };
  });
}

function recOf(id: string): CardRec {
  const rec = state.cards.get(id);
  if (!rec) throw new UserError('찾을 수 없는 카드예요');
  return rec;
}

// 카드 상태를 서버에 알림 — 이미 저장한 일은 되돌리지 않으므로 실패해도 던지지 않음. 앞에 못 끝난 요청이 있으면 큐에서 기다림
//   서버가 거절해도(CONFLICT는 세션을 다시 읽고 새 rev로 한 번 더) 앱에서 한 저장은 그대로
//   saved = 저장됨 로컬 표시를 지울 카드 (SAVED 알림 — 서버가 받으면 지움)
async function notifyCard(action: Record<string, unknown>, saved?: { cardId: string }): Promise<void> {
  const turnId = newId();
  await submitCard({
    phase: 'CARD',
    turnId,
    make: (session_id, rev) => ({ session_id, rev, client_turn_id: turnId, card_action: action }),
    ...(saved && state.userId && state.sessionId ? { saved: { userId: state.userId, sessionId: state.sessionId, cardId: saved.cardId } } : {}),
  });
}

// 저장한 카드를 '저장됨'으로 로컬에 적음 — 서버에 알리기 전에. 앱이 꺼져 알림이 안 가도 다시 열면 이 표시로 일정이 두 벌 생기지 않게 (저장소 오류는 삼킴)
async function rememberSaved(cardId: string, cardKind: CardKind, appointmentId: string, alarms: readonly { kind: AlarmKind; at: Date; enabled: boolean }[], level: number): Promise<void> {
  if (!state.userId || !state.sessionId) return; // 로그인 전이면 표시를 쓰지 않음
  await markSaved(state.userId, state.sessionId, cardId, { appointmentId, cardKind, alarms: alarmSummary(alarms, level), savedAt: now().toISOString() });
}

// 저장 뒤 알람 한 줄씩 — 서버가 말할 숫자 (종류 · 시각 · 켜짐 · 강도만, 이동 분은 안 보냄 — D5)
const alarmSummary = (alarms: readonly { kind: AlarmKind; at: Date; enabled: boolean }[], level: number) =>
  ringAlarms(alarms).map((a) => ({ kind: a.kind, at: a.at.toISOString(), enabled: a.enabled, level }));

// 새 약속 저장 뒤 준비 +N · 강도 — 실제로 바뀔 때만 saveAlarmSettings 한 번 더 (L1 답 L1-1). 바꾼 뒤의 약속과 그 저장의 뒤처리 결과를 돌려줌
async function adjustAfterSave(id: string, edit: ServerEdit | null | undefined): Promise<{ after: AppointmentDetail | null; followUp?: SaveFollowUp } | null> {
  const delta = prepDeltaOf(edit);
  if (delta == null && LEVEL_AXES.every((axis) => wantedLevelOf(edit, axis) === undefined)) return null; // 고칠 말 없음
  const detail = await getAppointment(id);
  if (!detail) return null;
  const { draft, changed, levelChanged } = editsOf(detail, { prepare_delta: delta ?? undefined, levels: edit?.levels });
  if (!changed && !levelChanged) return null; // 이미 그 값 — 길찾기를 또 부르지 않음
  const { followUp } = await saveAlarmSettings(id, draft);
  return { after: await getAppointment(id), followUp };
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
    // 저장은 됐는데 폰 예약 · 준비물이 못 한 것 (saveNotice.ts) — 있으면 성공 문구 대신 이것. partial도 있으면 둘 다 (폰 안내가 앞)
    let notice: string | null = null;

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
      await rememberSaved(cardId, kind, saved.id, alarms, level); // 서버에 알리기 전에 — 앱이 꺼져도 다시 저장되지 않게
      let followUp = saved.followUp;
      try {
        const adjusted = await adjustAfterSave(saved.id, rec.server.edit);
        if (adjusted) {
          // 두 번째 저장이 폰 예약을 다시 했으니 못 건 수는 그 결과로, 준비물은 첫 저장 결과 그대로
          const phoneFailed = adjusted.followUp?.phoneFailed ?? 0;
          const itemsFailed = saved.followUp?.itemsFailed === true;
          followUp = phoneFailed > 0 || itemsFailed ? { phoneFailed, itemsFailed } : undefined;
        }
        if (adjusted?.after) {
          alarms = adjusted.after.alarms;
          level = adjusted.after.level;
          await rememberSaved(cardId, kind, saved.id, alarms, level); // 바뀐 알람으로 갱신
        }
      } catch {
        partial = `${saved.title}은 저장했지만 준비 시간 · 강도는 바꾸지 못했어요. 알람 설정에서 바꿔 주세요`;
      }
      notice = saveNotice(followUp, `${saved.title} 일정은 저장했지만`);
    } else if (kind === 'ALARM_EDIT') {
      const id = rec.server.edit?.appointment_id;
      const detail = id ? await getAppointment(id) : null;
      if (!id || !detail) throw new UserError('바꿀 일정을 찾지 못했어요');
      const { followUp } = await saveAlarmSettings(id, editsOf(detail, rec.server.edit).draft);
      notice = saveNotice(followUp, '바꾼 값은 저장했지만');
      const after = await getAppointment(id);
      appointmentId = id;
      alarms = after?.alarms ?? detail.alarms;
      level = after?.level ?? detail.level;
      toast = '알람을 바꿨어요';
      rec.status = 'SAVED';
      rec.appointmentId = id;
      await rememberSaved(cardId, kind, id, alarms, level);
    } else if (kind === 'ALARM_NEW') {
      const at = rec.server.edit?.at ? new Date(rec.server.edit.at) : null;
      if (!at || Number.isNaN(at.getTime())) throw new UserError('알람 시각을 알 수 없어요');
      const lv = toLevel(rec.server.edit?.level);
      const saved = await createStandaloneAlarm({ at, ...(lv != null ? { level: lv } : {}) });
      notice = saveNotice(saved.followUp, '알람은 저장했지만');
      appointmentId = saved.id;
      alarms = saved.alarms;
      level = saved.level;
      rec.status = 'SAVED';
      rec.appointmentId = saved.id;
      await rememberSaved(cardId, kind, saved.id, alarms, level);
    } else {
      throw new UserError('이 카드는 저장할 게 없어요');
    }

    await notifyCard({ id: cardId, action: 'SAVED', appointment_id: appointmentId, alarms: alarmSummary(alarms, level) }, { cardId });
    // 한 문구만 보이면 다른 쪽(폰에 못 건 알람 · 준비 시간 · 강도 못 바꿈)을 모르므로 둘 다 나면 이어 붙임
    if (notice && partial) return `${notice}. 준비 시간 · 강도도 바꾸지 못했어요. 알람 설정에서 바꿔 주세요`;
    return notice ?? partial ?? toast;
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

// 앱이 계산한 카드 결과만 서버에 알림 — 새 client_turn_id (장소 고른 뒤 · 다시 연 뒤 이어서 계산). 서버(#265 handleResults)는 기다리는 앱 일이 없어도 받음
async function sendResults(cards: ResultCard[]): Promise<void> {
  const turnId = newId();
  await submitCard({ phase: 'RESULTS', turnId, make: (session_id, rev) => ({ session_id, rev, client_turn_id: turnId, results: { cards, fixes: [] } }) });
}

// 카드 [장소 고르기] — 고른 곳으로 다시 계산해 READY로, 결과를 서버에 알림 (새 client_turn_id로 results만 보냄 — 서버(#265)가 받음)
export function pickCardPlace(cardId: string, place: { name: string; lat?: number; lng?: number }): Promise<void> {
  return serial(async () => {
    const rec = recOf(cardId);
    if (typeof place.lat !== 'number' || typeof place.lng !== 'number') throw new UserError('이 장소는 위치를 몰라요. 다른 곳을 골라 주세요');
    rec.place = { name: place.name, lat: place.lat, lng: place.lng };
    rec.status = 'ESTIMATING';
    const outcome = await runCard(rec);
    applyOutcome(rec, outcome);
    if (!state.sessionId) return;
    // 서버가 받지 않아도 이 카드는 앱에서 계산한 상태 그대로
    await sendResults([resultCard(cardId, outcome)]);
  });
}
