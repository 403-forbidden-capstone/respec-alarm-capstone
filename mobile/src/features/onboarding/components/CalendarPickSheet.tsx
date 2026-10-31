import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, Sheet, Text } from '@/components/ui';
import { colors } from '@/theme';

import type { CalendarChoice } from '../calendar';

type Props = {
  visible: boolean;
  calendars: readonly CalendarChoice[];
  picked: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
};

// 가져올 캘린더 고르기 시트 — 여러 개 켜고 끌 수 있음 (처음엔 모두 켜짐). 값 · 콜백만 받음
export function CalendarPickSheet({ visible, calendars, picked, onToggle, onConfirm, onClose, busy }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title="캘린더 고르기">
      <Text variant="small" tone="sub" style={styles.lead}>
        앞으로 2주 동안 매주 반복되는 일정을 수업 후보로 찾아요
      </Text>
      <View style={styles.list}>
        {calendars.map((c) => {
          const on = picked.has(c.id);
          return (
            <Pressable
              key={c.id}
              onPress={() => onToggle(c.id)}
              accessibilityRole="checkbox"
              accessibilityLabel={c.title}
              accessibilityState={{ checked: on }}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Card style={[styles.card, on && styles.on]}>
                <View style={styles.row}>
                  <View style={styles.text}>
                    <Text variant="bodyStrong">{c.title}</Text>
                    {c.source ? (
                      <Text variant="small" tone="sub">
                        {c.source}
                      </Text>
                    ) : null}
                  </View>
                  <Text variant="bodyStrong" accessibilityElementsHidden importantForAccessibility="no">
                    {on ? '✓' : ''}
                  </Text>
                </View>
              </Card>
            </Pressable>
          );
        })}
      </View>
      <Button label={picked.size ? `${picked.size}개 캘린더에서 가져오기` : '가져오기'} onPress={onConfirm} disabled={busy || picked.size === 0} loading={busy} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  lead: { marginBottom: 12 },
  list: { gap: 8, marginBottom: 16 },
  card: { borderColor: colors.line },
  on: { borderColor: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44 },
  text: { flex: 1 },
  pressed: { opacity: 0.6 },
});
