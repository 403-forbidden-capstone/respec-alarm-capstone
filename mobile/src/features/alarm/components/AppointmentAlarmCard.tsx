import { router } from 'expo-router';

import { AlarmCard, toast } from '@/components/ui';
import { formatDateShort, formatTime, timeParts } from '@/lib/format';

import { setAppointmentEnabled } from '../api';
import { KIND_LABEL, LEVELS, type Appointment } from '../types';

type Props = {
  appointment: Appointment;
  onChanged: () => void; // 켜기 · 끄기 뒤 다시 읽기
};

// 일정 하나의 알람 카드 (홈 · 알람 목록) — 시각을 누르면 알람 설정(H03)
export function AppointmentAlarmCard({ appointment: a, onChanged }: Props) {
  const list = a.alarms.filter((x) => x.kind !== 'ARRIVE');
  // 큰 시각 = 켜진 첫 알람 (홈 "다음 알람"과 같은 것을 가리키게). 다 껐으면 첫 알람
  const first = list.find((x) => x.enabled) ?? list[0];

  async function toggle(next: boolean) {
    await setAppointmentEnabled(a.id, next);
    toast(next ? '이 일정의 알람을 켰어요' : '이 일정의 알람을 껐어요');
    onChanged();
  }

  return (
    <AlarmCard
      dateLabel={`${formatDateShort(a.at)}${a.groupName ? ` · ${a.groupName} 공유` : ''}`}
      time={timeParts(first.at)}
      kindLabel={KIND_LABEL[first.kind]}
      chain={list.map((x) => `${formatTime(x.at)} ${KIND_LABEL[x.kind]}${x.enabled ? '' : ' · 꺼짐'}`)}
      meta={[
        `알람 강도 · ${LEVELS[a.level].name}`,
        `준비 ${a.predictedPrepMinutes}분 · 이동 ${a.travelMinutes}분 · 여유 ${a.bufferMinutes}분`,
      ]}
      foot={`${a.title} · ${a.place} · ${formatTime(a.at)}`}
      enabled={a.enabled}
      onToggle={toggle}
      toggleLabel={`${a.title} 알람`}
      onPress={() => router.push({ pathname: '/alarm/[id]', params: { id: a.id } })}
      pressLabel={`${a.title} 알람 설정 열기`}
    />
  );
}
