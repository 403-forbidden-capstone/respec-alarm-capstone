import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Card, LoadError, Loading, Screen, Text, TopBar } from '@/components/ui';
import { useDetectionFix, type FixPhase } from '@/features/location/hooks/useDetectionFix';
import { parseDetectionParams } from '@/features/location/link';
import { formatTime } from '@/lib/format';
import { backOrHome } from '@/lib/nav';

const KIND_LABEL = { DEPART: '출발', ARRIVE: '도착' } as const;
// 지운 뒤 안내 — 출발은 다음 이탈, 도착은 다시 들어갈 때 자동으로 채워짐
const AFTER_ERASE = { DEPART: '다음에 위치가 다시 잡히면 그 시각으로 기록해요.', ARRIVE: '목적지에 다시 들어가면 그때 시각으로 기록해요.' } as const;

// 감지 안내 알림("출발 오전 8:30 감지")을 눌러 열리는 1탭 정정 화면 — 목업에 없는 화면 (docs/screen-data-map.md "NTF 감지 안내")
//   주소: /detection?kind=DEPART&participantId=…&at=<ms> — 열자마자 위치로 잡은 그 값을 지우고, 5초 안에는 되돌릴 수 있음
//   원탭으로 바뀐 값이나 이미 지운 기록은 건드리지 않음 (api.ts rejectDetection이 null)
export default function DetectionScreen() {
  const link = parseDetectionParams(useLocalSearchParams());
  const { phase, busy, undo, retry } = useDetectionFix(link);

  return (
    <Screen>
      <TopBar onBack={backOrHome} screenId="NTF" />
      <Text variant="title" style={styles.title}>
        자동 기록 정정
      </Text>
      {link ? (
        <Body phase={phase} busy={busy} onUndo={() => void undo()} onRetry={retry} />
      ) : (
        <Card variant="dash">
          <Text variant="body" tone="sub">
            열 수 없는 안내예요. 알림을 다시 확인해 주세요.
          </Text>
        </Card>
      )}
      <View style={styles.close}>
        <Button variant="ghost" label="닫기" onPress={backOrHome} />
      </View>
    </Screen>
  );
}

function Body({ phase, busy, onUndo, onRetry }: { phase: FixPhase; busy: boolean; onUndo: () => void; onRetry: () => void }) {
  if (phase.name === 'working') return <Loading text="기록을 정정하는 중" />;
  if (phase.name === 'failed') return <LoadError message={phase.message} onRetry={onRetry} />;
  if (phase.name === 'gone') {
    return (
      <Card>
        <Text variant="body" weight={600}>
          이미 바뀐 기록이에요
        </Text>
        <Text variant="small" style={styles.sub}>
          직접 누른 시각이거나 이미 지운 기록은 여기서 고치지 않아요.
        </Text>
      </Card>
    );
  }
  if (phase.name === 'undone') {
    return (
      <Card>
        <Text variant="body" weight={600}>
          {KIND_LABEL[phase.kind]} {formatTime(phase.at)} 기록을 되돌렸어요
        </Text>
      </Card>
    );
  }
  return (
    <>
      <Card>
        <Text variant="body" weight={600} accessibilityLiveRegion="polite">
          {KIND_LABEL[phase.kind]} {formatTime(phase.at)} 기록을 지웠어요
        </Text>
        <Text variant="small" style={styles.sub}>
          {AFTER_ERASE[phase.kind]}
        </Text>
      </Card>
      {phase.undoable ? (
        <View style={styles.undo}>
          <Button variant="primary" label={`되돌리기 (${phase.secondsLeft}초)`} loading={busy} onPress={onUndo} />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 12 },
  sub: { marginTop: 4 },
  undo: { marginTop: 12 },
  close: { marginTop: 12 },
});
