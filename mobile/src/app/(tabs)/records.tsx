import { Screen, Text, TopBar } from '@/components/ui';

// 04 기록 탭 — 목업 R02(나의 기록)가 들어올 자리 (#38). 일정 추가 · 상세는 src/app/schedule/
export default function RecordsScreen() {
  return (
    <Screen>
      <TopBar screenId="R02" />
      <Text variant="title">나의 기록</Text>
      <Text variant="lead">월간 · 주간 · 일간 기록이 들어올 자리예요.</Text>
    </Screen>
  );
}
