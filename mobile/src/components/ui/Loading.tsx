import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Text } from './Text';

// 처음 읽어 오는 동안 (useLoad의 data가 아직 없을 때) — 빈 화면 · null 대신 이걸 보임
// <Loading /> · <Loading text="알람을 불러오는 중" />
export function Loading({ text }: { text?: string }) {
  return (
    <View style={styles.wrap} accessibilityRole="progressbar" accessibilityLabel={text ?? '불러오는 중'} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.sub} />
      {text ? (
        <Text variant="small" tone="sub" align="center">
          {text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 48 },
});
