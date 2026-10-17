// 서버 alarms ↔ 폰 예약 맞추기의 계산 부분 — 순수 함수 (시험: __tests__/reconcile.test.ts)
// 쿼리 · 폰 호출은 index.ts. 여기는 "서버에 이런 행이 있고 폰에 이런 예약이 있으면 무엇을 걸고 무엇을 지울지"만 정함
// 근거: docs/alarm-core.md "앞으로 더할 것" 앱 연결 (P6), 전체작업계획 7절 "폰 예약 맞추기" · 8.1 Q11
import type { RingPackage as PhoneRingPackage, ScheduledAlarm } from '@capstone/alarm-core';
import { buildRingPackages, subtitleFor, type PackageSource } from '@shared/ring-package.ts';
import { safeTimeZone } from '@shared/tz.ts';

import { normalizeDbTime, parseDbTime } from '../dbTime';

// 서버 알람을 폰에 미리 걸어 두는 기간. 이보다 먼 알람은 폰에 없어도 더하지 않음 (이미 폰에 있는 것은 이 기간 밖이어도 시각 · 강도를 맞춤)
// 작성자 판단 — 되돌리기 쉬움. 반복 알람은 서버가 다음 회차 하나만 만들어서(docs/alarm-core.md) 대부분 며칠 안쪽
export const RECONCILE_WINDOW_DAYS = 14;
export const DEFAULT_TIME_ZONE = 'Asia/Seoul';
const DAY_MS = 24 * 60 * 60 * 1000;

// alarms 행 한 줄 + 꾸러미 제목 · 부제에 쓰는 약속 · 루틴 정보 (쿼리가 임베드 결과를 이 모양으로 폄)
export type SyncRow = PackageSource & {
  participant_id: string | null;
  routine_id: string | null;
  appointment: { title: string; appointment_at: string; dest_name: string | null } | null; // 약속 알람이면
  routine_title: string | null; // 루틴 알람이면
};

export const STANDALONE_TITLE = '알람'; // 일정 없는 알람 — 서버 commitStandalone과 같은 이름

// 부제 글자는 시각 서식(Intl, 시간대 지정)에 기대는데, 이 기기가 못 만들거나 시각 값이 이상해도 맞추기 전체가 멈추지 않게 — 시각을 뺀 장소만 (알람은 그대로 울림)
function safeSubtitle(at: string, place: string | null, timeZone: string): string | undefined {
  try {
    return subtitleFor(parseDbTime(at), place, timeZone);
  } catch {
    return place ?? undefined;
  }
}

// 서버가 alarm-commit에서 조립하는 것과 같은 꾸러미 (_shared/ring-package.ts) — 약속(참여 조건) · 루틴 · 일정 없는 알람별로 묶어서
//   · 부제는 약속 알람이면 "오전 10:00 · 장소", 일정 없는 알람이면 알람 시각만 (서버와 같음), 루틴은 없음
//   · departAt은 같은 약속의 출발 알람 시각 (단축 준비 안내용 — 폰이 아직 안 읽음). 출발 알람이 꺼져 있거나 이 목록에 없으면 빠짐
export function buildServerPackages(rows: readonly SyncRow[], timeZone: string = DEFAULT_TIME_ZONE): PhoneRingPackage[] {
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
  const packages: PhoneRingPackage[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const appointment = first.appointment;
    const departure = group.find((row) => row.alarm_type === 'DEPARTURE');
    packages.push(
      ...buildRingPackages({
        alarms: group,
        title: appointment?.title ?? first.routine_title ?? STANDALONE_TITLE,
        subtitle: appointment
          ? safeSubtitle(appointment.appointment_at, appointment.dest_name, tz)
          : first.routine_id
            ? undefined
            : safeSubtitle(first.scheduled_at, null, tz),
        departAt: departure ? parseDbTime(departure.scheduled_at) : undefined,
      }),
    );
  }
  return packages.sort((a, b) => a.atMillis - b.atMillis);
}

export type ReconcilePlan = {
  schedule: PhoneRingPackage[]; // 폰에 걸 것 (없어서 더하는 것 + 시각 · 강도가 달라서 다시 거는 것). 같은 alarmId면 덮어씀
  cancel: string[]; // 폰에서 지울 alarmId (서버에 없는 것)
};

// 서버 꾸러미(server)와 폰 예약(phone)을 alarmId + 시각 + 강도로 비교
//   · 지난 시각 꾸러미는 건너뜀
//   · 폰에 없음 → 더함 (기간 안일 때만). 폰에 있는데 시각(atMillis = 서버 scheduled_at) 또는 강도가 다름 → 다시 걺 (친구의 ±5분 · 제안 적용 · 다른 기기에서 고친 것)
//   · 서버에 없는 폰 예약 → 지움. 단 첫 울림 시각이 이미 지난 예약(울리는 중 · 미룸 · 다시 울림 대기)은 건드리지 않음 — 서버 행은 울린 뒤 과거가 되어 목록에서 빠지는 것이 정상이고,
//     울리는 중인 알람을 지우면 안 되므로. 그 알람이 서버에서 지워졌다면 alarm-commit 응답의 canceled_alarm_ids(applyCommit)가 지움
//     예외 forceCancel: 서버에서 꺼졌거나 지워진 것이 확인된 알람(서버에 켜진 행이 없음)은 시각과 상관없이 지움 — 끄기를 누른 직후(reconcile({ alarmIds }))와
//     전체 맞추기 모두, 서버에서 꺼진 알람이 미룸 · 다시 울림 대기로 다시 울리지 않게 (확인은 index.ts. 확인하지 못했으면 안 넘겨서 지우지 않음)
//   · 같은 alarmId가 폰에서 울리거나 미룬 중이면 schedule()이 'deferred'를 돌려주어 다음 맞추기로 넘어감 (여기서는 계획에 넣기만 함)
export function planReconcile(input: {
  server: readonly PhoneRingPackage[];
  phone: readonly ScheduledAlarm[];
  nowMs: number;
  windowDays?: number;
  forceCancel?: ReadonlySet<string>; // 서버에 켜진 행이 없다고 확인된 알람 id (있으면 첫 울림이 지났어도 폰에서 지움). 확인 못 했으면 안 넘김
}): ReconcilePlan {
  const { server, phone, nowMs, forceCancel } = input;
  const horizon = nowMs + (input.windowDays ?? RECONCILE_WINDOW_DAYS) * DAY_MS;
  const onPhone = new Map(phone.map((a) => [a.id, a]));
  const onServer = new Set(server.map((p) => p.alarmId));

  const schedule = server.filter((p) => {
    if (p.atMillis <= nowMs) return false;
    const existing = onPhone.get(p.alarmId);
    if (!existing) return p.atMillis <= horizon;
    return existing.atMillis !== p.atMillis || existing.intensity !== p.intensity;
  });
  const cancel = phone.filter((a) => !onServer.has(a.id) && (a.atMillis > nowMs || forceCancel?.has(a.id) === true)).map((a) => a.id);
  return { schedule, cancel };
}
