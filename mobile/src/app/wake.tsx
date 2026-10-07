import { router } from 'expo-router';

import { Screen, Text, TopBar } from '@/components/ui';

// H08 기상 확인 — 목업 화면이 들어올 자리 (#30)
export default function WakeScreen() {
  return (
    <Screen>
      <TopBar screenId="H08" onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">기상 확인</Text>
      <Text variant="lead">목업 H08 화면이 들어올 자리예요.</Text>
    </Screen>
  );
}
