import { Pressable, StyleSheet, View } from 'react-native';

import { Sheet, Text } from '@/components/ui';
import { colors } from '@/theme';

import type { EditScope } from '../types';

type Props = {
  visible: boolean;
  onClose: () => void;
  title: string; // 무엇을 하는지에 따라 부르는 쪽이 정함 (예: 어느 일정을 바꿀까요? / 어느 일정을 지울까요?)
  onPick: (scope: EditScope) => void; // 시트를 닫는 것은 부르는 쪽
};

const OPTIONS: readonly { scope: EditScope; label: string; sub: string }[] = [
  { scope: 'this', label: '이번만', sub: '이 날짜 하나만' },
  { scope: 'following', label: '이후 모두', sub: '이 날짜부터 이후 모두' },
];

// 반복 범위 고르기 (U15) — 반복 일정을 고치거나 지울 때 "이번만 · 이후 모두". 진한 버튼 없이 줄 두 개, 고르면 바로 넘어감
export function RepeatScopeSheet({ visible, onClose, title, onPick }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <View style={styles.list}>
        {OPTIONS.map(({ scope, label, sub }, i) => (
          <Pressable
            key={scope}
            onPress={() => onPick(scope)}
            accessibilityRole="button"
            accessibilityLabel={`${label}, ${sub}`}
            style={({ pressed }) => [styles.row, i > 0 && styles.divider, pressed && styles.pressed]}
          >
            <Text variant="bodyStrong">{label}</Text>
            <Text variant="label" tone="sub" style={styles.sub}>
              {sub}
            </Text>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 4 },
  row: { minHeight: 56, paddingVertical: 12, justifyContent: 'center' },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  sub: { marginTop: 2 },
});
