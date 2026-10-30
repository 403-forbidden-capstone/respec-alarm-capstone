import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';

type Props = {
  text: string; // bannerSummary가 만든 한 줄
  onPress: () => void; // 점검표(L04) 열기
};

// 홈 인사 아래 빨간 줄 — 알람이 안 울릴 수 있는 이유가 있을 때만. 누르면 "알람이 안 울릴 때" 점검표로
export function PermissionBanner({ text, onPress }: Props) {
  return (
    <Card onPress={onPress} accessibilityLabel={`${text}, 점검표 열기`}>
      <View style={styles.row}>
        <Text variant="bodyStrong" tone="warn" style={styles.text}>
          {text}
        </Text>
        <Text variant="rowLabel" tone="sub">
          확인 ›
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  text: { flex: 1 },
});
