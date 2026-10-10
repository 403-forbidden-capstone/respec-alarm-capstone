import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Sheet, Stepper, Text } from '@/components/ui';
import { addMinutes, formatTime, minuteOfDay, startOfDay } from '@/lib/format';
import { colors } from '@/theme';

type Props = {
  label: string;
  value: Date; // 고른 날짜의 그 시각
  onChange: (next: Date) => void; // 날짜는 그대로, 시 · 분만 바뀜
  first?: boolean; // 묶음의 첫 줄이면 위 구분선을 뺌
};

// 시간 고르는 줄 (목업의 input type="time") — 누르면 아래 시트에서 시 · 분을 올리고 내림
// 24시간, 분은 5분 단위. 직접 적지 않아서 25:99 같은 틀린 값이 들어올 수 없음
export function TimeRow({ label, value, onChange, first }: Props) {
  const [open, setOpen] = useState(false);
  const minutes = minuteOfDay(value);
  const hour = Math.floor(minutes / 60);
  const minute = Math.floor((minutes % 60) / 5) * 5; // 5분 단위가 아닌 값(대화에서 찾은 14:07 등)은 시트에서 5분 단위로 내려 고름
  const text = formatTime(value);
  const set = (h: number, m: number) => onChange(addMinutes(startOfDay(value), h * 60 + m));

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label} ${text}`}
        style={({ pressed }) => [styles.row, !first && styles.divider, pressed && styles.pressed]}
      >
        <Text variant="rowLabel" tone="sub">
          {label}
        </Text>
        <Text variant="bodyStrong">{text}</Text>
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title={label}>
        <Text variant="stat" align="center" style={styles.preview}>
          {text}
        </Text>
        <Stepper first label="시" value={hour} step={1} min={0} max={23} unit="시" onChange={(h) => set(h, minute)} />
        <Stepper label="분" value={minute} step={5} min={0} max={55} unit="분" onChange={(m) => set(hour, m)} />
        <View style={styles.done}>
          <Button label="확인" onPress={() => setOpen(false)} />
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 14 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  preview: { marginTop: 10, marginBottom: 14 },
  done: { marginTop: 16 },
});
