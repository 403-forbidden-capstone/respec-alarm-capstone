import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Chip, LoadError, Loading, Screen, Sheet, Text, Timeline, toast, TopBar } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { getShareLog, getSharedAlarms, setSharedAlarmEnabled, shiftSharedAlarm } from '@/features/social/api';
import { MemberAlarmCard } from '@/features/social/components/MemberAlarmCard';
import { Note } from '@/features/social/components/Note';
import type { ShareLogItem } from '@/features/social/types';
import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';
import { useAction } from '@/lib/useAction';
import { backOrHome } from '@/lib/nav';

// G04 공유받은 알람 — 친구 · 그룹원이 공유한 알람을 봄. 설정 권한이 있으면 켜기 · 끄기 · 5분 옮기기
// 바꾸면 주인에게 알림(실데이터는 notify Edge Function, 알림이 안 가도 저장은 됨), 변경 기록은 이번 실행 동안만 남음 (docs/decisions.md D9 · D20)
export default function SharedAlarmsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload } = useLoad(() => getSharedAlarms(id));
  const { run } = useAction();
  const [log, setLog] = useState<ShareLogItem[] | null>(null);

  async function openLog() {
    setLog(await getShareLog());
  }

  const top = <TopBar onBack={backOrHome} screenId="G04" right={<TextLink label="변경 기록" onPress={openLog} />} />;
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

  if (data === undefined) return <Screen>{top}{error ? <LoadError onRetry={reload} /> : <Loading />}</Screen>;
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

  // 연타해도 한 번씩 — 실데이터에선 "5분 앞당기기"를 두 번 누르면 두 번 옮겨질 수 있음
  const toggle = (alarmId: string, next: boolean) =>
    run(async () => {
      const { notified } = await setSharedAlarmEnabled(p.id, alarmId, next);
      toast(changedMessage(p.short, notified));
      await reload();
    });

  const shift = (alarmId: string, minutes: number) =>
    run(async () => {
      const { notified } = await shiftSharedAlarm(p.id, alarmId, minutes);
      toast(changedMessage(p.short, notified));
      await reload();
    });

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

      {canView && !alarms.length ? (
        <Text variant="body" tone="sub">
          공유된 알람이 없어요.
        </Text>
      ) : null}
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
          {canEdit ? `변경하면 ${p.short}님에게 알림이 전송돼요.` : '알람 설정 권한이 없어 볼 수만 있어요.'}
        </Note>
      ) : null}

      {logSheet}
    </Screen>
  );
}

// 알림이 안 간 경우(상대가 알림을 받을 수 없는 상태 등)에도 알람은 바뀐 것 — 실패처럼 보이지 않게 조용히
const changedMessage = (name: string, notified: boolean) => (notified ? `${name}님에게 변경 알림을 보냈어요` : `${name}님의 알람을 바꿨어요`);

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  summary: { backgroundColor: colors.chip },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  empty: { marginVertical: 6 },
  stack: { gap: 10, marginTop: 16 },
});
