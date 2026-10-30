// 시간표 사진으로 넣기(D66-1 A 캡처)의 순수 함수 — 고른 사진 검사 · 서버 함수 timetable-extract 응답을 가져온 수업으로 바꾸기 · 실패 문구 (시험: __tests__/photo.test.ts)
import { EdgeError } from '@/lib/edge';
import { UserError } from '@/lib/errors';
import { WEEKDAYS, type Weekday } from '@/lib/weekday';

import type { ImportBatch, ImportConfidence, ImportedClass } from './timetableImport';

// 서버가 받는 원본 크기 상한 (supabase/functions/_shared/timetable/extract.ts MAX_IMAGE_BYTES와 같게)
export const MAX_PHOTO_BYTES = 4_000_000;

export type PhotoMediaType = 'image/jpeg' | 'image/png' | 'image/webp';
const MEDIA_TYPES: readonly PhotoMediaType[] = ['image/jpeg', 'image/png', 'image/webp'];

// timetable-extract 응답 — 요일은 앱 Weekday 그대로, 시각은 HH:MM
export type ExtractedRow = { title: string; weekdays: string[]; start: string; end: string; place: string | null };
export type ExtractResponse = { rows: ExtractedRow[]; confidence: ImportConfidence; left_today?: number };

export type PickedPhoto = { base64: string; mediaType: PhotoMediaType };

// 갤러리에서 고른 사진이 서버로 보낼 수 있는지. 문제가 있으면 사용자에게 보일 이유, 괜찮으면 null
//   fileSize가 없으면(웹 등) base64 길이로 원본 크기를 어림
export function photoProblem(asset: { fileSize?: number; mimeType?: string; base64?: string | null }): string | null {
  if (!asset.base64) return '사진을 읽지 못했어요. 다른 사진으로 다시 골라 주세요';
  if (!mediaTypeOf(asset.mimeType)) return 'jpg · png · webp 사진만 쓸 수 있어요. 시간표 화면을 캡처한 사진을 골라 주세요';
  const bytes = asset.fileSize ?? Math.floor((asset.base64.length * 3) / 4);
  if (bytes > MAX_PHOTO_BYTES) return '사진이 너무 커요. 시간표 화면만 캡처한 사진을 골라 주세요';
  return null;
}

export function mediaTypeOf(mime?: string): PhotoMediaType | null {
  const m = mime?.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mime?.toLowerCase();
  return MEDIA_TYPES.find((t) => t === m) ?? null;
}

const minutesOf = (hhmm: string): number | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const isWeekday = (d: string): d is Weekday => (WEEKDAYS as readonly string[]).includes(d);

// 서버 응답 → 가져온 수업. 서버가 이미 검사했지만 앱도 못 읽는 줄은 건너뜀 (시각 · 요일이 틀린 줄)
export function toBatch(res: ExtractResponse): ImportBatch {
  const classes: ImportedClass[] = [];
  for (const row of res.rows) {
    const start = minutesOf(row.start);
    const end = minutesOf(row.end);
    const weekdays = row.weekdays.filter(isWeekday);
    if (start == null || end == null || weekdays.length === 0 || !row.title.trim()) continue;
    classes.push({ title: row.title.trim(), weekdays, startMinutes: start, endMinutes: end, place: row.place?.trim() || null });
  }
  return { source: 'photo', classes, confidence: res.confidence };
}

const READ_FAILED = '사진을 읽지 못했어요. 더 또렷한 캡처로 다시 골라 주세요';

// 서버 오류 → 사용자 문구. 모르는 오류는 그대로 던져 화면의 기본 문구가 보이게
export function photoFailure(e: unknown): unknown {
  if (!(e instanceof EdgeError)) return e;
  if (e.code === 'RATE_LIMITED') return new UserError('오늘은 사진으로 넣을 수 있는 횟수를 다 썼어요. 내일 다시 하거나 직접 넣어 주세요');
  if (e.code === 'VALIDATION_FAILED') return new UserError(READ_FAILED);
  if (e.code === 'NOT_CONFIGURED') return new UserError('사진 읽기가 아직 준비되지 않았어요. 직접 넣어 주세요');
  if (e.code === 'LLM_UNAVAILABLE') {
    const why = (e.details as { code?: unknown } | null | undefined)?.code;
    // 사진을 AI가 못 읽은 경우(거절 · 답이 깨짐 · 끊김)와 AI 서버가 안 되는 경우를 나눔
    if (why === 'REFUSED' || why === 'BAD_OUTPUT' || why === 'TRUNCATED') return new UserError(READ_FAILED);
  }
  return e;
}
