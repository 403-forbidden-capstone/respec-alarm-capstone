import { Screen, Text, TopBar } from '@/components/ui';

// 02 그룹 탭 — 목업 G01(친구와 그룹)이 들어올 자리 (#43)
export default function GroupScreen() {
  return (
    <Screen>
      <TopBar screenId="G01" />
      <Text variant="title">친구와 그룹</Text>
      <Text variant="lead">친구 · 그룹 · 공유 권한이 들어올 자리예요.</Text>
    </Screen>
  );
}
