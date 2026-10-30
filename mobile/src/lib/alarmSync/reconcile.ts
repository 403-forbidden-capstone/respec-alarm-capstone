// 서버 alarms ↔ 폰 예약 맞추기의 계산 부분 — 순수 함수 (시험: __tests__/reconcile.test.ts)
// 쿼리 · 폰 호출은 index.ts. 여기는 "서버에 이런 행이 있고 폰에 이런 예약이 있으면 무엇을 걸고 무엇을 지울지"만 정함
// 근거: docs/alarm-core.md "앞으로 더할 것" 앱 연결 (P6), 전체작업계획 7절 "폰 예약 맞추기" · 8.1 Q11
import type { RingPackage as PhoneRingPackage, ScheduledAlarm } from '@capstone/alarm-core';
import { buildRingPackages, subtitleFor, type PackageSource } from '@shared/ring-package.ts';
import { safeTimeZone } from '@shared/tz.ts';

import { dbTimeMs, normalizeDbTime, parseDbTime } from '../dbTime';

// 서버 알람을 폰에 미리 걸어 두는 기간. 이보다 먼 알람은 폰에 없어도 더하지 않음 (이미 폰에 있는 것은 이 기간 밖이어도 시각 · 강도를 맞춤)
// 작성자 판단 — 되돌리기 쉬움. 반복 일정은 서버(alarm-roll)가 14일치 회차를 미리 만들어 두므로(docs/alarm-core.md) 이 기간과 같은 길이
export const RECONCILE_WINDOW_DAYS = 14;
export const DEFAULT_TIME_ZONE = 'Asia/Seoul';
const DAY_MS = 24 * 60 * 60 * 1000;

// alarms 행 한 줄 + 꾸러미 제목 · 부제에 쓰는 약속 · 루틴 정보 (쿼리가 임베드 결과를 이 모양으로 폄)
export type SyncRow = PackageSource & {
  participant_id: string | null;
  routine_id: string | null;
  appointment: { title: string; appointment_at: string; dest_name: string | null } | null; // 약속 알람이면
  travel_minutes?: number | null; // 약속 알람이면 내 참여 조건의 est_travel_minutes — 출발 알림의 도착 시각 · 여유 (없으면 그 줄이 빠짐)
  routine_title: string | null; // 루틴 알람이면
  departed_at?: string | null; // 약속 알람이면 내 참여 조건의 출발 기록 시각 (dropRecorded가 봄)
  arrived_at?: string | null; // 〃 도착 기록 시각
};

// 출발 · 도착 기록이 있으면 폰에 걸지 않을 알람 (L2 요청, 원탭 줄이기 #240) — 기상(WAKE)은 그대로
//   · 출발 기록(departed_at) → 준비 · 출발 알람 (이미 나섰으니 "곧 출발하세요"가 필요 없음)
//   · 도착 기록(arrived_at) → 준비 · 출발 · 도착 목표 알람
//   서버 행은 지우지 않고 폰 예약 대상에서만 뺌. 이미 폰에 걸린 것은 "서버에 없음"으로 지워짐 (planReconcile)
const DONE_BY_DEPARTURE: ReadonlySet<string> = new Set(['PREPARE', 'DEPARTURE']);
const DONE_BY_ARRIVAL: ReadonlySet<string> = new Set(['PREPARE', 'DEPARTURE', 'ARRIVE']);

export function dropRecorded(rows: readonly SyncRow[]): { kept: SyncRow[]; dropped: SyncRow[] } {
  const kept: SyncRow[] = [];
  const dropped: SyncRow[] = [];
  for (const row of rows) {
    const done = (row.arrived_at != null && DONE_BY_ARRIVAL.has(row.alarm_type)) || (row.departed_at != null && DONE_BY_DEPARTURE.has(row.alarm_type));
    (done ? dropped : kept).push(row);
  }
  return { kept, dropped };
}

// 이번에 본 앞으로 알람의 참여 행 — 약속 알람의 참여 조건(participant_id)마다 하나, 약속 시각 빠른 순 (onAlarmsSynced의 upcoming)
//   일정 없는 알람 · 루틴 알람은 약속이 없어 빠짐. 약속 시각을 못 읽는 행도 뺌. 시각은 toISOString 글자
export type UpcomingParticipant = { participantId: string; appointmentAt: string };

export function upcomingParticipants(rows: readonly SyncRow[]): UpcomingParticipant[] {
  const seen = new Map<string, UpcomingParticipant>();
  for (const row of rows) {
    if (!row.participant_id || !row.appointment || seen.has(row.participant_id)) continue;
    const ms = dbTimeMs(row.appointment.appointment_at);
    if (Number.isNaN(ms)) continue;
    seen.set(row.participant_id, { participantId: row.participant_id, appointmentAt: new Date(ms).toISOString() });
  }
  return [...seen.values()].sort((a, b) => Date.parse(a.appointmentAt) - Date.parse(b.appointmentAt));
}

export const STANDALONE_TITLE = '알람'; // 일정 없는 알람 — 서버 commitStandalone과 같은 이름

// 맞추기 계산에서만 쓰는 서버 꾸러미 — 폰 꾸러미 + 같은 약속의 알람을 묶는 키(buildServerPackages가 묶을 때 쓰는 participant_id 등).
// 이 칸은 앱 안 TS에만 있음: planReconcile이 폰에 걸 꾸러미를 돌려줄 때 떼어 내고, 네이티브 글자(toNativePayload)도 정해진 칸만 골라 담아 키가 새지 않음
export type ServerPackage = PhoneRingPackage & { groupKey?: string };

// 부제 글자는 시각 서식(Intl, 시간대 지정)에 기대는데, 이 기기가 못 만들거나 시각 값이 이상해도 맞추기 전체가 멈추지 않게 — 시각을 뺀 장소만 (알람은 그대로 울림)
function safeSubtitle(at: string, place: string | null, timeZone: string): string | undefined {
  try {
    return subtitleFor(parseDbTime(at), place, timeZone);
  } catch {
    return place ?? undefined;
  }
}

function safeDate(value: string): Date | undefined {
  const date = parseDbTime(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// 서버가 alarm-commit에서 조립하는 것과 같은 꾸러미 (_shared/ring-package.ts) — 약속(참여 조건) · 루틴 · 일정 없는 알람별로 묶어서
//   · 부제는 약속 알람이면 "오전 10:00 · 장소", 일정 없는 알람이면 알람 시각만 (서버와 같음), 루틴은 없음
//   · departAt은 같은 약속의 출발 알람 시각 (단축 준비 안내용 — 폰이 아직 안 읽음). 출발 알람이 꺼져 있거나 이 목록에 없으면 빠짐
//   · 약속 알람은 준비 · 출발 알림 문구(notice)와 기상 음성 문장(voiceText)도 서버와 같은 함수로 만듦 (_shared/ring-package.ts). 일정 없는 알람 · 루틴은 없음
export function buildServerPackages(rows: readonly SyncRow[], timeZone: string = DEFAULT_TIME_ZONE): ServerPackage[] {
  const tz = safeTimeZone(timeZone);
  const groups = new Map<string, SyncRow[]>();
  for (const source of rows) {
    // 꾸러미 조립(@shared/ring-package)이 Date.parse로 읽으므로 DB 시각 글자를 먼저 밀리초 3자리 모양으로 (lib/dbTime)
    const row = { ...source, scheduled_at: normalizeDbTime(source.scheduled_at) };
    const key = row.participant_id ?? (row.routine_id ? `routine:${row.routine_id}` : `alarm:${row.alarm_id}`);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const packages: ServerPackage[] = [];
  for (const [groupKey, group] of groups) {
    const first = group[0];
    const appointment = first.appointment;
    const departure = group.find((row) => row.alarm_type === 'DEPARTURE');
    const appointmentAt = appointment ? safeDate(appointment.appointment_at) : undefined;
    const built = buildRingPackages({
      alarms: group,
      title: appointment?.title ?? first.routine_title ?? STANDALONE_TITLE,
      subtitle: appointment
        ? safeSubtitle(appointment.appointment_at, appointment.dest_name, tz)
        : first.routine_id
          ? undefined
          : safeSubtitle(first.scheduled_at, null, tz),
      departAt: departure ? parseDbTime(departure.scheduled_at) : undefined,
      // 약속 시각을 못 읽으면 문구만 빼고 꾸러미는 그대로 (알람은 울려야 함)
      appointment: appointmentAt ? { appointmentAt, travelMinutes: first.travel_minutes, timeZone: tz } : undefined,
    });
    packages.push(...built.map((pkg) => ({ ...pkg, groupKey })));
  }
  return packages.sort((a, b) => a.atMillis - b.atMillis);
}

export type ReconcilePlan = {
  schedule: PhoneRingPackage[]; // 폰에 걸 것 (없어서 더하는 것 + 시각 · 강도가 달라서 다시 거는 것 + 출발 알람이 바뀐 약속의 준비 · 기상). 같은 alarmId면 덮어씀
  cancel: string[]; // 폰에서 지울 alarmId (서버에 없는 것)
};

// 준비 알림 글자 · 기상 음성 문장은 같은 약속의 출발 알람 시각 · 켜짐에서 나옴 (_shared/ring-package.ts). 폰 list()는 글자를 안 돌려줘서 글자로는 못 비교하므로,
// 출발 알람이 바뀌면 그 약속의 준비 · 기상을 시각 · 강도가 같아도 다시 걸어 새 글자로 덮음
const TEXT_SIBLING_TYPES: ReadonlySet<string> = new Set(['PREPARE', 'WAKE']);

// reconcile({ alarmIds })처럼 알람 일부만 맞출 때: 그 가운데 출발 알람(서버 꾸러미에 있거나, 서버에 없어 지울 폰 출발 알람 = departureGroups)이 있으면
// 같은 약속의 준비 · 기상 알람 id도 대상에 더해서 돌려줌 (planReconcile이 그 글자를 새로 걸 수 있게). 출발 알람이 없으면 그대로
export function expandWithTextSiblings(ids: ReadonlySet<string>, server: readonly ServerPackage[], departureGroups: ReadonlyMap<string, string>): Set<string> {
  const groups = new Set<string>(departureGroups.values());
  for (const p of server) if (p.type === 'DEPARTURE' && p.groupKey && ids.has(p.alarmId)) groups.add(p.groupKey);
  const expanded = new Set(ids);
  if (!groups.size) return expanded;
  for (const p of server) if (p.groupKey && groups.has(p.groupKey) && TEXT_SIBLING_TYPES.has(p.type)) expanded.add(p.alarmId);
  return expanded;
}

// 서버 꾸러미(server)와 폰 예약(phone)을 alarmId + 시각 + 강도로 비교
//   · 지난 시각 꾸러미는 건너뜀
//   · 폰에 없음 → 더함 (기간 안일 때만). 폰에 있는데 시각(atMillis = 서버 scheduled_at) 또는 강도가 다름 → 다시 걺 (친구의 ±5분 · 제안 적용 · 다른 기기에서 고친 것)
//   · 출발(DEPARTURE) 알람이 새로 걸리거나 시각이 바뀌어 다시 걸 때, 같은 약속(groupKey)의 폰에 있는 준비 · 기상도 시각 · 강도가 같아도 같이 다시 걺 (위 글자 이유).
//     출발 알람이 폰에서 지워질 때(아래)도 같음 — 폰은 지울 알람의 약속을 몰라서 호출하는 쪽이 departureGroups(폰 출발 알람 id → 약속 키)로 알려 줌.
//     아무것도 안 바뀌면 다시 걸지 않음. 강도만 바뀐 출발 알람은 글자가 같아 해당 없음
//   · 서버에 없는 폰 예약 → 지움. 단 첫 울림 시각이 이미 지난 예약(울리는 중 · 미룸 · 다시 울림 대기)은 건드리지 않음 — 서버 행은 울린 뒤 과거가 되어 목록에서 빠지는 것이 정상이고,
//     울리는 중인 알람을 지우면 안 되므로. 그 알람이 서버에서 지워졌다면 alarm-commit 응답의 canceled_alarm_ids(applyCommit)가 지움
//     예외 forceCancel: 서버에서 꺼졌거나 지워진 것이 확인된 알람(서버에 켜진 행이 없음)은 시각과 상관없이 지움 — 끄기를 누른 직후(reconcile({ alarmIds }))와
//     전체 맞추기 모두, 서버에서 꺼진 알람이 미룸 · 다시 울림 대기로 다시 울리지 않게 (확인은 index.ts. 확인하지 못했으면 안 넘겨서 지우지 않음)
//   · 같은 alarmId가 폰에서 울리거나 미룬 중이면 schedule()이 'deferred'를 돌려주어 다음 맞추기로 넘어감 (여기서는 계획에 넣기만 함)
//   · schedule에 든 꾸러미는 groupKey를 뗀 폰 꾸러미 (앱 안에서만 쓰는 칸이 알람 코어로 넘어가지 않게)
export function planReconcile(input: {
  server: readonly ServerPackage[];
  phone: readonly ScheduledAlarm[];
  nowMs: number;
  windowDays?: number;
  forceCancel?: ReadonlySet<string>; // 서버에 켜진 행이 없다고 확인된 알람 id (있으면 첫 울림이 지났어도 폰에서 지움). 확인 못 했으면 안 넘김
  departureGroups?: ReadonlyMap<string, string>; // 폰의 출발 알람 id → 그 약속의 키(participant_id). 서버에 없어 지울 출발 알람의 약속 — 모르면 안 넘김 (그 약속의 준비 · 기상은 다시 안 걺)
}): ReconcilePlan {
  const { server, phone, nowMs, forceCancel, departureGroups } = input;
  const horizon = nowMs + (input.windowDays ?? RECONCILE_WINDOW_DAYS) * DAY_MS;
  const onPhone = new Map(phone.map((a) => [a.id, a]));
  const onServer = new Set(server.map((p) => p.alarmId));

  const picked = new Set<string>();
  const departureChanged = new Set<string>(); // 출발 알람이 새로 걸리거나 시각이 바뀌어 지워지는 약속
  for (const p of server) {
    if (p.atMillis <= nowMs) continue;
    const existing = onPhone.get(p.alarmId);
    if (!existing && p.atMillis > horizon) continue; // 폰에 없는 먼 알람은 안 더함
    const timeChanged = !existing || existing.atMillis !== p.atMillis; // 폰에 없어서 새로 거는 것도 포함
    if (timeChanged || existing?.intensity !== p.intensity) picked.add(p.alarmId);
    if (timeChanged && p.type === 'DEPARTURE' && p.groupKey) departureChanged.add(p.groupKey);
  }

  const cancel = phone.filter((a) => !onServer.has(a.id) && (a.atMillis > nowMs || forceCancel?.has(a.id) === true)).map((a) => a.id);
  for (const id of cancel) {
    const group = onPhone.get(id)?.type === 'DEPARTURE' ? departureGroups?.get(id) : undefined;
    if (group) departureChanged.add(group);
  }

  // 폰에 이미 있는 같은 약속의 준비 · 기상 (폰에 없으면 위에서 이미 걸림)
  if (departureChanged.size) {
    for (const p of server) {
      if (p.atMillis > nowMs && p.groupKey && departureChanged.has(p.groupKey) && TEXT_SIBLING_TYPES.has(p.type) && onPhone.has(p.alarmId)) picked.add(p.alarmId);
    }
  }

  const schedule = server.filter((p) => picked.has(p.alarmId)).map(toPhonePackage);
  return { schedule, cancel };
}

// 앱 안에서만 쓰는 칸(groupKey)을 뗀 폰 꾸러미
function toPhonePackage(pkg: ServerPackage): PhoneRingPackage {
  const copy = { ...pkg };
  delete copy.groupKey;
  return copy;
}
