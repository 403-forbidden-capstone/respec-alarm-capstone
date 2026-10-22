import { Pressable, StyleSheet, View } from 'react-native';

import { WEEKDAYS, type Weekday } from '@/lib/weekday';
import { colors } from '@/theme';

import { Text } from './Text';

// 반복 요일 (.days) — 월~일 동그라미, 고른 요일은 검게. 루틴 반복(A04) · 일정 반복(H05)이 같이 씀
export function DayPicker({ value, onToggle }: { value: readonly Weekday[]; onToggle: (day: Weekday) => void }) {
  return (
    <View style={styles.row} accessibilityLabel="반복 요일">
      {WEEKDAYS.map((day) => {
        const on = value.includes(day);
        return (
          <Pressable
            key={day}
            onPress={() => onToggle(day)}
            hitSlop={3}
            accessibilityRole="checkbox"
            accessibilityLabel={`${day}요일`}
            accessibilityState={{ checked: on }}
            style={[styles.day, on && styles.on]}
          >
            <Text variant="body" tone={on ? 'inverse' : 'faint'} weight={on ? 600 : 400}>
              {day}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const DAY = 38; // 모양은 38, 누르는 칸은 hitSlop 3을 더해 44

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  day: { width: DAY, height: DAY, borderRadius: DAY / 2, backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
  on: { backgroundColor: colors.ink },
});
