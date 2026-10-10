import { router } from 'expo-router';

import { Screen, Text, TopBar } from '@/components/ui';

// H02 알람 목록 — 목업 화면이 들어올 자리 (#30)
export default function AlarmsScreen() {
  return (
    <Screen>
      <TopBar screenId="H02" onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">알람 목록</Text>
      <Text variant="lead">목업 H02 화면이 들어올 자리예요.</Text>
    </Screen>
  );
}
