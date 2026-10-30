// 시간표 사진으로 넣기(D66-1 A 캡처)의 순수 함수 — 고른 사진 검사 · 서버 함수 timetable-extract 응답을 가져온 수업으로 바꾸기 · 실패 문구 (시험: __tests__/photo.test.ts)
import { EdgeError } from '@/lib/edge';
import { UserError } from '@/lib/errors';
import { WEEKDAYS, type Weekday } from '@/lib/weekday';

import type { ImportBatch, ImportConfidence, ImportedClass } from './timetableImport';

// 서버가 받는 원본 크기 상한 (supabase/functions/_shared/timetable/extract.ts MAX_IMAGE_BYTES와 같게)
export const MAX_PHOTO_BYTES = 4_000_000;

// 올리기 전에 줄임 (헤드 결정 10/30): 긴 변 1600px 이하, JPEG 0.8 — 시간표 글자는 읽히고 파일은 수백 KB. Claude도 긴 변 1568px 넘는 사진은 어차피 줄여서 읽음
export const MAX_LONG_SIDE = 1600;
export const JPEG_QUALITY = 0.8;

// 긴 변이 MAX_LONG_SIDE를 넘으면 그 변만 지정해 줄이기(다른 변은 비율대로), 아니면 null(크기는 그대로, JPEG로만 다시 저장)
export function resizeFor(width: number, height: number): { width: number } | { height: number } | null {
  if (!(width > 0) || !(height > 0) || Math.max(width, height) <= MAX_LONG_SIDE) return null;
  return width >= height ? { width: MAX_LONG_SIDE } : { height: MAX_LONG_SIDE };
}

export type PhotoMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

// timetable-extract 응답 — 요일은 앱 Weekday 그대로, 시각은 HH:MM
export type ExtractedRow = { title: string; weekdays: string[]; start: string; end: string; place: string | null };
export type ExtractResponse = { rows: ExtractedRow[]; confidence: ImportConfidence; left_today?: number };

export type PickedPhoto = { base64: string; mediaType: PhotoMediaType };

// base64 앞부분으로 실제 파일 종류를 앎 — asset.mimeType은 원본 파일 것이라, 고르기 창이 다시 압축하면(iOS는 늘 JPEG) 바이트와 어긋남. 서버도 첫 바이트가 말한 종류와 다르면 거절함
//   /9j/ = JPEG(FF D8 FF), iVBOR = PNG(89 'PNG'), UklGR = RIFF(WebP)
export function sniffMediaType(base64: string): PhotoMediaType | null {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return null;
}

// 갤러리에서 고른 사진을 서버로 보낼 수 있게 다듬음. 못 보내면 사용자에게 보일 이유
//   종류는 바이트로 판별(sniffMediaType), 크기는 fileSize(원본)와 base64 길이로 어림한 값 중 큰 쪽 — 다시 압축된 쪽이 더 클 수도 있어서
export function preparePhoto(asset: { fileSize?: number; base64?: string | null }): { photo: PickedPhoto } | { problem: string } {
  if (!asset.base64) return { problem: '사진을 읽지 못했어요. 다른 사진으로 다시 골라 주세요' };
  const mediaType = sniffMediaType(asset.base64);
  if (!mediaType) return { problem: 'jpg · png · webp 사진만 쓸 수 있어요. 시간표 화면을 캡처한 사진을 골라 주세요' };
  const bytes = Math.max(asset.fileSize ?? 0, Math.floor((asset.base64.length * 3) / 4));
  if (bytes > MAX_PHOTO_BYTES) return { problem: '사진이 너무 커요. 시간표 화면만 캡처한 사진을 골라 주세요' };
  return { photo: { base64: asset.base64, mediaType } };
}

// 서버 요청 본문 (timetable-extract: media_type · image_base64)
export const extractBody = (photo: PickedPhoto) => ({ media_type: photo.mediaType, image_base64: photo.base64 });

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
