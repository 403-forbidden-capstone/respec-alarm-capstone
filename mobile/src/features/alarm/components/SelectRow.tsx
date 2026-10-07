import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { Chip, Sheet, Text } from '@/components/ui';
import { colors } from '@/theme';

type Props<T extends string> = {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[]; // [값, 보이는 글자]
  onChange: (next: T) => void;
  first?: boolean; // 묶음의 첫 줄이면 위 구분선을 뺌
};

// 고르는 칸 한 줄 (목업의 select) — 누르면 아래 시트에서 고름
export function SelectRow<T extends string>({ label, value, options, onChange, first }: Props<T>) {
  const [open, setOpen] = useState(false);
  const current = options.find(([v]) => v === value)?.[1] ?? '';

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label} ${current}`}
        style={({ pressed }) => [styles.row, !first && styles.divider, pressed && styles.pressed]}
      >
        <Text variant="body" tone="sub" style={styles.label}>
          {label}
        </Text>
        <Text variant="bodyStrong">{current}</Text>
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title={label}>
        {options.map(([v, text], i) => (
          <Pressable
            key={v}
            onPress={() => {
              onChange(v);
              setOpen(false);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: v === value }}
            style={[styles.option, i > 0 && styles.divider]}
          >
            <Text variant="body" weight={v === value ? 600 : 400}>
              {text}
            </Text>
            {v === value ? <Chip label="선택됨" variant="ink" /> : null}
          </Pressable>
        ))}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 14 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  label: { fontSize: 13.5 },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, minHeight: 52 },
});
