import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { timeParts } from '@/lib/format';
import { colors } from '@/theme';

import { IMPORTANCE_LABEL, type ScheduleItem } from '../types';

// 하루 일정 줄 (.srow) — 알람 있는 일정은 진한 막대 · 누르면 알람 설정, 알람 없는 일정은 흐린 막대 · 누를 수 없음 (일정 수정 · 삭제 입구는 D41이 정함)
export function ScheduleList({ items }: { items: ScheduleItem[] }) {
  if (!items.length) {
    return (
      <Text variant="note" tone="sub" style={styles.empty}>
        일정이 없어요. 일정을 추가하면 알람을 계산해 드려요.
      </Text>
    );
  }
  return (
    <View>
      {items.map((item, i) => {
        const t = timeParts(item.at);
        const inner = (
          <>
            <View style={styles.time}>
              <Text variant="tiny" tone="sub">
                {t.ampm}
              </Text>
              <Text variant="bodyLarge" weight={700} style={styles.hm}>
                {t.hm}
              </Text>
            </View>
            <View style={[styles.bar, !item.hasAlarm && styles.barPlain]} />
            <View style={styles.text}>
              <Text variant="listTitle">
                {item.title}
              </Text>
              <Text variant="label" tone="sub">
                {item.hasAlarm ? `${item.place} · ${IMPORTANCE_LABEL[item.importance]}` : `${item.place} · 알람 없는 일정`}
              </Text>
            </View>
          </>
        );
        const style = [styles.row, i > 0 && styles.divider];
        const id = item.appointmentId;
        return item.hasAlarm ? (
          <Pressable
            key={`${id}-${i}`}
            onPress={() => router.push({ pathname: '/alarm/[id]', params: { id } })}
            accessibilityRole="button"
            style={({ pressed }) => [style, pressed && styles.pressed]}
          >
            {inner}
          </Pressable>
        ) : (
          <View key={`plain-${id}-${i}`} style={style}>
            {inner}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.7 },
  time: { width: 50 },
  hm: { fontVariant: ['tabular-nums'] },
  bar: { width: 2, height: 30, backgroundColor: colors.ink },
  barPlain: { backgroundColor: colors.line },
  text: { flex: 1 },
  empty: { marginVertical: 6 },
});
