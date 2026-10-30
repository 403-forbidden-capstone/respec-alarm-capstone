// "그날 첫 일정" 판정 — 이 약속보다 약속 시각이 앞선, 같은 날의 다른 약속에 켜진 기상 알람이 이미 있으면 이 약속은 기상 없이 준비부터
//   서버(plan.ts)와 앱 목업(estimateAppointment)이 같은 함수를 씀. 알람이 울리는 시각이 아니라 약속 시각으로 앞뒤를 가림
//   (이 약속 앞에 울리는 기상이 있다고 첫 일정이 아닌 게 아님 — 10시 약속의 8시 기상이 있는 날 8:30 약속은 그날 첫 일정)
// "같은 날"(내 시간대 0시 기준)은 부르는 쪽이 정해서 그날의 참여만 넘김. 이 함수는 날짜를 보지 않음
import { localDateKey, localMinuteOfDay, safeTimeZone } from '../tz.ts';

export type SameDayWake = {
  appointmentId?: string; // 이 기상 알람이 걸린 약속
  appointmentAt: Date; // 그 약속의 시각 (알람 시각이 아님)
  isEnabled?: boolean; // 기상 알람이 켜져 있는지. 안 주면 켜짐. 꺼 둔 기상은 세지 않음
};

// 이 약속(thisAt)보다 약속 시각이 엄밀히 앞인 다른 약속에 켜진 기상 알람이 있나
//   · 같은 시각이면 앞선 게 아님 → 둘 다 기상을 가짐 (서로를 앞섰다고 보면 둘 다 기상이 없어지므로)
//   · ownAppointmentId = 지금 다시 계산하는 이 약속. 자기 자신의 기상은 안 셈
export function hasEarlierWake(thisAt: Date, sameDayWakes: readonly SameDayWake[], ownAppointmentId?: string): boolean {
  return sameDayWakes.some(
    (w) => w.isEnabled !== false && w.appointmentAt.getTime() < thisAt.getTime() && !(ownAppointmentId != null && w.appointmentId === ownAppointmentId),
  );
}

// 계산된 기상 시각이 저녁(그 시간대 낮 12시 이후)인가 — 이러면 기상 알람 없이 준비 · 출발(+ 도착)만 (B1 7일 기능시험 버그 후보 4, 헤드 10/30)
//   저녁에만 일정이 있는 날 "그날 첫 일정"이라고 오후에 기상 알람이 울리던 것을 막음. 12:00 정각은 이후(= 기상 없음)
//   하루는 사용자 시간대(profiles.timezone, 없거나 틀리면 Asia/Seoul) 0시 기준. 서버 computePlan · 앱 가짜 모드가 같은 함수를 씀
export const EVENING_WAKE_FROM_MINUTE = 12 * 60;

//   appointmentAt을 주면 기상이 약속 날짜가 아니라 전날 밤이면(새벽 1시 약속의 23:10 기상) 저녁 기상이 아님 — "그날"은 약속이 있는 날
export function isEveningWake(wakeAt: Date, timeZone?: string | null, appointmentAt?: Date): boolean {
  const zone = safeTimeZone(timeZone);
  if (appointmentAt && localDateKey(wakeAt, zone) !== localDateKey(appointmentAt, zone)) return false;
  return localMinuteOfDay(wakeAt, zone) >= EVENING_WAKE_FROM_MINUTE;
}
