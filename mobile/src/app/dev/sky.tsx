import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Screen, SectionHeader, Segmented, Text, TopBar, TopBarButton } from '@/components/ui';
import { SkyBackdrop } from '@/features/sky/components/SkyBackdrop';
import { setSkyPreview } from '@/features/sky/preview';
import { SKY_KINDS, SKY_PHASES, skyTop, type SkyKind, type SkyPhase } from '@/features/sky/sky';

// 개발용 하늘 배경 견본 — 탭에는 없고 주소로만 들어옴: /dev/sky (앱은 respecalarm://dev/sky)
// 홈 위쪽과 같은 배치(날짜 · 설정 버튼 · 인사말 · 카드)에 날씨 × 시간대를 골라 가며 봄. 주소로도 고름: /dev/sky?kind=snow&phase=night
// 고른 하늘은 탭 화면 네 곳 모두에 입혀짐. 주소에 home=1이면 바로 엶 — to=alarms · group · ai로 그 탭을 엶 (캡처용)
const KIND_LABEL: Record<SkyKind, string> = { clear: '맑음', cloudy: '흐림', rain: '비', snow: '눈' };
const TAB_PATH = { home: '/', alarms: '/alarms', group: '/group', ai: '/ai' } as const;
const PHASE_LABEL: Record<SkyPhase, string> = { dawn: '새벽', morning: '아침', day: '낮', dusk: '해 질 녘', night: '밤' };

export default function SkySampleScreen() {
  const params = useLocalSearchParams<{ kind?: string; phase?: string; home?: string; to?: string }>();
  const [kind, setKind] = useState<SkyKind>(SKY_KINDS.find((k) => k === params.kind) ?? 'clear');
  const [phase, setPhase] = useState<SkyPhase>(SKY_PHASES.find((p) => p === params.phase) ?? 'day');

  function openHome() {
    setSkyPreview({ kind, phase });
    router.replace(TAB_PATH[params.to as keyof typeof TAB_PATH] ?? '/');
  }
  const direct = params.home === '1';
  useEffect(() => {
    if (direct) openHome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direct]);

  return (
    <Screen backdrop={<SkyBackdrop kind={kind} phase={phase} />}>
      <TopBar
        left={
          <Text variant="small" tone="ink">
            5월 22일 목요일
          </Text>
        }
        right={<TopBarButton label="설정" glass onPress={router.canGoBack() ? router.back : undefined} />}
      />
      <Text variant="title" style={styles.title}>
        좋은 아침이에요
      </Text>
      <SectionHeader title="날씨" right={skyTop(kind, phase)} />
      <Segmented options={SKY_KINDS.map((k) => [k, KIND_LABEL[k]] as const)} value={kind} onChange={setKind} />
      <SectionHeader title="시간대" />
      <Segmented options={SKY_PHASES.map((p) => [p, PHASE_LABEL[p]] as const)} value={phase} onChange={setPhase} />
      <View style={styles.buttons}>
        <Button label="이 하늘로 홈 보기" onPress={openHome} />
        <Button label="탭을 실제 날씨로 되돌리기" variant="ghost" onPress={() => setSkyPreview(null)} />
      </View>
      <Card style={styles.card}>
        <Text variant="body">카드는 불투명한 흰색 그대로 — 위로 스크롤하면 하늘 위를 지나감</Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  card: { marginTop: 16 },
  buttons: { marginTop: 16, gap: 10 },
});
