import { router } from 'expo-router';

import { Screen, Text, TopBar } from '@/components/ui';

// H07 알람 울림 — 목업 화면이 들어올 자리 (#30)
export default function RingScreen() {
  return (
    <Screen>
      <TopBar screenId="H07" onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">알람 울림</Text>
      <Text variant="lead">목업 H07 화면이 들어올 자리예요.</Text>
    </Screen>
  );
}
