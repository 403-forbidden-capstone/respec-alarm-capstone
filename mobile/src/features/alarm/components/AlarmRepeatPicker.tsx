import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { useAccent } from '@/lib/skyTone';
import { WEEKDAYS, type Weekday } from '@/lib/weekday';
import { colors, radius } from '@/theme';

import { sortDays, toggleWeekday } from '../repeat';

export function AlarmRepeatPicker({ value, onChange }: { value: readonly Weekday[]; onChange: (days: Weekday[]) => void }) {
  const accent = useAccent();
  const summary = value.length ? `매주 ${sortDays(value).join(' · ')}` : '한 번만';
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text variant="bodyStrong">반복</Text>
        <Text variant="small" tone="sub" accessibilityLiveRegion="polite">{summary}</Text>
      </View>
      <View style={styles.days}>
        {WEEKDAYS.map((day) => {
          const checked = value.includes(day);
          return (
            <Pressable key={day} onPress={() => onChange(toggleWeekday(value, day))}
              accessibilityRole="checkbox" accessibilityLabel={day + '요일'} accessibilityState={{ checked }} style={styles.touch}>
              <View style={[styles.circle, checked && { backgroundColor: accent }]}>
                <Text variant="body" tone={checked ? 'inverse' : 'sub'} weight={checked ? 600 : 400}>{day}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.bg, borderRadius: radius.card, paddingHorizontal: 10, paddingTop: 14, paddingBottom: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  days: { flexDirection: 'row', alignItems: 'center' },
  touch: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  circle: { width: '94%', maxWidth: 38, aspectRatio: 1, borderRadius: radius.pill, backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
});
