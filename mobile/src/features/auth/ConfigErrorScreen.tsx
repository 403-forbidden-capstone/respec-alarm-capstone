import { StyleSheet, View } from 'react-native';

import { Screen, Text } from '@/components/ui';

// 설정 오류 — 폰 출시용 빌드(실데이터만 쓰는 빌드)인데 Supabase 값이 안 들어 있을 때 루트 레이아웃이 보여 줌 (lib/modePolicy.ts)
// 이런 빌드는 가짜 데이터로 돌지 않음: 로그인 없이 알람이 쓰이면 안 되고, 값이 빠진 것을 사용자가 모르고 지나가면 안 됨
// 값이 어디서 빠졌는지 알아볼 수 있게 변수 이름은 그대로 보여 줌 (이름만 — 값은 공개 값이라 어차피 앱에 들어감)
export function ConfigErrorScreen() {
  return (
    <Screen scroll={false}>
      <View style={styles.center}>
        <Text variant="title">앱 설정이 빠져 있어요</Text>
        <Text variant="lead">서버 주소가 이 빌드에 들어 있지 않아 시작할 수 없어요. 개발자에게 알려 주세요.</Text>
        <Text variant="caption">EXPO_PUBLIC_SUPABASE_URL · EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', gap: 8 },
});
