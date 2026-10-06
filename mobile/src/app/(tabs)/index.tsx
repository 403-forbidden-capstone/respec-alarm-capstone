import { Screen, Text, TopBar } from '@/components/ui';

// 01 홈 탭 — 목업 H01(홈)이 들어올 자리 (#30)
export default function HomeScreen() {
  return (
    <Screen>
      <TopBar screenId="H01" />
      <Text variant="title">홈</Text>
      <Text variant="lead">다음 알람 · 오늘 일정 · 루틴이 들어올 자리예요.</Text>
    </Screen>
  );
}
