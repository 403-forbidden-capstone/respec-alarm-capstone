import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Card, EmptyState, LoadError, Loading, Screen, Text, toast, TopBar } from '@/components/ui';
import { getAppointment, previewAlarms, saveAlarmSettings } from '@/features/alarm/api';
import { settingsDraftOf } from '@/features/alarm/groupChange';
import { KIND_LABEL, RING_KINDS } from '@/features/alarm/types';
import { formatDateShort, formatTime } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

// 공동 약속 시각이 바뀐 뒤 내 알람 확인 (친구 9장, 공동 약속 푸시 needsConfirm) — 만든 사람이 5분 넘게 늦췄거나 이동시간을 못 구해 서버가 내 알람을 그대로 둔 경우
//   지금 알람 → 바뀐 약속 시각으로 다시 계산한 알람을 나란히 보여 주고, [새 시각으로 맞추기]를 누르면 내 조건 그대로 다시 저장(서버가 다시 계산) · 폰에 걺
//   열리는 길: 공동 약속 변경 알림(needsConfirm)을 누름 — 알림을 받는 곳은 푸시 앱 PR. 주소 /alarm/changed?id=<약속 id>
export default function GroupChangeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload } = useLoad(async () => {
    const saved = await getAppointment(id);
    if (!saved) return null;
    return { saved, next: await previewAlarms(id, saved.edits) };
  });
  const { busy, run } = useAction();

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} />
        {error ? <LoadError onRetry={reload} /> : <Loading />}
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} />
        <EmptyState title="약속을 찾을 수 없어요" body="취소됐거나 내가 빠진 약속이에요." />
      </Screen>
    );
  }

  const { saved, next } = data;
  const before = (kind: string) => saved.alarms.find((x) => x.kind === kind);
  const after = (kind: string) => next.alarms.find((x) => x.kind === kind);
  const rows = RING_KINDS.filter((kind) => before(kind)?.enabled || after(kind)?.enabled);

  const apply = () =>
    run(async () => {
      await saveAlarmSettings(id, settingsDraftOf(saved));
      toast('내 알람을 새 시각으로 맞췄어요');
      backOrHome();
    }, '맞추지 못했어요. 다시 해 주세요');

  return (
    <Screen
      footer={
        <View style={styles.footer}>
          <Button label="새 시각으로 맞추기" loading={busy} onPress={apply} />
          <Button label="지금은 그대로 두기" variant="plain" onPress={() => (router.canGoBack() ? router.back() : backOrHome())} />
        </View>
      }
    >
      <TopBar onBack={backOrHome} />
      <Text variant="title" style={styles.title}>
        약속 시각이 바뀌었어요
      </Text>
      <Text variant="lead" style={styles.lead}>
        {`${saved.groupName ? `${saved.groupName} · ` : ''}${saved.title} · ${formatDateShort(saved.at)} ${formatTime(saved.at)}`}
      </Text>
      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          내 알람
        </Text>
        {rows.map((kind) => {
          const b = before(kind);
          const a = after(kind);
          return (
            <View key={kind} style={styles.row}>
              <Text variant="body" style={styles.kind}>
                {KIND_LABEL[kind]}
              </Text>
              <Text variant="body" tone="sub">
                {b ? formatTime(b.at) : '—'}
              </Text>
              <Text variant="body" tone="sub">
                →
              </Text>
              <Text variant="bodyStrong">{a ? formatTime(a.at) : '—'}</Text>
            </View>
          );
        })}
      </Card>
      <Text variant="small" tone="sub" style={styles.note}>
        내 출발지 · 이동 수단 · 준비 시간은 그대로 두고 바뀐 약속 시각으로 다시 계산했어요. 맞추기 전까지 지금 알람이 울려요.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  label: { marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  kind: { width: 44 },
  note: { marginTop: 12, lineHeight: 20 },
  footer: { gap: 8 },
});
