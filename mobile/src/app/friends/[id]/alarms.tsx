import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Chip, Screen, Sheet, Text, Timeline, toast, TopBar } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { getShareLog, getSharedAlarms, setSharedAlarmEnabled, shiftSharedAlarm } from '@/features/social/api';
import { MemberAlarmCard } from '@/features/social/components/MemberAlarmCard';
import { Note } from '@/features/social/components/Note';
import type { ShareLogItem } from '@/features/social/types';
import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

// G04 공유받은 알람 — 친구 · 그룹원이 공유한 알람을 봄. 설정 권한이 있으면 켜기 · 끄기 · 5분 옮기기
// 바꾸면 주인에게 알림(실데이터는 notify Edge Function), 변경 기록은 이번 실행 동안만 남음 (docs/decisions.md D9)
export default function SharedAlarmsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, reload } = useLoad(() => getSharedAlarms(id));
  const [log, setLog] = useState<ShareLogItem[] | null>(null);
  const back = router.canGoBack() ? router.back : undefined;

  async function openLog() {
    setLog(await getShareLog());
  }

  const top = <TopBar onBack={back} screenId="G04" right={<TextLink label="변경 기록" onPress={openLog} />} />;
  const logSheet = (
    <Sheet visible={log != null} onClose={() => setLog(null)} title="변경 기록">
      {log?.length ? (
        <Timeline items={log.map((l) => ({ time: formatTime(l.at), label: l.text, source: '나' }))} />
      ) : (
        <Text variant="note" tone="sub" style={styles.empty}>
          아직 바꾼 내용이 없어요.
        </Text>
      )}
      <View style={styles.stack}>
        <Button label="닫기" variant="ghost" onPress={() => setLog(null)} />
      </View>
    </Sheet>
  );

  if (data === undefined) return <Screen>{top}</Screen>;
  if (data === null) {
    return (
      <Screen>
        {top}
        <Text variant="body" tone="sub">
          공유받은 알람이 없어요.
        </Text>
        {logSheet}
      </Screen>
    );
  }

  const { person: p, canView, canEdit, tags, alarms } = data;

  async function toggle(alarmId: string, next: boolean) {
    await setSharedAlarmEnabled(p.id, alarmId, next);
    toast(`${p.short}님에게 변경 알림을 보냈어요`);
    reload();
  }

  async function shift(alarmId: string, minutes: number) {
    await shiftSharedAlarm(p.id, alarmId, minutes);
    toast(`${p.short}님에게 변경 알림을 보냈어요`);
    reload();
  }

  return (
    <Screen>
      {top}
      <Text variant="title" style={styles.title}>
        {p.short}님의 알람
      </Text>
      <Text variant="lead" style={styles.lead}>
        {p.short}님이 공유한 알람을 확인하고 관리해요.
      </Text>

      <Card style={styles.summary}>
        <Text variant="bodyStrong">
          {!canView ? '알람 조회 권한이 없어요' : canEdit ? '조회와 설정 권한이 있어요' : '조회 권한만 있어요'}
        </Text>
        {tags.length ? (
          <View style={styles.chips}>
            {tags.map((tag) => (
              <Chip key={tag} label={tag} />
            ))}
          </View>
        ) : null}
      </Card>

      {alarms.map((a) => (
        <MemberAlarmCard
          key={a.id}
          alarm={a}
          onToggle={canEdit ? (next) => toggle(a.id, next) : undefined}
          onShift={canEdit ? (minutes) => shift(a.id, minutes) : undefined}
        />
      ))}

      {canView ? (
        <Note>
          {canEdit ? `변경하면 ${p.short}님에게 알림이 전송되고 권한 변경 기록에 남아요.` : '알람 설정 권한이 없어 볼 수만 있어요.'}
        </Note>
      ) : null}

      {logSheet}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  summary: { backgroundColor: colors.chip },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  empty: { marginVertical: 6 },
  stack: { gap: 10, marginTop: 16 },
});
