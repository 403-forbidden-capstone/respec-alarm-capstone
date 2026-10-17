import { describe, expect, it } from '@jest/globals';

import { EdgeError } from '@/lib/edge';
import { UserError } from '@/lib/errors';

import { toPreview, travelProblemOf, type Suggestion } from '../request';
import { TRAVEL_PROBLEM_NOTE, TravelConfirmNeeded, travelConfirmMessage, travelFallbackOf } from '../travelConfirm';
import type { AlarmEdits, AppointmentDetail } from '../types';

const routeUnavailable = (details: unknown) => new EdgeError('ROUTE_UNAVAILABLE', { status: 502, details });

describe('travelFallbackOf — alarm-commit이 ROUTE_UNAVAILABLE과 함께 준 어림값 읽기', () => {
  it('직선거리 어림(ESTIMATE) · 내 지난 이동 중앙값(CACHED)의 분을 반올림해 읽음', () => {
    expect(travelFallbackOf(routeUnavailable({ manual_required: true, fallback: { minutes: 63.4, source: 'ESTIMATE', needs_confirmation: true } }))).toEqual({ minutes: 63, source: 'ESTIMATE' });
    expect(travelFallbackOf(routeUnavailable({ fallback: { minutes: 45, source: 'CACHED', needs_confirmation: false, sample_count: 3 } }))).toEqual({ minutes: 45, source: 'CACHED' });
  });

  it('어림값이 없거나 모양이 다르면 null — 좌표가 없어 직접 입력해야 하는 경우 · 다른 오류 · 모르는 출처 · 분이 숫자가 아님', () => {
    expect(travelFallbackOf(routeUnavailable({ manual_required: true, fallback: null }))).toBeNull();
    expect(travelFallbackOf(routeUnavailable({ manual_required: true }))).toBeNull();
    expect(travelFallbackOf(routeUnavailable(undefined))).toBeNull();
    expect(travelFallbackOf(routeUnavailable({ fallback: { minutes: 30, source: 'API' } }))).toBeNull();
    expect(travelFallbackOf(routeUnavailable({ fallback: { minutes: '30', source: 'ESTIMATE' } }))).toBeNull();
    expect(travelFallbackOf(new EdgeError('INTERNAL', { details: { fallback: { minutes: 30, source: 'ESTIMATE' } } }))).toBeNull();
    expect(travelFallbackOf(new Error('x'))).toBeNull();
  });

  it('분은 1분 이상', () => {
    expect(travelFallbackOf(routeUnavailable({ fallback: { minutes: 0, source: 'ESTIMATE' } }))?.minutes).toBe(1);
  });
});

describe('확인 요청 오류 · 문구', () => {
  it('TravelConfirmNeeded는 UserError(화면이 못 잡아도 이유가 토스트로 보임)이고 분 · 출처를 들고 있음', () => {
    const e = new TravelConfirmNeeded({ minutes: 55, source: 'ESTIMATE' });
    expect(e).toBeInstanceOf(UserError);
    expect([e.minutes, e.source, e.name]).toEqual([55, 'ESTIMATE', 'TravelConfirmNeeded']);
  });

  it('확인 시트 문구: 어림이면 "대략", 지난 이동 기록이면 그 사실을 밝힘', () => {
    expect(travelConfirmMessage({ minutes: 55, source: 'ESTIMATE' })).toBe('길찾기를 못 해 이동시간을 대략 55분으로 잡았어요. 이 값으로 저장할까요?');
    expect(travelConfirmMessage({ minutes: 45, source: 'CACHED' })).toBe('길찾기를 못 해 최근 이동 기록으로 이동시간을 45분으로 잡았어요. 이 값으로 저장할까요?');
  });
});

describe('미리 보기 이동시간 상태 (H03 이동 조건 안내)', () => {
  const travel = (overrides: Partial<Suggestion['travel']>): Pick<Suggestion, 'travel'> => ({
    travel: { minutes: 50, source: 'API', manual_required: false, needs_confirmation: false, note: null, auto_minutes: 50, ...overrides },
  });

  it('길찾기(API) · 직접 입력(MANUAL)은 문제 없음, 어림(ESTIMATE) · 내 이동 기록(CACHED) · 직접 입력 필요(manual_required)는 알려 줌', () => {
    expect(travelProblemOf(travel({}))).toBeNull();
    expect(travelProblemOf(travel({ source: 'MANUAL' }))).toBeNull();
    expect(travelProblemOf(travel({ source: 'ESTIMATE', needs_confirmation: true }))).toBe('ESTIMATE');
    expect(travelProblemOf(travel({ source: 'CACHED' }))).toBe('CACHED');
    expect(travelProblemOf(travel({ minutes: null, source: null, manual_required: true, auto_minutes: null }))).toBe('MANUAL_REQUIRED');
  });

  it('안내 문구가 상태마다 있음', () => {
    expect(Object.keys(TRAVEL_PROBLEM_NOTE).sort()).toEqual(['CACHED', 'ESTIMATE', 'MANUAL_REQUIRED']);
  });

  it('toPreview가 상태를 travelProblem으로 실음 — 문제 없으면 칸 자체가 없음', () => {
    const saved = { id: 'a', alarms: [], travelMinutes: 50, travelSource: '길찾기', auto: { travelMinutes: 50, predictedPrepMinutes: 60 } } as unknown as AppointmentDetail;
    const edits = { travelMinutes: null } as unknown as AlarmEdits;
    const base = { appointment_at: '', arrive_at: null, alarms: [], check: { ok: true }, prepare: { minutes: 60 } } as unknown as Suggestion;
    expect(toPreview({ ...base, ...travel({ source: 'ESTIMATE', needs_confirmation: true, minutes: 63, auto_minutes: 63 }) }, saved, edits)).toMatchObject({ travelProblem: 'ESTIMATE', travelMinutes: 63 });
    expect(toPreview({ ...base, ...travel({}) }, saved, edits)).not.toHaveProperty('travelProblem');
    expect(toPreview({ ...base, ...travel({ minutes: null, source: null, manual_required: true, auto_minutes: null }) }, saved, edits)).toMatchObject({ travelProblem: 'MANUAL_REQUIRED' });
  });
});
