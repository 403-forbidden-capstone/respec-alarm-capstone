// ① 약속 기반 알람 — 데이터 접근은 이 파일에서만 합니다.
// 지금은 src/mocks의 가짜 데이터를 돌려주고, Supabase가 붙으면 이 파일 안에서만 바꿉니다.
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (H01 · H02 · H03 · H05 · H07 · H08)
import { DEFAULT_COMMON_P80, personalPrepareOf, predictPrepare, prepareStatsOf, recentPrepareOf, wakeMarginOf } from '@shared/calc/prepare.ts';
import { hasEarlierWake, isEveningWake } from '@shared/calc/wake.ts';
import { Platform } from 'react-native';

import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';
import { isMock } from '@/lib/mode';
import { addMinutes, isSameDay, josa, joinKo, minuteOfDay, minutesBetween, spokenTime, startOfDay } from '@/lib/format';
import { alarmChain, autoLevel, axisLevel, departAtOf } from '@/mocks/calc';
import { awayFromHomeFactor, db, people, places, recentMockPlaces, timelines, transportFactor, type MockAppointment } from '@/mocks/data';

import {
  defaultAlarms,
  IMPORTANCE_POINT,
  KIND_LABEL,
  LEVELS,
  MANUAL_SOURCE,
  ORIGIN_HOME,
  RING_KINDS,
  type AlarmEdits,
  type AlarmKind,
  type AlarmPreview,
  type AlarmSettingsDraft,
  type CancelSnoozeResult,
  type EditLogField,
  type Appointment,
  type AppointmentDetail,
  type AppointmentDraft,
  type AppointmentPatch,
  type DepartCheck,
  type EditScope,
  type Estimate,
  type IntensityAxis,
  type LatLng,
  type Level,
  type MorningPlan,
  type NextAlarm,
  type Occurrence,
  type Place,
  type PinAddress,
  type RingInfo,
  type RingKind,
  type SavedAppointment,
  type ScheduleItem,
  type SettingsSaveResult,
  type Snooze,
  type Transport,
  type UpdateOptions,
  type UpdateResult,
  type UserEditLog,
  type WakeCheck,
  type JoinChoice,
  type JoinDefaults,
  type JoinResult,
  type EarlyWake,
  EARLY_WAKE_MINUTES,
} from './types';
import { manualTimes, orderError } from './adjust';
import { LEVEL_FIELD, type EditLogLine } from './edits';
import { hasAlarms, listOnePerSeries, toOccurrences } from './map';
import { filterPlaces } from './places';
import * as real from './real';
import { getNearestPreviewRing, getPreviewRing, isPreviewAlarmId, nextPreviewAlarm, parsePreviewAlarmId } from './ringPreview';
import { repeatLabel, repeatToRrule, rruleToRepeat } from './repeat';
import { pickMorningSource, toDepartCheck, toMorningPlan, morningDay, wakeAlarmOf, type MorningSource } from './morning';
import { ringNotice } from './notice';
import { changedAlarms, CONFIRM_MOVE_MINUTES, draftAt, initialTime, ringingKinds } from './schedule';
import type { StandaloneInput } from './request';
import { thetaReachedAt, usageSummary, WAKE_THETA_MINUTES, type UseSpan } from './wake';
// 알람 코어의 순수 계산 파일만 직접 가져옴 (index는 네이티브 모듈을 찾으므로 — 같은 선례: lib/alarmSync 시험)
import { canSnooze, DEFAULT_SNOOZE_LIMIT } from '../../../modules/alarm-core/src/plan';

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
    ...(a.groupId && !isMine(a) ? { canEdit: false as const } : {}),
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
//   반복은 묶음(series_id)당 지금 이후 가장 가까운 회차 하나 — 실데이터와 같은 규칙. everyOccurrence = 묶음을 줄이지 않고 모든 회차 (H05가 같은 날 앞 일정의 기상을 찾을 때)
export async function listAppointments(options: { everyOccurrence?: boolean } = {}): Promise<Appointment[]> {
  if (!isMock()) return real.listAppointments(options);
  const entries = db.appointments
    .map((a) => ({ seriesId: a.seriesId, item: toAppointment(a) }))
    .filter((entry) => hasAlarms(entry.item));
  return options.everyOccurrence ? entries.map((entry) => entry.item).sort(byTime) : listOnePerSeries(entries, now().getTime());
}

// 반복 일정의 앞으로 회차 (H03 회차 목록) — 같은 묶음의 지금 이후 회차, 시각 순. 반복이 아니면 빈 목록. 화면은 다음 3회만 보이고 나머지는 접음
export async function listOccurrences(id: string): Promise<Occurrence[]> {
  if (!isMock()) return real.listOccurrences(id);
  const own = find(id);
  if (!own?.seriesId) return [];
  const rows = db.appointments
    .filter((a) => a.seriesId === own.seriesId)
    .map((a) => ({
      appointment: { appointment_id: a.id, appointment_at: a.at.toISOString() },
      alarms: alarmChain(a).map((x) => ({ alarm_type: x.kind, scheduled_at: x.at.toISOString(), is_enabled: x.enabled && !db.disabledAppointments.has(a.id) })),
    }));
  return toOccurrences(rows, now().getTime());
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

// 오늘 첫 일정 (H08 기상 확정 뒤 한 줄 · H01 아침 카드, 이슈 #230) — 켜진 기상 알람이 붙은 그날 가장 이른 약속. 저녁(18시~)에는 홈처럼 내일. 없으면 null
//   칸: 약속 · 준비 · 출발 · 도착 목표 시각(켜진 알람만) · 이동분과 출처 · 기상 확인 시각 · 출발 기록. 실데이터는 하루 일정(getDaySchedule)과 같은 읽기를 같이 씀 (realMorning.ts)
export async function getMorningPlan(): Promise<MorningPlan | null> {
  if (!isMock()) return real.getMorningPlan();
  const day = morningDay(now());
  const sources: MorningSource[] = db.appointments
    .filter((a) => isSameDay(a.at, day))
    .map(toAppointment)
    .map((a) => ({
      appointmentId: a.id,
      title: a.title,
      at: a.at,
      place: a.place,
      travelMinutes: a.travelMinutes,
      travelSource: a.travelSource,
      alarms: a.enabled ? a.alarms : a.alarms.map((x) => ({ ...x, enabled: false })), // 일정 전체를 끈 가짜 일정은 알람도 꺼진 것으로 (실데이터는 알람마다 꺼짐)
      departedAt: db.me.departAt,
    }));
  const source = pickMorningSource(sources);
  const wake = source ? wakeAlarmOf(source) : undefined;
  return source && wake ? toMorningPlan(source, db.wakeConfirmations[wake.id]?.at ?? null) : null;
}

// 지금 나가면 (H01 아침 카드 [다시 확인]) — 도착 = 지금 + 이동, 여유 · 상태는 서버와 같은 departNow. 저장하지 않음
//   실데이터는 alarm-suggest 미리 보기로 이동시간을 새로 구함 (realPlan.ts). 가짜 모드는 일정에 적힌 이동분
export async function checkDepartNow(appointmentId: string): Promise<DepartCheck> {
  if (!isMock()) return real.checkDepartNow(appointmentId);
  const a = find(appointmentId);
  if (!a) throw new UserError('일정을 찾을 수 없어요');
  const view = toAppointment(a);
  return toDepartCheck({ appointmentAt: view.at, travelMinutes: view.travelMinutes, source: view.travelSource, now: now() });
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
// 가짜 모드의 "내 기록" — 기상~출발 10건(최신순)이고 0.8 분위수가 70분(정렬 …65 70 70 90) = 첫 값 50보다 20분 긺 (목업 숫자 n 10 · 개인 오차 20). 계산은 서버와 같은 predictPrepare
//   서버와 같은 규칙: 개인 보정은 그날 첫 일정(기상 있음)에만, 두 번째 일정은 공통 15분 그대로 (학습 루프 기초 2절 2).
//   깨우는 여유(db.wakeMargin)는 이 기록의 0.7 · 0.8 · 0.9 분위수, 매우 중요 일정은 한 단계 위 (서버 personalPrepareOf와 같은 함수). 기본 보통 = 예전과 같은 70분
const MOCK_PREPARE_STATS = prepareStatsOf([90, 70, 62, 55, 48, 70, 65, 60, 58, 45]);

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
    prepareSampleCount: appointment.withWake ? MOCK_PREPARE_STATS.sampleCount : 0,
    prepareRecent: appointment.withWake ? recentPrepareOf(MOCK_PREPARE_STATS) : [],
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
// 돌려주는 값 = 이번 저장으로 일정 알람이 꺼졌는지 · 켜졌는지. 실데이터는 alarm-commit — 폰에 못 건 알람이 있으면 followUp (saveNotice.ts)
export async function saveAlarmSettings(id: string, draft: AlarmSettingsDraft): Promise<SettingsSaveResult> {
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

// ── 일정 수정 · 삭제 (H03 편집 시트 · 이슈 #211 · D41 A · N6) ──
//   가짜 모드만 — 실서버는 4b(서버 함수 appointment-edit)에서 realEdit.ts를 채움. 화면(L5)은 이 4개 함수와 types.ts의 AppointmentPatch · EditScope · UpdateResult만 앎

const NOT_CREATOR = '공동 약속은 만든 사람만 고칠 수 있어요';

// 공동 약속은 만든 사람만 고치고 지움 (N6). 만든 사람 칸이 없으면 나
const isMine = (a: MockAppointment) => (a.creatorId ?? 'me') === 'me';

function assertEditable(a: MockAppointment) {
  if (a.groupId && !isMine(a)) throw new UserError(NOT_CREATOR);
}

// 고치기 · 지우기가 닿는 일정들 — this = 그 일정만, following = 같은 반복 묶음(seriesId)의 이 일정과 그 뒤 일정. 묶음이 없으면(반복이 아니거나 가짜 데이터에 묶음이 없음) scope와 상관없이 그 일정 하나
function scopeTargets(a: MockAppointment, scope: EditScope): MockAppointment[] {
  if (scope === 'this' || !a.seriesId) return [a];
  return db.appointments.filter((x) => x.seriesId === a.seriesId && x.at.getTime() >= a.at.getTime()).sort(byTime);
}

// 그날 첫 일정만 기상 알람 — 같은 날 일정 중 기상을 울릴 수 있는 가장 이른 일정에 붙이고 나머지는 준비부터 (서버 hasEarlierWake와 같은 기준: 꺼 둔 기상 · 알람 없는 일정은 안 셈)
//   시각이 옮겨지거나 일정이 지워지고 되살아날 때 그날 첫 일정이 바뀌므로 다시 판정 (실서버는 4b가 7.1.3대로). days = 다시 볼 날짜들
function wakeFlags(list: readonly MockAppointment[], days: readonly Date[]): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  for (const day of days) {
    let taken = false;
    for (const a of list.filter((x) => isSameDay(x.at, day)).sort(byTime)) {
      // 계산된 기상이 낮 12시 이후(저녁 일정)면 기상을 울릴 수 없음 — 서버 computePlan과 같은 함수 (#320). 직접 고른 기상 시각은 존중
      const wake = alarmChain({ ...a, withWake: true }).find((x) => x.kind === 'WAKE');
      const canWake = wake != null && (a.manual?.times?.WAKE != null || !isEveningWake(wake.at, 'Asia/Seoul', a.at));
      flags.set(a.id, canWake && !taken);
      if (canWake && !db.disabledAppointments.has(a.id) && !db.disabledKinds.has(`${a.id}:WAKE`)) taken = true;
    }
  }
  return flags;
}

function reassignWake(days: readonly Date[]) {
  const flags = wakeFlags(db.appointments, days);
  for (const a of db.appointments) if (flags.has(a.id)) a.withWake = flags.get(a.id)!;
}

// 일정 하나에 고친 값을 반영한 새 일정 (저장 전) — 알람 시각 · 강도는 alarmChain · axisLevel이 일정 값에서 다시 셈
//   · at: 'following'은 고른 일정이 옮겨진 만큼(delta) 뒤 회차도 같이 옮김 (회차마다 날짜가 다르니 같은 시각으로 맞추지 않고 같은 간격으로)
//   · place: 목업 장소표에 있는 곳이면 이동시간을 다시 구함(자동값). 직접 입력한 이동시간은 그대로 (D42 C)
//   · 직접 고른 알람 시각은 그대로 두되, 날짜가 바뀌면 같은 시:분으로 따라감
//     // L6 안건후보: 일정 시각을 옮길 때 직접 고른 알람 시각 기본안 = 같은 날이면 유지 · 날짜가 바뀌면 날짜만 따라감
//   · repeatDays: 'following'일 때만 (한 회차만 고치면서 반복 규칙을 바꾸는 건 뜻이 없음)
//     // L6 안건후보: 이번만 고칠 때 반복 요일 기본안 = 무시
function applyPatch(a: MockAppointment, patch: AppointmentPatch, delta: number, scope: EditScope): MockAppointment {
  const next: MockAppointment = { ...a };
  if (patch.title !== undefined) next.title = patch.title.trim();
  if (patch.at) {
    next.at = new Date(a.at.getTime() + delta);
    if (!isSameDay(a.at, next.at) && a.manual?.times) {
      const days = startOfDay(next.at).getTime() - startOfDay(a.at).getTime();
      const times: Partial<Record<RingKind, Date>> = {};
      for (const kind of RING_KINDS) {
        const picked = a.manual.times[kind];
        if (picked) times[kind] = new Date(picked.getTime() + days);
      }
      next.manual = { ...a.manual, times };
    }
  }
  if (patch.place !== undefined && patch.place !== a.place) {
    next.place = patch.place;
    const travel = mockTravel(patch.place, a.transport, a.origin);
    if (travel != null) {
      next.travelMinutes = travel;
      next.travelSource = '길찾기';
    }
  }
  if (patch.importance) next.importance = patch.importance;
  if (patch.repeatDays && scope === 'following') next.recurrenceRule = repeatToRrule(patch.repeatDays);
  return next;
}

// 일정 고치기 (H03 편집 시트) — 제목 · 날짜 시각 · 장소 · 중요도 · 반복 요일. 알람 시각 · 강도는 고친 값으로 다시 계산됨
//   changes = 시각이 바뀌는 기상 · 준비 · 출발의 전 → 후 (제목만 바꾸면 빈 목록)
//   needsConfirm = 5분(CONFIRM_MOVE_MINUTES) 이상 늦춰지는 알람이 있음 (D67, 앞당김은 묻지 않음 — H03 기존 확인 시트 needsMoveConfirm은 앞당김도 묻는 쪽이라 다름). true면 저장하지 않고 돌려줌 → 화면이 기존 확인 시트로 묻고, 확인하면 { confirmed: true }로 같은 값을 다시 부름
//   앞당김 · 5분 미만 늦춤은 바로 저장하고 needsConfirm false → 화면이 토스트 [되돌리기]. 되돌리기 = 이전 값을 { confirmed: true }로 넣어 같은 함수를 다시 부름 (늦춤이어도 묻지 않게)
//   공동 약속은 만든 사람만 (UserError). 알람 순서(기상 ≤ 준비 ≤ 출발 ≤ 도착 목표)가 뒤집히면 저장하지 않고 UserError — saveAlarmSettings와 같은 검사
export async function updateAppointment(id: string, patch: AppointmentPatch, scope: EditScope, options: UpdateOptions = {}): Promise<UpdateResult> {
  if (!isMock()) return real.updateAppointment(id, patch, scope, options);
  const a = find(id);
  if (!a) throw new UserError('일정을 찾을 수 없어요');
  assertEditable(a);
  if (patch.title !== undefined && !patch.title.trim()) throw new UserError('일정 이름을 입력해 주세요');

  const targets = scopeTargets(a, scope);
  const delta = patch.at ? patch.at.getTime() - a.at.getTime() : 0;
  const edited = targets.map((t) => applyPatch(t, patch, delta, scope));
  // 그날 첫 일정을 다시 판정해 기상 알람이 붙는 일정을 정함 — 옮기기 전 날 · 옮긴 뒤 날 모두
  const after = db.appointments.map((x) => edited.find((e) => e.id === x.id) ?? x);
  const flags = wakeFlags(after, [...targets, ...edited].map((x) => x.at));
  const next = after.map((x) => (flags.has(x.id) && x.withWake !== flags.get(x.id) ? { ...x, withWake: flags.get(x.id)! } : x));

  for (const e of edited) {
    const blocked = orderError(alarmChain(next.find((x) => x.id === e.id)!));
    if (blocked) throw new UserError(blocked);
  }
  const changes = changedAlarms(alarmChain(a), alarmChain(next.find((x) => x.id === id)!));
  const needsConfirm = changes.some((c) => minutesBetween(c.from, c.to) >= CONFIRM_MOVE_MINUTES);
  if (needsConfirm && !options.confirmed) return { changes, needsConfirm: true };

  db.appointments.forEach((x, i) => Object.assign(x, next[i]));
  return { changes, needsConfirm: false };
}

let trashBatch = 0; // 한 번에 지운 일정들을 묶는 번호

// 일정 지우기 (H03 · H01) — 가짜 db에서 숨김(휴지통)으로 옮겨 목록 · 하루 일정 · 다음 알람에서 안 보임. restoreAppointment로 되살림
//   scope: 반복이면 this = 이번 회차만 · following = 이번 회차와 그 뒤 모두. 반복이 아니면 scope를 안 봄 (그 일정 하나)
//   지운 일정이 그날 첫 일정이었으면 그날 다음 일정에 기상 알람이 붙음. 공동 약속은 만든 사람만 (UserError)
export async function deleteAppointment(id: string, scope: EditScope): Promise<void> {
  if (!isMock()) return real.deleteAppointment(id, scope);
  const a = find(id);
  if (!a) throw new UserError('일정을 찾을 수 없어요');
  assertEditable(a);
  const targets = scopeTargets(a, scope);
  const batch = ++trashBatch;
  const rows = targets.map((t) => ({ batch, index: db.appointments.indexOf(t), appointment: t }));
  for (const row of [...rows].sort((x, y) => y.index - x.index)) db.appointments.splice(row.index, 1);
  db.trash.push(...rows);
  reassignWake(targets.map((t) => t.at));
}

// 지운 일정 되살리기 (삭제 토스트 [되돌리기], 앱이 5초 안에 부름) — 같이 지운 반복 회차도 함께, 원래 자리로. 지운 적 없으면 아무것도 안 함
//   실데이터(4b)는 5초 안에는 서버로 안 보내서 되살릴 것이 서버에 없음 — 가짜 모드만 지운 것을 되살림
export async function restoreAppointment(id: string): Promise<void> {
  if (!isMock()) return real.restoreAppointment(id);
  const hit = db.trash.filter((t) => t.appointment.id === id).pop();
  if (!hit) return;
  const batch = db.trash.filter((t) => t.batch === hit.batch).sort((x, y) => x.index - y.index);
  db.trash = db.trash.filter((t) => t.batch !== hit.batch);
  for (const row of batch) db.appointments.splice(Math.min(row.index, db.appointments.length), 0, row.appointment);
  reassignWake(batch.map((t) => t.appointment.at));
}

// 공동 약속 [내 알람 만들기] (친구 9장) — 가짜 모드는 빠졌던 약속을 내 목록으로 되돌림(내 집 · 고른 수단)
export async function joinSharedAppointment(id: string, choice: JoinChoice): Promise<JoinResult> {
  if (!isMock()) return real.joinSharedAppointment(id, choice);
  const left = db.left.find((x) => x.id === id);
  if (left) {
    db.left.splice(db.left.indexOf(left), 1);
    db.appointments.push({ ...left, transport: choice.transport, origin: ORIGIN_HOME });
    reassignWake([left.at]);
  }
  return { phoneFailed: 0 };
}

export async function getJoinDefaults(): Promise<JoinDefaults> {
  if (!isMock()) return real.getJoinDefaults();
  return { homeName: '집', transport: 'TRANSIT', prepareMinutes: 60 };
}

// 공동 약속에서 나만 빠지기 ([나는 빠지기]) — 내 참여 행 · 알람만 사라지고 약속은 다른 참여자에게 그대로 (가짜 모드는 내 목록에서만 뺌, 되살리기 없음)
//   공동 약속이 아니거나 내가 만든 약속이면 UserError (만든 사람은 지우기를 써야 함)
//   // L6 안건후보: 만든 사람이 빠지려 할 때 기본안 = 막고 "지워 주세요" 안내
export async function leaveSharedAppointment(id: string): Promise<void> {
  if (!isMock()) return real.leaveSharedAppointment(id);
  const a = find(id);
  if (!a) throw new UserError('일정을 찾을 수 없어요');
  if (!a.groupId) throw new UserError('공동 약속이 아니에요');
  if (isMine(a)) throw new UserError('내가 만든 공동 약속은 빠질 수 없어요. 지워 주세요');
  db.appointments.splice(db.appointments.indexOf(a), 1);
  db.left.push(a);
  reassignWake([a.at]);
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

// 지도 핀 자리의 주소 (지도 고르기 시트) — 핀이 멈춘 뒤 부름. 못 구하면 null (바다 · 해외), 서버 오류는 던짐 (실데이터는 place-reverse 카카오 좌표→주소, 저장 안 함)
//   가짜 모드는 좌표로 만든 그럴듯한 광진구 주소 (같은 좌표면 같은 주소)
export async function reverseAddress(lat: number, lng: number): Promise<PinAddress | null> {
  if (!isMock()) return real.reverseAddress(lat, lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const number = 1 + (Math.round(Math.abs(lat * 1e4 + lng * 1e4)) % 300);
  return { address: `서울 광진구 능동로 ${number} (가짜)` };
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

// 알람 계산 (H05 확인 시트) — 서버와 같은 공용 계산(predictPrepare): 첫 값 + 개인 보정(n ÷ (n + k) × 개인 오차)
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
  // 예전에는 여기에 같은 식을 따로 적어 두고 두 번째 일정(15분)에도 개인 보정 +10을 붙였음 → 서버와 같은 함수로 (두 번째 일정은 15분 그대로)
  const prepareOf = (wake: boolean) =>
    predictPrepare({
      commonP80: wake ? DEFAULT_COMMON_P80.withWake : DEFAULT_COMMON_P80.sameDay,
      personalP80: wake ? personalPrepareOf(MOCK_PREPARE_STATS, wakeMarginOf(db.wakeMargin), d.importance) : null,
      sampleCount: wake ? MOCK_PREPARE_STATS.sampleCount : 0,
    });
  // 계산된 기상이 낮 12시 이후(저녁에만 일정이 있는 날)면 기상 없이 준비부터 — 서버 computePlan과 같은 함수 isEveningWake (#320). 여유 10분은 이 가짜 모드의 고정값
  let withWake = !sameDayWake;
  let prepare = prepareOf(withWake);
  if (withWake && isEveningWake(new Date(at.getTime() - (10 + travel + prepare.minutes) * 60_000), 'Asia/Seoul', at)) {
    withWake = false;
    prepare = prepareOf(false);
  }
  const common = prepare.commonP80;
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
    predictedPrepMinutes: prepare.minutes,
    importance: d.importance,
    recurrenceRule: repeatToRrule(d.repeat),
    groupId: d.groupId && db.groups[d.groupId] ? d.groupId : null, // 함께할 그룹 (친구 9장)
    items: d.items
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    withWake,
    kinds: RING_KINDS.filter((kind) => d.alarms[kind]),
  };
  return {
    appointment: toAppointment(draft),
    commonP80: prepare.commonP80,
    correction: prepare.correction,
    sampleCount: prepare.sampleCount,
    prior: prepare.prior,
    weight: prepare.weight,
    residualP80: prepare.residualP80,
    sameDayWake,
    latePoint: db.lateCount4w >= 2 ? 1 : 0,
    ...(d.levels ? { levels: d.levels } : {}),
  };
}

// 계산한 일정을 저장 — 실데이터는 alarm-commit (일정 · 참여 조건 · 알람 4개를 한 번에)
// source = 하루 기록에 남길 출처 (AI 대화에서 찾은 일정이면 'AI 대화 · 확인함' 등)
// 확인 시트에서 알람 시각을 직접 고쳤으면(D43) 그 시각으로 저장하고 고친 값 기록에 남김. 순서가 뒤집혔으면 저장하지 않고 UserError
// 실데이터는 저장 뒤 폰 예약 · 준비물이 못 한 것이 있으면 followUp — 화면은 saveNotice.ts 문구로 알림
export async function createAppointment(estimate: Estimate, source = '직접 입력'): Promise<SavedAppointment> {
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
    groupId: a.groupName ? (Object.values(db.groups).find((g) => g.name === a.groupName)?.id ?? null) : null, // 화면 일정에는 그룹 이름만 있어 이름으로 찾음
    items: a.items,
    withWake: a.withWake,
    kinds: ringingKinds(a.alarms).map((x) => x.kind as RingKind), // 만든 알람 종류 — 하나도 없으면 알람 없는 일정
    ...(Object.keys(picked).length ? { manual: { times: picked } } : {}),
  };
  db.appointments.push(saved);
  if (estimate.levels) db.intensityOverrides[saved.id] = { ...estimate.levels };
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
function voiceLine(a: MockAppointment, kind: RingKind, at: Date) {
  const chain = alarmChain(a);
  const depart = chain.find((x) => x.kind === 'DEPARTURE')?.at ?? a.at;
  const when = spokenTime(a.at);
  if (kind === 'WAKE') {
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
// 준비 · 출발 알람의 머리글(notice)은 폰 알림과 같은 글자 (서버 알림 문구 함수 — features/alarm/notice.ts)
export async function getRing(alarmId: string): Promise<RingInfo | null> {
  if (!isMock()) {
    const ring = isPreviewAlarmId(alarmId) ? await getPreviewRing(alarmId) : await real.getRing(alarmId); // 웹 미리보기는 저장된 일정으로 (ringPreview.ts), 폰은 코어의 지금 울리는 알람
    // 웹은 폰 알람 코어가 없어 누른 알람을 못 찾을 때가 많음(가짜 데이터 주소 · 주소 없이 열기) → 저장된 알람 중 지금과 가장 가까운 것을 바로 울림
    return ring ?? (Platform.OS === 'web' ? getNearestPreviewRing(alarmId) : null);
  }
  const found = findAlarm(alarmId);
  if (!found || found.alarm.kind === 'ARRIVE') return null;
  const { a, alarm } = found;
  const kind = alarm.kind as RingKind;
  const overall = LEVELS[autoLevel(a)]; // 전체 세기(볼륨) — 배경음 · 진동은 축별로 따로 고를 수 있음
  const sound = LEVELS[axisLevel(a, 'sound')];
  const vibration = LEVELS[axisLevel(a, 'vibration')];
  const at = alarm.at;
  const appointment = toAppointment(a);
  return {
    alarmId: alarm.id,
    kind,
    appointment,
    at,
    voiceTone: LEVELS[axisLevel(a, 'voice')].voice,
    voiceLine: voiceLine(a, kind, at),
    notice: ringNotice(appointment, kind, at),
    levelLine: `알람 강도 ${overall.name} · 볼륨 ${overall.volume} · 배경음 ${sound.sound} · 진동 ${vibration.vibration}`,
    important: a.importance !== 'LOW',
    // 미루기 한도 (D3 기본안 A) — 실데이터는 알람 코어의 snoozeCount · 꾸러미 snoozeLimit · departAt (네이티브 화면이 보여 줌)
    snoozeCount: db.snoozeCounts[alarm.id] ?? 0,
    snoozeLimit: DEFAULT_SNOOZE_LIMIT,
    departAt: departAtOf(a) ?? null,
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

// 웹 울림 미리보기에서 같은 일정의 다음 알람 (울림 · 기상 확인 화면의 [다음 알람 울려 보기]) — 없으면 null
export const nextPreviewRing = (alarmId: string) => nextPreviewAlarm(alarmId);

// 웹 실데이터 울림 미리보기의 기상 확인 (ringPreview.ts) — 이 탭 메모리에만 두고 서버에 안 씀. 시연 버튼 값은 가짜 데이터와 같음
type PreviewWake = Pick<WakeCheck, 'phase' | 'dismissedAt' | 'usage' | 'recent' | 'confirmed'>;
const previewWakes = new Map<string, PreviewWake>();

async function previewWakeCheck(alarmId: string): Promise<WakeCheck | null> {
  const wake = previewWakes.get(alarmId);
  const parsed = parsePreviewAlarmId(alarmId);
  if (!wake || !parsed) return null;
  const a = await real.getAppointment(parsed.appointmentId);
  // 그룹 공유 문구는 뺌 — 미리보기는 그룹에 알리지 않음
  return { alarmId, appointmentTitle: a?.title ?? '', groupId: null, groupName: null, thetaMinutes: WAKE_THETA_MINUTES, ...wake };
}

// 울리기 시작 (H07) — 기상 알람이면 내 상태가 '알람 울리는 중'. 실데이터는 알람 코어(#33) · alarm_events TRIGGERED
// 이미 기상 확정한 알람이면 판정을 그대로 둠 (목업은 기상 전에만 S.wake를 비움)
export async function startRing(alarmId: string, at: Date) {
  if (!isMock()) return real.startRing();
  delete db.snoozes[alarmId]; // 다시 울리기 시작하면 미룸 표시는 끝
  if (findAlarm(alarmId)?.alarm.kind !== 'WAKE' || db.wakeConfirmations[alarmId]) return;
  db.wake = { alarmId, phase: 'ringing', ringAt: at, dismissedAt: null, ...NO_USE };
}

// H07을 띄웠다고 알람 코어의 길잡이 화면에 알림 (실데이터만 — 가짜 데이터는 길잡이 화면이 없음)
export function ackRing(): void {
  if (!isMock()) real.ackRing();
}

// 미루기 · 해제 없이 울림 화면을 나감 (뒤로 가기) — 울리는 중 표시만 지우고 기록은 안 남김
export async function stopRing(alarmId: string) {
  if (!isMock()) return real.stopRing();
  if (db.wake.alarmId === alarmId && db.wake.phase === 'ringing') db.wake = { ...db.wake, phase: 'idle' };
}

// 미루기 (H07) — 울리는 중 표시를 지우고 기록 (목업 A.snooze). at = 미룬 시각, minutes = 고른 분 (5 · 10 · 15)
// 3번까지 (한도에 닿으면 아무것도 안 함 — 화면이 이미 버튼을 끔). 실데이터의 다시 울림 · 한도 · SNOOZED 기록은 알람 코어(#33)
// 돌려주는 값 = 미뤘는지. 한도 · 이미 멈춤으로 못 미루면 false (화면이 토스트로 알림)
export async function snoozeRing(alarmId: string, minutes: number, at: Date): Promise<boolean> {
  if (!isMock()) {
    // 웹 미리보기 알람은 코어에 없는 id라 부르지 않음 — 화면(ring.tsx)이 미리보기면 이 함수를 안 부르고 "다시 울리지 않아요"로 안내
    if (isPreviewAlarmId(alarmId)) return false;
    return real.snoozeRing(alarmId, minutes);
  }
  const found = findAlarm(alarmId);
  // 이미 기상 확정한 알람이면 해제처럼 기록을 그대로 둠 (확정 뒤에 미루기가 붙지 않게)
  if (!found || db.wakeConfirmations[alarmId]) return false;
  const count = db.snoozeCounts[alarmId] ?? 0;
  if (!canSnooze(count, DEFAULT_SNOOZE_LIMIT)) return false;
  await stopRing(alarmId);
  db.snoozeCounts[alarmId] = count + 1;
  db.snoozes[alarmId] = { at: addMinutes(at, minutes), minutes };
  db.events.push({ at, label: `${KIND_LABEL[found.alarm.kind]} 알람 ${minutes}분 미루기`, source: '자동' });
  return true;
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
  delete db.snoozeCounts[alarmId];
  return { wakeCheck: false };
}

// 알람 해제 (H07) — at = 실제로 끈 시각(울린 시각). 기상 알람이면 기상 판정(관찰 중)을 시작
// 이미 기상 확정한 알람이면 판정 · 기록을 그대로 둠 (해제 기록이 겹치지 않게). 실데이터는 alarm_events DISMISSED
export async function dismissRing(alarmId: string, at: Date) {
  if (!isMock()) {
    if (!isPreviewAlarmId(alarmId)) return real.dismissRing();
    // 웹 미리보기 — 기상 알람이면 이 탭에서 기상 확인을 처음부터 시작 (끈 시각 = 지금). 확정된 뒤 다시 울려 봐도 시연 버튼이 다시 나옴
    if (parsePreviewAlarmId(alarmId)?.kind === 'WAKE') {
      previewWakes.set(alarmId, { phase: 'observing', dismissedAt: now(), ...NO_USE, confirmed: null });
    }
    return;
  }
  const found = findAlarm(alarmId);
  delete db.snoozes[alarmId];
  delete db.snoozeCounts[alarmId]; // 해제하면 미룬 횟수는 끝
  if (!found || db.wakeConfirmations[alarmId]) return;
  db.events.push({ at, label: `${KIND_LABEL[found.alarm.kind]} 알람 해제`, source: '자동' });
  if (found.alarm.kind === 'WAKE') db.wake = { alarmId, phase: 'observing', ringAt: null, dismissedAt: at, ...NO_USE };
}

// 기상 확인 (H08) — 기상 알람을 끈 뒤 화면 사용으로 판정. 실데이터는 #35 · #40
// alarmId가 없으면 진행 중인 판정, 그것도 없으면 오늘 첫 기상 알람
// 확정 전인데 아직 안 껐으면(울리기 전 · 울리는 중) 목업 빈 화면처럼 null
export async function getWakeCheck(alarmId?: string): Promise<WakeCheck | null> {
  if (!isMock()) return alarmId && isPreviewAlarmId(alarmId) ? previewWakeCheck(alarmId) : real.getWakeCheck(alarmId);
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
  if (!isMock()) {
    if (!isPreviewAlarmId(alarmId)) return real.promptWake();
    const wake = previewWakes.get(alarmId);
    if (wake && !wake.confirmed) previewWakes.set(alarmId, { ...wake, phase: 'prompt', ...SLEPT });
    return;
  }
  const dismissedAt = db.wake.alarmId === alarmId ? db.wake.dismissedAt : null;
  db.wake = { alarmId, phase: 'prompt', ringAt: null, dismissedAt, ...SLEPT };
  db.events.push({ at, label: '확인 알림 발송', source: '알림' });
}

// how: self = 확인 알림에 직접 응답(사용 시간은 확인 알림 때 그대로), auto = 화면 사용으로 자동 판정(시연: 폰을 보며 일어남)
// at = 판정한 시각 (자동은 관찰이 끝난 시각, 직접 응답은 응답 시각)
// 기록 시각 (D14): 직접 응답은 at 그대로, 자동은 누적 사용이 θ를 넘은 시각 — 해제 시각을 모르거나 못 넘었으면 at
// 실데이터는 alarm_events WAKE_CONFIRMED
export async function confirmWake(alarmId: string, how: 'self' | 'auto', at: Date) {
  if (!isMock()) {
    if (!isPreviewAlarmId(alarmId)) return real.confirmWake(alarmId, how);
    const wake = previewWakes.get(alarmId);
    if (!wake || wake.confirmed) return;
    const reached = how === 'auto' ? thetaReachedAt(wake.dismissedAt, USED_SPANS, WAKE_THETA_MINUTES) : null;
    previewWakes.set(alarmId, { ...wake, ...(how === 'auto' ? USED : {}), confirmed: { at: reached ?? now(), how } });
    return;
  }
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

// H08 [먼저 깼어요] — 알람이 울리기 전 60분 안에 깬 날 (D61). 곧 울릴 기상 알람이 없거나 이미 울렸 · 확인했으면 null
//   가짜 모드: 내 첫 기상 알람(팀 주간회의) 기준. 웹 실데이터 미리보기 알람은 대상이 아님
export async function getEarlyWake(): Promise<EarlyWake | null> {
  if (!isMock()) return real.getEarlyWake();
  const a = find('a1');
  const wake = a ? alarmChain(a).find((x) => x.kind === 'WAKE') : undefined;
  if (!wake || db.wakeConfirmations[wake.id] || db.me.wakeAt || db.wake.phase !== 'idle') return null;
  const left = wake.at.getTime() - now().getTime();
  return left > 0 && left <= EARLY_WAKE_MINUTES * 60_000 ? { alarmId: wake.id, at: wake.at } : null;
}

export async function confirmEarlyWake(alarmId: string): Promise<void> {
  if (!isMock()) return real.confirmEarlyWake(alarmId);
  if (db.wakeConfirmations[alarmId]) return;
  const at = now();
  db.wakeConfirmations[alarmId] = { at, how: 'self', ...NO_USE };
  db.me.wakeAt = at;
  db.events.push({ at, label: '기상 확인', source: '먼저 깼어요' });
}

// 일정 없는 알람 만들기 · 고치기 (D46 · Q10, 알람 목록 "+") — 입력 화면은 새 UI라 아직 없고 api만. 실데이터 전용 (alarm-commit STANDALONE)
//   만들기: 시각(at) 필수, repeat(요일, [] = 반복 없음) · level(강도 한 단계, null = 자동) · enabled는 고르는 것
//   고치기: 알람 id와 바꿀 것만 — 시각 없이 강도(level) · 켜기(enabled)만도 됨. 돌려주는 값은 목록이 그리는 모양(제목 "알람")
//   가짜 데이터에는 이 알람을 둘 자리가 없어 실데이터 모드에서만
export type NewStandaloneAlarm = Required<Pick<StandaloneInput, 'at'>> & Omit<StandaloneInput, 'alarmId' | 'at'>;
export type StandaloneAlarmPatch = Omit<StandaloneInput, 'alarmId'>;

export async function createStandaloneAlarm(input: NewStandaloneAlarm): Promise<SavedAppointment> {
  if (isMock()) throw new UserError('일정 없는 알람은 실데이터 모드에서만 만들 수 있어요');
  return real.saveStandaloneAlarm(input);
}

export async function updateStandaloneAlarm(alarmId: string, patch: StandaloneAlarmPatch): Promise<SavedAppointment> {
  if (isMock()) throw new UserError('일정 없는 알람은 실데이터 모드에서만 고칠 수 있어요');
  return real.saveStandaloneAlarm({ ...patch, alarmId });
}
