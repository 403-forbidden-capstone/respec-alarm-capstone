// ① 약속 기반 알람 — 데이터 접근은 이 파일에서만 합니다.
// 지금은 src/mocks의 가짜 데이터를 돌려주고, Supabase가 붙으면 이 파일 안에서만 바꿉니다.
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (H01 · H02 · H03 · H05 · H07 · H08)
import { now } from '@/lib/clock';
import { addMinutes, isSameDay, josa, joinKo, minuteOfDay, spokenTime, startOfDay } from '@/lib/format';
import { alarmChain, autoLevel, axisLevel } from '@/mocks/calc';
import { db, people, places, timelines, transportFactor, type MockAppointment } from '@/mocks/data';

import {
  IMPORTANCE_POINT,
  KIND_LABEL,
  LEVELS,
  WAKE_NO_REPLY_MINUTES,
  WAKE_OBSERVE_MINUTES,
  type AlarmKind,
  type AlarmSettingsDraft,
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
  type Snooze,
  type WakeCheck,
} from './types';
import { repeatLabel, repeatToRrule, rruleToRepeat } from './repeat';
import { initialTime, ringingKinds } from './schedule';
import { thetaReachedAt, usageSummary, type UseSpan } from './wake';

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

// 알람 설정 저장 (H03) — 여유 · 종류별 켜기 · 강도를 한 번에. 화면은 초안으로 들고 있다가 저장할 때만 부름
// 종류를 모두 껐으면 일정 알람도 끄고, 껐던 종류를 다시 켜면 일정 알람도 다시 켬 (종류를 안 바꿨으면 일정 켜기 · 끄기는 그대로)
// 돌려주는 값 = 이번 저장으로 일정 알람이 꺼졌는지 · 켜졌는지. 실데이터는 alarm-commit
export async function saveAlarmSettings(id: string, draft: AlarmSettingsDraft): Promise<{ turnedOff: boolean; turnedOn: boolean }> {
  const a = find(id);
  if (!a) return { turnedOff: false, turnedOn: false };
  if (draft.bufferMinutes !== a.bufferMinutes) await saveBuffer(id, draft.bufferMinutes);
  let kindOn = false;
  let kindOff = false;
  for (const alarm of ringingKinds(alarmChain(a))) {
    const next = draft.kinds[alarm.kind];
    if (next == null || next === alarm.enabled) continue;
    await setAlarmEnabled(id, alarm.kind, next);
    if (next) kindOn = true;
    else kindOff = true;
  }
  for (const [axis, level] of Object.entries(draft.levels) as [IntensityAxis, Level | null][]) {
    if ((db.intensityOverrides[id]?.[axis] ?? null) !== level) await setIntensity(id, axis, level);
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

// 새 일정 (H05) — 장소는 지금 목업 4곳. 실데이터는 place-search(카카오 키워드)
export async function listPlaces(): Promise<Place[]> {
  return places;
}

// 새 일정 처음 입력값 — 일정명 · 준비물은 비어 있음, 장소는 첫 곳 선택. 날짜 · 시간은 홈에서 넘어온 날(day)의 오후 2시
// (그 시각이 이미 지났으면 다음 정각)
export function defaultDraft(day: Date, current = now()): AppointmentDraft {
  return {
    title: '',
    date: startOfDay(day),
    time: initialTime(day, current),
    repeat: [],
    place: '학교 도서관',
    transport: 'TRANSIT',
    importance: 'LOW',
    items: '',
  };
}

// 날짜 + 시간 칸('14:00') → 시각. 시간이 비었거나 형식이 틀리면 목업처럼 14:00
export function draftAt(date: Date, time: string): Date {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  return addMinutes(startOfDay(date), match ? Number(match[1]) * 60 + Number(match[2]) : 14 * 60);
}

let draftSeq = 0; // 새 일정 가짜 id 뒤에 붙이는 번호 — 같은 순간에 만들어도 겹치지 않게

// 알람 계산 (H05 확인 시트) — 공통 P80 + 개인 보정(n ÷ (n + k) × 개인 오차 P80)
export async function estimateAppointment(d: AppointmentDraft): Promise<Estimate> {
  const at = draftAt(d.date, d.time);
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
    id: `n${Date.now()}_${++draftSeq}`,
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
    recurrenceRule: repeatToRrule(d.repeat),
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
    recurrenceRule: a.recurrenceRule,
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
// again = 확인 알림에 응답이 없어 다시 울림 → 큰 시각은 다시 울린 시각 (목업 ring-time = S.now). 기상 알람만, 다른 종류는 무시
export async function getRing(alarmId: string, again = false): Promise<RingInfo | null> {
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
  delete db.snoozes[alarmId]; // 다시 울리기 시작하면 미룸 표시는 끝
  if (findAlarm(alarmId)?.alarm.kind !== 'WAKE' || db.wakeConfirmations[alarmId]) return;
  db.wake = { alarmId, phase: 'ringing', ringAt: at, dismissedAt: null, ...NO_USE };
}

// 미루기 · 해제 없이 울림 화면을 나감 (뒤로 가기) — 울리는 중 표시만 지우고 기록은 안 남김
export async function stopRing(alarmId: string) {
  if (db.wake.alarmId === alarmId && db.wake.phase === 'ringing') db.wake = { ...db.wake, phase: 'idle' };
}

// 미루기 (H07) — 울리는 중 표시를 지우고 기록 (목업 A.snooze). at = 미룬 시각
// 미룬 뒤 다시 울림 · 3번 제한 · SNOOZED 기록은 알람 코어(#33)
export async function snoozeRing(alarmId: string, minutes: number, at: Date) {
  const found = findAlarm(alarmId);
  // 이미 기상 확정한 알람이면 해제처럼 기록을 그대로 둠 (확정 뒤에 미루기가 붙지 않게)
  if (!found || db.wakeConfirmations[alarmId]) return;
  await stopRing(alarmId);
  db.snoozes[alarmId] = { at: addMinutes(at, minutes), minutes };
  db.events.push({ at, label: `${KIND_LABEL[found.alarm.kind]} 알람 ${minutes}분 미루기`, source: '자동' });
}

// 미룬 알람 (H01) — 다시 울릴 시각이 아직 안 된 것 중 가장 빠른 것. 실데이터는 알람 코어가 가진 미루기 예약(#33)
export async function getSnooze(): Promise<Snooze | null> {
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
export async function cancelSnooze(alarmId: string) {
  delete db.snoozes[alarmId];
}

// 알람 해제 (H07) — at = 실제로 끈 시각(울린 시각). 기상 알람이면 기상 판정(관찰 중)을 시작
// 이미 기상 확정한 알람이면 판정 · 기록을 그대로 둠 (해제 기록이 겹치지 않게). 실데이터는 alarm_events DISMISSED
export async function dismissRing(alarmId: string, at: Date) {
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
  const id = alarmId ?? db.wake.alarmId;
  const found = id
    ? findAlarm(id)
    : db.appointments
        .map((a) => ({ a, alarm: alarmChain(a)[0] }))
        .filter(({ alarm }) => alarm.kind === 'WAKE')
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
  if (!db.wake.alarmId || (db.wake.phase !== 'observing' && db.wake.phase !== 'prompt')) return null;
  const check = await getWakeCheck(db.wake.alarmId);
  return check && !check.confirmed ? check : null;
}

// 확인 알림 (H08) — 해제 뒤 10분 동안 조건을 못 채움 (시연: 알람만 끄고 다시 잠듦). at = 관찰이 끝난 시각. 실데이터는 #35 · #40
export async function promptWake(alarmId: string, at: Date) {
  const dismissedAt = db.wake.alarmId === alarmId ? db.wake.dismissedAt : null;
  db.wake = { alarmId, phase: 'prompt', ringAt: null, dismissedAt, ...SLEPT };
  db.events.push({ at, label: '확인 알림 발송', source: '알림' });
}

// 확인 알림에도 응답이 없음 → 기상 알람이 다시 울림 (H07 again=1). at = 다시 울리는 시각
// 다시 울릴지는 D2에서 정함 — 안 울리기로 하면 이 함수와 재알람 기록을 같이 뺌
export async function missWake(alarmId: string, at: Date) {
  db.wake = { alarmId, phase: 'ringing', ringAt: at, dismissedAt: null, ...NO_USE };
  db.events.push({ at, label: '재알람', source: '자동' });
}

// how: self = 확인 알림에 직접 응답(사용 시간은 확인 알림 때 그대로), auto = 화면 사용으로 자동 판정(시연: 폰을 보며 일어남)
// at = 판정한 시각 (자동은 관찰이 끝난 시각, 직접 응답은 응답 시각)
// 기록 시각 (D14): 직접 응답은 at 그대로, 자동은 누적 사용이 θ를 넘은 시각 — 해제 시각을 모르거나 못 넘었으면 at
// 실데이터는 alarm_events WAKE_CONFIRMED
export async function confirmWake(alarmId: string, how: 'self' | 'auto', at: Date) {
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
