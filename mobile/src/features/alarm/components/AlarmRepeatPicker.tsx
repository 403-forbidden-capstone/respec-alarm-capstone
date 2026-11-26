import { Pressable, StyleSheet, View } from 'react-native';

import { Segmented, Text } from '@/components/ui';
import { useAccent } from '@/lib/skyTone';
import { WEEKDAYS, type Weekday } from '@/lib/weekday';
import { colors, radius } from '@/theme';

import { EVERY_DAY, repeatLabel, sameDays, toggleWeekday, WEEKDAYS_ONLY } from '../repeat';

const WEEKEND: readonly Weekday[] = ['토', '일'];
const PRESETS = [['once', '한 번'], ['weekdays', '평일'], ['weekend', '주말'], ['daily', '매일']] as const;
type Preset = (typeof PRESETS)[number][0] | 'custom';
const DAYS: Record<Exclude<Preset, 'custom'>, readonly Weekday[]> = {
  once: [], weekdays: WEEKDAYS_ONLY, weekend: WEEKEND, daily: EVERY_DAY,
};

export function AlarmRepeatPicker({ value, onChange }: { value: readonly Weekday[]; onChange: (days: Weekday[]) => void }) {
  const accent = useAccent();
  const preset: Preset = PRESETS.find(([key]) => sameDays(value, DAYS[key]))?.[0] ?? 'custom';
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text variant="bodyStrong">반복</Text>
        <Text variant="small" tone="sub" accessibilityLiveRegion="polite">{preset === 'weekend' ? '주말' : repeatLabel(value)}</Text>
      </View>
      <Segmented<Preset> options={PRESETS} value={preset} onChange={(key) => { if (key !== 'custom') onChange([...DAYS[key]]); }} />
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
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  days: { flexDirection: 'row', alignItems: 'center' },
  touch: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  circle: { width: '94%', maxWidth: 38, aspectRatio: 1, borderRadius: radius.pill, backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
});
