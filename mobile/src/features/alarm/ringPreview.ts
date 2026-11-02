// 웹 실데이터 울림 미리보기 (H07 → H08 → 다음 알람) — 웹에는 폰 알람 코어가 없어 실제로 울리지 않으므로, 저장된 일정의 알람으로 화면만 보여 줌
//   서버에는 아무것도 쓰지 않음 (해제 · 미루기 · 기상 확인 기록은 폰 알람 코어 몫). 미리보기 기상 확인 상태는 api.ts가 탭 메모리에만 둠
//   미리보기 알람 id = `${일정 id}:${종류}` — 가짜 데이터의 알람 id와 같은 모양이라 울림 · 기상 확인 화면을 그대로 씀. 실데이터 알람 id(UUID)에는 ':'가 없음
//   들어오는 길: 알람 설정(H03) 알람 칸 아래 [기상 · 준비 · 출발 울려 보기] (웹만). 끈 뒤에는 같은 일정의 다음 알람으로 이어 봄 (기상 → 준비 → 출발)
import { DEFAULT_SNOOZE_LIMIT } from '../../../modules/alarm-core/src/plan';
import { josa, spokenTime } from '@/lib/format';

import { ringNotice } from './notice';
import { getAppointment } from './real';
import { LEVELS, RING_KINDS, type Appointment, type RingInfo, type RingKind } from './types';

export const previewAlarmId = (appointmentId: string, kind: RingKind) => `${appointmentId}:${kind}`;

export function parsePreviewAlarmId(id: string): { appointmentId: string; kind: RingKind } | null {
  const cut = id.lastIndexOf(':');
  if (cut <= 0) return null;
  const kind = id.slice(cut + 1) as RingKind;
  return RING_KINDS.includes(kind) ? { appointmentId: id.slice(0, cut), kind } : null;
}

export const isPreviewAlarmId = (id: string) => parsePreviewAlarmId(id) != null;

// 같은 일정에서 이 알람 다음으로 켜진 울림 알람 (기상 → 준비 → 출발). 없으면 null
export function nextRingKind(a: Pick<Appointment, 'alarms'>, kind: RingKind): RingKind | null {
  const on = new Set(a.alarms.filter((x) => x.enabled).map((x) => x.kind));
  return RING_KINDS.slice(RING_KINDS.indexOf(kind) + 1).find((k) => on.has(k)) ?? null;
}

// 음성 안내 문장 — 가짜 데이터(api.ts voiceLine)의 보통 강도 문장과 같은 틀. 폰에서는 서버 꾸러미의 문장을 씀
function voiceLine(a: Appointment, kind: RingKind, departAt: Date | null): string {
  const when = spokenTime(a.at);
  if (kind === 'WAKE') return `좋은 아침이에요. 오늘 ${when}에 ${josa(a.title, '이', '가')} 있어요. 천천히 일어나 볼까요?`;
  if (kind === 'PREPARE') {
    return a.items.length ? `준비를 시작할 시간이에요. ${a.items.join(', ')} 챙기는 것 잊지 마세요.` : `준비를 시작할 시간이에요. ${spokenTime(departAt ?? a.at)}에 출발해요.`;
  }
  return `출발 시간입니다. 지금 나가면 ${when} ${a.title}에 여유 ${a.bufferMinutes}분을 두고 도착해요.`;
}

// 저장된 일정 → 울림 화면 값. 강도는 지금 적용되는 강도 하나로 보여 줌 (축별 값은 폰 꾸러미가 정함), 미루기는 처음부터. 꺼진 알람이면 null
export function previewRingOf(a: Appointment, kind: RingKind): RingInfo | null {
  const alarm = a.alarms.find((x) => x.kind === kind && x.enabled);
  if (!alarm) return null;
  const level = LEVELS[a.level];
  const departAt = a.alarms.find((x) => x.kind === 'DEPARTURE')?.at ?? null;
  return {
    alarmId: previewAlarmId(a.id, kind),
    kind,
    appointment: a,
    at: alarm.at,
    voiceTone: level.voice,
    voiceLine: voiceLine(a, kind, departAt),
    notice: ringNotice(a, kind, alarm.at),
    levelLine: `알람 강도 ${level.name} · 볼륨 ${level.volume} · 배경음 ${level.sound} · 진동 ${level.vibration}`,
    important: a.importance !== 'LOW',
    snoozeCount: 0,
    snoozeLimit: DEFAULT_SNOOZE_LIMIT,
    departAt,
  };
}

export async function getPreviewRing(alarmId: string): Promise<RingInfo | null> {
  const parsed = parsePreviewAlarmId(alarmId);
  if (!parsed) return null;
  const a = await getAppointment(parsed.appointmentId);
  return a ? previewRingOf(a, parsed.kind) : null;
}

// 끈 알람 다음에 이어 볼 알람 — 울림 화면(준비 · 출발 끈 뒤) · 기상 확인(확정 뒤)의 [다음 알람 울려 보기]
export async function nextPreviewAlarm(alarmId: string): Promise<{ id: string; kind: RingKind; at: Date } | null> {
  const parsed = parsePreviewAlarmId(alarmId);
  if (!parsed) return null;
  const a = await getAppointment(parsed.appointmentId);
  const kind = a ? nextRingKind(a, parsed.kind) : null;
  const alarm = kind ? a?.alarms.find((x) => x.kind === kind) : undefined;
  return a && kind && alarm ? { id: previewAlarmId(a.id, kind), kind, at: alarm.at } : null;
}
