// alarm-commit이 DB에 쓸 내용을 정하는 순수 부분 — 어떤 알람 행을 새로 만들고 · 고치고 · 지울지, 고친 값 기록 행
// 실제 쓰기는 alarm-commit/index.ts. 여기서는 읽어 온 행과 계획만 받아 계산함 (node --test)
import { addMinutes, PAST_GRACE_MINUTES } from './calc/index.ts';
import type { AlarmRow, Plan } from './plan-core.ts';

export type AlarmKindDb = AlarmRow['alarm_type'];

// alarms 행에 쓸 칸 (user_id · participant_id는 만들 때만 붙음 — 고칠 때는 keep_keys 트리거가 못 바꾸게 함)
export type AlarmWrite = {
  alarm_type: AlarmKindDb;
  scheduled_at: string;
  intensity: AlarmRow['intensity'];
  voice_tone: AlarmRow['voice_tone'];
  sound_key: string;
  vibration: AlarmRow['vibration']; // 직접 고른 진동만 값, 자동이면 null (강도를 따름)
  is_enabled: boolean;
  time_source: 'AUTO' | 'MANUAL';
  intensity_source: 'AUTO' | 'MANUAL';
  last_calculated_at: string;
};

export type AlarmDiff = {
  insert: AlarmWrite[];
  update: { alarm_id: string; patch: AlarmWrite }[];
  remove: string[]; // 지울 alarm_id
};

const LIFECYCLE_TYPES: readonly AlarmKindDb[] = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];

// 알람이 켜진 채로 저장되는지 — 미리 보기(toSuggestion)와 저장(diffAlarms)이 같은 규칙을 씀
//   checkedEnabled: 지난 알림 검사(8.2.1)를 통과했는지. 통과 못 하면 꺼서 저장
//   requested: 요청의 enabled(H03 종류별 켜기 · 끄기). 없으면 지금 상태 → 새 알람이면 켬
//   지금 꺼져 있어도 옛 시각이 이미 지났다면 지나서 꺼진 것으로 보고 새 시각으로 다시 켬 (사용자가 H02에서 끈 것과 구분)
export function resolveEnabled(args: { checkedEnabled: boolean; old?: Pick<AlarmRow, 'is_enabled' | 'scheduled_at'>; requested?: boolean; now: Date }): boolean {
  const graceEnd = addMinutes(args.now, PAST_GRACE_MINUTES).getTime();
  const wasOn = args.old ? args.old.is_enabled || Date.parse(args.old.scheduled_at) < graceEnd : true;
  return args.checkedEnabled && (args.requested ?? wasOn);
}

// 계획(plan.check가 ok인 것)을 DB 행으로. existing = 이 참여 조건의 지금 알람
//   · 켜짐: 지난 알림이면 꺼서 저장(8.2.1). 아니면 요청의 enabled → 지금 상태 → 켬 순.
//     지금 꺼져 있어도 옛 시각이 이미 지났다면 지나서 꺼진 것으로 보고 새 시각으로 다시 켬 (사용자가 H02에서 끈 것과 구분)
//   · 시각 출처: 직접 고른 시각이면 MANUAL, 아니면 AUTO (기상을 직접 옮겨서 따라온 준비는 AUTO)
//   · 강도 4칸(전체 세기 · 배경음 · 말소리 · 진동)은 같은 값을 모든 종류에 씀 (한 일정의 강도 — H03이 어느 알람에서든 읽을 수 있게). 진동은 직접 고를 때만 값, 자동이면 null
export function diffAlarms(
  plan: Plan,
  existing: readonly AlarmRow[],
  options: { now: Date; enabled?: Partial<Record<'WAKE' | 'PREPARE' | 'DEPARTURE', boolean>>; replaceExisting: boolean },
): AlarmDiff {
  if (!plan.check.ok) throw new Error('검증을 통과하지 못한 계획은 저장할 수 없어요');
  const nowIso = options.now.toISOString();
  const { fields, manual } = plan.intensity;
  const diff: AlarmDiff = { insert: [], update: [], remove: [] };
  const wanted = new Set<AlarmKindDb>();

  for (const a of plan.check.alarms) {
    wanted.add(a.kind);
    const old = existing.find((x) => x.alarm_type === a.kind);
    const requested = a.kind === 'ARRIVE' ? undefined : options.enabled?.[a.kind];
    const write: AlarmWrite = {
      alarm_type: a.kind,
      scheduled_at: a.at.toISOString(),
      intensity: fields.intensity,
      voice_tone: fields.voiceTone,
      sound_key: fields.soundKey,
      vibration: fields.vibration,
      is_enabled: resolveEnabled({ checkedEnabled: a.enabled, old, requested, now: options.now }),
      time_source: a.auto ? 'MANUAL' : 'AUTO',
      intensity_source: manual ? 'MANUAL' : 'AUTO',
      last_calculated_at: nowIso,
    };
    if (old) diff.update.push({ alarm_id: old.alarm_id, patch: write });
    else diff.insert.push(write);
  }

  if (options.replaceExisting) {
    for (const old of existing) {
      if (LIFECYCLE_TYPES.includes(old.alarm_type) && !wanted.has(old.alarm_type)) diff.remove.push(old.alarm_id);
    }
  }
  return diff;
}

// ---- 고친 값 기록 (user_edit_logs) ----

export type EditInput = {
  screen: 'H03' | 'H05' | 'S01';
  field: string;
  alarmType?: AlarmKindDb;
  autoValue?: unknown;
  editedValue?: unknown; // null · 없음 = 자동으로 되돌림 (D42 C)
};

export type EditLogRow = {
  user_id: string;
  appointment_id: string | null;
  alarm_id: string | null;
  screen: EditInput['screen'];
  field: string;
  alarm_type: AlarmKindDb | null;
  auto_value: unknown;
  edited_value: unknown;
};

// 앱은 새 알람의 id를 저장 전에 모르므로 alarm_type으로 가리킴 → 저장된 알람에서 id를 찾아 붙임
export function buildEditLogRows(
  userId: string,
  appointmentId: string | null,
  alarms: readonly { alarm_id: string; alarm_type: AlarmKindDb }[],
  edits: readonly EditInput[],
): EditLogRow[] {
  return edits.map((e) => ({
    user_id: userId,
    appointment_id: appointmentId,
    alarm_id: e.alarmType ? (alarms.find((a) => a.alarm_type === e.alarmType)?.alarm_id ?? null) : null,
    screen: e.screen,
    field: e.field,
    alarm_type: e.alarmType ?? null,
    auto_value: e.autoValue ?? null,
    edited_value: e.editedValue ?? null,
  }));
}
