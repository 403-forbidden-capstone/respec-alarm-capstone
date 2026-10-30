import { describe, expect, it } from '@jest/globals';

import { EdgeError } from '@/lib/edge';
import { UserError } from '@/lib/errors';

import { MAX_PHOTO_BYTES, mediaTypeOf, photoFailure, photoProblem, toBatch, type ExtractResponse } from '../photo';

const B64 = 'A'.repeat(400);

describe('photoProblem — 고른 사진 검사', () => {
  it('base64가 없으면 읽지 못한 것', () => {
    expect(photoProblem({ mimeType: 'image/jpeg', base64: null })).toMatch(/읽지 못했어요/);
  });

  it('jpeg · png · webp(image/jpg도)만', () => {
    expect(photoProblem({ mimeType: 'image/png', base64: B64 })).toBeNull();
    expect(photoProblem({ mimeType: 'image/jpg', base64: B64 })).toBeNull();
    expect(photoProblem({ mimeType: 'image/gif', base64: B64 })).toMatch(/jpg · png · webp/);
    expect(photoProblem({ base64: B64 })).toMatch(/jpg · png · webp/);
  });

  it('원본 크기 상한 — fileSize가 있으면 그 값, 없으면 base64 길이로 어림', () => {
    expect(photoProblem({ mimeType: 'image/jpeg', base64: B64, fileSize: MAX_PHOTO_BYTES })).toBeNull();
    expect(photoProblem({ mimeType: 'image/jpeg', base64: B64, fileSize: MAX_PHOTO_BYTES + 1 })).toMatch(/너무 커요/);
    expect(photoProblem({ mimeType: 'image/jpeg', base64: 'A'.repeat(Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 8) })).toMatch(/너무 커요/);
  });
});

describe('mediaTypeOf', () => {
  it('대소문자 · image/jpg를 맞춤', () => {
    expect(mediaTypeOf('IMAGE/JPG')).toBe('image/jpeg');
    expect(mediaTypeOf('image/webp')).toBe('image/webp');
    expect(mediaTypeOf(undefined)).toBeNull();
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
