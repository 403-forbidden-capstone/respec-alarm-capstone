import { StyleSheet, View } from 'react-native';

import { AlarmCard, TopBarButton } from '@/components/ui';
import { formatDateShort, formatTime, timeParts } from '@/lib/format';

import type { MemberAlarm } from '../types';

type Props = {
  alarm: MemberAlarm;
  onToggle?: (next: boolean) => void; // 설정 권한이 있을 때만 — 켜기 · 끄기 스위치
  onShift?: (minutes: number) => void; // 설정 권한이 있을 때만 — 5분 앞당기기 · 늦추기
};

const SHIFT_MINUTES = 5;

// 친구 · 그룹원이 공유한 알람 카드 (목업 memberAlarmCard) — 그룹원 기상 상태(G03) · 공유받은 알람(G04)
export function MemberAlarmCard({ alarm, onToggle, onShift }: Props) {
  const first = alarm.chain[0];
  return (
    <AlarmCard
      dateLabel={formatDateShort(alarm.date)}
      time={timeParts(first.at)}
      kindLabel={first.label}
      chain={alarm.chain.map((x) => `${formatTime(x.at)} ${x.label}`)}
      meta={[`알람 강도 · ${alarm.levelName}`, alarm.note]}
      foot={alarm.appointmentLabel}
      enabled={alarm.enabled}
      onToggle={onToggle}
      toggleLabel="공유 알람 켜기"
    >
      {onShift ? (
        <View style={styles.shift}>
          <TopBarButton label={`${SHIFT_MINUTES}분 앞당기기`} onPress={() => onShift(-SHIFT_MINUTES)} />
          <TopBarButton label={`${SHIFT_MINUTES}분 늦추기`} onPress={() => onShift(SHIFT_MINUTES)} />
        </View>
      ) : null}
    </AlarmCard>
  );
}

const styles = StyleSheet.create({
  shift: { flexDirection: 'row', gap: 8, marginTop: 12 },
});
