import { router } from 'expo-router';

import { Screen, Text, TopBar } from '@/components/ui';

// G02 그룹 상세 — 목업 화면이 들어올 자리 (#43)
export default function GroupDetailScreen() {
  return (
    <Screen>
      <TopBar screenId="G02" onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">그룹 상세</Text>
      <Text variant="lead">목업 G02 화면이 들어올 자리예요.</Text>
    </Screen>
  );
}
