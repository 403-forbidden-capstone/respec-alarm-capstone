import { beforeEach, describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';

import { forgetPlaces, rememberPlaces } from '../places';
import {
  createCommitBody,
  existingBody,
  manualTimesBody,
  newAppointmentBody,
  settingsCommitBody,
  standaloneBody,
  toCreatedAppointment,
  toEditPayload,
  toEstimate,
  toPreview,
  type CommitResponse,
  type Suggestion,
} from '../request';
import { defaultAlarms, type AlarmEdits, type AppointmentDetail, type AppointmentDraft } from '../types';

// 5월 22일 한국 시각 hhmm
const at = (hhmm: string) => new Date(`2025-05-22T${hhmm}:00+09:00`);
const iso = (hhmm: string) => at(hhmm).toISOString();

const draft = (overrides: Partial<AppointmentDraft> = {}): AppointmentDraft => ({
  title: '스터디',
  date: at('00:00'),
  time: '10:00',
  repeat: [],
  place: '세종대학교',
  transport: 'TRANSIT',
  importance: 'LOW',
  items: '노트북, 충전기',
  alarms: defaultAlarms(),
  ...overrides,
});

beforeEach(() => forgetPlaces());

describe('새 일정 요청 (newAppointmentBody)', () => {
  it('감지 반경을 골랐고 좌표가 있으면 destination.radius_m을 실음 (칸이 없으면 안 보냄)', () => {
    const dest = (d: Partial<AppointmentDraft>) => (newAppointmentBody(draft(d), at('10:00')) as { appointment: { destination: unknown } }).appointment.destination;
    expect(dest({ placeLat: 37.55, placeLng: 127.07, destRadiusM: 150 })).toEqual({ name: '세종대학교', lat: 37.55, lng: 127.07, radius_m: 150 });
    expect(dest({ placeLat: 37.55, placeLng: 127.07 })).toEqual({ name: '세종대학교', lat: 37.55, lng: 127.07 });
    expect(dest({ placeLat: 37.55, placeLng: 127.07, destRadiusM: 50 })).toEqual({ name: '세종대학교', lat: 37.55, lng: 127.07 }); // 범위 밖
    expect(dest({ destRadiusM: 150 })).toEqual({ name: '세종대학교' }); // 좌표가 없으면 반경만 보내지 않음
  });

  it('서버의 H05 초안 모양: appointment + participant + kinds, 중요도는 늘 보냄', () => {
    expect(newAppointmentBody(draft(), at('10:00'))).toEqual({
      appointment: { title: '스터디', appointment_at: iso('10:00'), destination: { name: '세종대학교' }, importance: 'LOW' },
      participant: { origin: { name: '집' }, transport_type: 'TRANSIT' },
      kinds: ['WAKE', 'PREPARE', 'DEPARTURE'],
    });
  });

  it('고른 장소의 좌표를 담음 (초안의 좌표가 먼저, 없으면 기억해 둔 이름 → 좌표)', () => {
    const withCoords = newAppointmentBody(draft({ placeLat: 37.55, placeLng: 127.07 }), at('10:00')) as { appointment: { destination: unknown } };
    expect(withCoords.appointment.destination).toEqual({ name: '세종대학교', lat: 37.55, lng: 127.07 });
    rememberPlaces([{ name: '세종대학교', lat: 37.5, lng: 127.0 }]);
    const remembered = newAppointmentBody(draft(), at('10:00')) as { appointment: { destination: unknown } };
    expect(remembered.appointment.destination).toEqual({ name: '세종대학교', lat: 37.5, lng: 127.0 });
  });

  it('반복 요일은 RRULE로, 제목이 비면 "새 일정", 알람 종류는 켠 것만 (모두 끄면 빈 목록 = 알람 없는 일정)', () => {
    const body = newAppointmentBody(draft({ title: ' ', repeat: ['월', '수'], alarms: { WAKE: false, PREPARE: false, DEPARTURE: false } }), at('10:00')) as {
      appointment: Record<string, unknown>;
      kinds: unknown;
    };
    expect(body.appointment).toMatchObject({ title: '새 일정', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE' });
    expect(body.kinds).toEqual([]);
  });
});

// 저장된 팀 주간회의 (H03 처음 값) — 길찾기로 구한 이동 50, 준비 60, 기상 · 준비 모두 자동
const saved = (overrides: Partial<AppointmentDetail> = {}): AppointmentDetail => ({
  id: 'appt-1',
  title: '팀 주간회의',
  at: at('10:00'),
  place: '세종대학교',
  origin: '집',
  transport: 'TRANSIT',
  travelMinutes: 50,
  travelSource: '길찾기',
  bufferMinutes: 10,
  beforePrepMinutes: 30,
  prepMinutes: 30,
  predictedPrepMinutes: 60,
  importance: 'NORMAL',
  repeatLabel: '반복 없음',
  recurrenceRule: null,
  groupName: null,
  items: [],
  withWake: true,
  enabled: true,
  alarms: [
    { id: 'a-wake', kind: 'WAKE', at: at('08:00'), enabled: true },
    { id: 'a-prep', kind: 'PREPARE', at: at('08:30'), enabled: true },
    { id: 'a-dep', kind: 'DEPARTURE', at: at('09:00'), enabled: true },
    { id: 'a-arrive', kind: 'ARRIVE', at: at('09:50'), enabled: true },
  ],
  level: 1,
  intensity: { auto: 1, importancePoint: 1, lateCount: 0, latePoint: 0, axes: { sound: { level: 1, manual: false }, voice: { level: 1, manual: false }, vibration: { level: 1, manual: false } } },
  edits: { bufferMinutes: 10, origin: '집', transport: 'TRANSIT', travelMinutes: null, prepareMinutes: null, times: {} },
  auto: { travelMinutes: 50, predictedPrepMinutes: 60 },
  ...overrides,
});
const same = (d: AppointmentDetail): AlarmEdits => ({ ...d.edits });

describe('기존 약속 요청 (existingBody)', () => {
  it('손대지 않은 저장이면 준비 · 준비 전 활동만 이어 보냄 — 저장된 길찾기(API) 값은 이어 보내지 않아 서버가 카카오 값을 새로 구함 (D5: 카카오 응답 저장 · 재사용 불허)', () => {
    expect(existingBody(saved(), same(saved()))).toEqual({
      appointment_id: 'appt-1',
      participant: {
        origin: { name: '집' },
        transport_type: 'TRANSIT',
        buffer_minutes: 10,
        prepare_minutes: 60,
        before_prepare_minutes: 30,
      },
      manual_times: {},
    });
  });

  it('H03에서 직접 입력한 값도 서버 범위(이동 600 · 여유 240)를 넘지 않게', () => {
    const body = existingBody(saved(), { ...same(saved()), travelMinutes: 900, bufferMinutes: 500 }) as { participant: Record<string, unknown> };
    expect(body.participant).toMatchObject({ est_travel_minutes: 600, travel_source: 'MANUAL', buffer_minutes: 240 });
  });

  it('이동시간을 고쳤을 때만 est_travel_minutes + MANUAL을 보냄', () => {
    const body = existingBody(saved(), { ...same(saved()), travelMinutes: 40 }) as { participant: Record<string, unknown> };
    expect(body.participant).toMatchObject({ est_travel_minutes: 40, travel_source: 'MANUAL' });
  });

  it('직접 입력으로 저장된 이동시간은 손대지 않아도 그대로 MANUAL로 이어 보냄 (길찾기 값과 달리 카카오 응답이 아님)', () => {
    const detail = saved({ travelMinutes: 40, travelSource: '직접 입력', edits: { ...saved().edits, travelMinutes: 40 } });
    const body = existingBody(detail, same(detail)) as { participant: Record<string, unknown> };
    expect(body.participant).toMatchObject({ est_travel_minutes: 40, travel_source: 'MANUAL' });
  });

  it('출발 위치나 이동 수단을 바꾸면 저장된 이동시간을 이어 보내지 않음 (서버가 새로 구함)', () => {
    for (const patch of [{ origin: '강남역' }, { transport: 'CAR' as const }]) {
      const body = existingBody(saved(), { ...same(saved()), ...patch }) as { participant: Record<string, unknown> };
      expect(body.participant).not.toHaveProperty('est_travel_minutes');
      expect(body.participant).not.toHaveProperty('travel_source');
    }
  });

  it('직접 입력했던 이동을 "자동으로" 되돌리면(edits null) 이동시간을 보내지 않아 서버가 새로 구함', () => {
    const detail = saved({ travelSource: '직접 입력', edits: { ...saved().edits, travelMinutes: 40 } });
    const body = existingBody(detail, { ...detail.edits, travelMinutes: null }) as { participant: Record<string, unknown> };
    expect(body.participant).not.toHaveProperty('travel_source');
  });

  it('준비 시간은 직접 고른 값 → 없으면 저장된 값, 준비 전 활동이 0이면(기상 · 준비 중 하나뿐) 안 보냄', () => {
    const picked = existingBody(saved(), { ...same(saved()), prepareMinutes: 45 }) as { participant: Record<string, unknown> };
    expect(picked.participant.prepare_minutes).toBe(45);
    const noBefore = existingBody(saved({ beforePrepMinutes: 0 }), same(saved())) as { participant: Record<string, unknown> };
    expect(noBefore.participant).not.toHaveProperty('before_prepare_minutes');
  });

  it('직접 고른 알람 시각은 전부 manual_times로 (없는 종류는 자동으로 되돌림)', () => {
    const body = existingBody(saved(), { ...same(saved()), times: { WAKE: at('07:45') } }) as { manual_times: unknown };
    expect(body.manual_times).toEqual({ WAKE: iso('07:45') });
    expect(manualTimesBody({})).toEqual({});
  });

  it('출발 위치 이름으로 기억해 둔 좌표를 같이 보냄', () => {
    rememberPlaces([{ name: '강남역', lat: 37.49, lng: 127.03 }]);
    const body = existingBody(saved(), { ...same(saved()), origin: '강남역' }) as { participant: { origin: unknown } };
    expect(body.participant.origin).toEqual({ name: '강남역', lat: 37.49, lng: 127.03 });
  });
});

describe('H03 저장 요청 (settingsCommitBody)', () => {
  it('미리 보기 요청 + 종류별 켜기 + 강도(null = 자동) + 고친 값 기록', () => {
    const base = existingBody(saved(), same(saved()));
    const body = settingsCommitBody(
      base,
      { ...same(saved()), kinds: { WAKE: false, PREPARE: true, DEPARTURE: true, ARRIVE: true }, levels: { sound: 2, voice: null, vibration: null } },
      [{ screen: 'H03', field: 'alarm_enabled', alarm_type: 'WAKE', auto_value: true, edited_value: false }],
    );
    expect(body).toMatchObject({
      appointment_id: 'appt-1',
      enabled: { WAKE: false, PREPARE: true, DEPARTURE: true }, // 도착 목표는 종류별 켜기가 없음
      levels: { sound: 2, voice: null, vibration: null },
      edits: [{ screen: 'H03', field: 'alarm_enabled', alarm_type: 'WAKE', auto_value: true, edited_value: false }],
    });
  });
});

describe('일정 없는 알람 요청 (standaloneBody)', () => {
  it('만들기: 시각 + 반복(RRULE) + 강도 한 단계를 세 칸에', () => {
    expect(standaloneBody({ at: at('07:00'), repeat: ['월', '화', '수', '목', '금'], level: 2 })).toEqual({
      type: 'STANDALONE',
      alarm: {
        scheduled_at: iso('07:00'),
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
        levels: { sound: 2, voice: 2, vibration: 2 },
      },
    });
  });

  it('고치기: 시각 없이 강도만, 켜기만도 됨 — 안 준 칸은 보내지 않음', () => {
    expect(standaloneBody({ alarmId: 'x', level: 0 })).toEqual({ type: 'STANDALONE', alarm: { alarm_id: 'x', levels: { sound: 0, voice: 0, vibration: 0 } } });
    expect(standaloneBody({ alarmId: 'x', enabled: false })).toEqual({ type: 'STANDALONE', alarm: { alarm_id: 'x', is_enabled: false } });
  });

  it('반복을 [] 로 주면 반복 끔(null), 강도 null이면 자동으로 되돌림', () => {
    expect(standaloneBody({ alarmId: 'x', repeat: [], level: null })).toEqual({
      type: 'STANDALONE',
      alarm: { alarm_id: 'x', recurrence_rule: null, levels: { sound: null, voice: null, vibration: null } },
    });
  });
});

describe('고친 값 기록 줄 (toEditPayload)', () => {
  it('날짜는 ISO 글자로, 비면 null (edited_value null = 자동으로 되돌림)', () => {
    expect(toEditPayload({ screen: 'H05', field: 'scheduled_at', alarmType: 'WAKE', autoValue: at('08:00'), editedValue: at('07:45') })).toEqual({
      screen: 'H05',
      field: 'scheduled_at',
      alarm_type: 'WAKE',
      auto_value: iso('08:00'),
      edited_value: iso('07:45'),
    });
    expect(toEditPayload({ screen: 'H03', field: 'travel_minutes', autoValue: 50, editedValue: undefined })).toEqual({ screen: 'H03', field: 'travel_minutes', auto_value: 50, edited_value: null });
  });
});

// 서버 alarm-suggest 응답 예 (팀 주간회의, 길찾기 이동 50)
const suggestion = (overrides: Partial<Suggestion> = {}): Suggestion => ({
  appointment_at: iso('10:00'),
  arrive_at: iso('09:50'),
  alarms: [
    { alarm_type: 'WAKE', scheduled_at: iso('08:00'), auto_scheduled_at: null, is_enabled: true },
    { alarm_type: 'PREPARE', scheduled_at: iso('08:30'), auto_scheduled_at: null, is_enabled: true },
    { alarm_type: 'DEPARTURE', scheduled_at: iso('09:00'), auto_scheduled_at: null, is_enabled: true },
    { alarm_type: 'ARRIVE', scheduled_at: iso('09:50'), auto_scheduled_at: null, is_enabled: true },
  ],
  check: { ok: true },
  travel: { minutes: 50, source: 'API', manual_required: false, needs_confirmation: false, note: '길찾기 기준', auto_minutes: 50 },
  prepare: { minutes: 60, auto_minutes: 60, common_p80: 50, correction: 10, sample_count: 10, prior: 10, weight: 0.5, residual_p80: 20, before_prepare_minutes: 30 },
  intensity: { level: 'NORMAL', auto_level: 1, late_point: 0, axes: { sound: { level: 1, manual: false }, voice: { level: 1, manual: false }, vibration: { level: 1, manual: false } } },
  with_wake: true,
  same_day_wake: false,
  ...overrides,
});

describe('H03 미리 보기 읽기 (toPreview)', () => {
  it('준비 시간에 쓴 내 기록 수를 그대로 실음 (H03 계산식 아래 "배우는 중 N/5" · "내 기록 기반 N건" 한 줄용)', () => {
    const base = suggestion({});
    const withCount = (n: number) => suggestion({ prepare: { ...base.prepare, sample_count: n } });
    expect(toPreview(withCount(3), saved(), same(saved())).prepareSampleCount).toBe(3);
    expect(toPreview(withCount(12), saved(), same(saved())).prepareSampleCount).toBe(12);
  });

  it('서버가 준 최근 기록 값(최신순 최대 5개)을 그대로 실음 — 없으면(옛 서버) 칸 자체가 없음', () => {
    const base = suggestion({});
    const withRecent = (recent?: number[]) => suggestion({ prepare: { ...base.prepare, ...(recent ? { recent } : {}) } });
    expect(toPreview(withRecent([75, 70, 62, 55, 48]), saved(), same(saved())).prepareRecent).toEqual([75, 70, 62, 55, 48]);
    expect(toPreview(withRecent([]), saved(), same(saved())).prepareRecent).toEqual([]);
    expect('prepareRecent' in toPreview(withRecent(), saved(), same(saved()))).toBe(false);
  });

  it('알람 시각은 서버 값으로, 알람 id는 저장된 알람에서, 직접 고른 시각은 auto 포함', () => {
    const s = suggestion({
      alarms: [
        { alarm_type: 'WAKE', scheduled_at: iso('07:45'), auto_scheduled_at: iso('08:00'), is_enabled: true },
        { alarm_type: 'PREPARE', scheduled_at: iso('08:15'), auto_scheduled_at: null, is_enabled: true },
        { alarm_type: 'DEPARTURE', scheduled_at: iso('09:00'), auto_scheduled_at: null, is_enabled: true },
        { alarm_type: 'ARRIVE', scheduled_at: iso('09:50'), auto_scheduled_at: null, is_enabled: false },
      ],
    });
    const preview = toPreview(s, saved(), { ...same(saved()), times: { WAKE: at('07:45') } });
    expect(preview.alarms.map((x) => `${x.id} ${x.kind} ${formatTime(x.at)}`)).toEqual([
      'a-wake WAKE 오전 7:45',
      'a-prep PREPARE 오전 8:15',
      'a-dep DEPARTURE 오전 9:00',
      'a-arrive ARRIVE 오전 9:50',
    ]);
    expect(preview.alarms[0].auto && formatTime(preview.alarms[0].auto)).toBe('오전 8:00');
    expect(preview.alarms[3].enabled).toBe(true); // 도착 목표는 늘 켜짐으로
  });

  it('이동 · 준비: 적용 값은 서버 값, 자동 이동은 서버의 자동값, 자동 준비는 저장된 값 (DB에 직접 고름 표시가 없음)', () => {
    const s = suggestion({ travel: { ...suggestion().travel, minutes: 40, source: 'MANUAL', auto_minutes: 55 }, prepare: { ...suggestion().prepare, minutes: 45, auto_minutes: 70 } });
    expect(toPreview(s, saved(), { ...same(saved()), travelMinutes: 40, prepareMinutes: 45 })).toMatchObject({
      travelMinutes: 40,
      travelSource: '직접 입력',
      autoTravelMinutes: 55,
      predictedPrepMinutes: 45,
      autoPredictedPrepMinutes: 60,
    });
  });

  it('이동시간을 구할 길이 없으면(좌표 없음) 저장된 알람 · 이동을 그대로 보여 줌 — 예상 이동 칸에 직접 입력하게', () => {
    const s = suggestion({ alarms: [], travel: { minutes: null, source: null, manual_required: true, needs_confirmation: true, note: null, auto_minutes: null } });
    const preview = toPreview(s, saved(), same(saved()));
    expect(preview.alarms).toEqual(saved().alarms);
    expect(preview).toMatchObject({ travelMinutes: 50, travelSource: '길찾기', autoTravelMinutes: 50 });
  });
});

describe('새 일정 계산 결과 읽기 (toEstimate)', () => {
  const body = newAppointmentBody(draft(), at('10:00'));

  it('H05 확인 시트가 읽는 값: 알람은 자리 id, 여유는 도착 목표에서, 근거 숫자는 서버 값', () => {
    const estimate = toEstimate(suggestion(), draft(), at('10:00'), body, 1);
    expect(estimate.appointment).toMatchObject({
      id: 'draft:1',
      title: '스터디',
      place: '세종대학교',
      travelMinutes: 50,
      travelSource: '길찾기',
      bufferMinutes: 10,
      beforePrepMinutes: 30,
      prepMinutes: 30,
      predictedPrepMinutes: 60,
      withWake: true,
      items: ['노트북', '충전기'],
      level: 1,
    });
    expect(estimate.appointment.alarms.map((x) => x.id)).toEqual(['draft:WAKE', 'draft:PREPARE', 'draft:DEPARTURE', 'draft:ARRIVE']);
    expect(estimate).toMatchObject({ commonP80: 50, correction: 10, sampleCount: 10, prior: 10, weight: 0.5, residualP80: 20, sameDayWake: false, latePoint: 0, travelNeedsConfirm: false, travelNote: '길찾기 기준' });
    expect(estimate.commit).toEqual({ body, travelSource: 'API' });
  });

  it('직선거리로 어림한 이동이면 확인 필요 표시 + 근거 한 줄', () => {
    const s = suggestion({ travel: { minutes: 35, source: 'ESTIMATE', manual_required: false, needs_confirmation: true, note: '대략적인 값이에요 · 확인이 필요해요', auto_minutes: 35 } });
    expect(toEstimate(s, draft(), at('10:00'), body, 2)).toMatchObject({ travelNeedsConfirm: true, travelNote: '대략적인 값이에요 · 확인이 필요해요', commit: { travelSource: 'ESTIMATE' } });
  });

  it('알람을 모두 끄고 계산하면 알람 없는 일정 (도착 목표도 없음)', () => {
    const estimate = toEstimate(suggestion({ alarms: [] }), draft({ alarms: { WAKE: false, PREPARE: false, DEPARTURE: false } }), at('10:00'), body, 3);
    expect(estimate.appointment.alarms).toEqual([]);
  });
});

describe('새 일정 저장 요청 (createCommitBody)', () => {
  const estimate = () => toEstimate(suggestion(), draft(), at('10:00'), newAppointmentBody(draft(), at('10:00')), 1);

  it('현재 위치로 계산한 출발지를 확인 화면과 저장 요청까지 유지함', () => {
    const selected = draft({ originLocation: { lat: 37.55, lng: 127.07 } });
    const requested = newAppointmentBody(selected, at('10:00'));
    const calculated = toEstimate(suggestion(), selected, at('10:00'), requested, 1);
    expect(calculated.appointment.origin).toBe('현재 위치');
    expect((createCommitBody(calculated, {}, []) as { participant: Record<string, unknown> }).participant.origin).toEqual({ name: '현재 위치', lat: 37.55, lng: 127.07 });
  });

  it('확인 시트에서 보여 준 이동 · 준비 · 준비 전 활동 · 기상 여부를 그대로 박고, 길찾기 값은 API로', () => {
    const body = createCommitBody(estimate(), {}, []) as { appointment: Record<string, unknown>; participant: Record<string, unknown>; manual_times: unknown; edits: unknown };
    expect(body.appointment).toMatchObject({ title: '스터디', appointment_at: iso('10:00'), importance: 'LOW' });
    expect(body.participant).toMatchObject({
      origin: { name: '집' },
      transport_type: 'TRANSIT',
      buffer_minutes: 10,
      est_travel_minutes: 50,
      travel_source: 'API',
      prepare_minutes: 60,
      before_prepare_minutes: 30,
      with_wake: true,
    });
    expect(body.manual_times).toEqual({});
    expect(body.edits).toEqual([]);
  });

  it('실측 중앙값 · 근사값은 사용자가 확인한 값으로 보고 MANUAL로 저장 (서버는 API · MANUAL만 저장)', () => {
    const s = suggestion({ travel: { ...suggestion().travel, source: 'ESTIMATE', needs_confirmation: true } });
    const body = createCommitBody(toEstimate(s, draft(), at('10:00'), newAppointmentBody(draft(), at('10:00')), 1), {}, []) as { participant: Record<string, unknown> };
    expect(body.participant.travel_source).toBe('MANUAL');
  });

  it('직접 고른 알람 시각과 고친 값 기록을 같이 보냄', () => {
    const edits = [toEditPayload({ screen: 'H05', field: 'scheduled_at', alarmType: 'WAKE', autoValue: at('08:00'), editedValue: at('07:45') })];
    const body = createCommitBody(estimate(), { WAKE: at('07:45') }, edits) as { manual_times: unknown; edits: unknown };
    expect(body.manual_times).toEqual({ WAKE: iso('07:45') });
    expect(body.edits).toEqual(edits);
  });

  it('서버가 받는 범위(이동 · 준비 600분, 여유 · 준비 전 활동 240분)를 넘는 값은 범위 안으로 — 먼 거리 근사값이 저장을 통째로 거절시키지 않게', () => {
    const e = estimate();
    const far = { ...e, appointment: { ...e.appointment, travelMinutes: 845, bufferMinutes: 300, predictedPrepMinutes: 700, beforePrepMinutes: 250 }, commit: { ...e.commit!, travelSource: 'ESTIMATE' as const } };
    const body = createCommitBody(far, {}, []) as { participant: Record<string, unknown> };
    expect(body.participant).toMatchObject({ est_travel_minutes: 600, buffer_minutes: 240, prepare_minutes: 600, before_prepare_minutes: 240, travel_source: 'MANUAL' });
    // 범위 안의 값은 그대로 (소수는 반올림)
    const ok = { ...e, appointment: { ...e.appointment, travelMinutes: 50, bufferMinutes: 10, predictedPrepMinutes: 60, beforePrepMinutes: 30 } };
    expect((createCommitBody(ok, {}, []) as { participant: Record<string, unknown> }).participant).toMatchObject({ est_travel_minutes: 50, buffer_minutes: 10, prepare_minutes: 60, before_prepare_minutes: 30 });
  });

  it('서버 요청 조각이 없는 계산 결과(가짜 데이터로 만든 것)는 null', () => {
    const { commit, ...rest } = estimate();
    void commit;
    expect(createCommitBody(rest, {}, [])).toBeNull();
  });
});

describe('저장 결과 → 일정 (toCreatedAppointment)', () => {
  const response: CommitResponse = {
    appointment_id: 'new-appt',
    participant_id: 'new-part',
    alarms: [
      { alarm_id: 'n-wake', alarm_type: 'WAKE', scheduled_at: iso('07:45'), is_enabled: true, intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', vibration: null, time_source: 'MANUAL', intensity_source: 'AUTO', recurrence_rule: null },
      { alarm_id: 'n-arrive', alarm_type: 'ARRIVE', scheduled_at: iso('09:50'), is_enabled: true, intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', vibration: null, time_source: 'AUTO', intensity_source: 'AUTO', recurrence_rule: null },
    ],
    ring_packages: [],
    canceled_alarm_ids: [],
  };

  it('서버가 만든 일정 · 알람 id로 바뀌고 직접 고른 시각의 자동값은 확인 시트의 값을 이어 씀', () => {
    const base = toEstimate(suggestion(), draft(), at('10:00'), newAppointmentBody(draft(), at('10:00')), 1);
    const picked = { ...base, appointment: { ...base.appointment, alarms: base.appointment.alarms.map((x) => (x.kind === 'WAKE' ? { ...x, at: at('07:45'), auto: at('08:00') } : x)) } };
    const created = toCreatedAppointment(response, picked);
    expect(created.id).toBe('new-appt');
    expect(created.alarms.map((x) => `${x.id} ${x.kind} ${formatTime(x.at)}`)).toEqual(['n-wake WAKE 오전 7:45', 'n-arrive ARRIVE 오전 9:50']);
    expect(created.alarms[0].auto && formatTime(created.alarms[0].auto)).toBe('오전 8:00');
    expect(created.enabled).toBe(true);
  });
});
