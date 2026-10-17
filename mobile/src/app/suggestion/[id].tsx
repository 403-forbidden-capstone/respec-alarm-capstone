import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, KeyValueRow, LoadError, Loading, Screen, Sheet, Text, toast, TopBar, TopBarButton } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { applySuggestion, getSuggestion, ignoreSuggestion, reopenSuggestion, undoSuggestion } from '@/features/records/api';
import { dayWord } from '@/features/records/calendar';
import { CompareTimes } from '@/features/records/components/CompareTimes';
import { useHoldRepeat } from '@/features/records/hooks/useHoldRepeat';
import { EDIT_STEP, previewTimes, shiftText, stepMinutes, suggestionPhase } from '@/features/records/suggestion';
import type { Suggestion } from '@/features/records/types';
import { now } from '@/lib/clock';
import { addMinutes, formatDateShort, formatTime } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

// S01 알람 조정 제안 — 최근 기록으로 고른 앞당김을 적용 · 직접 수정 · 무시, 적용한 뒤에는 다시 수정하거나 이전 값으로 되돌리기
// 적용하면 그 일정의 예측 준비가 바뀌어 기상 · 준비 알람이 같이 움직임. 출발은 약속에 맞춰 그대로 (실제 저장 · 다시 예약은 #49)
// 직접 수정(D53) — 1분씩 일찍 · 늦게, 기상 · 준비 · 출발 미리 보기, 적용한 뒤에도 바로 다시 수정
export default function SuggestionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload } = useLoad(() => getSuggestion(id));

  if (data === undefined) {
    return (
      <Screen>
        <TopBar screenId="S01" onBack={backOrHome} />
        {error ? <LoadError onRetry={reload} /> : <Loading />}
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar screenId="S01" onBack={backOrHome} />
        <Text variant="body" tone="sub">
          제안을 찾을 수 없어요.
        </Text>
      </Screen>
    );
  }
  return <Detail suggestion={data} reload={reload} />;
}

function Detail({ suggestion: s, reload }: { suggestion: Suggestion; reload: () => Promise<boolean> }) {
  const [editing, setEditing] = useState<number | null>(null); // 직접 수정 시트에서 고른 값(적용 전보다 일찍 +, 늦게 − 분), 닫혀 있으면 null
  // 버튼은 한 번에 하나씩, 다시 읽기가 끝날 때까지 잠금 — 연타 · 옛 화면에서 다시 누르기를 막음 (lib/useAction)
  const { busy, run: act } = useAction();
  const phase = suggestionPhase(s.status);
  const target = `${formatDateShort(s.appointment.at)} ${s.appointment.title}`;

  // 제안이 바꾸는 알람을 확인하러 (H03)
  const alarmLink = (
    <TextLink label="알람 설정 보기 ›" onPress={() => router.push({ pathname: '/alarm/[id]', params: { id: s.appointment.id } })} />
  );

  // 시트의 1분 버튼 — 길게 누르면 반복하므로 최신 값에서 이어 가게 함수형 갱신
  const step = (delta: number) => setEditing((m) => (m == null ? m : stepMinutes(m, delta, s.bounds)));

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
      {/* 앞 화면이 없으면(주소로 바로 열기) 홈으로 */}
      <TopBar screenId="S01" onBack={backOrHome} />
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
            <View style={[styles.link, styles.linkCenter]}>{alarmLink}</View>
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
              적용 전보다 {shiftText(s.applied.minutes)} 울려요.
            </Text>
            <Text variant="small" style={styles.sub}>
              다음 기록에서 성능이 나빠지면 이전 값으로 되돌려요.
            </Text>
            <View style={styles.link}>{alarmLink}</View>
          </Card>
          <View style={styles.stack}>
            <Button label="다시 수정하기" variant="ghost" onPress={() => setEditing(s.applied?.minutes ?? s.minutes)} disabled={busy} />
            <Button label="이전 값으로 되돌리기" variant="plain" onPress={undo} disabled={busy} />
          </View>
        </>
      ) : null}

      {phase === 'ignored' ? (
        <>
          <Card>
            <Text variant="small">이번 제안을 무시했어요. 같은 제안은 당분간 다시 보이지 않아요.</Text>
            <View style={styles.link}>{alarmLink}</View>
          </Card>
          <View style={styles.stack}>
            <Button label="제안 다시 보기" variant="ghost" onPress={reopen} disabled={busy} />
          </View>
        </>
      ) : null}

      <Sheet visible={editing != null} onClose={() => setEditing(null)} title={s.applied ? '기상 시각 다시 정하기' : '기상 시각 직접 정하기'}>
        {editing != null ? (
          <EditWake
            suggestion={s}
            minutes={editing}
            onStep={step}
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
  minutes: number; // 적용 전보다 일찍(+) · 늦게(−) 분
  onStep: (delta: number) => void;
  onApply: () => void;
  onCancel: () => void;
  busy: boolean; // 적용이 도는 중 — 시트 버튼을 흐리게
};

// 직접 수정 시트 (D53) — 1분씩 늦게 · 일찍. 기상 시각이 움직이면 준비도 같이, 출발은 약속에 묶여 그대로
// 지금(적용 전) 시각 그대로(0분)이거나 이미 적용한 값 그대로면 적용할 수 없음
function EditWake({ suggestion: s, minutes, onStep, onApply, onCancel, busy }: EditProps) {
  const applied = s.applied;
  const preview = previewTimes(s, minutes);
  const atEarliest = minutes >= s.bounds.earlier;
  const atLatest = minutes <= -s.bounds.later;
  const { start, stop } = useHoldRepeat(onStep);
  // 끝에 닿으면 버튼이 꺼져 놓았다는 신호(onPressOut)가 안 올 수 있어 반복을 멈춤
  useEffect(() => {
    if (atEarliest || atLatest) stop();
  }, [atEarliest, atLatest, stop]);
  const base = applied ? '적용 전' : '지금';

  return (
    <>
      <Text variant="small">
        {s.appointment.title} · {formatDateShort(s.appointment.at)} · {applied ? `적용 전 ${formatTime(s.currentWake)} · 지금 ${formatTime(applied.wake)}` : `지금 ${formatTime(s.currentWake)}`}
      </Text>
      <View style={styles.stepper}>
        <TopBarButton
          label={`${EDIT_STEP}분 늦게`}
          onPress={() => onStep(-EDIT_STEP)}
          onLongPress={() => start(-EDIT_STEP)}
          onPressOut={stop}
          disabled={atLatest || busy}
        />
        <View style={styles.center}>
          <Text variant="caption" align="center">
            기상
          </Text>
          <Text variant="compare" align="center" accessibilityLiveRegion="polite">
            {formatTime(preview.wake)}
          </Text>
          <Text variant="small" align="center">
            {minutes === 0 ? `${base}과 같아요` : `${base}보다 ${shiftText(minutes)}`}
          </Text>
        </View>
        <TopBarButton
          label={`${EDIT_STEP}분 일찍`}
          onPress={() => onStep(EDIT_STEP)}
          onLongPress={() => start(EDIT_STEP)}
          onPressOut={stop}
          disabled={atEarliest || busy}
        />
      </View>
      <View style={styles.preview}>
        {preview.prepare ? <KeyValueRow first label="준비" value={formatTime(preview.prepare)} /> : null}
        <KeyValueRow first={!preview.prepare} label="출발" value={formatTime(preview.depart)} sub="약속에 맞춰 그대로예요" />
      </View>
      <View style={styles.stack}>
        <Button
          label={applied ? '이 시간으로 다시 적용' : '이 시간으로 적용'}
          onPress={onApply}
          disabled={minutes === 0 || minutes === applied?.minutes || busy}
        />
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
  link: { alignSelf: 'flex-start', marginTop: 10 },
  linkCenter: { alignSelf: 'center' },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, marginBottom: 6 },
  center: { flex: 1, alignItems: 'center', gap: 2 },
  preview: { marginTop: 8 },
});
