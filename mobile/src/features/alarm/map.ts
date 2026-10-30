// DB 행 → 화면 타입(types.ts) 바꾸기 — 순수 함수만 (시험: __tests__/map.test.ts). 쿼리는 real.ts
// 실데이터 구현의 틀 (P6): 쿼리는 real.ts에서 얇게, 행 → 화면 모양 변환은 여기서 순수 함수로 빼서 jest로 시험
import { parseDbTime } from '@/lib/dbTime';
import type { Tables } from '@/types/database';
import { alarmChain } from '@shared/calc/chain.ts';
import { autoLevel, levelOfIntensity, levelOfSoundKey, levelOfVoiceTone } from '@shared/calc/intensity.ts';
import { DEFAULT_BEFORE_PREPARE_MINUTES } from '@shared/calc/prepare.ts';
import { minutesBetween } from '@shared/calc/time.ts';
import type { RingKind } from '@shared/calc/types.ts';

import type { MorningSource } from './morning';
import { repeatLabel, rruleToRepeat } from './repeat';
import {
  MANUAL_SOURCE,
  ORIGIN_HOME,
  type AlarmEdits,
  type AlarmKind,
  type AlarmTime,
  type Appointment,
  type AppointmentDetail,
  type Importance,
  type Intensity,
  type IntensityAxis,
  type Level,
  type NextAlarm,
  type ScheduleItem,
} from './types';

export type AlarmRow = Pick<Tables<'alarms'>, 'alarm_id' | 'alarm_type' | 'scheduled_at' | 'intensity' | 'voice_tone' | 'sound_key' | 'is_enabled' | 'time_source' | 'intensity_source'>;
export type ParticipantRow = Pick<
  Tables<'appointment_participants'>,
  'participant_id' | 'origin_name' | 'transport_type' | 'est_travel_minutes' | 'travel_source' | 'prepare_minutes' | 'buffer_minutes'
>;
export type AppointmentRow = Pick<Tables<'appointments'>, 'appointment_id' | 'title' | 'appointment_at' | 'dest_name' | 'importance' | 'recurrence_rule'> & {
  series_id?: string; // 반복 묶음 번호 — 같은 반복의 회차는 같은 값 (H02 목록이 묶음당 하나만 보일 때 씀). 안 읽은 쿼리(H03 등)에는 없음
};

// 한 약속(내 참여 조건)을 화면에 그리는 데 필요한 행 묶음. alarms는 이 참여 조건의 알람 전부 (꺼진 것 · 도착 목표 포함)
export type AppointmentRows = {
  appointment: AppointmentRow;
  participant: ParticipantRow;
  alarms: readonly AlarmRow[];
  groupName: string | null; // 같이 가는 그룹 (appointments.group_id → groups.group_name)
  items: readonly string[]; // 준비물 (todos ITEM)
};

// 일정 없는 알람 한 줄 (participant_id · routine_id가 모두 NULL인 기상 알람, D46)
export type StandaloneRow = AlarmRow & Pick<Tables<'alarms'>, 'recurrence_rule'> & { series_id?: string | null }; // series_id = 반복 묶음 번호 (목록 쿼리만 읽음)

// 일정 없는 알람의 제목 — 서버 commitStandalone · 폰 예약(lib/alarmSync/reconcile STANDALONE_TITLE)과 같은 글자
export const STANDALONE_TITLE = '알람';

// travel_source(DB) → 화면 글자. 서버가 저장하는 값은 API · MANUAL이고 CACHED는 D5가 열려 있어 저장하지 않지만 읽기는 함
//   ESTIMATE는 alarm-suggest가 돌려주는 미리 보기 값 (직선거리 근사 — 저장하려면 확인한 값을 MANUAL로)
export const TRAVEL_SOURCE_LABEL: Record<ParticipantRow['travel_source'] | 'ESTIMATE', string> = {
  API: '길찾기',
  CACHED: '내 실측 이동시간',
  MANUAL: MANUAL_SOURCE,
  ESTIMATE: '대략적인 값',
};

// 화면이 쓰는 순서 — 기상 · 준비 · 출발 · 도착 목표
const KIND_ORDER: readonly AlarmKind[] = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];

const isRingRow = (row: AlarmRow): row is AlarmRow & { alarm_type: RingKind } =>
  row.alarm_type === 'WAKE' || row.alarm_type === 'PREPARE' || row.alarm_type === 'DEPARTURE';

// 알람 한 줄. ROUTINE 알람은 약속에 속하지 않아 여기 오지 않음 (호출하는 쪽이 participant_id로 거름)
//   auto(직접 고른 시각이면 자동 계산값)는 DB에 값이 없어서 toAppointment가 공용 계산(@shared/calc/chain)으로 구해 넘김
export function toAlarmTime(row: Pick<AlarmRow, 'alarm_id' | 'alarm_type' | 'scheduled_at' | 'is_enabled'>, auto?: Date): AlarmTime | null {
  if (row.alarm_type === 'ROUTINE') return null;
  return {
    id: row.alarm_id,
    kind: row.alarm_type,
    at: parseDbTime(row.scheduled_at),
    enabled: row.alarm_type === 'ARRIVE' || row.is_enabled,
    ...(auto ? { auto } : {}),
  };
}

// 직접 고른 강도(intensity_source = MANUAL)가 저장된 알람 — 기상 알람이 먼저, 없으면 다른 알람. 서버 resolveOverrides와 같은 순서
//   H02 카드 단계(levelOf)와 H03 직접 고름(storedOverrides)이 같은 알람을 읽게 이 함수 하나로 고름
const manualIntensityRow = (alarms: readonly AlarmRow[]) =>
  alarms.find((a) => a.alarm_type === 'WAKE' && a.intensity_source === 'MANUAL') ?? alarms.find((a) => a.intensity_source === 'MANUAL');

// 강도 단계 — 한 약속의 알람은 보통 강도 세 칸이 같은 값이라 한 알람의 배경음 칸으로 읽음 (types.ts level = 배경음 기준)
//   읽을 알람: 직접 고른 강도가 저장된 알람 → 기상 알람 → 첫 알람. DB가 돌려주는 알람 순서에 기대지 않음
//   (S01 제안 적용은 대상 알람 하나의 칸만 바꾸므로 순서가 바뀌면 카드 단계가 달라 보일 수 있었음)
function levelOf(rows: readonly AlarmRow[]): Level {
  const source = manualIntensityRow(rows) ?? rows.find((a) => a.alarm_type === 'WAKE') ?? rows[0];
  if (!source) return 1;
  return levelOfSoundKey(source.sound_key) ?? levelOfIntensity(source.intensity) ?? 1;
}

// 준비 전 활동(기상 뒤 준비 알람까지) — DB에 따로 저장하지 않아 두 알람의 간격으로 읽음. 기상 · 준비가 둘 다 있을 때만
//   준비 알람 시각을 직접 골랐으면 간격이 준비 전 활동이 아니라서 기본값(20분)으로 봄 (서버 inferBeforePrepare도 직접 고른 쪽은 기본값을 씀)
export function beforePrepareOf(alarms: readonly AlarmRow[]): number {
  const wake = alarms.find((x) => x.alarm_type === 'WAKE');
  const prepare = alarms.find((x) => x.alarm_type === 'PREPARE');
  if (!wake || !prepare) return 0;
  if (prepare.time_source === 'MANUAL') return DEFAULT_BEFORE_PREPARE_MINUTES;
  return Math.max(0, minutesBetween(parseDbTime(wake.scheduled_at), parseDbTime(prepare.scheduled_at)));
}

// 직접 고른 시각(time_source = MANUAL)의 자동 계산값 — 공용 역산(서버와 같은 파일)에 직접 고른 시각을 넣어 auto를 받음
//   자동값과 같은 시각이면 직접 고른 것으로 안 침 (alarmChain이 auto를 안 줌)
export function autoTimesOf(rows: AppointmentRows): Partial<Record<RingKind, Date>> {
  const { appointment, participant } = rows;
  const manualTimes: Partial<Record<RingKind, Date>> = {};
  for (const row of rows.alarms) if (isRingRow(row) && row.time_source === 'MANUAL') manualTimes[row.alarm_type] = parseDbTime(row.scheduled_at);
  if (!Object.keys(manualTimes).length) return {};
  const chain = alarmChain({
    at: parseDbTime(appointment.appointment_at),
    travelMinutes: participant.est_travel_minutes ?? 0,
    bufferMinutes: participant.buffer_minutes,
    prepareMinutes: participant.prepare_minutes,
    beforePrepareMinutes: beforePrepareOf(rows.alarms),
    withWake: rows.alarms.some((x) => x.alarm_type === 'WAKE'),
    manualTimes,
  });
  const autos: Partial<Record<RingKind, Date>> = {};
  for (const x of chain) if (x.kind !== 'ARRIVE' && x.auto && manualTimes[x.kind]) autos[x.kind] = x.auto;
  return autos;
}

export function toAppointment(rows: AppointmentRows): Appointment {
  const { appointment, participant } = rows;
  const autos = autoTimesOf(rows);
  const alarms = KIND_ORDER.flatMap((kind) =>
    rows.alarms
      .filter((row) => row.alarm_type === kind)
      .map((row) => toAlarmTime(row, kind === 'ARRIVE' ? undefined : autos[kind]))
      .filter((x): x is AlarmTime => x != null),
  );
  const before = beforePrepareOf(rows.alarms);
  const predicted = participant.prepare_minutes; // 약속 시점에 정해진 기상 ~ 출발 (DB에는 직접 고름 표시가 없어 이 값을 자동 값으로 봄)
  return {
    id: appointment.appointment_id,
    title: appointment.title,
    at: parseDbTime(appointment.appointment_at),
    place: appointment.dest_name,
    origin: participant.origin_name ?? ORIGIN_HOME,
    transport: participant.transport_type,
    travelMinutes: participant.est_travel_minutes ?? 0,
    travelSource: TRAVEL_SOURCE_LABEL[participant.travel_source],
    bufferMinutes: participant.buffer_minutes,
    beforePrepMinutes: before,
    prepMinutes: Math.max(0, predicted - before), // 준비 알람 ~ 출발. 기록(daily_records)의 실제 준비는 평균을 읽을 칸이 없어 쓰지 않음
    predictedPrepMinutes: predicted,
    importance: appointment.importance,
    repeatLabel: repeatLabel(rruleToRepeat(appointment.recurrence_rule)),
    recurrenceRule: appointment.recurrence_rule,
    groupName: rows.groupName,
    items: [...rows.items],
    withWake: alarms.some((x) => x.kind === 'WAKE'),
    enabled: alarms.some((x) => x.kind !== 'ARRIVE' && x.enabled), // 일정 전체 켜기는 DB에 따로 없음 — 울리는 알람이 하나라도 켜져 있으면 켜짐
    alarms,
    level: levelOf(rows.alarms),
  };
}

// 일정 없는 알람(D46) → 목록 · 다음 알람 카드가 그리는 일정 모양. 제목은 "알람", 이동 · 준비 칸은 뜻이 없어 0
export function toStandaloneAppointment(row: StandaloneRow): Appointment {
  const alarm = toAlarmTime(row);
  return {
    id: row.alarm_id,
    title: STANDALONE_TITLE,
    at: parseDbTime(row.scheduled_at),
    place: '',
    origin: '',
    transport: 'WALK',
    travelMinutes: 0,
    travelSource: '',
    bufferMinutes: 0,
    beforePrepMinutes: 0,
    prepMinutes: 0,
    predictedPrepMinutes: 0,
    importance: 'NORMAL',
    repeatLabel: repeatLabel(rruleToRepeat(row.recurrence_rule)),
    recurrenceRule: row.recurrence_rule,
    groupName: null,
    items: [],
    withWake: true,
    enabled: row.is_enabled,
    alarms: alarm ? [alarm] : [],
    level: levelOf([row]),
    standalone: true,
  };
}

// 알람이 하나라도 있는 일정 (H02) — 알람 없는 일정(H05에서 알람을 모두 끄고 저장)은 목록에서 빠지고 H01 일정 줄에만 보임
export const hasAlarms = (appointment: Appointment) => appointment.alarms.length > 0;

// 하루 일정 한 줄 (H01) — 알람 없는 일정도 일정이라 한 줄이 됨
export function toScheduleItem(rows: {
  appointment: Pick<AppointmentRow, 'appointment_id' | 'title' | 'appointment_at' | 'dest_name' | 'importance'>;
  alarms: readonly Pick<AlarmRow, 'alarm_type'>[];
}): ScheduleItem {
  const { appointment } = rows;
  return {
    appointmentId: appointment.appointment_id,
    at: parseDbTime(appointment.appointment_at),
    title: appointment.title,
    place: appointment.dest_name,
    importance: appointment.importance,
    hasAlarm: rows.alarms.some((x) => x.alarm_type !== 'ROUTINE'),
  };
}

// 하루 일정 읽기 한 줄 (realRows loadDayRows) — 하루 일정(H01)과 오늘 첫 일정(아침 흐름)이 같이 읽는 칸
export type DayRow = {
  participant_id: string;
  est_travel_minutes: number | null;
  travel_source: ParticipantRow['travel_source'];
  departed_at: string | null;
  appointments: Pick<AppointmentRow, 'appointment_id' | 'title' | 'appointment_at' | 'dest_name'>;
  alarms: readonly Pick<AlarmRow, 'alarm_id' | 'alarm_type' | 'scheduled_at' | 'is_enabled'>[];
};

// 오늘 첫 일정을 고를 약속 한 줄 (features/alarm/morning.ts) — 루틴 알람은 약속에 속하지 않아 거름
export function toMorningSource(row: DayRow): MorningSource {
  const { appointments: appointment } = row;
  return {
    appointmentId: appointment.appointment_id,
    title: appointment.title,
    at: parseDbTime(appointment.appointment_at),
    place: appointment.dest_name,
    travelMinutes: row.est_travel_minutes ?? 0,
    travelSource: TRAVEL_SOURCE_LABEL[row.travel_source],
    alarms: row.alarms.flatMap((alarm) => {
      const time = toAlarmTime(alarm);
      return time ? [time] : [];
    }),
    departedAt: row.departed_at ? parseDbTime(row.departed_at) : null,
  };
}

export const byTime = <T extends { at: Date }>(x: T, y: T) => x.at.getTime() - y.at.getTime();

// 알람 목록(H02)은 반복 묶음(series_id)당 한 장 — 지금 이후 가장 가까운 회차 (지난 회차는 안 보임). 묶음 번호가 없거나 한 장뿐인 묶음(반복이 아닌 약속)은 그대로
//   한 묶음의 회차가 모두 지났으면 가장 최근 지난 회차 하나 (다음 회차가 아직 안 만들어진 반복이 목록에서 사라지지 않게)
//   L6 안건후보: H02 묶음이 전부 지난 경우 기본안 = 가장 최근 지난 회차 하나를 "지난 일정"에 둠
//   알람이 있는 회차만 넘길 것 (hasAlarms로 거른 뒤) — 가장 가까운 회차의 알람이 모두 꺼졌다고 묶음 전체가 사라지지 않게
export function onePerSeries<T extends { at: Date }>(entries: readonly { seriesId: string | null | undefined; item: T }[], nowMs: number): T[] {
  const bySeries = new Map<string, T[]>();
  const out: T[] = [];
  for (const { seriesId, item } of entries) {
    if (!seriesId) {
      out.push(item);
      continue;
    }
    const list = bySeries.get(seriesId);
    if (list) list.push(item);
    else bySeries.set(seriesId, [item]);
  }
  for (const list of bySeries.values()) {
    const upcoming = list.filter((x) => x.at.getTime() >= nowMs).sort(byTime);
    out.push(upcoming.length ? upcoming[0] : list.reduce((latest, x) => (x.at.getTime() > latest.at.getTime() ? x : latest)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// H03 알람 설정
// ---------------------------------------------------------------------------

// 직접 고른 강도 — 서버 resolveOverrides와 같은 규칙: 저장된 알람 중 기상(없으면 아무거나)이 intensity_source = MANUAL이면
//   그 알람의 세 칸(배경음 sound_key · 말소리 voice_tone · 진동 intensity)이 자동 값과 다른 칸만 직접 고른 것
export function storedOverrides(alarms: readonly AlarmRow[], auto: Level): Record<IntensityAxis, Level | null> {
  const stored = manualIntensityRow(alarms);
  if (!stored) return { sound: null, voice: null, vibration: null };
  const pick = (level: Level | null) => (level != null && level !== auto ? level : null);
  return {
    sound: pick(levelOfSoundKey(stored.sound_key)),
    voice: pick(levelOfVoiceTone(stored.voice_tone)),
    vibration: pick(levelOfIntensity(stored.intensity)),
  };
}

export function toIntensity(alarms: readonly AlarmRow[], importance: Importance, lateCount4w: number): Intensity {
  const auto = autoLevel(importance, lateCount4w);
  const picked = storedOverrides(alarms, auto);
  const axis = (key: IntensityAxis) => ({ level: picked[key] ?? auto, manual: picked[key] != null });
  return {
    auto,
    importancePoint: { LOW: 0, NORMAL: 1, HIGH: 2 }[importance],
    lateCount: lateCount4w,
    latePoint: lateCount4w >= 2 ? 1 : 0,
    axes: { sound: axis('sound'), voice: axis('voice'), vibration: axis('vibration') },
  };
}

// 지금 저장된 값(초안의 처음 모양) — 직접 입력한 이동 · 직접 고른 알람 시각만 값이 있고 나머지는 자동(null)
//   준비 시간은 DB에 직접 고름 표시가 없어 늘 자동(null) — 저장된 값이 곧 자동 값으로 보임 (toAppointment predictedPrepMinutes)
export function toEdits(appointment: Appointment, rows: AppointmentRows): AlarmEdits {
  const times: AlarmEdits['times'] = {};
  for (const x of appointment.alarms) if (x.kind !== 'ARRIVE' && x.auto) times[x.kind] = x.at;
  return {
    bufferMinutes: appointment.bufferMinutes,
    origin: appointment.origin,
    transport: appointment.transport,
    travelMinutes: rows.participant.travel_source === 'MANUAL' ? rows.participant.est_travel_minutes : null,
    prepareMinutes: null,
    times,
  };
}

export function toAppointmentDetail(rows: AppointmentRows, lateCount4w: number): AppointmentDetail {
  const appointment = toAppointment(rows);
  return {
    ...appointment,
    intensity: toIntensity(rows.alarms, appointment.importance, lateCount4w),
    edits: toEdits(appointment, rows),
    // 직접 입력한 이동은 자동값을 모름 — 저장된 값을 자리에 두고, 미리 보기(alarm-suggest)가 오면 서버의 자동값으로 바뀜
    auto: { travelMinutes: appointment.travelMinutes, predictedPrepMinutes: appointment.predictedPrepMinutes },
  };
}

// 지금 이후 가장 먼저 울릴 알람 (H01) — 꺼진 일정 · 꺼진 종류 · 도착 목표는 뺌. 가짜 구현(api.ts getNextAlarm)과 같은 규칙
export function pickNextAlarm(appointments: readonly Appointment[], nowMs: number): NextAlarm | null {
  let best: NextAlarm | null = null;
  for (const appointment of appointments) {
    if (!appointment.enabled) continue;
    for (const alarm of appointment.alarms) {
      if (alarm.kind === 'ARRIVE' || !alarm.enabled || alarm.at.getTime() < nowMs) continue;
      if (!best || alarm.at < best.alarm.at) best = { appointment, alarm };
    }
  }
  return best;
}
