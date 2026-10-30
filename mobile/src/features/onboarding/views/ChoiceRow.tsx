import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { colors } from '@/theme';

type Props = {
  label: string;
  sub?: string; // 라벨 아래 작은 설명
  selected: boolean;
  onPress: () => void;
};

// 세로로 쌓아 하나 고르는 줄 — 고른 줄은 테두리가 진해지고 오른쪽에 ✓. 값 · 콜백만 받음
// 글이 긴 선택지(잠귀 3지선다 등)용 — 짧은 선택지는 Segmented
export function ChoiceRow({ label, sub, selected, onPress }: Props) {
  return (
    <Card onPress={onPress} accessibilityLabel={selected ? `${label}, 선택됨` : label} style={[styles.card, selected && styles.selected]}>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text variant="bodyStrong">{label}</Text>
          {sub ? (
            <Text variant="small" style={styles.sub}>
              {sub}
            </Text>
          ) : null}
        </View>
        {selected ? (
          <Text variant="bodyStrong" accessibilityElementsHidden importantForAccessibility="no">
            ✓
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 8 },
  selected: { borderColor: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  text: { flex: 1 },
  sub: { marginTop: 2 },
});
