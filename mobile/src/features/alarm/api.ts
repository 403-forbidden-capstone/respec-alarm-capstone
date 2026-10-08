// ① 약속 기반 알람 — 데이터 접근은 이 파일에서만 합니다.
// 지금은 src/mocks의 가짜 데이터를 돌려주고, Supabase가 붙으면 이 파일 안에서만 바꿉니다.
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (H01 · H02 · H03 · H05 · H07 · H08)
import { now } from '@/lib/clock';
import { addMinutes, dateParts, isSameDay, josa, joinKo, minuteOfDay, spokenTime, startOfDay } from '@/lib/format';
import { alarmChain, autoLevel, axisLevel } from '@/mocks/calc';
import { db, kst, people, places, timelines, TODAY, transportFactor, type MockAppointment } from '@/mocks/data';

import {
  IMPORTANCE_POINT,
  LEVELS,
  type AlarmKind,
  type AlarmTime,
  type Appointment,
  type AppointmentDetail,
  type AppointmentDraft,
  type Estimate,
  type IntensityAxis,
  type Level,
  type NextAlarm,
  type Place,
  type RingInfo,
  type RingKind,
  type ScheduleItem,
  type WakeCheck,
} from './types';

function toAppointment(a: MockAppointment): Appointment {
  return {
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
    repeatLabel: a.repeatLabel,
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

// 모든 일정의 알람 (H02) — 시각 순
export async function listAppointments(): Promise<Appointment[]> {
  return db.appointments.map(toAppointment).sort(byTime);
}

// 지금 이후 가장 먼저 울릴 알람 (H01) — 꺼진 일정 · 꺼진 종류 · 도착 목표는 뺌
export async function getNextAlarm(): Promise<NextAlarm | null> {
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

// 하루 일정 (H01) — 알람 있는 일정 + 알람 없는 일정
export async function getDaySchedule(day: Date): Promise<ScheduleItem[]> {
  const withAlarm = db.appointments
    .filter((a) => isSameDay(a.at, day))
    .map((a) => ({ appointmentId: a.id, at: a.at, title: a.title, place: a.place, importance: a.importance }));
  const plain = db.plainSchedule
    .filter((p) => isSameDay(p.at, day))
    .map((p) => ({ appointmentId: null, at: p.at, title: p.title, place: null, importance: null }));
  return [...withAlarm, ...plain].sort(byTime);
}

// 알람 설정 (H03)
export async function getAppointment(id: string): Promise<AppointmentDetail | null> {
  const a = find(id);
  if (!a) return null;
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
  };
}

// 여유 시간을 바꾸면 알람이 어떻게 되는지 (저장 전 미리 보기) — 실데이터는 alarm-suggest
export async function previewAlarms(id: string, bufferMinutes: number): Promise<AlarmTime[]> {
  const a = find(id);
  return a ? alarmChain({ ...a, bufferMinutes }) : [];
}

export async function saveBuffer(id: string, bufferMinutes: number) {
  const a = find(id);
  if (a) a.bufferMinutes = bufferMinutes;
}

// 일정의 알람 전체 켜기 · 끄기 (H01 · H02)
export async function setAppointmentEnabled(id: string, enabled: boolean) {
  if (enabled) db.disabledAppointments.delete(id);
  else db.disabledAppointments.add(id);
}

// 종류별 켜기 · 끄기 (H03)
export async function setAlarmEnabled(id: string, kind: AlarmKind, enabled: boolean) {
  const key = `${id}:${kind}`;
  if (enabled) db.disabledKinds.delete(key);
  else db.disabledKinds.add(key);
}

// 강도 직접 고르기 — level이 null이면 자동으로 되돌림
export async function setIntensity(id: string, axis: IntensityAxis, level: Level | null) {
  const current = { ...(db.intensityOverrides[id] ?? {}) };
  if (level == null) delete current[axis];
  else current[axis] = level;
  db.intensityOverrides[id] = current;
}

export async function resetIntensity(id: string) {
  delete db.intensityOverrides[id];
}

// 새 일정 (H05) — 장소는 지금 목업 4곳. 실데이터는 place-search(카카오 키워드)
export async function listPlaces(): Promise<Place[]> {
  return places;
}

// 날짜 고르기 — 시나리오의 오늘부터 사흘
export function draftDates(): Date[] {
  return [kst(TODAY, 0), kst(TODAY + 1, 0), kst(TODAY + 2, 0)];
}

// 목업에서 처음 보이는 입력값 (내일 오후 2시 스터디)
export function defaultDraft(): AppointmentDraft {
  return {
    title: '스터디',
    date: kst(TODAY + 1, 0),
    time: '14:00',
    repeat: 'NONE',
    place: '학교 도서관',
    transport: 'TRANSIT',
    importance: 'LOW',
    items: '노트북 충전기',
  };
}

// 알람 계산 (H05 확인 시트) — 공통 P80 + 개인 보정(n ÷ (n + k) × 개인 오차 P80)
export async function estimateAppointment(d: AppointmentDraft): Promise<Estimate> {
  const [h, m] = d.time.split(':').map(Number);
  const at = addMinutes(startOfDay(d.date), (h || 0) * 60 + (m || 0));
  const place = places.find((p) => p.name === d.place) ?? places[0];
  const travel = Math.max(5, Math.round((place.travelMinutes * (transportFactor[d.transport] ?? 1)) / 5) * 5);
  const sameDayWake = db.appointments.some((a) => isSameDay(a.at, at) && a.withWake && alarmChain(a)[0].at < at);
  const withWake = !sameDayWake;
  const common = withWake ? 50 : 15;
  const n = 10;
  const k = 10;
  const weight = n / (n + k);
  const residual = 20;
  const correction = Math.round(weight * residual);
  const before = withWake ? 20 : 0;
  const draft: MockAppointment = {
    id: `n${Date.now()}`,
    title: d.title.trim() || '새 일정',
    at,
    place: place.name,
    origin: '집',
    transport: d.transport,
    travelMinutes: travel,
    travelSource: '길찾기',
    bufferMinutes: 10,
    beforePrepMinutes: before,
    prepMinutes: common - before,
    predictedPrepMinutes: common + correction,
    importance: d.importance,
    repeatLabel: d.repeat === 'WEEKLY' ? `매주 ${dateParts(at).weekday}요일` : '반복 없음',
    groupId: null,
    items: d.items
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    withWake,
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
export async function createAppointment(estimate: Estimate, source = '직접 입력'): Promise<Appointment> {
  const a = estimate.appointment;
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
    repeatLabel: a.repeatLabel,
    groupId: null,
    items: a.items,
    withWake: a.withWake,
  };
  db.appointments.push(saved);
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
export async function getRing(alarmId: string, again = false): Promise<RingInfo | null> {
  const found = findAlarm(alarmId);
  if (!found || found.alarm.kind === 'ARRIVE') return null;
  const { a, alarm } = found;
  const kind = alarm.kind as RingKind;
  const sound = LEVELS[axisLevel(a, 'sound')];
  const vibration = LEVELS[axisLevel(a, 'vibration')];
  return {
    alarmId: alarm.id,
    kind,
    appointment: toAppointment(a),
    at: alarm.at,
    voiceTone: LEVELS[axisLevel(a, 'voice')].voice,
    voiceLine: voiceLine(a, kind, alarm.at, again),
    levelLine: `알람 강도 ${sound.name} · 배경음 ${sound.sound} · 진동 ${vibration.vibration}`,
    important: a.importance !== 'LOW',
  };
}

// 기상 확인 (H08) — 기상 알람을 끈 뒤 화면 사용으로 판정. 실데이터는 #35 · #40
// alarmId가 없으면 오늘 첫 기상 알람
export async function getWakeCheck(alarmId?: string): Promise<WakeCheck | null> {
  const found = alarmId
    ? findAlarm(alarmId)
    : db.appointments
        .map((a) => ({ a, alarm: alarmChain(a)[0] }))
        .filter(({ alarm }) => alarm.kind === 'WAKE')
        .sort((x, y) => x.alarm.at.getTime() - y.alarm.at.getTime())[0];
  if (!found || found.alarm.kind !== 'WAKE') return null;
  const { a, alarm } = found;
  const confirmed = db.wakeConfirmations[alarm.id];
  return {
    alarmId: alarm.id,
    appointmentTitle: a.title,
    groupName: a.groupId ? (db.groups[a.groupId]?.name ?? null) : null,
    dismissedAt: alarm.at,
    thetaMinutes: db.wakeThetaMinutes,
    confirmed: confirmed ? { ...confirmed } : null,
  };
}

// how: self = 확인 알림에 직접 응답, auto = 화면 사용으로 자동 판정 — 실데이터는 alarm_events WAKE_CONFIRMED
export async function confirmWake(alarmId: string, how: 'self' | 'auto', at: Date) {
  db.wakeConfirmations[alarmId] = { at, how };
  db.me.wakeAt = at;
  db.events.push({ at, label: '기상 확인', source: how === 'self' ? '직접 응답' : '자동 판정' });
}
