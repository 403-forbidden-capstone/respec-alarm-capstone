import { describe, expect, it } from '@jest/globals';

import { EdgeError } from '@/lib/edge';
import { UserError } from '@/lib/errors';

import { extractBody, MAX_PHOTO_BYTES, photoFailure, preparePhoto, sniffMediaType, toBatch, type ExtractResponse } from '../photo';

const JPEG_B64 = '/9j/' + 'A'.repeat(400);
const PNG_B64 = 'iVBOR' + 'A'.repeat(400);
const WEBP_B64 = 'UklGR' + 'A'.repeat(400);

describe('sniffMediaType — 바이트로 종류 판별', () => {
  it('jpeg · png · webp', () => {
    expect(sniffMediaType(JPEG_B64)).toBe('image/jpeg');
    expect(sniffMediaType(PNG_B64)).toBe('image/png');
    expect(sniffMediaType(WEBP_B64)).toBe('image/webp');
  });

  it('그 밖(gif · 텍스트)은 null', () => {
    expect(sniffMediaType('R0lGOD' + 'A'.repeat(100))).toBeNull();
    expect(sniffMediaType('hello')).toBeNull();
  });
});

describe('preparePhoto — 고른 사진을 서버로 보낼 수 있게', () => {
  it('종류는 mimeType이 아니라 바이트로: PNG 파일이 JPEG로 다시 압축돼 와도 JPEG로 보냄', () => {
    expect(preparePhoto({ base64: JPEG_B64 })).toEqual({ photo: { base64: JPEG_B64, mediaType: 'image/jpeg' } });
    expect(preparePhoto({ base64: PNG_B64 })).toEqual({ photo: { base64: PNG_B64, mediaType: 'image/png' } });
  });

  it('base64가 없으면 읽지 못한 것, 모르는 종류는 안내', () => {
    expect(preparePhoto({ base64: null })).toEqual({ problem: expect.stringMatching(/읽지 못했어요/) });
    expect(preparePhoto({ base64: 'R0lGOD' + 'A'.repeat(100) })).toEqual({ problem: expect.stringMatching(/jpg · png · webp/) });
  });

  it('크기는 fileSize와 base64 길이로 어림한 값 중 큰 쪽이 상한 이하여야 함', () => {
    expect(preparePhoto({ base64: JPEG_B64, fileSize: MAX_PHOTO_BYTES })).toHaveProperty('photo');
    expect(preparePhoto({ base64: JPEG_B64, fileSize: MAX_PHOTO_BYTES + 1 })).toEqual({ problem: expect.stringMatching(/너무 커요/) });
    // 원본은 작다고 하는데 다시 압축돼 base64가 커진 경우
    expect(preparePhoto({ base64: '/9j/' + 'A'.repeat(Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 8), fileSize: 100 })).toEqual({ problem: expect.stringMatching(/너무 커요/) });
  });
});

describe('extractBody — 서버 계약 필드 이름', () => {
  it('media_type · image_base64 (supabase/functions/_shared/timetable/extract.ts parseRequest)', () => {
    expect(extractBody({ base64: 'QUJD', mediaType: 'image/png' })).toEqual({ media_type: 'image/png', image_base64: 'QUJD' });
  });
});

describe('toBatch — 서버 응답 → 가져온 수업', () => {
  const res: ExtractResponse = {
    confidence: 'MEDIUM',
    rows: [
      { title: ' 자료구조 ', weekdays: ['월', '수'], start: '10:30', end: '12:00', place: ' 공학관 301 ' },
      { title: '장소 없음', weekdays: ['금'], start: '09:00', end: '11:50', place: null },
      { title: '시각 깨짐', weekdays: ['월'], start: '9:00', end: '10:00', place: null },
      { title: '요일 모름', weekdays: ['Mon'], start: '09:00', end: '10:00', place: null },
      { title: ' ', weekdays: ['월'], start: '09:00', end: '10:00', place: null },
    ],
  };

  it('분 단위로 바꾸고 읽을 수 없는 줄은 건너뜀, 글자는 다듬음', () => {
    const batch = toBatch(res);
    expect(batch.source).toBe('photo');
    expect(batch.confidence).toBe('MEDIUM');
    expect(batch.classes).toEqual([
      { title: '자료구조', weekdays: ['월', '수'], startMinutes: 630, endMinutes: 720, place: '공학관 301' },
      { title: '장소 없음', weekdays: ['금'], startMinutes: 540, endMinutes: 710, place: null },
    ]);
  });

  it('빈 응답도 그대로 (안내는 importNotice가 함)', () => {
    expect(toBatch({ rows: [], confidence: 'LOW' }).classes).toEqual([]);
  });
});

describe('photoFailure — 서버 오류 → 사용자 문구', () => {
  const msg = (e: unknown) => (e instanceof UserError ? e.message : null);

  it('하루 횟수를 다 쓴 경우', () => {
    expect(msg(photoFailure(new EdgeError('RATE_LIMITED')))).toMatch(/횟수를 다 썼어요/);
  });

  it('AI가 사진을 못 읽은 경우(거절 · 답 깨짐 · 끊김)는 다시 고르기 안내', () => {
    for (const code of ['REFUSED', 'BAD_OUTPUT', 'TRUNCATED']) {
      expect(msg(photoFailure(new EdgeError('LLM_UNAVAILABLE', { details: { code } })))).toMatch(/더 또렷한 캡처/);
    }
    expect(msg(photoFailure(new EdgeError('VALIDATION_FAILED')))).toMatch(/더 또렷한 캡처/);
  });

  it('AI 서버가 안 되는 경우(UPSTREAM 등)는 기본 문구 그대로', () => {
    const e = new EdgeError('LLM_UNAVAILABLE', { details: { code: 'UPSTREAM' } });
    expect(photoFailure(e)).toBe(e);
    expect(msg(photoFailure(e))).toMatch(/AI가 지금 답하지 못해요/);
  });

  it('키 없음은 직접 넣기를 안내, 모르는 오류는 그대로 던짐', () => {
    expect(msg(photoFailure(new EdgeError('NOT_CONFIGURED')))).toMatch(/직접 넣어 주세요/);
    const other = new Error('x');
    expect(photoFailure(other)).toBe(other);
  });
});
