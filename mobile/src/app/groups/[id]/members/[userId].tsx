import { router } from 'expo-router';

import { Screen, Text, TopBar } from '@/components/ui';

// G03 그룹원 기상 상태 — 목업 화면이 들어올 자리 (#43)
export default function MemberWakeScreen() {
  return (
    <Screen>
      <TopBar screenId="G03" onBack={router.canGoBack() ? router.back : undefined} />
      <Text variant="title">그룹원 기상 상태</Text>
      <Text variant="lead">목업 G03 화면이 들어올 자리예요.</Text>
    </Screen>
  );
}
