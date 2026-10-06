import { Screen, Text, TopBar } from '@/components/ui';

// 03 AI 탭 — 목업 A02(AI 대화)가 들어올 자리 (#39)
export default function AiScreen() {
  return (
    <Screen>
      <TopBar screenId="A02" />
      <Text variant="title">AI 대화</Text>
      <Text variant="lead">자기 전 · 기상 후 대화가 들어올 자리예요.</Text>
    </Screen>
  );
}
