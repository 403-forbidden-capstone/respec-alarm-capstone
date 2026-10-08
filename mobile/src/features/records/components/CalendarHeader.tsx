import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';

type Props = {
  title: string; // 2025년 5월 · 5월 19일 — 25일
  sub?: string; // 제목 아래 작은 글자 (이번 주)
  unit: '달' | '주'; // 화면 읽기용 — 이전 달 · 다음 주
  onPrev: () => void;
  onNext: () => void;
};

// 달력 맨 위 줄 (.cal-h) — 왼쪽 · 오른쪽 화살표로 앞뒤 달 · 주
export function CalendarHeader({ title, sub, unit, onPrev, onNext }: Props) {
  return (
    <View style={styles.row}>
      <Arrow label="←" a11y={`이전 ${unit}`} onPress={onPrev} />
      <View style={styles.center}>
        <Text variant="big" align="center">
          {title}
        </Text>
        {sub ? (
          <Text variant="small" align="center">
            {sub}
          </Text>
        ) : null}
      </View>
      <Arrow label="→" a11y={`다음 ${unit}`} onPress={onNext} />
    </View>
  );
}

function Arrow({ label, a11y, onPress }: { label: string; a11y: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => [styles.arrow, pressed && styles.pressed]}
    >
      <Text variant="big" tone="sub" weight={400}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  center: { flex: 1 },
  arrow: { width: 36, alignItems: 'center' },
  pressed: { opacity: 0.5 },
});
