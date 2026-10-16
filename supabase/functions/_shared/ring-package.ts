// 예약 꾸러미(RingPackage) 조립 — alarm-commit이 돌려주고 앱이 그대로 알람 코어 schedule(pkg)에 넘김
// 모양은 mobile/modules/alarm-core/src/types.ts RingPackage와 같음 (docs/alarm-core.md "예약 꾸러미"):
//   alarmId · type · atMillis · title · subtitle? · intensity · snoozeLimit · soundKey? · departAt? (voiceText · volumeAdjust · vibration · snoozeMinutesOptions는 아직 안 채움)
// 5장 5.4.2는 snake_case 응답이지만 이 꾸러미 안쪽은 알람 코어 타입(camelCase) 그대로 — 앱이 변환 없이 넘기려고
// 순수 TS — node --test로 시험
import { formatKoTime } from './tz.ts';

export type RingPackage = {
  alarmId: string;
  type: 'WAKE' | 'PREPARE' | 'DEPARTURE' | 'ARRIVE' | 'ROUTINE';
  atMillis: number;
  title: string;
  subtitle?: string;
  intensity: 'SOFT' | 'NORMAL' | 'STRONG';
  snoozeLimit: number;
  soundKey?: string;
  departAt?: number;
};

// 꾸러미를 만들 알람 한 줄 (DB alarms 행에서 필요한 칸)
export type PackageSource = {
  alarm_id: string;
  alarm_type: RingPackage['type'];
  scheduled_at: string;
  intensity: RingPackage['intensity'];
  sound_key: string | null;
  snooze_limit: number;
  is_enabled: boolean;
};

export function subtitleFor(at: Date, place: string | null | undefined, timeZone: string): string {
  const time = formatKoTime(at, timeZone);
  return place ? `${time} · ${place}` : time;
}

// 켜진 알람만 꾸러미로. 꺼진 알람(지난 알림 · 사용자가 끈 알람)은 폰에 걸지 않음 → canceled_alarm_ids 쪽
export function buildRingPackages(args: {
  alarms: readonly PackageSource[];
  title: string;
  subtitle?: string;
  departAt?: Date; // 출발 시각 (단축 준비 안내용)
}): RingPackage[] {
  return args.alarms
    .filter((a) => a.is_enabled)
    .map((a) => ({
      alarmId: a.alarm_id,
      type: a.alarm_type,
      atMillis: Date.parse(a.scheduled_at),
      title: args.title,
      ...(args.subtitle ? { subtitle: args.subtitle } : {}),
      intensity: a.intensity,
      snoozeLimit: a.snooze_limit,
      ...(a.sound_key ? { soundKey: a.sound_key } : {}),
      ...(args.departAt ? { departAt: args.departAt.getTime() } : {}),
    }))
    .sort((x, y) => x.atMillis - y.atMillis);
}

// 폰에서 지워야 할 예약: 이번 저장으로 지워졌거나 꺼진 알람 (5장 5.4.2 "canceled_alarm_ids를 반드시 반환함")
export function canceledAlarmIds(args: {
  before: readonly { alarm_id: string }[];
  after: readonly { alarm_id: string; is_enabled: boolean }[];
}): string[] {
  const live = new Set(args.after.filter((a) => a.is_enabled).map((a) => a.alarm_id));
  return args.before.map((a) => a.alarm_id).filter((id) => !live.has(id));
}
