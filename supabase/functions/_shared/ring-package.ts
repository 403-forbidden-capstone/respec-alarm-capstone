// 예약 꾸러미(RingPackage) 조립 — alarm-commit이 돌려주고 앱이 그대로 알람 코어 schedule(pkg)에 넘김
// 모양은 mobile/modules/alarm-core/src/types.ts RingPackage와 같음 (docs/alarm-core.md "예약 꾸러미"):
//   alarmId · type · atMillis · title · subtitle? · intensity · snoozeLimit · soundKey? · departAt? · notice? · voiceText? (volumeAdjust · vibration · snoozeMinutesOptions는 아직 안 채움)
//   notice = 준비 · 출발 알림의 한 줄, voiceText = 기상 알람의 음성 문장 — 약속 알람만 (docs/alarm-core.md "예약 꾸러미")
// 5장 5.4.2는 snake_case 응답이지만 이 꾸러미 안쪽은 알람 코어 타입(camelCase) 그대로 — 앱이 변환 없이 넘기려고
// 순수 TS — node --test로 시험
import { departNow } from './calc/depart.ts';
import { minutesBetween } from './calc/time.ts';
import { formatKoDuration, formatKoSpokenTime, formatKoTime } from './tz.ts';

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
  voiceText?: string; // 기상 알람의 음성 문장 (읽어 주는 것은 D8 · 나중 — 지금은 폰이 저장만 함)
  notice?: string; // 준비 · 출발 알림 한 줄 — 알람 코어가 화면 줄(HEADING) 대신 보여 줌
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

// ---------------------------------------------------------------------------
// 알림 문구 — 약속 알람만. 새 알림을 늘리지 않고 기존 준비 · 출발 알림 문구에 출발 안내를 합침 (D65 기본안)
// 서버(alarm-commit)와 앱(lib/alarmSync reconcile)이 이 함수들로 같은 글자를 만듦 — 한쪽만 고치면 폰 알림이 갈라짐
// ---------------------------------------------------------------------------

// "오전 8:40 출발까지 30분" — 준비 알람이 울린 때부터 출발 알람까지. 준비가 출발 뒤거나 같으면 문구 없음(화면 줄 그대로)
export function prepareNotice(args: { prepareAt: Date; departAt: Date; timeZone: string }): string | undefined {
  const minutes = minutesBetween(args.prepareAt, args.departAt);
  if (!(minutes > 0)) return undefined;
  return `${formatKoTime(args.departAt, args.timeZone)} 출발까지 ${formatKoDuration(minutes)}`;
}

// "지금 나가면 오전 9:50 도착 · 여유 10분" — 도착 = 출발 알람 시각 + 이동분, 여유 = 약속 − 도착 (7장 7.5.2 departNow)
//   출발 알람은 직접 고른 시각일 수 있어서 약속 − 여유로 거꾸로 세지 않음. 여유 0이면 "여유 없음", 늦으면 "N분 늦어요". 시각을 못 읽으면 문구 없음
export function departureNotice(args: { departAt: Date; appointmentAt: Date; travelMinutes: number; timeZone: string }): string | undefined {
  const { arriveAt, slackMinutes } = departNow({ appointmentAt: args.appointmentAt, travelMinutes: args.travelMinutes, now: args.departAt });
  if (!Number.isFinite(slackMinutes)) return undefined;
  const slack = slackMinutes > 0 ? `여유 ${formatKoDuration(slackMinutes)}` : slackMinutes === 0 ? '여유 없음' : `${formatKoDuration(-slackMinutes)} 늦어요`;
  return `지금 나가면 ${formatKoTime(arriveAt, args.timeZone)} 도착 · ${slack}`;
}

// 닫는 괄호로 끝나면 괄호 안을 빼고 그 앞 글자만 ("자료구조(월)" → "자료구조"). 짝이 없거나 제목 전체가 괄호면 그대로
const OPEN_BRACKETS = '([{（［｛';
const CLOSE_BRACKETS = ')]}）］｝';
function stripTrailingBrackets(text: string): string {
  let rest = text.trimEnd();
  while (rest && CLOSE_BRACKETS.includes(rest[rest.length - 1])) {
    let depth = 0;
    let start = -1;
    for (let i = rest.length - 1; i >= 0; i -= 1) {
      if (CLOSE_BRACKETS.includes(rest[i])) {
        depth += 1;
      } else if (OPEN_BRACKETS.includes(rest[i])) {
        depth -= 1;
        if (depth === 0) {
          start = i;
          break;
        }
      }
    }
    if (start <= 0) return rest;
    rest = rest.slice(0, start).trimEnd();
  }
  return rest;
}

// 읽을 때 받침이 있는 숫자: 0 영 · 1 일 · 3 삼 · 6 육 · 7 칠 · 8 팔 (2 이 · 4 사 · 5 오 · 9 구는 받침 없음)
const BATCHIM_DIGITS = new Set(['0', '1', '3', '6', '7', '8']);

// 받침 있는 말 뒤에는 "이에요", 없으면 "예요". 끝이 숫자면 읽는 소리로("영어 1" → 일 → 이에요), 닫는 괄호면 괄호 앞 글자로. 영문 · 기타는 받침 없음으로 봄
// 앱 lib/format josa는 한글 끝글자만 보므로 이 규칙이 없음 — 이 문구에는 이 함수를 씀
function copula(word: string): string {
  const last = stripTrailingBrackets(word).slice(-1);
  const code = last.charCodeAt(0);
  const hasBatchim = BATCHIM_DIGITS.has(last) || (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0);
  return hasBatchim ? '이에요' : '예요';
}

// 기상 알람의 음성 문장 — 회사 제안 2 speech_text의 틀: 인사 → 오늘 첫 일정 한 줄 → 나갈 시각.
// 시각은 "오전 10시"로 풀어 씀. 출발 알람이 없으면 나갈 시각 문장을 뺌
export function wakeVoiceText(args: { title: string; appointmentAt: Date; departAt?: Date; timeZone: string }): string {
  const title = args.title.trim() || '일정';
  const sentences = [
    '좋은 아침이에요.',
    `오늘 첫 일정은 ${formatKoSpokenTime(args.appointmentAt, args.timeZone)} ${title}${copula(title)}.`,
  ];
  if (args.departAt) sentences.push(`${formatKoSpokenTime(args.departAt, args.timeZone)}에 나가면 돼요.`);
  return sentences.join(' ');
}

// 문구는 덧붙임일 뿐 — 시각 서식(Intl)이 못 만들거나 값이 이상해도 꾸러미(알람 예약)는 그대로 만들어야 하므로 문구만 빼고 넘어감
// 다만 조용히 삼키면 문구가 왜 없는지 알 수 없으므로 무엇이 실패했는지(알람 종류 · id · 오류)만 한 줄 남김. 제목 · 장소 같은 사용자 글자는 안 남김
function tryText<T>(what: RingPackage['type'], alarmId: string, make: () => T): T | undefined {
  try {
    return make();
  } catch (e) {
    console.warn(`[ring-package] ${what} 문구를 못 만들어 빼고 알람만 걸어요 (알람 ${alarmId}): ${e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error'}`);
    return undefined;
  }
}

// 약속 알람이 문구를 만들 때 쓰는 값 (일정 없는 알람 · 루틴은 넘기지 않음 → 문구 없음)
export type AppointmentNotice = {
  appointmentAt: Date;
  travelMinutes?: number | null; // 이동 (est_travel_minutes). 없으면 출발 문구가 빠짐
  timeZone: string;
};

// 켜진 알람만 꾸러미로. 꺼진 알람(지난 알림 · 사용자가 끈 알람)은 폰에 걸지 않음 → canceled_alarm_ids 쪽
//   appointment가 있으면 문구도 채움: 준비 = notice(출발까지 몇 분), 출발 = notice(지금 나가면), 기상 = voiceText. 도착 · 루틴은 그대로
//   준비 · 기상 문구는 같은 약속의 켜진 출발 알람을 기준으로 함 (출발 알람이 없으면 해당 줄이 빠짐)
export function buildRingPackages(args: {
  alarms: readonly PackageSource[];
  title: string;
  subtitle?: string;
  departAt?: Date; // 출발 시각 (단축 준비 안내용)
  appointment?: AppointmentNotice;
}): RingPackage[] {
  const live = args.alarms.filter((a) => a.is_enabled);
  const departure = live.find((a) => a.alarm_type === 'DEPARTURE');
  const departureAt = departure ? new Date(Date.parse(departure.scheduled_at)) : undefined;
  const { appointment } = args;

  const textFor = (a: PackageSource): Pick<RingPackage, 'notice' | 'voiceText'> => {
    if (!appointment) return {};
    const at = new Date(Date.parse(a.scheduled_at));
    if (a.alarm_type === 'PREPARE' && departureAt) {
      const notice = tryText(a.alarm_type, a.alarm_id, () => prepareNotice({ prepareAt: at, departAt: departureAt, timeZone: appointment.timeZone }));
      return notice ? { notice } : {};
    }
    if (a.alarm_type === 'DEPARTURE' && appointment.travelMinutes != null && Number.isFinite(appointment.travelMinutes)) {
      const travelMinutes = appointment.travelMinutes;
      const notice = tryText(a.alarm_type, a.alarm_id, () => departureNotice({ departAt: at, appointmentAt: appointment.appointmentAt, travelMinutes, timeZone: appointment.timeZone }));
      return notice ? { notice } : {};
    }
    if (a.alarm_type === 'WAKE') {
      const voiceText = tryText(a.alarm_type, a.alarm_id, () => wakeVoiceText({ title: args.title, appointmentAt: appointment.appointmentAt, departAt: departureAt, timeZone: appointment.timeZone }));
      return voiceText ? { voiceText } : {};
    }
    return {};
  };

  return live
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
      ...textFor(a),
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
