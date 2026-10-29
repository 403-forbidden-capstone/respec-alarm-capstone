import { describe, expect, it, jest } from '@jest/globals';

import { LATE_AFTER_MINUTES, ON_TIME_BEFORE_MINUTES } from '../../alarm/participantTimes';
import { defaultRadiusFor, isAreaPlace, placeKind } from '../area';
import { DETECTION_DELAY_MAX_MINUTES, LOCATION_HOLD_AFTER_MINUTES, LOCATION_HOLD_BEFORE_MINUTES } from '../constants';

// participantTimes의 상수만 읽음 — DB 클라이언트는 가짜
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));

// 카카오 category_name 모양 (kakao-parse.ts) — 실제 응답은 "교육,학문 > 학교 > 대학교", 시험 샘플은 "교육 > 대학교"
const UNIV = '교육,학문 > 학교 > 대학교';

describe('대표 좌표 판정 (isAreaPlace, D68)', () => {
  it('대학교 자체는 캠퍼스 대표 좌표 — 캠퍼스 이름이 붙어도', () => {
    expect(isAreaPlace({ name: '세종대학교', category: UNIV })).toBe(true);
    expect(isAreaPlace({ name: '세종대학교', category: '교육 > 대학교' })).toBe(true);
    expect(isAreaPlace({ name: '서울대학교 관악캠퍼스', category: UNIV })).toBe(true);
    expect(placeKind({ name: '세종대학교', category: UNIV })).toBe('CAMPUS');
  });

  it('캠퍼스 안 건물 · 부속 시설은 아님', () => {
    expect(isAreaPlace({ name: '세종대학교 광개토관', category: UNIV })).toBe(false);
    expect(isAreaPlace({ name: '세종대학교 대양AI센터', category: `${UNIV} > 대학교부속시설` })).toBe(false);
    expect(placeKind({ name: '세종대학교 광개토관', category: UNIV })).toBe('BUILDING');
  });

  it('공원 · 테마파크 · 공항 · 경기장은 대표 좌표', () => {
    expect(isAreaPlace({ name: '어린이대공원', category: '여행 > 공원 > 도시근린공원' })).toBe(true);
    expect(isAreaPlace({ name: '서울숲', category: '여행 > 공원' })).toBe(true);
    expect(isAreaPlace({ name: '롯데월드 어드벤처', category: '여행 > 관광,명소 > 테마파크' })).toBe(true);
    expect(isAreaPlace({ name: '김포국제공항', category: '교통,수송 > 공항' })).toBe(true);
    expect(isAreaPlace({ name: '서울월드컵경기장', category: '스포츠,레저 > 경기장' })).toBe(true);
  });

  it('역 · 백화점은 넓지만 한 곳 — 경고 없음', () => {
    expect(isAreaPlace({ name: '군자역 7호선', category: '교통,수송 > 지하철,전철 > 수도권7호선' })).toBe(false);
    expect(placeKind({ name: '군자역 7호선', category: '교통,수송 > 지하철,전철 > 수도권7호선' })).toBe('WIDE');
    expect(isAreaPlace({ name: '롯데백화점 본점', category: '쇼핑 > 백화점' })).toBe(false);
  });

  it('가게 · 건물은 아님', () => {
    expect(isAreaPlace({ name: '스타벅스 세종대점', category: '음식점 > 카페 > 커피전문점 > 스타벅스' })).toBe(false);
    expect(isAreaPlace({ name: '동네 치과', category: '의료,건강 > 치과' })).toBe(false);
  });

  it('분류가 없으면 이름으로만 — "OO대학교(캠퍼스)"만 캠퍼스', () => {
    expect(isAreaPlace({ name: '세종대학교' })).toBe(true);
    expect(isAreaPlace({ name: '고려대학교 서울캠퍼스', category: null })).toBe(true);
    expect(isAreaPlace({ name: '세종대학교 광개토관' })).toBe(false);
    expect(isAreaPlace({ name: '동네 치과' })).toBe(false);
    expect(placeKind({ name: '동네 치과' })).toBe('UNKNOWN');
  });
});

describe('기본 반경 (defaultRadiusFor, D77 기본안 A)', () => {
  it('건물 · 가게 150, 역 · 공원 · 대형 시설 · 캠퍼스 300, 분류 없음 200', () => {
    expect(defaultRadiusFor('음식점 > 카페')).toBe(150);
    expect(defaultRadiusFor('교통,수송 > 지하철,전철 > 수도권2호선')).toBe(300);
    expect(defaultRadiusFor('여행 > 공원')).toBe(300);
    expect(defaultRadiusFor('쇼핑 > 백화점')).toBe(300);
    expect(defaultRadiusFor(UNIV)).toBe(300);
    expect(defaultRadiusFor(null)).toBe(200);
    expect(defaultRadiusFor('')).toBe(200);
  });

  it('이름을 주면 캠퍼스 안 건물은 150', () => {
    expect(defaultRadiusFor(UNIV, '세종대학교')).toBe(300);
    expect(defaultRadiusFor(UNIV, '세종대학교 광개토관')).toBe(150);
  });
});

describe('위치 도착 지각 보류 구간 (D76 기본안 A)', () => {
  it('−2 ~ +11분 = 원탭 지각 기준 +5분 + 최대 감지 지연 6분', () => {
    expect([LOCATION_HOLD_BEFORE_MINUTES, LOCATION_HOLD_AFTER_MINUTES]).toEqual([2, 11]);
    expect(LOCATION_HOLD_AFTER_MINUTES).toBe(LATE_AFTER_MINUTES + DETECTION_DELAY_MAX_MINUTES);
    expect(LOCATION_HOLD_BEFORE_MINUTES).toBe(ON_TIME_BEFORE_MINUTES);
  });
});
