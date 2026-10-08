import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Screen, Sheet, Text, toast, TopBar, TopBarButton } from '@/components/ui';
import { applySuggestion, getSuggestion, ignoreSuggestion, reopenSuggestion, undoSuggestion } from '@/features/records/api';
import { dayWord } from '@/features/records/calendar';
import { CompareTimes } from '@/features/records/components/CompareTimes';
import { EDIT_STEP, stepMinutes, suggestionPhase } from '@/features/records/suggestion';
import type { Suggestion } from '@/features/records/types';
import { now } from '@/lib/clock';
import { addMinutes, formatDateShort, formatTime } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

// S01 알람 조정 제안 — 최근 기록으로 고른 앞당김을 적용 · 직접 수정 · 무시, 적용한 뒤에는 이전 값으로 되돌리기
// 적용하면 그 일정의 예측 준비가 늘어 기상 · 준비 알람이 같이 앞당겨짐 (실제 저장 · 다시 예약은 #49)
export default function SuggestionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, reload } = useLoad(() => getSuggestion(id));
  const back = backOrHome; // 앞 화면이 없으면(주소로 바로 열기) 홈으로

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={back} />
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar screenId="S01" onBack={back} />
        <Text variant="body" tone="sub">
          제안을 찾을 수 없어요.
        </Text>
      </Screen>
    );
  }
  return <Detail suggestion={data} reload={reload} onBack={back} />;
}

function Detail({ suggestion: s, reload, onBack }: { suggestion: Suggestion; reload: () => Promise<boolean>; onBack?: () => void }) {
  const [editing, setEditing] = useState<number | null>(null); // 직접 수정 시트에서 고른 앞당김(분), 닫혀 있으면 null
  // 버튼은 한 번에 하나씩, 다시 읽기가 끝날 때까지 잠금 — 연타 · 옛 화면에서 다시 누르기를 막음 (lib/useAction)
  const { busy, run: act } = useAction();
  const phase = suggestionPhase(s.status);
  const target = `${formatDateShort(s.appointment.at)} ${s.appointment.title}`;

  const apply = (minutes: number) =>
    act(async () => {
      await applySuggestion(s.id, minutes);
      setEditing(null);
      toast(`${dayWord(s.currentWake, now())} 기상 알람이 ${formatTime(addMinutes(s.currentWake, -minutes))}에 울려요`);
      await reload();
    });

  const undo = () =>
    act(async () => {
      await undoSuggestion(s.id);
      toast('이전 값으로 되돌렸어요');
      await reload();
    });

  const ignore = () =>
    act(async () => {
      await ignoreSuggestion(s.id);
      toast('이번 제안을 무시했어요');
      await reload();
    });

  const reopen = () =>
    act(async () => {
      await reopenSuggestion(s.id);
      await reload();
    });

  return (
    <Screen>
      <TopBar screenId="S01" onBack={onBack} />
      <Text variant="title" style={styles.title}>
        다음 알람을 조정할까요?
      </Text>
      <Text variant="lead" style={styles.lead}>
        최근 실행 기록을 바탕으로 더 잘 맞는 시간을 찾았어요.
      </Text>

      <Card>
        <Text variant="label" style={styles.label}>
          제안 이유
        </Text>
        <Text variant="big">{s.reason}</Text>
        <View style={styles.trio}>
          {s.deltas.map((d) => (
            <View key={d.label} style={styles.trioItem}>
              <Text variant="caption" align="center">
                {d.label}
              </Text>
              <Text variant="bodyLarge" weight={700} align="center">
                {d.value}
              </Text>
            </View>
          ))}
        </View>
      </Card>

      {phase === 'pending' ? (
        <>
          <Card>
            <Text variant="label" style={styles.label}>
              변경 제안 · {target}
            </Text>
            <CompareTimes before={s.currentWake} after={s.proposedWake} />
            <Text variant="small" align="center">
              준비 알람도 {s.minutes}분 앞당겨져요.
            </Text>
          </Card>
          <View style={styles.stack}>
            <Button label="제안 적용하기" onPress={() => apply(s.minutes)} disabled={busy} />
            <Button label="직접 수정하기" variant="ghost" onPress={() => setEditing(s.minutes)} disabled={busy} />
            <Button label="이번 제안 무시" variant="plain" onPress={ignore} disabled={busy} />
          </View>
        </>
      ) : null}

      {phase === 'applied' && s.applied ? (
        <>
          <Card>
            <Text variant="label" style={styles.label}>
              적용했어요
            </Text>
            <Text variant="big">
              {target}
              {'\n'}기상 {formatTime(s.applied.wake)}
              {s.applied.prepare ? ` · 준비 ${formatTime(s.applied.prepare)}` : ''}
            </Text>
            <Text variant="small" style={styles.sub}>
              다음 기록에서 성능이 나빠지면 이전 값으로 되돌려요.
            </Text>
          </Card>
          <View style={styles.stack}>
            <Button label="이전 값으로 되돌리기" variant="ghost" onPress={undo} disabled={busy} />
          </View>
        </>
      ) : null}

      {phase === 'ignored' ? (
        <>
          <Card>
            <Text variant="small">이번 제안을 무시했어요. 같은 제안은 당분간 다시 보이지 않아요.</Text>
          </Card>
          <View style={styles.stack}>
            <Button label="제안 다시 보기" variant="ghost" onPress={reopen} disabled={busy} />
          </View>
        </>
      ) : null}

      <Sheet visible={editing != null} onClose={() => setEditing(null)} title="기상 시각 직접 정하기">
        {editing != null ? (
          <EditWake
            suggestion={s}
            minutes={editing}
            onChange={setEditing}
            onApply={() => apply(editing)}
            onCancel={() => setEditing(null)}
            busy={busy}
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}

type EditProps = {
  suggestion: Suggestion;
  minutes: number; // 앞당길 분
  onChange: (minutes: number) => void;
  onApply: () => void;
  onCancel: () => void;
  busy: boolean; // 적용이 도는 중 — 시트 버튼을 흐리게
};

// 직접 수정 시트 — 5분씩 늦게 · 일찍, 지금 시각 그대로(0분)면 적용할 수 없음
function EditWake({ suggestion: s, minutes, onChange, onApply, onCancel, busy }: EditProps) {
  return (
    <>
      <Text variant="small">
        {s.appointment.title} · {formatDateShort(s.appointment.at)} · 지금 {formatTime(s.currentWake)}
      </Text>
      <View style={styles.stepper}>
        <TopBarButton label={`${EDIT_STEP}분 늦게`} onPress={() => onChange(stepMinutes(minutes, -EDIT_STEP))} />
        <Text variant="compare" accessibilityLiveRegion="polite">
          {formatTime(addMinutes(s.currentWake, -minutes))}
        </Text>
        <TopBarButton label={`${EDIT_STEP}분 일찍`} onPress={() => onChange(stepMinutes(minutes, EDIT_STEP))} />
      </View>
      <View style={styles.stack}>
        <Button label="이 시간으로 적용" onPress={onApply} disabled={minutes === 0 || busy} />
        <Button label="취소" variant="plain" onPress={onCancel} disabled={busy} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  label: { marginBottom: 8 },
  trio: { flexDirection: 'row', marginTop: 16 },
  trioItem: { flex: 1 },
  sub: { marginTop: 4 },
  stack: { gap: 10, marginTop: 16 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, marginBottom: 6 },
});
