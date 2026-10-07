import { router } from 'expo-router';

import { Screen, Text, TopBar } from '@/components/ui';

// H03 알람 설정 — 목업 화면이 들어올 자리 (#30)
export default function AlarmDetailScreen() {
  return (
    <Screen>
      <TopBar screenId="H03" onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">알람 설정</Text>
      <Text variant="lead">목업 H03 화면이 들어올 자리예요.</Text>
    </Screen>
  );
}
