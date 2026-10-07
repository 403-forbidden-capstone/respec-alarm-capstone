import { router } from 'expo-router';
import { Fragment, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, ProgressBar, Screen, Text, toast, TopBar } from '@/components/ui';
import { confirmWake, getWakeCheck } from '@/features/alarm/api';
import { FormulaBox } from '@/features/alarm/components/FormulaBox';
import type { WakeCheck } from '@/features/alarm/types';
import { addMinutes, formatTime, timeParts } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

type Phase = 'observing' | 'prompt' | 'confirmed';
type WakeState = { phase: Phase; usage: number; recent: number; at: Date | null; how: 'self' | 'auto' | null };

const METER_MAX = 5; // 분

// H08 기상 확인 — 기상 알람을 끈 뒤 10분 동안 화면 사용으로 판정, 모자라면 확인 알림
// 실제 판정(사용 정보 접근)은 #35 · #40. 지금은 목업처럼 "시연용" 버튼으로 두 경우를 보여 줌
export default function WakeScreen() {
  const { data } = useLoad(getWakeCheck);
  if (!data) return (
    <Screen>
      <TopBar />
    </Screen>
  );
  return <WakeFlow check={data} />;
}

function WakeFlow({ check }: { check: WakeCheck }) {
  const [state, setState] = useState<WakeState>(() =>
    check.confirmed
      ? { phase: 'confirmed', usage: 3.2, recent: 1.4, at: check.confirmed.at, how: check.confirmed.how }
      : { phase: 'observing', usage: 0, recent: 0, at: null, how: null },
  );
  const observeEnd = addMinutes(check.dismissedAt, 10);
  const group = check.groupName ?? '그룹';
  const back = router.canGoBack() ? router.back : undefined;

  async function confirm(how: 'self' | 'auto', usage: number, recent: number) {
    await confirmWake(how, observeEnd);
    setState({ phase: 'confirmed', usage, recent, at: observeEnd, how });
    toast(`기상을 확인했어요 · ${group}에 공유했어요`);
  }

  // 시연용: 폰을 보며 일어나면 누적 사용이 θ를 넘어 자동 판정
  const useAndWake = () => confirm('auto', 3.2, 1.4);
  // 시연용: 알람만 끄고 다시 자면 조건을 못 채워 확인 알림
  const sleepAgain = () => setState({ phase: 'prompt', usage: 0.4, recent: 0, at: null, how: null });
  // 시연용: 확인 알림에도 응답이 없으면 기상 알람이 다시 울림
  const noReply = () => router.replace({ pathname: '/ring', params: { appointment: 'a1', kind: 'WAKE', again: '1' } });

  const meters = (
    <>
      <Meter label="누적 사용 · 해제 후 10분" value={state.usage} threshold={check.thetaMinutes} />
      <Meter label="최근 사용 · 뒤쪽 5분" value={state.recent} />
      <FormulaBox lines={[`기상 확정 = 누적 사용 ≥ θ(${check.thetaMinutes}분) 그리고 최근 사용 > 0`]} />
    </>
  );

  return (
    <Screen>
      <TopBar
        onBack={back}
        screenId={back ? undefined : 'H08'}
        right={back ? <Text variant="screenId">H08</Text> : undefined}
      />
      <Text variant="title" style={styles.title}>
        기상 확인
      </Text>
      <Text variant="lead" style={styles.lead}>
        알람을 끈 것만으로는 기상으로 보지 않아요.
      </Text>
      <Flow state={state} />

      {state.phase === 'observing' ? (
        <>
          <Card>
            <Text variant="label" tone="sub">
              {formatTime(check.dismissedAt)}에 해제 · 10분 동안 화면 사용을 보고 있어요
            </Text>
            {meters}
          </Card>
          <View style={styles.sim}>
            <Text variant="label" tone="sub" style={styles.simText}>
              시연용 · 해제 후 10분을 어떻게 보낼지 골라 보세요
            </Text>
            <View style={styles.simButtons}>
              <Button label="폰을 보며 일어나기" onPress={useAndWake} />
              <Button label="알람만 끄고 다시 잠들기" variant="ghost" onPress={sleepAgain} />
            </View>
          </View>
        </>
      ) : null}

      {state.phase === 'prompt' ? (
        <>
          <View style={styles.notif} accessibilityRole="alert">
            <View style={styles.notifHead}>
              <Text variant="label" tone="sub" weight={600}>
                Re:Spec Alarm
              </Text>
              <Text variant="label" tone="sub">
                {timeParts(observeEnd).hm}
              </Text>
            </View>
            <Text variant="bodyStrong">지금 일어나셨나요?</Text>
            <Text variant="body" tone="sub" style={styles.notifText}>
              응답하면 {group}에 기상 완료로 표시돼요.
            </Text>
            <Button label="일어났어요" small onPress={() => confirm('self', 0.4, 0)} />
          </View>
          <Card>
            <Text variant="label" tone="sub">
              조건을 채우지 못해 확인 알림을 보냈어요
            </Text>
            {meters}
          </Card>
          <View style={styles.sim}>
            <Text variant="label" tone="sub" style={styles.simText}>
              시연용
            </Text>
            <Button label="응답 없이 5분 지나기" variant="ghost" onPress={noReply} />
          </View>
        </>
      ) : null}

      {state.phase === 'confirmed' && state.at ? (
        <>
          <View style={styles.done}>
            <View style={styles.check}>
              <Text variant="stat" tone="inverse">
                ✓
              </Text>
            </View>
            <Text variant="sheetTitle">기상 확정 · {formatTime(state.at)}</Text>
            <Text variant="small" tone="sub" align="center" style={styles.doneText}>
              {state.how === 'self' ? '확인 알림에 직접 응답했어요' : '화면 사용으로 자동 판정했어요'} · {group}에 공유했어요
            </Text>
          </View>
          <Card>{meters}</Card>
          <View style={styles.stack}>
            <Button label="홈으로" onPress={() => router.dismissTo('/')} />
            <Button
              label={`${group} 기상 현황 보기`}
              variant="ghost"
              onPress={() => router.push({ pathname: '/groups/[id]', params: { id: 'cap' } })}
            />
          </View>
        </>
      ) : null}
    </Screen>
  );
}

// 판정 단계 (.flow) — 해제됨 → 관찰 중 → (확인 알림) → 기상 확정
function Flow({ state }: { state: WakeState }) {
  const steps: { label: string; mode: 'done' | 'on' | 'todo' }[] = [
    { label: '해제됨', mode: 'done' },
    { label: '관찰 중', mode: state.phase === 'observing' ? 'on' : 'done' },
  ];
  if (state.phase === 'prompt') steps.push({ label: '확인 알림', mode: 'on' });
  else if (state.phase === 'confirmed' && state.how === 'self') {
    steps.push({ label: '확인 알림', mode: 'done' }, { label: '기상 확정', mode: 'on' });
  } else steps.push({ label: '기상 확정', mode: state.phase === 'confirmed' ? 'on' : 'todo' });

  return (
    <View style={styles.flow} accessibilityLabel="판정 단계">
      {steps.map((step, i) => (
        <Fragment key={step.label}>
          {i > 0 ? (
            <Text variant="label" tone="faint">
              →
            </Text>
          ) : null}
          <View style={[styles.flowStep, step.mode === 'on' && styles.flowOn]}>
            <Text variant="label" tone={step.mode === 'on' ? 'inverse' : step.mode === 'done' ? 'ink' : 'faint'}>
              {step.label}
            </Text>
          </View>
        </Fragment>
      ))}
    </View>
  );
}

// 사용 시간 막대 (.meter) — threshold는 기상 판정 기준 θ
function Meter({ label, value, threshold }: { label: string; value: number; threshold?: number }) {
  return (
    <View style={styles.meter}>
      <View style={styles.meterHead}>
        <Text variant="body" style={styles.meterText}>
          {label}
        </Text>
        <Text variant="bodyStrong" style={styles.meterText}>
          {value.toFixed(1)}분
        </Text>
      </View>
      <ProgressBar value={value / METER_MAX} threshold={threshold != null ? threshold / METER_MAX : undefined} thick />
    </View>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  flow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 14 },
  flowStep: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  flowOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  meter: { marginVertical: 12 },
  meterHead: { flexDirection: 'row', justifyContent: 'space-between' },
  meterText: { fontSize: 13 },
  sim: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.faint, borderRadius: 18, padding: 14, marginTop: 14 },
  simText: { marginBottom: 10 },
  simButtons: { gap: 8 },
  notif: {
    backgroundColor: colors.card,
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.line,
    marginBottom: 12,
    boxShadow: `0 10px 26px -14px ${colors.shadow}4D`,
  },
  notifHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  notifText: { fontSize: 13, marginTop: 4, marginBottom: 12 },
  done: { alignItems: 'center', paddingTop: 18, paddingBottom: 14 },
  check: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  doneText: { marginTop: 4 },
  stack: { gap: 10, marginTop: 16 },
});
