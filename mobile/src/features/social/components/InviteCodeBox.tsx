import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors } from '@/theme';

// 초대 코드를 크게 (G02 초대 시트 · 그룹 만들기 결과) — 길게 눌러 복사할 수 있게 selectable
export function InviteCodeBox({ code }: { code: string }) {
  return (
    <View style={styles.box}>
      <Text variant="stat" selectable accessibilityLabel={`초대 코드 ${code}`}>
        {code}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    marginVertical: 16,
    paddingVertical: 18,
    borderRadius: 16,
    backgroundColor: colors.chip,
  },
});
