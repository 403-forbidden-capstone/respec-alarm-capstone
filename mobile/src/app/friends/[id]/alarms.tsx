import { router } from 'expo-router';

import { Screen, Text, TopBar } from '@/components/ui';

// G04 공유받은 알람 — 목업 화면이 들어올 자리 (#43)
export default function SharedAlarmsScreen() {
  return (
    <Screen>
      <TopBar screenId="G04" onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">공유받은 알람</Text>
      <Text variant="lead">목업 G04 화면이 들어올 자리예요.</Text>
    </Screen>
  );
}
