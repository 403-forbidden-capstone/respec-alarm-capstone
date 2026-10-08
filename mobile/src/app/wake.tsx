import { router, useLocalSearchParams } from 'expo-router';
import { Fragment, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, ProgressBar, Screen, Text, toast, TopBar } from '@/components/ui';
import { confirmWake, getWakeCheck, missWake, promptWake } from '@/features/alarm/api';
import { FormulaBox } from '@/features/alarm/components/FormulaBox';
import { WAKE_NO_REPLY_MINUTES, WAKE_OBSERVE_MINUTES, type WakeCheck } from '@/features/alarm/types';
import { addMinutes, formatTime, timeParts } from '@/lib/format';
import { backOrHome, openGroupDetail } from '@/lib/nav';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

type Phase = 'observing' | 'prompt' | 'confirmed';
type WakeState = { phase: Phase; usage: number; recent: number; at: Date | null; how: 'self' | 'auto' | null };
type How = WakeState['how'];

const METER_MAX = 5; // 분

// 단계 · 사용 시간은 가짜 db에 있음(api) — 시연 값도 api가 정함
function toState(check: WakeCheck): WakeState {
  const use = { usage: check.usage, recent: check.recent };
  const c = check.confirmed;
  if (c) return { phase: 'confirmed', ...use, at: c.at, how: c.how };
  return { phase: check.phase, ...use, at: null, how: null };
}

// H08 기상 확인 — 기상 알람을 끈 뒤 10분 동안 화면 사용으로 판정, 모자라면 확인 알림
// 실제 판정(사용 정보 접근)은 #35 · #40. 지금은 목업처럼 "시연용" 버튼으로 두 경우를 보여 줌
export default function WakeScreen() {
  const { alarm } = useLocalSearchParams<{ alarm?: string }>();
  const { data } = useLoad(() => getWakeCheck(alarm));

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} />
      </Screen>
    );
  }
  // 확정 전인데 기상 알람을 아직 안 껐으면(울리기 전 · 울리는 중) 목업 빈 화면 — 알람을 못 찾아도 같음
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} right={<Text variant="screenId">H08</Text>} />
        <Text variant="title" style={styles.title}>
          기상 확인
        </Text>
        <Text variant="lead" style={styles.lead}>
          알람을 끈 것만으로는 기상으로 보지 않아요.
        </Text>
        <Flow phase="idle" how={null} />
        <Card>
          <Text variant="body" tone="sub">
            기상 알람을 해제하면 여기서 기상을 판정해요.
          </Text>
        </Card>
      </Screen>
    );
  }
  return <WakeFlow check={data} />;
}

// 단계는 가짜 db에 남아 있어서(api) 화면을 나갔다 와도 이어짐 — 확인 알림 단계면 확인 알림부터
function WakeFlow({ check }: { check: WakeCheck }) {
  const [state, setState] = useState(() => toState(check));
  // 두 번 눌러도 한 단계에서 한 번만 기록 (H07 handled와 같음) — 단계가 바뀌면 다시 누를 수 있음
  const handled = useRef<Phase | null>(null);
  // 실제로 끈 시각부터 10분 — 다시 울린 뒤 끄면 그 시각부터
  const observeEnd = addMinutes(check.dismissedAt, WAKE_OBSERVE_MINUTES);
  // 그룹 일정이 아니면 공유 문구 · 그룹 버튼을 뺌
  const shared = check.groupId != null ? ` · ${check.groupName ?? '그룹'}에 공유했어요` : '';

  function first() {
    if (handled.current === state.phase) return false;
    handled.current = state.phase;
    return true;
  }

  // api가 바꾼 단계 · 사용 시간을 다시 읽음
  async function refresh() {
    const next = await getWakeCheck(check.alarmId);
    if (next) setState(toState(next));
  }

  async function confirm(how: 'self' | 'auto') {
    if (!first()) return;
    await confirmWake(check.alarmId, how, observeEnd);
    await refresh();
    toast(`기상을 확인했어요${shared}`);
  }

  // 시연용: 폰을 보며 일어나면 누적 사용이 θ를 넘어 자동 판정
  const useAndWake = () => confirm('auto');
  // 시연용: 알람만 끄고 다시 자면 조건을 못 채워 관찰이 끝날 때 확인 알림
  async function sleepAgain() {
    if (!first()) return;
    await promptWake(check.alarmId, observeEnd);
    await refresh();
  }
  // 시연용: 확인 알림에도 응답이 없으면 5분 뒤 기상 알람이 다시 울림
  async function noReply() {
    if (!first()) return;
    await missWake(check.alarmId, addMinutes(observeEnd, WAKE_NO_REPLY_MINUTES));
    router.replace({ pathname: '/ring', params: { alarm: check.alarmId, again: '1' } });
  }

  const meters = (
    <>
      <Meter label="누적 사용 · 해제 후 10분" value={state.usage} threshold={check.thetaMinutes} />
      <Meter label="최근 사용 · 뒤쪽 5분" value={state.recent} />
      <FormulaBox lines={[`기상 확정 = 누적 사용 ≥ θ(${check.thetaMinutes}분) 그리고 최근 사용 > 0`]} />
    </>
  );

  return (
    <Screen>
      <TopBar onBack={backOrHome} right={<Text variant="screenId">H08</Text>} />
      <Text variant="title" style={styles.title}>
        기상 확인
      </Text>
      <Text variant="lead" style={styles.lead}>
        알람을 끈 것만으로는 기상으로 보지 않아요.
      </Text>
      <Flow phase={state.phase} how={state.how} />

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
            <Text variant="note" tone="sub" style={styles.notifText}>
              {check.groupId != null ? `응답하면 ${check.groupName ?? '그룹'}에 기상 완료로 표시돼요.` : '응답하면 기상 완료로 기록돼요.'}
            </Text>
            <Button label="일어났어요" small onPress={() => confirm('self')} />
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
              {state.how === 'self' ? '확인 알림에 직접 응답했어요' : '화면 사용으로 자동 판정했어요'}
              {shared}
            </Text>
          </View>
          <Card>{meters}</Card>
          <View style={styles.stack}>
            <Button label="홈으로" onPress={() => router.dismissTo('/')} />
            {check.groupId != null ? (
              <Button
                label={`${check.groupName ?? '그룹'} 기상 현황 보기`}
                variant="ghost"
                onPress={() => openGroupDetail(check.groupId!)}
              />
            ) : null}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

// 판정 단계 (.flow) — 해제됨 → 관찰 중 → (확인 알림) → 기상 확정
// idle(끈 알람 없음)은 목업 그대로 해제됨 · 관찰 중을 지난 단계로 그림
function Flow({ phase, how }: { phase: Phase | 'idle'; how: How }) {
  const steps: { label: string; mode: 'done' | 'on' | 'todo' }[] = [
    { label: '해제됨', mode: 'done' },
    { label: '관찰 중', mode: phase === 'observing' ? 'on' : 'done' },
  ];
  if (phase === 'prompt') steps.push({ label: '확인 알림', mode: 'on' });
  else if (phase === 'confirmed' && how === 'self') {
    steps.push({ label: '확인 알림', mode: 'done' }, { label: '기상 확정', mode: 'on' });
  } else steps.push({ label: '기상 확정', mode: phase === 'confirmed' ? 'on' : 'todo' });

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
        <Text variant="note">
          {label}
        </Text>
        <Text variant="note" weight={600}>
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
  notifText: { marginTop: 4, marginBottom: 12 },
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
