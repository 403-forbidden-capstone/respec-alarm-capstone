// 기상 알람 그룹 상태 안내 (group-status-device) — 그룹 화면과 같은 단계(group-wake-state.ts)로 그룹원 상태를 그룹마다 한 문장
//   "캡스톤 그룹에서 수연님은 취침 중, 준성님은 준비 중이에요." — 상태를 새로 판정하지 않음. 줄은 get_group_wake와 같은 계산 · 공유 범위(group_wake_for_device)
//   본인 · 줄이 없는 사람(동의 안 함 · 숨김 · 차단)은 빼고, 그날 그 그룹 약속이 없거나(줄 없음) 나 말고 보이는 사람이 없는 그룹은 건너뜀
//   시각은 말로만 필요한 곳(준비 알람 예정)에 "오후 5시 10분"으로 — 나머지는 화면 글자의 앞부분(상태)만 읽음
//   3 · 4단계면 그 단계 Gemini 목소리(GEMINI_STAGE)로 음성까지 — 'AV' 한도를 기상 브리핑과 같이 씀. 한도 · 실패 · 시간 초과면 글만 (폰이 그 단계 Android TTS로 읽음)
// 호출 한도 (11/20): 울림 회차마다 조회 1번, 음성 생성은 단계마다 1번 — 서버는 어떤 실패도 다시 시도하지 않음 (DB 1번 · 예약 1번 · Gemini 1번)
//   첫 요청 { level } = 조회 + 그 단계 음성. 울리는 도중 단계가 바뀌면 { level, text, token } = 이미 받은 문장의 음성만 (DB를 다시 안 읽음)
//   token = 이 서버가 그 사람에게 만들어 준 문장이라는 서명 — 기기 키로 아무 글이나 Gemini로 읽혀 프로젝트 한도를 쓰지 못하게
import { HttpError } from './errors.ts';
import { LlmClientError } from './ai/llm.ts';
import type { Tts, TtsAudio } from './ai/tts.ts';
import type { TtsQuota } from './ai/tts-quota.ts';
import { GEMINI_STAGE, TTS_MODEL } from './briefing.ts';
import { must } from './db.ts';
import { wakePhaseOf, type WakePhase, type WakePhaseRow } from './group-wake-state.ts';
import { copula } from './ring-package.ts';
import type { Db } from './supabase.ts';
import { formatKoSpokenTime } from './tz.ts';

export type GroupWakeDeviceRow = WakePhaseRow & { group_id: string; group_name: string; nickname: string; is_me: boolean };
export type GroupStatusOut = { text: string | null; token: string | null; level: number | null; audio: TtsAudio | null };
/** secret = 문장 서명 열쇠 (서버 비밀값 — index.ts는 service_role 키) */
export type GroupStatusDeps = { tts: Tts | null; quota: TtsQuota; secret: string };

// 서명한 문장을 음성으로 만들어 주는 시간 — 한 울림(미루기 전까지)이 이보다 길면 새 단계는 Android TTS로
export const TOKEN_TTL_MS = 2 * 60 * 60_000;
const MAX_TEXT = 2000;

// 화면 글자(map.ts wakeStateOf)의 상태 부분 — '알람 울림 · 기상 확인 전'은 뒤쪽만
const SPOKEN: Record<WakePhase, string> = {
  ARRIVED: '도착',
  MOVING: '이동 중',
  DEPARTED: '출발',
  PREPARING: '준비 중',
  WOKE: '기상 완료',
  RINGING: '알람 울리는 중',
  RANG: '기상 확인 전',
  SCHEDULED: '취침 중',
  PREP_SCHEDULED: '준비 알람 예정',
  NO_ALARM: '알람 없음',
};

// 앱 lib/format formatTime이 한국 시간 고정이라 같게
const TIME_ZONE = 'Asia/Seoul';

function spokenState(row: WakePhaseRow, current: Date): string {
  const phase = wakePhaseOf(row, current);
  if (phase === 'PREP_SCHEDULED' && row.prepare_alarm_at) return `${formatKoSpokenTime(new Date(row.prepare_alarm_at), TIME_ZONE)} 준비 알람 예정`;
  return SPOKEN[phase];
}

// 이미 '님' · '그룹'으로 끝나는 이름은 한 번 더 붙이지 않음
const person = (name: string) => (name.trim().endsWith('님') ? name.trim() : `${name.trim()}님`);
const groupLabel = (name: string) => (name.trim().endsWith('그룹') ? name.trim() : `${name.trim()} 그룹`);

/** 그룹마다 한 문장, 안내할 사람이 없으면 null. rows 순서(그룹 · 이름순)를 그대로 따름 */
export function groupStatusText(rows: readonly GroupWakeDeviceRow[], current: Date): string | null {
  const groups = new Map<string, GroupWakeDeviceRow[]>();
  for (const row of rows) {
    if (row.is_me) continue;
    groups.set(row.group_id, [...(groups.get(row.group_id) ?? []), row]);
  }
  const sentences = [...groups.values()].map((members) => {
    const states = members.map((m) => `${person(m.nickname)}은 ${spokenState(m, current)}`);
    return `${groupLabel(members[0].group_name)}에서 ${states.join(', ')}${copula(states[states.length - 1])}.`;
  });
  return sentences.length ? sentences.join(' ') : null;
}

async function groupAudio(text: string, level: 3 | 4, deps: GroupStatusDeps): Promise<TtsAudio | null> {
  if (!deps.tts) return null;
  const callId = await deps.quota.reserve(TTS_MODEL).catch(() => null);
  if (!callId) return null;
  const started = Date.now();
  try {
    const audio = await deps.tts({ model: TTS_MODEL, text, ...GEMINI_STAGE[level] });
    await deps.quota.finish(callId, { ok: true, errorCode: null, latencyMs: Date.now() - started }).catch(() => undefined);
    return audio;
  } catch (e) {
    await deps.quota.finish(callId, { ok: false, errorCode: e instanceof LlmClientError ? e.kind : 'unknown', latencyMs: Date.now() - started }).catch(() => undefined);
    console.warn(`[group-status] ${level}단계 음성을 못 만듦 — 폰이 Android TTS로: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`);
    return null;
  }
}

async function sign(secret: string, userId: string, issuedAt: number, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${userId}
${issuedAt}
${text}`));
  return `${issuedAt}.${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function verified(secret: string, userId: string, token: unknown, text: string, nowMs: number): Promise<boolean> {
  if (typeof token !== 'string') return false;
  const issuedAt = Number(token.split('.')[0]);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > nowMs || nowMs - issuedAt > TOKEN_TTL_MS) return false;
  return (await sign(secret, userId, issuedAt, text)) === token;
}

/**
 * body = { level: 지금 울리는 음성 단계 1~4, text?, token? }. 돌려주는 level = 받은 단계(폰이 음성과 지금 단계가 같은지 볼 때 씀)
 *   text 없음 → 조회 1번(실패면 던짐 — 음성 생성 안 함) + 3 · 4단계면 음성 1번
 *   text 있음 → 서명 확인 뒤 음성 1번만 (DB 안 읽음). 서명이 틀리거나 지났으면 거절 (폰은 Android TTS로)
 */
export async function groupStatus(service: Db, userId: string, body: unknown, deps: GroupStatusDeps, now: Date = new Date()): Promise<GroupStatusOut> {
  const b = (body ?? {}) as { level?: unknown; text?: unknown; token?: unknown };
  const level = typeof b.level === 'number' && Number.isInteger(b.level) && b.level >= 1 && b.level <= 4 ? b.level : null;
  const voiced = (text: string | null) => (text && (level === 3 || level === 4) ? groupAudio(text, level, deps) : Promise.resolve(null));
  if (b.text !== undefined) {
    if (typeof b.text !== 'string' || !b.text || b.text.length > MAX_TEXT || !(await verified(deps.secret, userId, b.token, b.text, now.getTime()))) {
      throw new HttpError('VALIDATION_FAILED', '이 서버가 만든 안내 문장이 아니에요');
    }
    return { text: b.text, token: b.token as string, level, audio: await voiced(b.text) };
  }
  const rows = must<GroupWakeDeviceRow[] | null>('group wake', await service.rpc('group_wake_for_device', { p_user_id: userId })) ?? [];
  const text = groupStatusText(rows, now);
  const token = text ? await sign(deps.secret, userId, now.getTime(), text) : null;
  return { text, token, level, audio: await voiced(text) };
}
