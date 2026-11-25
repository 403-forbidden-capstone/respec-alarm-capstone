import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Card, confirm, EmptyState, LoadError, Loading, Screen, Text, toast, TopBar } from '@/components/ui';
import { getAppointment, previewAlarms, saveAlarmSettings } from '@/features/alarm/api';
import { settingsDraftOf } from '@/features/alarm/groupChange';
import { saveNotice } from '@/features/alarm/saveNotice';
import { travelConfirmMessage, TravelConfirmNeeded, TRAVEL_CONFIRM_OK } from '@/features/alarm/travelConfirm';
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
  // 울리는 알람 + 도착 목표(약속 시각이 바뀐 만큼 같이 움직임 — 원래 시각 → 새 시각이 여기서 보임)
  const rows = [...RING_KINDS, 'ARRIVE' as const].filter((kind) => (kind === 'ARRIVE' ? before(kind) && after(kind) : before(kind)?.enabled || after(kind)?.enabled));

  // 길찾기를 못 해 서버가 어림값만 가졌으면(이동시간을 못 구해 보류된 참여자) 어림 분을 보여 주고, 확인하면 그 분을 직접 정한 값(MANUAL)으로 다시 저장 — H03 저장과 같은 길
  //   확인 창은 한 번에 하나 가드(run) 밖에서
  const save = async (travelMinutes?: number) => {
    const draft = { ...settingsDraftOf(saved), ...(travelMinutes != null ? { travelMinutes } : {}) };
    const result = await saveAlarmSettings(id, draft);
    toast(saveNotice(result.followUp, '맞췄지만') ?? '내 알람을 새 시각으로 맞췄어요');
    backOrHome();
  };
  const apply = async () => {
    let ask: TravelConfirmNeeded | null = null;
    await run(async () => {
      try {
        await save();
      } catch (e) {
        if (!(e instanceof TravelConfirmNeeded)) throw e;
        ask = e;
      }
    }, '맞추지 못했어요. 다시 해 주세요');
    const fallback = ask as TravelConfirmNeeded | null;
    if (!fallback) return;
    if (!(await confirm({ title: '이동시간을 확인해 주세요', message: travelConfirmMessage(fallback), okLabel: TRAVEL_CONFIRM_OK }))) return;
    await run(() => save(fallback.minutes), '맞추지 못했어요. 다시 해 주세요');
  };

  return (
    <Screen
      footer={
        <View style={styles.footer}>
          <Button label="새 시각으로 맞추기" loading={busy} onPress={() => void apply()} />
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
          const same = b != null && a != null && b.at.getTime() === a.at.getTime(); // 약속이 바뀌어도 이 알람은 그대로
          return (
            <View key={kind} style={[styles.row, same && styles.same]}>
              <Text variant="body" style={styles.kind}>
                {kind === 'ARRIVE' ? '도착 목표' : KIND_LABEL[kind]}
              </Text>
              <Text variant="body" tone="sub">
                {b ? formatTime(b.at) : '—'}
              </Text>
              <Text variant="body" tone="sub">
                →
              </Text>
              {same ? (
                <Text variant="body" tone="sub">
                  그대로
                </Text>
              ) : (
                <Text variant="bodyStrong">{a ? formatTime(a.at) : '—'}</Text>
              )}
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
  kind: { width: 68 },
  same: { opacity: 0.55 },
  note: { marginTop: 12, lineHeight: 20 },
  footer: { gap: 8 },
});
