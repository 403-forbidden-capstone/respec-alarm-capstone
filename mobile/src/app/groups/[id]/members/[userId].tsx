import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Card, EmptyState, LoadError, Loading, Screen, Text, Timeline, toast, TopBar } from '@/components/ui';
import { getMemberWake, sendWakePing } from '@/features/social/api';
import { useWakeLoad } from '@/features/social/hooks/useGroupWake';
import { MemberAlarmCard } from '@/features/social/components/MemberAlarmCard';
import { formatTime } from '@/lib/format';
import { useAction } from '@/lib/useAction';
import { backOrHome } from '@/lib/nav';

// G03 그룹원 기상 상태 — 오늘 기상 알람 · 지금까지 일어난 일(시나리오 시각까지) · 깨우기 알림
// 이 그룹 구성원이고 나에게 기상 상태 조회 권한을 줬을 때만 보임 (api가 아니면 null). 권한은 있는데 오늘 알람이 없으면 그렇게 알림
export default function MemberWakeScreen() {
  const { id, userId } = useLocalSearchParams<{ id: string; userId: string }>();
  const { data, error, reload } = useWakeLoad((date) => getMemberWake(id, userId, date), () => [id]); // 그룹 기상 신호가 오면 다시 읽음
  const { run } = useAction();

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="G03" />
        {error ? <LoadError onRetry={reload} /> : <Loading />}
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="G03" />
        <EmptyState title="기상 상태를 볼 수 없어요" body="상대가 기상 상태 공유를 허용한 같은 그룹 멤버만 볼 수 있어요." />
      </Screen>
    );
  }

  const { person: p, groupName, alarm, timeline, firstAlarmAt, noGroupAppointment } = data;

  const ping = () =>
    run(async () => {
      await sendWakePing(p.id);
      toast(`${p.short}님에게 깨우기 알림을 보냈어요`);
    });

  return (
    <Screen>
      <TopBar onBack={backOrHome} screenId="G03" />
      <Text variant="title" style={styles.title}>
        {p.short}님의 기상 상태
      </Text>
      {/* 부제 자리에 기록의 뜻을 한 줄로 (피그마 P04) — 카드 사이에 따로 두지 않음 */}
      <Text variant="lead" style={styles.lead}>
        알람 해제가 아니라 본인이 확인한 기상 기록이에요.
      </Text>
      {alarm ? (
        <>
          <MemberAlarmCard alarm={alarm} />

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
                {`아직 알람이 울리지 않았어요.${firstAlarmAt ? ` ${p.short}님의 알람은 ${formatTime(firstAlarmAt)}이에요.` : ''}`}
              </Text>
            )}
          </Card>
        </>
      ) : noGroupAppointment ? (
        // 그 그룹의 약속이 있는 날에만 기상 상태를 줌 (D57) — 알람이 없는 것과 다름
        <EmptyState title="오늘은 그룹 약속이 없어요" body={`'${groupName}' 그룹의 약속이 있는 날에만 ${p.short}님의 기상 상태를 볼 수 있어요.`} />
      ) : (
        <EmptyState title="오늘은 알람이 없어요" body={`${p.short}님이 오늘 맞춰 둔 기상 알람이 없어요.`} />
      )}

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
        <Button label="깨우기" variant="ghost" onPress={ping} />
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
