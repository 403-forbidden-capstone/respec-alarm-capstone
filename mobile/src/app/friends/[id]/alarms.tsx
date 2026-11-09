import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Card, Chip, LoadError, Loading, Screen, Sheet, Text, Timeline, toast, TopBar, TopBarButton } from '@/components/ui';
import { getShareLog, getSharedAlarms, proposeSharedAlarm } from '@/features/social/api';
import { PROPOSE_NOTE, PROPOSE_SENT, PROPOSE_SENT_NO_PUSH } from '@/features/social/proposalTexts';
import { MemberAlarmCard } from '@/features/social/components/MemberAlarmCard';
import { Note } from '@/features/social/components/Note';
import type { ShareLogItem } from '@/features/social/types';
import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';
import { useAction } from '@/lib/useAction';
import { backOrHome } from '@/lib/nav';

// G04 공유받은 알람 — 친구 · 그룹원이 공유한 알람을 봄. 설정 권한이 있으면 시각을 골라 [보내기](제안) · [원래대로] — 끄기 · 삭제는 없음 (친구 10장)
// 제안을 보내면 주인에게 알림(실데이터는 notify Edge Function, 알림이 안 가도 제안은 저장됨), 변경 기록은 이번 실행 동안만 남음 (docs/decisions.md D9 · D20)
export default function SharedAlarmsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload } = useLoad(() => getSharedAlarms(id));
  const { busy, run } = useAction();
  const [log, setLog] = useState<ShareLogItem[] | null>(null);

  async function openLog() {
    setLog(await getShareLog());
  }

  const top = <TopBar onBack={backOrHome} screenId="G04" right={<TopBarButton label="변경 기록" onPress={openLog} />} />;
  // 닫기는 시트 머리의 "닫기" 하나로 (아래에 또 두지 않음)
  const logSheet = (
    <Sheet visible={log != null} onClose={() => setLog(null)} title="변경 기록">
      {log?.length ? (
        <Timeline items={log.map((l) => ({ time: formatTime(l.at), label: l.text, source: '나' }))} />
      ) : (
        <Text variant="note" tone="sub" style={styles.empty}>
          아직 바꾼 내용이 없어요.
        </Text>
      )}
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

  // 시각을 골라 [보내기] — 제안 한 줄(상대 알람은 그대로, 상대가 [적용]해야 바뀜). 연타해도 한 번씩 (한 번에 하나)
  const propose = (alarmId: string, newAt: Date) =>
    run(async () => {
      const { notified } = await proposeSharedAlarm(p.id, alarmId, newAt);
      toast(notified ? PROPOSE_SENT : PROPOSE_SENT_NO_PUSH);
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
          busy={busy}
          onPropose={canEdit ? (newAt) => propose(a.id, newAt) : undefined}
        />
      ))}

      {canView ? (
        <Note>
          {canEdit ? PROPOSE_NOTE(p.short) : '알람 설정 권한이 없어 볼 수만 있어요.'}
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
});
