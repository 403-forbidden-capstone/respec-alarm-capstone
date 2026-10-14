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
  error?: string; // 줄 바로 아래에 붉게 (예: 이미 지난 시각이에요)
};

// 시간 고르는 줄 (목업의 input type="time") — 누르면 아래 시트에서 시 · 분을 올리고 내림
// 시는 24시간(23 다음 0), 분은 1분 단위(59 다음 0), 둘 다 숫자를 눌러 직접 적을 수 있음 (범위 밖은 범위 안으로 맞춤)
// 시트 맨 위 큰 글자는 줄과 같은 12시간 표기(오후 2:07) — 조절하는 대로 바뀜
export function TimeRow({ label, value, onChange, first, error }: Props) {
  const [open, setOpen] = useState(false);
  const minutes = minuteOfDay(value);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60; // 대화에서 찾은 14:07 같은 값도 그대로
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
        <Text variant="bodyStrong" tone={error ? 'warn' : 'ink'}>
          {text}
        </Text>
      </Pressable>
      {error ? (
        <Text variant="caption" tone="warn" align="right" style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={label}>
        <Text variant="stat" align="center" style={styles.preview} accessibilityLiveRegion="polite">
          {text}
        </Text>
        <Stepper first label="시 (24시간)" value={hour} step={1} min={0} max={23} unit="시" wrap onChange={(h) => set(h, minute)} />
        <Stepper label="분" value={minute} step={1} min={0} max={59} unit="분" wrap onChange={(m) => set(hour, m)} />
        {error ? (
          <Text variant="caption" tone="warn" align="center" style={styles.sheetError}>
            {error}
          </Text>
        ) : null}
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
  error: { marginTop: -6, marginBottom: 8 },
  preview: { marginTop: 10, marginBottom: 14 },
  sheetError: { marginTop: 8 },
  done: { marginTop: 16 },
});
