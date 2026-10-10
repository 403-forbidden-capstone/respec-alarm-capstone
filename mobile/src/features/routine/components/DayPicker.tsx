import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors } from '@/theme';

import { WEEKDAYS, type Weekday } from '../types';

// 반복 요일 (.days) — 월~일 동그라미, 고른 요일은 검게
export function DayPicker({ value, onToggle }: { value: Weekday[]; onToggle: (day: Weekday) => void }) {
  return (
    <View style={styles.row} accessibilityLabel="반복 요일">
      {WEEKDAYS.map((day) => {
        const on = value.includes(day);
        return (
          <Pressable
            key={day}
            onPress={() => onToggle(day)}
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

const DAY = 38;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  day: { width: DAY, height: DAY, borderRadius: DAY / 2, backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
  on: { backgroundColor: colors.ink },
});
