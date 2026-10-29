import { StyleSheet, View } from 'react-native';

import { Button } from './Button';
import { Card } from './Card';
import { Text } from './Text';

// 데이터를 못 읽었을 때 (useLoad의 error) — 머리만 보이는 빈 화면 대신 이유 + 다시 시도
// message: 이유를 따로 보일 때 (예: 장소 검색 키 없음 · 잠시 안 됨). 없으면 기본 문구
export function LoadError({ onRetry, message }: { onRetry: () => void; message?: string }) {
  return (
    <Card variant="dash">
      <Text variant="body" tone="sub" accessibilityLiveRegion="polite">
        {message ?? '불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.'}
      </Text>
      <View style={styles.button}>
        <Button small variant="ghost" label="다시 시도" onPress={onRetry} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  button: { marginTop: 10, alignSelf: 'flex-start' },
});
