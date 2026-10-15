import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { AlarmCard, confirm, toast } from '@/components/ui';
import { formatDateShort, formatTime, timeParts } from '@/lib/format';
import { colors, radius, space } from '@/theme';

import { setAppointmentEnabled } from '../api';
import { chainLabel, pickCardAlarm, ringingKinds } from '../schedule';
import { KIND_LABEL, LEVELS, type Appointment } from '../types';

type Props = {
  appointment: Appointment;
  current: Date; // 지금 시각 — 큰 시각은 앞으로 울릴 첫 알람, 지난 알람은 "지남"
  onChanged: () => void; // 켜기 · 끄기 뒤 다시 읽기
  highlight?: boolean; // 방금 만든 일정 등을 잠깐 테두리로 보여 줌 (H02)
};

// 일정 하나의 알람 카드 (홈 · 알람 목록) — 카드를 누르면 알람 설정(H03)
export function AppointmentAlarmCard({ appointment: a, current, onChanged, highlight }: Props) {
  const list = ringingKinds(a.alarms);
  // 큰 시각 = 앞으로 울릴 첫 알람 (홈 "다음 알람"과 같은 것을 가리키게). 다 지났으면 지남으로, 다 껐으면 첫 알람
  const { alarm: first, passed } = pickCardAlarm(a.alarms, current);

  async function toggle(next: boolean) {
    // 공유(그룹) 일정은 끄는 범위를 먼저 알려 줌 — 내 알람만 꺼지고 일정 · 다른 사람의 알람은 그대로
    if (!next && a.groupName) {
      const ok = await confirm({
        title: `${a.title} 알람을 끌까요?`,
        message: `내 알람만 꺼지고 ${a.groupName} 일정은 그대로예요.`,
        okLabel: '끄기',
      });
      if (!ok) return;
    }
    await setAppointmentEnabled(a.id, next);
    toast(next ? '이 일정의 알람을 켰어요' : '이 일정의 알람을 껐어요');
    onChanged();
  }

  const card = (
    <AlarmCard
      dateLabel={`${formatDateShort(a.at)}${a.groupName ? ` · ${a.groupName} 공유` : ''}`}
      time={timeParts(first.at)}
      kindLabel={`${KIND_LABEL[first.kind]}${passed ? ' · 지남' : ''}`}
      chain={list.map((x) => chainLabel(x, current, formatTime(x.at)))}
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
  if (!highlight) return card;
  // 카드 바깥에 테두리만 겹침 — 카드 크기 · 아래 간격은 그대로
  return (
    <View>
      {card}
      <View pointerEvents="none" style={styles.highlight} />
    </View>
  );
}

const styles = StyleSheet.create({
  highlight: {
    position: 'absolute',
    top: -3,
    left: -3,
    right: -3,
    bottom: space.cardBelow - 3,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: radius.card + 3,
  },
});
