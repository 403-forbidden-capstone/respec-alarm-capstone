import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, KeyValueRow, LoadError, Loading, Screen, Sheet, Text, toast, TopBar, TopBarButton } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { applySuggestion, getSuggestion, ignoreSuggestion, reopenSuggestion, undoSuggestion } from '@/features/records/api';
import { dayWord } from '@/features/records/calendar';
import { CompareTimes } from '@/features/records/components/CompareTimes';
import { CompareValues } from '@/features/records/components/CompareValues';
import { useHoldRepeat } from '@/features/records/hooks/useHoldRepeat';
import { EDIT_STEP, previewTimes, shiftText, stepMinutes, suggestionPhase, wakeLine } from '@/features/records/suggestion';
import type { Suggestion } from '@/features/records/types';
import { now } from '@/lib/clock';
import { formatDateShort, formatTime } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

// S01 알람 조정 제안 — 최근 기록으로 고른 준비 알람 앞당김을 적용 · 직접 수정 · 무시, 적용한 뒤에는 다시 수정하거나 이전 값으로 되돌리기
// 적용하면 그 일정(이번 회차와 이후 회차)의 준비 알람이 당겨지고, 준비 전 활동(기상 → 준비)을 넘는 만큼만 기상도 (안건 D111 1 · 2번). 출발은 그대로
//   실데이터는 서버 suggestion-apply가 알람을 옮기고 앱이 폰 예약을 맞춤 (records/real.ts)
// 직접 수정(D53) — 1분씩 더 당기기, 준비 · 기상 · 출발 미리 보기, 적용한 뒤에도 바로 다시 수정
// 알람 값 제안(말소리 · 배경음 · 진동, 실데이터)은 s.change가 있음 — 시각 비교 대신 값 비교를 보여 주고 직접 수정은 없음
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

// 적용 뒤 되돌림 안내 — 자동 되돌림은 없음(docs/decisions.md S01: 스키마에 자리 없음), 아래 [이전 값으로 되돌리기]로 직접 (C-15)
const REVERT_LINE = '아래에서 언제든 이전 값으로 되돌릴 수 있어요.';

function Detail({ suggestion: s, reload }: { suggestion: Suggestion; reload: () => Promise<boolean> }) {
  const [editing, setEditing] = useState<number | null>(null); // 직접 수정 시트에서 고른 값(적용 전보다 일찍 +, 늦게 − 분), 닫혀 있으면 null
  // 버튼은 한 번에 하나씩, 다시 읽기가 끝날 때까지 잠금 — 연타 · 옛 화면에서 다시 누르기를 막음 (lib/useAction)
  const { busy, run: act } = useAction();
  const phase = suggestionPhase(s.status);
  const change = s.change; // 시각이 아닌 제안(실데이터)
  const target = change ? change.target : `${formatDateShort(s.appointment.at)} ${s.appointment.title}`;

  // 제안이 바꾸는 알람을 확인하러 (H03) — 연결된 일정이 없는 알람(일정 없는 알람 · 루틴)은 열 곳이 없음
  //   ?changed= 는 이 제안이 움직인 알람 종류만 — 알람 설정 쪽이 그 줄을 표시함 (시각 제안만, 값 제안은 붙이지 않음)
  const movedKinds = [
    s.currentWake.getTime() !== s.proposedWake.getTime() ? 'WAKE' : null,
    s.currentPrepare && s.proposedPrepare && s.currentPrepare.getTime() !== s.proposedPrepare.getTime() ? 'PREPARE' : null,
  ].filter((k): k is string => k != null);
  const alarmLink = s.appointment.id ? (
    <TextLink
      label="알람 설정 보기 ›"
      onPress={() =>
        router.push({
          pathname: '/alarm/[id]',
          params: { id: s.appointment.id, ...(!change && movedKinds.length ? { changed: movedKinds.join(',') } : {}) },
        })
      }
    />
  ) : null;

  // 시트의 1분 버튼 — 길게 누르면 반복하므로 최신 값에서 이어 가게 함수형 갱신
  const step = (delta: number) => setEditing((m) => (m == null ? m : stepMinutes(m, delta, s.bounds)));

  const apply = (minutes: number) =>
    act(async () => {
      await applySuggestion(s.id, minutes);
      setEditing(null);
      const after = previewTimes(s, minutes);
      toast(
        change
          ? `${change.axis} 설정을 바꿨어요 · ${change.suggested}`
          : after.prepare
            ? `${dayWord(after.prepare, now())} 준비 알람이 ${formatTime(after.prepare)}에 울려요`
            : `${dayWord(after.wake, now())} 기상 알람이 ${formatTime(after.wake)}에 울려요`,
      );
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
        {change || !s.currentPrepare ? '다음 알람을 조정할까요?' : '준비 알람을 조정할까요?'}
      </Text>
      <Text variant="lead" style={styles.lead}>
        최근 실행 기록을 바탕으로 더 잘 맞는 시간을 찾았어요.
      </Text>

      <Card>
        <Text variant="label" style={styles.label}>
          제안 이유
        </Text>
        <Text variant="big">{s.reason}</Text>
        {s.deltas.length ? (
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
        ) : null}
      </Card>

      {phase === 'pending' ? (
        <>
          <Card>
            <Text variant="label" style={styles.label}>
              변경 제안 · {target}
            </Text>
            {change ? (
              <>
                <Text variant="small" align="center">
                  {change.axis}
                </Text>
                <CompareValues before={change.current} after={change.suggested} />
              </>
            ) : (
              <>
                {/* 준비 알람이 주인공 — 기상은 준비 전 활동을 넘을 때만 움직임 (안건 D111) */}
                <CompareTimes before={s.currentPrepare ?? s.currentWake} after={s.proposedPrepare ?? s.proposedWake} />
                {s.currentPrepare ? (
                  <Text variant="small" align="center">
                    {wakeLine(s.currentWake, s.proposedWake)}
                  </Text>
                ) : null}
              </>
            )}
            {alarmLink ? <View style={[styles.link, styles.linkCenter]}>{alarmLink}</View> : null}
          </Card>
          <View style={styles.stack}>
            <Button label="적용" onPress={() => apply(s.minutes)} disabled={busy} />
            <View style={styles.links}>
              {change ? null : <TextLink label="직접 수정" onPress={() => setEditing(s.minutes)} disabled={busy} />}
              <TextLink label="무시" onPress={ignore} disabled={busy} />
            </View>
          </View>
        </>
      ) : null}

      {phase === 'applied' && s.applied ? (
        <>
          <Card>
            <Text variant="label" style={styles.label}>
              적용했어요
            </Text>
            {change ? (
              <>
                <Text variant="big">
                  {target}
                  {'\n'}
                  {change.axis} {change.result}
                </Text>
                <Text variant="small" style={styles.sub}>
                  적용 전 값은 {change.current}이었어요. {REVERT_LINE}
                </Text>
              </>
            ) : (
              <>
                <Text variant="big">
                  {target}
                  {'\n'}
                  {s.applied.prepare && formatTime(s.applied.prepare) === formatTime(s.applied.wake)
                    ? `기상 · 준비 ${formatTime(s.applied.wake)}`
                    : `기상 ${formatTime(s.applied.wake)}${s.applied.prepare ? ` · 준비 ${formatTime(s.applied.prepare)}` : ''}`}
                </Text>
                <Text variant="small" style={styles.sub}>
                  {s.applied.prepare ? '준비 알람이 ' : ''}적용 전보다 {shiftText(s.applied.minutes)} 울려요. {REVERT_LINE}
                </Text>
              </>
            )}
            {alarmLink ? <View style={styles.link}>{alarmLink}</View> : null}
          </Card>
          <View style={styles.stack}>
            {change ? null : <Button label="다시 수정하기" variant="ghost" onPress={() => setEditing(s.applied?.minutes ?? s.minutes)} disabled={busy} />}
            <Button label="이전 값으로 되돌리기" variant="plain" onPress={undo} disabled={busy} />
          </View>
        </>
      ) : null}

      {phase === 'ignored' ? (
        <>
          <Card>
            <Text variant="small">이번 제안을 무시했어요. 같은 제안은 당분간 다시 보이지 않아요.</Text>
            {alarmLink ? <View style={styles.link}>{alarmLink}</View> : null}
          </Card>
          <View style={styles.stack}>
            <Button label="제안 다시 보기" variant="ghost" onPress={reopen} disabled={busy} />
          </View>
        </>
      ) : null}

      <Sheet
        visible={editing != null}
        onClose={() => setEditing(null)}
        title={`${s.currentPrepare ? '준비 알람' : '기상 시각'} ${s.applied ? '다시 정하기' : '직접 정하기'}`}
      >
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

// 직접 수정 시트 (D53) — 준비 알람을 1분씩 (준비 알람 당김은 더 당기는 쪽만, bounds.later 0). 기상은 준비 전 활동을 넘는 만큼만, 출발은 그대로
//   준비 알람이 없는 일정은 기상을 움직임 (예전 규칙)
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
  // 움직이는 알람 — 준비 알람이 있으면 준비, 없으면 기상
  const main = s.currentPrepare ? { label: '준비', before: s.currentPrepare, now: applied?.prepare ?? s.currentPrepare, at: preview.prepare ?? preview.wake } : { label: '기상', before: s.currentWake, now: applied?.wake ?? s.currentWake, at: preview.wake };

  return (
    <>
      <Text variant="small">
        {s.appointment.title} · {formatDateShort(s.appointment.at)} · {applied ? `적용 전 ${formatTime(main.before)} · 지금 ${formatTime(main.now)}` : `지금 ${formatTime(main.before)}`}
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
            {main.label}
          </Text>
          <Text variant="compare" align="center" accessibilityLiveRegion="polite">
            {formatTime(main.at)}
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
        {s.currentPrepare ? (
          <KeyValueRow first label="기상" value={formatTime(preview.wake)} sub={wakeLine(s.currentWake, preview.wake).replace('.', '')} />
        ) : null}
        <KeyValueRow first={!s.currentPrepare} label="출발" value={formatTime(preview.depart)} sub="약속에 맞춰 그대로예요" />
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
  links: { flexDirection: 'row', justifyContent: 'center', gap: 28 },
  link: { alignSelf: 'flex-start', marginTop: 10 },
  linkCenter: { alignSelf: 'center' },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, marginBottom: 6 },
  center: { flex: 1, alignItems: 'center', gap: 2 },
  preview: { marginTop: 8 },
});
