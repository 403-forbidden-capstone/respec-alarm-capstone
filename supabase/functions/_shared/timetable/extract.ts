// 시간표 사진 읽기(timetable-extract)의 본체 — 요청 검사 → 하루 한도 → Claude(사진 읽기) → 출력 다시 검사 → ai_calls 한 줄.
// 사진은 이 함수 안에서만 쓰고 어디에도 저장하지 않는다: ai_calls.io는 늘 null(사진 · 읽은 글 모두 남기지 않음), 서버 로그에도 안 찍음.
// 순수 TS (Deno · Node API 없음) — node --test로 시험. 모델은 callLlm의 LlmClient로만 부름.
import { seoulIso, startOf } from '../ai/context.ts';
import { callLlm, toHttpError, type LlmClient, type LlmImage } from '../ai/llm.ts';
import { seoulLocal } from '../ai/ko.ts';
import { MAX_AI_CALLS_PER_DAY } from '../ai/opening.ts';
import { recordCalls } from '../ai/session.ts';
import { must } from '../db.ts';
import { HttpError } from '../errors.ts';
import { Reader } from '../read.ts';
import type { Db } from '../supabase.ts';
import { TIMETABLE_PROMPT_ID, TIMETABLE_PROMPT_VERSION, TIMETABLE_SYSTEM, TIMETABLE_USER } from './prompt.ts';
import { TIMETABLE_SCHEMA, TIMETABLE_WEEKDAYS, type TimetableExtract, type TimetableRow } from './schema.ts';

// 하루에 시간표 사진을 읽을 수 있는 횟수 (ai_calls point 'TT' 줄 수, 성공 · 실패 모두 셈). 전체 하루 AI 호출 상한(300)도 같이 지킴
export const MAX_TIMETABLE_CALLS_PER_DAY = 10;
// 사진 한 장 상한 (원본 바이트). 앱은 갤러리 사진을 이 안으로 줄여 보냄
export const MAX_IMAGE_BYTES = 4_000_000;
// 요청 본문 글자 상한 — base64는 원본의 4/3배 + JSON 여유
export const MAX_REQUEST_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 2_000;
// 한 사진에서 받는 수업 줄 상한 · 글자 상한 (앱 확인 화면 칸 크기)
export const MAX_ROWS = 30;
export const MAX_TITLE_CHARS = 40;
export const MAX_PLACE_CHARS = 40;

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface TimetableRequest {
  image: LlmImage;
}

// 파일 첫 바이트가 말한 종류와 맞는지 — 확장자만 바꾼 파일이 공급자 400(BAD_REQUEST)으로 가지 않게 먼저 거름
function magicOf(head: string): LlmImage['media_type'] | null {
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (head.startsWith('\x89PNG')) return 'image/png';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function parseRequest(raw: unknown): TimetableRequest {
  const r = Reader.root(raw);
  const mediaType = r.oneOf('media_type', MEDIA_TYPES, { required: true });
  const data = r.string('image_base64', { required: true, min: 100 });
  r.finish();
  if (mediaType === undefined || data === undefined) throw new HttpError('VALIDATION_FAILED', '사진을 읽지 못했어요');
  if (!BASE64.test(data) || data.length % 4 !== 0) throw new HttpError('VALIDATION_FAILED', '사진 데이터 형식이 맞지 않아요');
  const bytes = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) throw new HttpError('VALIDATION_FAILED', '사진이 너무 커요. 더 작은 사진으로 다시 골라 주세요');
  if (magicOf(atob(data.slice(0, 16))) !== mediaType) throw new HttpError('VALIDATION_FAILED', '사진 종류가 맞지 않아요. 캡처한 사진을 다시 골라 주세요');
  return { image: { media_type: mediaType, data } };
}

// 제어문자 · 글자 방향을 뒤집는 문자(U+202A–202E, U+2066–2069) · 폭 없는 문자(U+200B–200F, U+FEFF) · U+0085는 공백으로 — 사진 속 글이 확인 화면의 글자 순서를 바꾸지 못하게
const CONTROL = /[\u0000-\u001f\u007f-\u0085​-‏‪-‮⁦-⁩﻿]/g;
// 글자 수로 자름 (이모지 같은 두 칸짜리 글자를 반으로 쪼개지 않게 Array.from)
const clean = (s: string, max: number): string => Array.from(s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// 모델 출력은 믿지 않는 입력 — 스키마를 통과했어도 앱이 그대로 쓸 수 있는 줄만 남김.
// 버리는 줄: 이름이 빈 것 · 요일이 없는 것 · 끝이 시작보다 늦지 않은 것 · 똑같은 줄(중복). dropped = 버린 줄 수
export function normalizeRows(rows: TimetableRow[]): { rows: TimetableRow[]; dropped: number } {
  const out: TimetableRow[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const row of rows) {
    const title = clean(row.title, MAX_TITLE_CHARS);
    const days = TIMETABLE_WEEKDAYS.filter((d) => row.weekdays.includes(d)); // 월요일부터 순서 · 중복 없음
    const place = row.place === null ? null : clean(row.place, MAX_PLACE_CHARS) || null;
    if (!title || days.length === 0 || minutesOf(row.end) <= minutesOf(row.start)) {
      dropped++;
      continue;
    }
    const key = `${title}|${days.join('')}|${row.start}|${row.end}|${place ?? ''}`;
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    if (out.length >= MAX_ROWS) {
      dropped++;
      continue;
    }
    out.push({ title, weekdays: days, start: row.start, end: row.end, place });
  }
  return { rows: out, dropped };
}

export interface TimetableDeps {
  userId: string;
  /** 부른 사람의 RLS — 오늘 호출 수 읽기 */
  userDb: Db;
  /** 서버 키 — ai_calls 쓰기 */
  service: Db;
  llm: LlmClient | null;
  model: string;
  now?: () => Date;
}

export interface TimetableOut {
  rows: TimetableRow[];
  confidence: TimetableExtract['confidence'];
  /** 오늘 더 읽을 수 있는 횟수 (이번 호출 포함해 센 뒤) */
  left_today: number;
}

async function countToday(db: Db, userId: string, sinceIso: string, point?: string): Promise<number> {
  let q = db.from('ai_calls').select('call_id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', sinceIso);
  if (point !== undefined) q = q.eq('point', point);
  const res = await q;
  must('ai_calls', { data: null, error: res.error });
  return res.count ?? 0;
}

export async function handleTimetableExtract(deps: TimetableDeps, raw: unknown): Promise<TimetableOut> {
  const req = parseRequest(raw);
  if (deps.llm === null) throw new HttpError('NOT_CONFIGURED', 'AI가 아직 준비되지 않았어요');

  const now = (deps.now ?? (() => new Date()))();
  const nowIso = seoulIso(now);
  const since = startOf(seoulLocal(nowIso).date);
  // 한도는 호출 전에 확인하고 기록은 호출 뒤에 쌓이므로, 같은 사용자가 동시에 여러 번 보내면 그 몇 번은 함께 통과할 수 있음 (로그인 필요 · 호출당 비용이 작아 허용, voice-turn 하루 상한도 같은 방식)
  const [today, all] = await Promise.all([countToday(deps.userDb, deps.userId, since, 'TT'), countToday(deps.userDb, deps.userId, since)]);
  if (today >= MAX_TIMETABLE_CALLS_PER_DAY || all >= MAX_AI_CALLS_PER_DAY) {
    throw new HttpError('RATE_LIMITED', '오늘은 사진으로 넣을 수 있는 횟수를 다 썼어요. 내일 다시 하거나 직접 넣어 주세요', { left_today: 0 });
  }

  const result = await callLlm<TimetableExtract>(deps.llm, {
    point: 'TT',
    promptId: TIMETABLE_PROMPT_ID,
    promptVersion: TIMETABLE_PROMPT_VERSION,
    model: deps.model,
    system: TIMETABLE_SYSTEM,
    user: TIMETABLE_USER,
    images: [req.image],
    schema: TIMETABLE_SCHEMA,
    effort: 'low',
    maxTokens: 3_000,
    thinking: null,
    cacheSystem: false,
    timeoutMs: 25_000,
    retryOnTimeout: false,
    deadlineMs: 28_000,
  });
  // 성공 · 실패 모두 한 줄 남김(한도 셈의 근거). io는 늘 null — 사진도 읽은 글도 보관하지 않음
  await recordCalls({ userId: deps.userId, userDb: deps.userDb, service: deps.service }, null, [{ call: result.call, io: null }], nowIso);
  if (!result.ok) throw toHttpError(result);

  const { rows, dropped } = normalizeRows(result.data.rows);
  // 버린 줄이 있고 모델이 HIGH라고 했으면 MEDIUM으로 내림 (앱은 LOW · MEDIUM이면 "확인" 안내를 강하게). 읽은 수업이 없으면 늘 LOW
  const confidence = rows.length === 0 ? 'LOW' : dropped > 0 && result.data.confidence === 'HIGH' ? 'MEDIUM' : result.data.confidence;
  return { rows, confidence, left_today: Math.max(0, MAX_TIMETABLE_CALLS_PER_DAY - today - 1) };
}
