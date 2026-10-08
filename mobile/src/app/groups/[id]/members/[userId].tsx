import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Card, LoadError, Screen, Text, Timeline, toast, TopBar } from '@/components/ui';
import { getMemberWake, sendWakePing } from '@/features/social/api';
import { MemberAlarmCard } from '@/features/social/components/MemberAlarmCard';
import { Note } from '@/features/social/components/Note';
import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useAction } from '@/lib/useAction';

// G03 그룹원 기상 상태 — 오늘 기상 알람 · 지금까지 일어난 일(시나리오 시각까지) · 깨우기 알림
// 이 그룹 구성원이고 나에게 기상 조회 권한을 줬을 때만 보임 (api가 아니면 null)
export default function MemberWakeScreen() {
  const { id, userId } = useLocalSearchParams<{ id: string; userId: string }>();
  const { data, error, reload } = useLoad(() => getMemberWake(id, userId));
  const { run } = useAction();
  const back = router.canGoBack() ? router.back : undefined;

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={back} screenId="G03" />
        {error ? <LoadError onRetry={reload} /> : null}
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={back} screenId="G03" />
        <Text variant="body" tone="sub">
          기상 상태를 볼 수 없어요.
        </Text>
      </Screen>
    );
  }

  const { person: p, groupName, alarm, timeline, firstAlarmAt } = data;

  const ping = () =>
    run(async () => {
      await sendWakePing(p.id);
      toast(`${p.short}님에게 깨우기 알림을 보냈어요`);
    });

  return (
    <Screen>
      <TopBar onBack={back} screenId="G03" />
      <Text variant="title" style={styles.title}>
        {p.short}의 기상 상태
      </Text>
      <Text variant="lead" style={styles.lead}>
        오늘의 기상 알람
      </Text>
      <MemberAlarmCard alarm={alarm} />
      <Note>알람 해제가 아니라 본인이 확인한 기상 기록이에요.</Note>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          오늘의 흐름
        </Text>
        {timeline.length ? (
          <Timeline
            highlightLast
            items={timeline.map((e) => ({ time: formatTime(e.at), label: e.label, source: e.source }))}
          />
        ) : (
          <Text variant="note" tone="sub" style={styles.empty}>
            아직 알람이 울리지 않았어요. {p.short}님의 알람은 {formatTime(firstAlarmAt)}이에요.
          </Text>
        )}
      </Card>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          공유 범위
        </Text>
        <Text variant="bodyStrong">기상 확인 여부와 시각</Text>
        <Text variant="small" tone="sub" style={styles.paragraph}>
          {`${p.short}님이 '${groupName}' 그룹에 허용한 범위만 표시해요. 수면 시간이나 알람 메모는 공유되지 않아요.`}
        </Text>
      </Card>

      <View style={styles.stack}>
        <Button label={`${p.short}에게 알람 보내기`} variant="ghost" onPress={ping} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  label: { marginBottom: 8 },
  empty: { marginVertical: 6 },
  paragraph: { marginTop: 4, lineHeight: 20 },
  stack: { gap: 10, marginTop: 16 },
});
