import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Sheet, Text } from '@/components/ui';
import { formatTime } from '@/lib/format';
import { colors } from '@/theme';

import { TimePicker } from './TimePicker';

type Props = {
  label: string;
  value: Date; // 고른 날짜의 그 시각
  onChange: (next: Date) => void; // 날짜는 그대로, 시 · 분만 바뀜
  first?: boolean; // 묶음의 첫 줄이면 위 구분선을 뺌
  error?: string; // 줄 바로 아래에 붉게 (예: 이미 지난 시각이에요)
};

// 시간 고르는 줄 (목업의 input type="time") — 누르면 아래 시트에서 시 · 분을 올리고 내림 (시트 본문은 TimePicker)
export function TimeRow({ label, value, onChange, first, error }: Props) {
  const [open, setOpen] = useState(false);
  const text = formatTime(value);

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
        <TimePicker value={value} onChange={onChange} error={error} />
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
  done: { marginTop: 16 },
});
