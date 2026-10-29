// ① 약속 기반 알람 — 데이터 접근은 이 파일에서만 합니다.
// 지금은 src/mocks의 가짜 데이터를 돌려주고, Supabase가 붙으면 이 파일 안에서만 바꿉니다.
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (H01 · H02 · H03 · H05 · H07 · H08)
import { hasEarlierWake } from '@shared/calc/wake.ts';

import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';
import { isMock } from '@/lib/mode';
import { addMinutes, isSameDay, josa, joinKo, minuteOfDay, spokenTime, startOfDay } from '@/lib/format';
import { alarmChain, autoLevel, axisLevel } from '@/mocks/calc';
import { awayFromHomeFactor, db, people, places, recentMockPlaces, timelines, transportFactor, type MockAppointment } from '@/mocks/data';

import {
  defaultAlarms,
  IMPORTANCE_POINT,
  KIND_LABEL,
  LEVELS,
  MANUAL_SOURCE,
  ORIGIN_HOME,
  RING_KINDS,
  WAKE_NO_REPLY_MINUTES,
  WAKE_OBSERVE_MINUTES,
  type AlarmEdits,
  type AlarmKind,
  type AlarmPreview,
  type AlarmSettingsDraft,
  type CancelSnoozeResult,
  type EditLogField,
  type Appointment,
  type AppointmentDetail,
  type AppointmentDraft,
  type Estimate,
  type IntensityAxis,
  type LatLng,
  type Level,
  type NextAlarm,
  type Place,
  type RingInfo,
  type RingKind,
  type ScheduleItem,
  type Snooze,
  type Transport,
  type UserEditLog,
  type WakeCheck,
} from './types';
import { manualTimes, orderError } from './adjust';
import { LEVEL_FIELD, type EditLogLine } from './edits';
import { filterPlaces } from './places';
import * as real from './real';
import { repeatLabel, repeatToRrule, rruleToRepeat } from './repeat';
import { draftAt, initialTime, ringingKinds } from './schedule';
import type { StandaloneInput } from './request';
import { thetaReachedAt, usageSummary, type UseSpan } from './wake';

function toAppointment(a: MockAppointment): Appointment {
  return {
    id: a.id,
    title: a.title,
    at: a.at,
    place: a.place,
    origin: a.origin,
    transport: a.transport,
    travelMinutes: a.manual?.travelMinutes ?? a.travelMinutes, // 직접 입력했으면 그 값 (D42 C)
    travelSource: a.manual?.travelMinutes != null ? MANUAL_SOURCE : a.travelSource,
    bufferMinutes: a.bufferMinutes,
    beforePrepMinutes: a.beforePrepMinutes,
    prepMinutes: a.prepMinutes,
    predictedPrepMinutes: a.manual?.predictedPrepMinutes ?? a.predictedPrepMinutes,
    importance: a.importance,
    repeatLabel: repeatLabel(rruleToRepeat(a.recurrenceRule)),
    recurrenceRule: a.recurrenceRule,
    groupName: a.groupId ? (db.groups[a.groupId]?.name ?? null) : null,
    items: [...a.items],
    withWake: a.withWake,
    enabled: !db.disabledAppointments.has(a.id),
    alarms: alarmChain(a),
    level: axisLevel(a, 'sound'),
  };
}

const byTime = <T extends { at: Date }>(x: T, y: T) => x.at.getTime() - y.at.getTime();

function find(id: string) {
  return db.appointments.find((a) => a.id === id);
}

// 모든 일정의 알람 (H02) — 시각 순. 알람 없는 일정(H05에서 알람을 모두 끄고 저장)은 알람 목록에 없고 H01 일정 줄에만 보임
export async function listAppointments(): Promise<Appointment[]> {
  if (!isMock()) return real.listAppointments();
  return db.appointments
    .map(toAppointment)
    .filter((a) => a.alarms.length > 0)
    .sort(byTime);
}

// 지금 이후 가장 먼저 울릴 알람 (H01) — 꺼진 일정 · 꺼진 종류 · 도착 목표는 뺌
// 실데이터 구현의 본보기: 가짜 구현은 그대로 두고 맨 앞에서 real.ts로 넘김 (docs/screen-data-map.md "실데이터 연결 규칙")
export async function getNextAlarm(): Promise<NextAlarm | null> {
  if (!isMock()) return real.getNextAlarm();
  const t = now().getTime();
  let best: NextAlarm | null = null;
  for (const appointment of db.appointments.map(toAppointment)) {
    if (!appointment.enabled) continue;
    for (const alarm of appointment.alarms) {
      if (alarm.kind === 'ARRIVE' || !alarm.enabled || alarm.at.getTime() < t) continue;
      if (!best || alarm.at < best.alarm.at) best = { appointment, alarm };
    }
  }
  return best;
}

// 하루 일정 (H01) — 알람 있는 일정 + 알람 없는 일정 (둘 다 일정이고, 알람 없는 쪽은 hasAlarm이 false)
export async function getDaySchedule(day: Date): Promise<ScheduleItem[]> {
  if (!isMock()) return real.getDaySchedule(day);
  return db.appointments
    .filter((a) => isSameDay(a.at, day))
    .map((a) => ({
      appointmentId: a.id,
      at: a.at,
      title: a.title,
      place: a.place,
      importance: a.importance,
      hasAlarm: alarmChain(a).length > 0,
    }))
    .sort(byTime);
}

// 알람 설정 (H03) — 알람 없는 일정은 열 알람이 없어 null (일정 수정 · 삭제를 어디서 할지는 D41이 정함)
export async function getAppointment(id: string): Promise<AppointmentDetail | null> {
  if (!isMock()) return real.getAppointment(id);
  const a = find(id);
  if (!a || !alarmChain(a).length) return null;
  const auto = autoLevel(a);
  const manual = db.intensityOverrides[a.id] ?? {};
  const axis = (key: IntensityAxis) => ({ level: manual[key] ?? auto, manual: manual[key] != null });
  return {
    ...toAppointment(a),
    intensity: {
      auto,
      importancePoint: IMPORTANCE_POINT[a.importance],
      lateCount: db.lateCount4w,
      latePoint: db.lateCount4w >= 2 ? 1 : 0,
      axes: { sound: axis('sound'), voice: axis('voice'), vibration: axis('vibration') },
    },
    edits: {
      bufferMinutes: a.bufferMinutes,
      origin: a.origin,
      transport: a.transport,
      travelMinutes: a.manual?.travelMinutes ?? null,
      prepareMinutes: a.manual?.predictedPrepMinutes ?? null,
      times: { ...a.manual?.times },
    },
    auto: { travelMinutes: a.travelMinutes, predictedPrepMinutes: a.predictedPrepMinutes },
  };
}

// 가짜 길찾기 — 장소 · 이동 수단 · 출발 위치로 이동시간(분)을 셈 (5분 단위). 실데이터는 alarm-suggest(카카오). 모르는 장소는 null
function mockTravel(placeName: string, transport: Transport, origin: string): number | null {
  const place = places.find((p) => p.name === placeName);
  if (!place) return null;
  if (origin === placeName) return 5; // 출발 위치가 약속 장소와 같은 곳이면 가장 작은 값 (가짜 길찾기라 거리를 셀 수 없음 — 아래 최소값과 같음)
  const minutes = place.travelMinutes * (transportFactor[transport] ?? 1) * (origin === ORIGIN_HOME ? 1 : awayFromHomeFactor);
  return Math.max(5, Math.round(minutes / 5) * 5);
}

// 고친 값(초안)을 반영한 일정 (H03) — 저장 전 미리 보기와 저장이 같은 계산을 씀
//   출발 위치 · 이동 수단이 바뀌면 이동시간을 다시 계산(자동값), 직접 입력한 이동 · 준비 · 알람 시각은 자동 계산보다 먼저
//   자동 계산값과 같은 값은 직접 고른 것이 아니라 자동으로 둠
function withEdits(a: MockAppointment, e: AlarmEdits) {
  const moved = e.origin !== a.origin || e.transport !== a.transport;
  const autoTravel = moved ? (mockTravel(a.place, e.transport, e.origin) ?? a.travelMinutes) : a.travelMinutes;
  const autoPrepare = a.predictedPrepMinutes;
  const manual: NonNullable<MockAppointment['manual']> = {};
  if (e.travelMinutes != null && e.travelMinutes !== autoTravel) manual.travelMinutes = e.travelMinutes;
  if (e.prepareMinutes != null && e.prepareMinutes !== autoPrepare) manual.predictedPrepMinutes = e.prepareMinutes;
  const edited: MockAppointment = {
    ...a,
    bufferMinutes: e.bufferMinutes,
    origin: e.origin,
    transport: e.transport,
    travelMinutes: autoTravel,
    travelSource: moved ? '길찾기' : a.travelSource,
    manual: { ...manual, times: e.times },
  };
  const times = manualTimes(alarmChain(edited)); // 자동값과 같아진 시각은 뺌
  const kept = { ...manual, ...(Object.keys(times).length ? { times } : {}) };
  return { appointment: { ...edited, manual: Object.keys(kept).length ? kept : undefined }, autoTravel, autoPrepare };
}

// 값을 바꾸면 알람이 어떻게 되는지 (저장 전 미리 보기) — 실데이터는 alarm-suggest
export async function previewAlarms(id: string, edits: AlarmEdits): Promise<AlarmPreview> {
  if (!isMock()) return real.previewAlarms(id, edits);
  const a = find(id);
  if (!a) return { alarms: [], travelMinutes: 0, travelSource: '', autoTravelMinutes: 0, predictedPrepMinutes: 0, autoPredictedPrepMinutes: 0 };
  const { appointment, autoTravel, autoPrepare } = withEdits(a, edits);
  const view = toAppointment(appointment);
  return {
    alarms: view.alarms,
    travelMinutes: view.travelMinutes,
    travelSource: view.travelSource,
    autoTravelMinutes: autoTravel,
    predictedPrepMinutes: view.predictedPrepMinutes,
    autoPredictedPrepMinutes: autoPrepare,
  };
}

// 고친 값 기록 (user_edit_logs) — 사용자가 자동 값을 직접 고치면 한 줄씩 남김. 개인화(계산 · 제안)에 쓸 자료라 H03 · H05 확인 시트 · S01이 같이 부름
// 실데이터는 user_edit_logs insert. 앱 안에서 지우는 길은 없음
function pushEditLog(log: Omit<UserEditLog, 'at'>) {
  db.editLogs.push({ at: now(), ...log });
}

export async function recordEdit(log: EditLogLine) {
  if (!isMock()) return real.recordEdit(log);
  pushEditLog(log);
}

export async function listEditLogs(): Promise<UserEditLog[]> {
  if (!isMock()) return real.listEditLogs();
  return db.editLogs.map((log) => ({ ...log }));
}

// 일정의 알람 전체 켜기 · 끄기 (H01 · H02)
export async function setAppointmentEnabled(id: string, enabled: boolean) {
  if (!isMock()) return real.setAppointmentEnabled(id, enabled);
  if (enabled) db.disabledAppointments.delete(id);
  else db.disabledAppointments.add(id);
}

// 종류별 켜기 · 끄기 (H03)
export async function setAlarmEnabled(id: string, kind: AlarmKind, enabled: boolean) {
  if (!isMock()) return real.setAlarmEnabled(id, kind, enabled);
  const key = `${id}:${kind}`;
  if (enabled) db.disabledKinds.delete(key);
  else db.disabledKinds.add(key);
}

// 강도 직접 고르기 — level이 null이면 자동으로 되돌림
export async function setIntensity(id: string, axis: IntensityAxis, level: Level | null) {
  if (!isMock()) return real.setIntensity(id, axis, level);
  const current = { ...(db.intensityOverrides[id] ?? {}) };
  if (level == null) delete current[axis];
  else current[axis] = level;
  db.intensityOverrides[id] = current;
}

// 알람 설정 저장 (H03) — 여유 · 출발 위치 · 이동 수단 · 이동 · 준비 · 알람 시각 · 종류별 켜기 · 강도를 한 번에. 화면은 초안으로 들고 있다가 저장할 때만 부름
// 직접 고친 값은 하나씩 고친 값 기록(user_edit_logs)에 남김. 알람 순서(기상 ≤ 준비 ≤ 출발 ≤ 도착 목표)가 뒤집히면 저장하지 않고 UserError
// 종류를 모두 껐으면 일정 알람도 끄고, 껐던 종류를 다시 켜면 일정 알람도 다시 켬 (종류를 안 바꿨으면 일정 켜기 · 끄기는 그대로)
//   ※ "종류를 모두 끔"은 알람을 만들어 둔 채 끈 것 — H05에서 알람을 처음부터 안 만든 "알람 없는 일정"과 다름
// 돌려주는 값 = 이번 저장으로 일정 알람이 꺼졌는지 · 켜졌는지. 실데이터는 alarm-commit
export async function saveAlarmSettings(id: string, draft: AlarmSettingsDraft): Promise<{ turnedOff: boolean; turnedOn: boolean }> {
  if (!isMock()) return real.saveAlarmSettings(id, draft);
  const a = find(id);
  if (!a) return { turnedOff: false, turnedOn: false };
  const { appointment: next, autoTravel, autoPrepare } = withEdits(a, draft);
  const after = toAppointment(next);
  const blocked = orderError(after.alarms);
  if (blocked) throw new UserError(blocked);

  const log = (field: EditLogField, autoValue: unknown, editedValue: unknown, target: { alarmId?: string; alarmType?: AlarmKind } = {}) =>
    pushEditLog({ screen: 'H03', field, appointmentId: id, ...target, autoValue, editedValue });
  if (draft.bufferMinutes !== a.bufferMinutes) log('buffer_minutes', a.bufferMinutes, draft.bufferMinutes);
  if (draft.origin !== a.origin) log('origin', a.origin, draft.origin);
  if (draft.transport !== a.transport) log('transport', a.transport, draft.transport);
  // 직접 고른 값이 새 자동값과 같아져 자동으로 돌아간 것(이동 수단을 바꿔 자동값이 따라온 경우 등)은 사용자가 되돌린 것이 아니라 기록하지 않음 — 초안의 값이 저장된 값과 다를 때만
  const savedTravel = a.manual?.travelMinutes ?? null;
  const savedPrepare = a.manual?.predictedPrepMinutes ?? null;
  if ((next.manual?.travelMinutes ?? null) !== savedTravel && draft.travelMinutes !== savedTravel) {
    log('travel_minutes', autoTravel, next.manual?.travelMinutes ?? null);
  }
  if ((next.manual?.predictedPrepMinutes ?? null) !== savedPrepare && draft.prepareMinutes !== savedPrepare) {
    log('prepare_minutes', autoPrepare, next.manual?.predictedPrepMinutes ?? null);
  }
  for (const kind of RING_KINDS) {
    const before = a.manual?.times?.[kind];
    const typed = draft.times[kind];
    const picked = next.manual?.times?.[kind];
    if (before?.getTime() === picked?.getTime() || before?.getTime() === typed?.getTime()) continue;
    const alarm = after.alarms.find((x) => x.kind === kind);
    if (alarm) log('scheduled_at', alarm.auto ?? alarm.at, picked ?? null, { alarmId: alarm.id, alarmType: kind });
  }

  Object.assign(a, {
    bufferMinutes: next.bufferMinutes,
    origin: next.origin,
    transport: next.transport,
    travelMinutes: next.travelMinutes,
    travelSource: next.travelSource,
    manual: next.manual,
  });

  let kindOn = false;
  let kindOff = false;
  for (const alarm of ringingKinds(alarmChain(a))) {
    const picked = draft.kinds[alarm.kind];
    if (picked == null || picked === alarm.enabled) continue;
    await setAlarmEnabled(id, alarm.kind, picked);
    log('alarm_enabled', alarm.enabled, picked, { alarmId: alarm.id, alarmType: alarm.kind });
    if (picked) kindOn = true;
    else kindOff = true;
  }
  for (const [axis, level] of Object.entries(draft.levels) as [IntensityAxis, Level | null][]) {
    if ((db.intensityOverrides[id]?.[axis] ?? null) === level) continue;
    log(LEVEL_FIELD[axis], autoLevel(a), level);
    await setIntensity(id, axis, level);
  }
  const wasEnabled = !db.disabledAppointments.has(id);
  if (kindOff && wasEnabled && ringingKinds(alarmChain(a)).every((x) => !x.enabled)) {
    await setAppointmentEnabled(id, false);
    return { turnedOff: true, turnedOn: false };
  }
  if (kindOn && !wasEnabled) {
    await setAppointmentEnabled(id, true);
    return { turnedOff: false, turnedOn: true };
  }
  return { turnedOff: false, turnedOn: false };
}

// 장소 목록 (H05 · H03) — 검색어가 없으면 최근에 쓴 곳, 있으면 이름 · 주소에 검색어가 든 곳 (실데이터는 place-search 카카오 키워드, 가짜는 목업 장소에서 거름)
//   near = 보통 집 좌표, 부르는 화면이 넘김 — 주면 검색 결과를 가까운 순으로 (최근 장소에는 안 씀)
//   category는 서버 값 그대로 통과 (저장하지 않음, D5)
export async function listPlaces(query?: string, near?: LatLng): Promise<Place[]> {
  if (!isMock()) return real.listPlaces(query, near);
  const text = query?.trim();
  // 가짜 모드의 "최근 장소" = 처음부터 있던 4곳 (이전 동작 그대로), 검색은 대학가 장소 전체에서
  if (!text) return recentMockPlaces.map((p) => ({ ...p }));
  return filterPlaces(places, text, near).map((p) => ({ ...p }));
}

// 새 일정 처음 입력값 — 일정명 · 준비물은 비어 있음, 장소는 첫 곳 선택. 날짜 · 시간은 홈에서 넘어온 날(day)의 오후 2시
// (그 시각이 이미 지났으면 다음 정각)
export function defaultDraft(day: Date, current = now()): AppointmentDraft {
  return {
    title: '',
    date: startOfDay(day),
    time: initialTime(day, current),
    repeat: [],
    place: isMock() ? '학교 도서관' : '', // 실데이터는 목록에서 고른 장소 (H05가 목록을 읽은 뒤 첫 곳을 미리 골라 둠)
    transport: 'TRANSIT',
    importance: 'LOW',
    items: '',
    alarms: defaultAlarms(),
  };
}

// 날짜 + 시간 칸('14:00') → 시각. 시간이 비었거나 형식이 틀리면 목업처럼 14:00
export { draftAt };

let draftSeq = 0; // 새 일정 가짜 id 뒤에 붙이는 번호 — 같은 순간에 만들어도 겹치지 않게

// 알람 계산 (H05 확인 시트) — 공통 P80 + 개인 보정(n ÷ (n + k) × 개인 오차 P80)
export async function estimateAppointment(d: AppointmentDraft): Promise<Estimate> {
  if (!isMock()) return real.estimateAppointment(d);
  const at = draftAt(d.date, d.time);
  const place = places.find((p) => p.name === d.place) ?? places[0];
  const travel = mockTravel(place.name, d.transport, ORIGIN_HOME) ?? place.travelMinutes;
  // 그날 첫 일정만 기상 알람 — 약속 시각이 이 일정보다 앞선 같은 날 일정에 켜진 기상 알람이 있으면 기상 없이 준비부터 (서버와 같은 함수 hasEarlierWake)
  //   알람 없는 일정 · 꺼 둔 기상은 세지 않음
  const sameDayWake = hasEarlierWake(
    at,
    db.appointments
      .filter((a) => isSameDay(a.at, at) && alarmChain(a).some((x) => x.kind === 'WAKE'))
      .map((a) => ({ appointmentId: a.id, appointmentAt: a.at, isEnabled: !db.disabledAppointments.has(a.id) && !db.disabledKinds.has(`${a.id}:WAKE`) })),
  );
  const withWake = !sameDayWake;
  const common = withWake ? 50 : 15;
  const n = 10;
  const k = 10;
  const weight = n / (n + k);
  const residual = 20;
  const correction = Math.round(weight * residual);
  const before = withWake ? 20 : 0;
  const draft: MockAppointment = {
    id: `n${Date.now()}_${++draftSeq}`,
    title: d.title.trim() || '새 일정',
    at,
    place: place.name,
    origin: ORIGIN_HOME,
    transport: d.transport,
    travelMinutes: travel,
    travelSource: '길찾기',
    bufferMinutes: 10,
    beforePrepMinutes: before,
    prepMinutes: common - before,
    predictedPrepMinutes: common + correction,
    importance: d.importance,
    recurrenceRule: repeatToRrule(d.repeat),
    groupId: null,
    items: d.items
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    withWake,
    kinds: RING_KINDS.filter((kind) => d.alarms[kind]),
  };
  return {
    appointment: toAppointment(draft),
    commonP80: common,
    correction,
    sampleCount: n,
    prior: k,
    weight,
    residualP80: residual,
    sameDayWake,
    latePoint: db.lateCount4w >= 2 ? 1 : 0,
  };
}

// 계산한 일정을 저장 — 실데이터는 alarm-commit (일정 · 참여 조건 · 알람 4개를 한 번에)
// source = 하루 기록에 남길 출처 (AI 대화에서 찾은 일정이면 'AI 대화 · 확인함' 등)
// 확인 시트에서 알람 시각을 직접 고쳤으면(D43) 그 시각으로 저장하고 고친 값 기록에 남김. 순서가 뒤집혔으면 저장하지 않고 UserError
export async function createAppointment(estimate: Estimate, source = '직접 입력'): Promise<Appointment> {
  if (!isMock()) return real.createAppointment(estimate, source);
  const a = estimate.appointment;
  const blocked = orderError(a.alarms);
  if (blocked) throw new UserError(blocked);
  const picked = manualTimes(a.alarms);
  const saved: MockAppointment = {
    id: a.id,
    title: a.title,
    at: a.at,
    place: a.place,
    origin: a.origin,
    transport: a.transport,
    travelMinutes: a.travelMinutes,
    travelSource: a.travelSource,
    bufferMinutes: a.bufferMinutes,
    beforePrepMinutes: a.beforePrepMinutes,
    prepMinutes: a.prepMinutes,
    predictedPrepMinutes: a.predictedPrepMinutes,
    importance: a.importance,
    recurrenceRule: a.recurrenceRule,
    groupId: null,
    items: a.items,
    withWake: a.withWake,
    kinds: ringingKinds(a.alarms).map((x) => x.kind as RingKind), // 만든 알람 종류 — 하나도 없으면 알람 없는 일정
    ...(Object.keys(picked).length ? { manual: { times: picked } } : {}),
  };
  db.appointments.push(saved);
  for (const alarm of a.alarms) {
    if (!alarm.auto) continue;
    pushEditLog({
      screen: 'H05',
      field: 'scheduled_at',
      appointmentId: saved.id,
      alarmId: alarm.id,
      alarmType: alarm.kind,
      autoValue: alarm.auto,
      editedValue: alarm.at,
    });
  }
  db.events.push({ at: now(), label: `일정 저장 · ${saved.title}`, source });
  return toAppointment(saved);
}

// 음성 안내 문장 — 강도(말소리)에 따라 말투가 바뀜. 출발 알람은 같이 가는 그룹원 상황을 알려 줌
// again = 기상 확인이 안 돼 다시 울림
function voiceLine(a: MockAppointment, kind: RingKind, at: Date, again: boolean) {
  const chain = alarmChain(a);
  const depart = chain.find((x) => x.kind === 'DEPARTURE')?.at ?? a.at;
  const when = spokenTime(a.at);
  if (kind === 'WAKE') {
    if (again) return `아직 기상 확인이 안 됐어요. ${a.title}에 늦지 않게 지금 일어나 주세요.`;
    const subject = josa(a.title, '이', '가');
    const late = db.lateCount4w ? ` 최근 4주에 ${db.lateCount4w}번 늦었어요.` : '';
    return [
      `좋은 아침이에요. 오늘 ${when}에 ${subject} 있어요. 천천히 일어나 볼까요?`,
      `좋은 아침이에요. 오늘 ${when}에 ${subject} 있어요. 지금 일어나면 여유롭게 준비할 수 있어요.`,
      `지금 일어나야 해요. ${when} ${a.title}.${late} 바로 일어나세요.`,
    ][axisLevel(a, 'voice')];
  }
  if (kind === 'PREPARE') {
    return a.items.length
      ? `준비를 시작할 시간이에요. ${a.items.join(', ')} 챙기는 것 잊지 마세요.`
      : `준비를 시작할 시간이에요. ${spokenTime(depart)}에 출발해요.`;
  }
  const group = a.groupId ? db.groups[a.groupId] : null;
  if (group) {
    const nowMin = minuteOfDay(at);
    const others = group.members.filter((p) => timelines[p]);
    const did = (p: string, label: string) => timelines[p].some(([m, l]) => l === label && m <= nowMin);
    const gone = others.filter((p) => did(p, '출발'));
    const preparing = others.filter((p) => !gone.includes(p) && did(p, '준비 시작'));
    const names = (ids: string[]) => joinKo(ids.map((p) => `${people[p].short}님`));
    let line = '출발 시간입니다.';
    if (gone.length) line += ` ${group.name}에서 ${josa(names(gone), '이', '가')} 이미 출발했어요.`;
    if (preparing.length) line += ` ${josa(names(preparing), '은', '는')} 기상 후 준비를 시작했어요.`;
    return line;
  }
  return `출발 시간입니다. 지금 나가면 ${when} ${a.title}에 여유 ${a.bufferMinutes}분을 두고 도착해요.`;
}

// 알람 id(`${일정 id}:${종류}`)로 일정과 알람을 찾음 — 실데이터는 alarms.alarm_id
function findAlarm(alarmId: string) {
  const a = find(alarmId.split(':')[0]);
  const alarm = a ? alarmChain(a).find((x) => x.id === alarmId) : undefined;
  return a && alarm ? { a, alarm } : null;
}

// 울림 화면 (H07) — 실제 울림은 알람 코어(네이티브). 이 화면은 디자인 · 웹 미리 보기용
// again = 확인 알림에 응답이 없어 다시 울림 → 큰 시각은 다시 울린 시각 (목업 ring-time = S.now). 기상 알람만, 다른 종류는 무시
export async function getRing(alarmId: string, again = false): Promise<RingInfo | null> {
  if (!isMock()) return real.getRing();
  const found = findAlarm(alarmId);
  if (!found || found.alarm.kind === 'ARRIVE') return null;
  const { a, alarm } = found;
  const kind = alarm.kind as RingKind;
  const re = again && kind === 'WAKE';
  const sound = LEVELS[axisLevel(a, 'sound')];
  const vibration = LEVELS[axisLevel(a, 'vibration')];
  const rang = db.wake.alarmId === alarm.id && db.wake.phase === 'ringing' ? db.wake.ringAt : null;
  // 기록이 없으면(주소로 바로 열기) 알람 시각에 끈 것으로 보고 관찰 10분 + 응답 없음 5분 뒤
  const at = re ? (rang ?? addMinutes(alarm.at, WAKE_OBSERVE_MINUTES + WAKE_NO_REPLY_MINUTES)) : alarm.at;
  return {
    alarmId: alarm.id,
    kind,
    appointment: toAppointment(a),
    at,
    voiceTone: LEVELS[axisLevel(a, 'voice')].voice,
    voiceLine: voiceLine(a, kind, at, re),
    levelLine: `알람 강도 ${sound.name} · 배경음 ${sound.sound} · 진동 ${vibration.vibration}`,
    important: a.importance !== 'LOW',
  };
}

// 해제 뒤 화면 사용 시간 (분) — 실데이터는 #35 · #40
// 지금은 시연 값: 폰을 보며 일어남 · 알람만 끄고 다시 잠듦 (목업 simUse · simSleep)
// 폰을 보며 일어남 = 해제 뒤 화면을 켠 구간 → 누적 3.2분 · 뒤쪽 5분 1.4분. θ = 1분이면 해제 1.5분 뒤 확정 시각
const USED_SPANS: UseSpan[] = [
  [0.5, 1.5],
  [2.5, 3.3],
  [6, 7],
  [8.6, 9],
];
const NO_USE = { usage: 0, recent: 0 };
const USED = usageSummary(USED_SPANS);
const SLEPT = { usage: 0.4, recent: 0 };

// 울리기 시작 (H07) — 기상 알람이면 내 상태가 '알람 울리는 중'. 실데이터는 알람 코어(#33) · alarm_events TRIGGERED
// 이미 기상 확정한 알람이면 판정을 그대로 둠 (목업은 기상 전에만 S.wake를 비움)
export async function startRing(alarmId: string, at: Date) {
  if (!isMock()) return real.startRing();
  delete db.snoozes[alarmId]; // 다시 울리기 시작하면 미룸 표시는 끝
  if (findAlarm(alarmId)?.alarm.kind !== 'WAKE' || db.wakeConfirmations[alarmId]) return;
  db.wake = { alarmId, phase: 'ringing', ringAt: at, dismissedAt: null, ...NO_USE };
}

// 미루기 · 해제 없이 울림 화면을 나감 (뒤로 가기) — 울리는 중 표시만 지우고 기록은 안 남김
export async function stopRing(alarmId: string) {
  if (!isMock()) return real.stopRing();
  if (db.wake.alarmId === alarmId && db.wake.phase === 'ringing') db.wake = { ...db.wake, phase: 'idle' };
}

// 미루기 (H07) — 울리는 중 표시를 지우고 기록 (목업 A.snooze). at = 미룬 시각
// 미룬 뒤 다시 울림 · 3번 제한 · SNOOZED 기록은 알람 코어(#33)
export async function snoozeRing(alarmId: string, minutes: number, at: Date) {
  if (!isMock()) return real.snoozeRing();
  const found = findAlarm(alarmId);
  // 이미 기상 확정한 알람이면 해제처럼 기록을 그대로 둠 (확정 뒤에 미루기가 붙지 않게)
  if (!found || db.wakeConfirmations[alarmId]) return;
  await stopRing(alarmId);
  db.snoozes[alarmId] = { at: addMinutes(at, minutes), minutes };
  db.events.push({ at, label: `${KIND_LABEL[found.alarm.kind]} 알람 ${minutes}분 미루기`, source: '자동' });
}

// 미룬 알람 (H01) — 다시 울릴 시각이 아직 안 된 것 중 가장 빠른 것. 실데이터는 알람 코어가 가진 미루기 예약(#33)
export async function getSnooze(): Promise<Snooze | null> {
  if (!isMock()) return real.getSnooze();
  const t = now().getTime();
  const list = Object.entries(db.snoozes)
    .filter(([, s]) => s.at.getTime() > t)
    .sort(([, x], [, y]) => x.at.getTime() - y.at.getTime());
  for (const [alarmId, s] of list) {
    const found = findAlarm(alarmId);
    if (found && found.alarm.kind !== 'ARRIVE') {
      return { alarmId, kind: found.alarm.kind, appointmentTitle: found.a.title, at: s.at, minutes: s.minutes };
    }
  }
  return null;
}

// 미루기 취소 (H01) — 다시 울리지 않음. 실데이터는 알람 코어의 미루기 예약 취소
// 돌려주는 wakeCheck = 기상 알람의 미루기를 취소해 해제로 기록했으니 기상 확인(H08)으로 이어가라는 뜻 (실데이터만 — 가짜 데이터는 지금처럼 늘 false)
export async function cancelSnooze(alarmId: string): Promise<CancelSnoozeResult> {
  if (!isMock()) return real.cancelSnooze(alarmId);
  delete db.snoozes[alarmId];
  return { wakeCheck: false };
}

// 알람 해제 (H07) — at = 실제로 끈 시각(울린 시각). 기상 알람이면 기상 판정(관찰 중)을 시작
// 이미 기상 확정한 알람이면 판정 · 기록을 그대로 둠 (해제 기록이 겹치지 않게). 실데이터는 alarm_events DISMISSED
export async function dismissRing(alarmId: string, at: Date) {
  if (!isMock()) return real.dismissRing();
  const found = findAlarm(alarmId);
  delete db.snoozes[alarmId];
  if (!found || db.wakeConfirmations[alarmId]) return;
  db.events.push({ at, label: `${KIND_LABEL[found.alarm.kind]} 알람 해제`, source: '자동' });
  if (found.alarm.kind === 'WAKE') db.wake = { alarmId, phase: 'observing', ringAt: null, dismissedAt: at, ...NO_USE };
}

// 기상 확인 (H08) — 기상 알람을 끈 뒤 화면 사용으로 판정. 실데이터는 #35 · #40
// alarmId가 없으면 진행 중인 판정, 그것도 없으면 오늘 첫 기상 알람
// 확정 전인데 아직 안 껐으면(울리기 전 · 울리는 중) 목업 빈 화면처럼 null
export async function getWakeCheck(alarmId?: string): Promise<WakeCheck | null> {
  if (!isMock()) return real.getWakeCheck(alarmId);
  const id = alarmId ?? db.wake.alarmId;
  const found = id
    ? findAlarm(id)
    : db.appointments
        .flatMap((a) => {
          const alarm = alarmChain(a).find((x) => x.kind === 'WAKE'); // 기상 알람이 없는 일정은 건너뜀
          return alarm ? [{ a, alarm }] : [];
        })
        .sort((x, y) => x.alarm.at.getTime() - y.alarm.at.getTime())[0];
  if (!found || found.alarm.kind !== 'WAKE') return null;
  const { a, alarm } = found;
  const confirmed = db.wakeConfirmations[alarm.id];
  const live = db.wake.alarmId === alarm.id ? db.wake : null;
  if (!confirmed && live?.phase !== 'observing' && live?.phase !== 'prompt') return null;
  return {
    alarmId: alarm.id,
    appointmentTitle: a.title,
    groupId: a.groupId && db.groups[a.groupId] ? a.groupId : null,
    groupName: a.groupId ? (db.groups[a.groupId]?.name ?? null) : null,
    phase: live?.phase === 'prompt' ? 'prompt' : 'observing',
    // 확정 뒤 다른 기상 알람이 울려 판정이 바뀌었으면 알람 시각에 끈 것으로 봄
    dismissedAt: live?.dismissedAt ?? alarm.at,
    thetaMinutes: db.wakeThetaMinutes,
    // 확정했으면 그때 저장한 사용 시간 — 다른 기상 알람이 울려 db.wake가 바뀌어도 "자동 판정"과 0분이 엇갈리지 않게
    usage: confirmed ? confirmed.usage : (live?.usage ?? 0),
    recent: confirmed ? confirmed.recent : (live?.recent ?? 0),
    confirmed: confirmed ? { at: confirmed.at, how: confirmed.how } : null,
  };
}

// 진행 중인 기상 확인 (H01 다시 들어가기) — 기상 알람을 끈 뒤 판정이 끝나기 전이면 H08을 다시 열 수 있게. 없으면 null
export async function getWakeInProgress(): Promise<WakeCheck | null> {
  if (!isMock()) return real.getWakeInProgress();
  if (!db.wake.alarmId || (db.wake.phase !== 'observing' && db.wake.phase !== 'prompt')) return null;
  const check = await getWakeCheck(db.wake.alarmId);
  return check && !check.confirmed ? check : null;
}

// 앱이 앞에 올 때 — 최근 12시간에 끈 기상 알람 중 확정이 없는 것을 다시 판정해 조건을 채웠으면 확정 기록 (실데이터만 — 가짜 데이터는 시연 버튼으로 넘기므로 하지 않음). 새로 확정한 알람 id를 돌려줌
export async function recheckRecentWakes(): Promise<string[]> {
  if (isMock()) return [];
  return real.recheckRecentWakes();
}

// 확인 알림 (H08) — 해제 뒤 10분 동안 조건을 못 채움 (시연: 알람만 끄고 다시 잠듦). at = 관찰이 끝난 시각. 실데이터는 #35 · #40
export async function promptWake(alarmId: string, at: Date) {
  if (!isMock()) return real.promptWake();
  const dismissedAt = db.wake.alarmId === alarmId ? db.wake.dismissedAt : null;
  db.wake = { alarmId, phase: 'prompt', ringAt: null, dismissedAt, ...SLEPT };
  db.events.push({ at, label: '확인 알림 발송', source: '알림' });
}

// 확인 알림에도 응답이 없음 → 기상 알람이 다시 울림 (H07 again=1). at = 다시 울리는 시각
// 다시 울릴지는 D2에서 정함 — 안 울리기로 하면 이 함수와 재알람 기록을 같이 뺌
export async function missWake(alarmId: string, at: Date) {
  if (!isMock()) return real.missWake();
  db.wake = { alarmId, phase: 'ringing', ringAt: at, dismissedAt: null, ...NO_USE };
  db.events.push({ at, label: '재알람', source: '자동' });
}

// how: self = 확인 알림에 직접 응답(사용 시간은 확인 알림 때 그대로), auto = 화면 사용으로 자동 판정(시연: 폰을 보며 일어남)
// at = 판정한 시각 (자동은 관찰이 끝난 시각, 직접 응답은 응답 시각)
// 기록 시각 (D14): 직접 응답은 at 그대로, 자동은 누적 사용이 θ를 넘은 시각 — 해제 시각을 모르거나 못 넘었으면 at
// 실데이터는 alarm_events WAKE_CONFIRMED
export async function confirmWake(alarmId: string, how: 'self' | 'auto', at: Date) {
  if (!isMock()) return real.confirmWake(alarmId, how);
  if (db.wakeConfirmations[alarmId]) return; // 이미 확정한 알람은 처음 판정 그대로
  const dismissedAt = db.wake.alarmId === alarmId ? db.wake.dismissedAt : null;
  const reached = how === 'auto' && dismissedAt ? thetaReachedAt(dismissedAt, USED_SPANS, db.wakeThetaMinutes) : null;
  const wokeAt = reached ?? at;
  if (db.wake.alarmId === alarmId) db.wake = { ...db.wake, phase: 'confirmed', ...(how === 'auto' ? USED : {}) };
  const use = db.wake.alarmId === alarmId ? { usage: db.wake.usage, recent: db.wake.recent } : how === 'auto' ? USED : NO_USE;
  db.wakeConfirmations[alarmId] = { at: wokeAt, how, ...use };
  db.me.wakeAt = wokeAt;
  db.events.push({ at: wokeAt, label: '기상 확인', source: how === 'self' ? '직접 응답' : '자동 판정' });
}

// 일정 없는 알람 만들기 · 고치기 (D46 · Q10, 알람 목록 "+") — 입력 화면은 새 UI라 아직 없고 api만. 실데이터 전용 (alarm-commit STANDALONE)
//   만들기: 시각(at) 필수, repeat(요일, [] = 반복 없음) · level(강도 한 단계, null = 자동) · enabled는 고르는 것
//   고치기: 알람 id와 바꿀 것만 — 시각 없이 강도(level) · 켜기(enabled)만도 됨. 돌려주는 값은 목록이 그리는 모양(제목 "알람")
//   가짜 데이터에는 이 알람을 둘 자리가 없어 실데이터 모드에서만
export type NewStandaloneAlarm = Required<Pick<StandaloneInput, 'at'>> & Omit<StandaloneInput, 'alarmId' | 'at'>;
export type StandaloneAlarmPatch = Omit<StandaloneInput, 'alarmId'>;

export async function createStandaloneAlarm(input: NewStandaloneAlarm): Promise<Appointment> {
  if (isMock()) throw new UserError('일정 없는 알람은 실데이터 모드에서만 만들 수 있어요');
  return real.saveStandaloneAlarm(input);
}

export async function updateStandaloneAlarm(alarmId: string, patch: StandaloneAlarmPatch): Promise<Appointment> {
  if (isMock()) throw new UserError('일정 없는 알람은 실데이터 모드에서만 고칠 수 있어요');
  return real.saveStandaloneAlarm({ ...patch, alarmId });
}
