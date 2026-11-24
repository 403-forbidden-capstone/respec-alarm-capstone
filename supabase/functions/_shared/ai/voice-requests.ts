// voice-session · voice-turn 요청 읽기 (순수 · node --test) — 모양은 설계 메모 2.1 · 2.2 · 14절.
//   voice-session { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume }
//   voice-turn    { session_id, rev, client_turn_id, text, spoken_reply? } | { …, results } | { …, card_action } 중 정확히 하나
//                 spoken_reply = 실시간 음성(Gemini Live)이 이미 소리로 한 답 — 있으면 음성 차례: 말을 쌓고 추출만, 글 답(T1)은 안 만듦
import { HttpError } from '../errors.ts';
import { parseIso, Reader } from '../read.ts';
import type { AlarmType, CardAction, TaskResults } from './types.ts';

const ALARM_KINDS = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'] as const satisfies readonly AlarmType[];
const CARD_ID = /^c\d{1,4}$/;
const FIX_ID = /^x\d{1,4}$/;
export const MAX_TEXT_CHARS = 1000;

export interface SessionRequest {
  session_type: 'BEFORE_SLEEP';
  input_mode: 'TEXT';
  resume: boolean;
}

export function readSessionRequest(body: unknown): SessionRequest {
  const r = Reader.root(body);
  const type = r.string('session_type', { required: true, max: 40 });
  const mode = r.string('input_mode', { max: 40 }) ?? 'TEXT';
  const resume = r.bool('resume') ?? true;
  r.finish();
  // v0는 자기 전 대화 · 글만 (설계 메모 2.1) — 5장 값(AFTER_WAKE · ANYTIME · VOICE)은 알지만 아직 안 함
  if (type !== 'BEFORE_SLEEP') throw new HttpError('VALIDATION_FAILED', '아직 자기 전 대화만 할 수 있어요', { issues: [{ path: 'session_type', message: 'BEFORE_SLEEP만 받아요' }] });
  if (mode !== 'TEXT') throw new HttpError('VALIDATION_FAILED', '아직 글로 하는 대화만 할 수 있어요', { issues: [{ path: 'input_mode', message: 'TEXT만 받아요' }] });
  return { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume };
}

interface TurnBase {
  session_id: string;
  rev: number;
  client_turn_id: string;
}
export type TurnRequest =
  | (TurnBase & { kind: 'text'; text: string; spoken_reply?: string })
  | (TurnBase & { kind: 'results'; results: TaskResults })
  | (TurnBase & { kind: 'card'; card_action: CardAction });

// ISO 8601(오프셋 있음) 글자를 받아 같은 글자로 돌려줌 — 맞지 않으면 문제로 기록
function isoField(r: Reader, key: string): string | undefined {
  const v = r.string(key, { required: true, max: 40 });
  if (v === undefined) return undefined;
  if (parseIso(v) === undefined) {
    r.problemAt(key, '시각은 오프셋이 있는 ISO 8601이어야 해요 (예: 2026-10-30T07:40:00+09:00)');
    return undefined;
  }
  return v;
}

function readAlarmEntry(a: Reader): { kind: AlarmType; at: string; enabled: boolean; level: number | null } | undefined {
  const kind = a.oneOf('kind', ALARM_KINDS, { required: true });
  const at = isoField(a, 'at');
  const enabled = a.bool('enabled', { required: true });
  const level = a.int('level', { min: 0, max: 2 }) ?? null;
  return kind && at && enabled !== undefined ? { kind, at, enabled, level } : undefined;
}

function readResults(r: Reader): TaskResults {
  const cards: TaskResults['cards'] = [];
  for (const c of r.objects('cards', { max: 20 }) ?? []) {
    const id = c.string('id', { required: true, pattern: CARD_ID });
    const status = c.oneOf('status', ['READY', 'NEEDS_PLACE', 'FAILED'] as const, { required: true });
    const error = c.string('error', { max: 300 }) ?? null;
    const est = c.object('estimate');
    let estimate: NonNullable<TaskResults['cards'][number]['estimate']> | null = null;
    if (est) {
      const alarms: { kind: AlarmType; at: string; enabled: boolean }[] = [];
      for (const a of est.objects('alarms', { required: true, max: 8 }) ?? []) {
        const e = readAlarmEntry(a);
        if (e) alarms.push({ kind: e.kind, at: e.at, enabled: e.enabled });
      }
      const level = est.int('level', { min: 0, max: 2 }) ?? null;
      const withWake = est.bool('with_wake') ?? false;
      estimate = { alarms, level, with_wake: withWake };
    }
    // READY인데 계산 요약이 없으면 받을 수 없음 (서버가 요약을 믿지 않고 범위를 검사하므로 모양까지만 여기서)
    if (status === 'READY' && !est) c.problemAt('estimate', 'READY는 estimate가 필요해요');
    if (id && status) cards.push({ id, status, estimate, error });
  }
  const fixes: TaskResults['fixes'] = [];
  for (const f of r.objects('fixes', { max: 20 }) ?? []) {
    const id = f.string('id', { required: true, pattern: FIX_ID });
    const ok = f.bool('ok', { required: true });
    const error = f.string('error', { max: 300 }) ?? null;
    if (id && ok !== undefined) fixes.push({ id, ok, error });
  }
  return { cards, fixes };
}

function readCardAction(r: Reader): CardAction {
  const id = r.string('id', { required: true, pattern: CARD_ID });
  const action = r.oneOf('action', ['SAVED', 'REJECTED', 'GROUP'] as const, { required: true });
  const groupId = r.uuid('group_id') ?? null; // GROUP — null = 개인 일정
  const appointmentId = r.uuid('appointment_id') ?? null;
  const alarms: NonNullable<CardAction['alarms']> = [];
  for (const a of r.objects('alarms', { max: 8 }) ?? []) {
    const e = readAlarmEntry(a);
    if (e) alarms.push(e);
  }
  return { id: id ?? '', action: action ?? 'REJECTED', appointment_id: appointmentId, alarms, ...(action === 'GROUP' ? { group_id: groupId } : {}) };
}

export function readTurnRequest(body: unknown): TurnRequest {
  const r = Reader.root(body);
  const base: TurnBase = {
    session_id: r.uuid('session_id', { required: true }) ?? '',
    rev: r.int('rev', { required: true, min: 0 }) ?? 0,
    client_turn_id: r.uuid('client_turn_id', { required: true }) ?? '',
  };
  const given = (['text', 'results', 'card_action'] as const).filter((k) => r.has(k) && !r.isNull(k));
  if (given.length !== 1) r.problemAt(given[0] ?? 'text', 'text · results · card_action 중 정확히 하나를 보내 주세요');
  let out: TurnRequest | undefined;
  if (given[0] === 'text' && given.length === 1) {
    const text = r.string('text', { required: true, min: 1, max: MAX_TEXT_CHARS });
    const spoken = r.string('spoken_reply', { max: MAX_TEXT_CHARS });
    out = { ...base, kind: 'text', text: text ?? '', ...(spoken !== undefined ? { spoken_reply: spoken } : {}) };
  } else if (given[0] === 'results' && given.length === 1) {
    const sub = r.object('results', { required: true });
    out = { ...base, kind: 'results', results: sub ? readResults(sub) : { cards: [], fixes: [] } };
  } else if (given[0] === 'card_action' && given.length === 1) {
    const sub = r.object('card_action', { required: true });
    out = { ...base, kind: 'card', card_action: sub ? readCardAction(sub) : { id: '', action: 'REJECTED' } };
  }
  r.finish();
  return out as TurnRequest;
}
