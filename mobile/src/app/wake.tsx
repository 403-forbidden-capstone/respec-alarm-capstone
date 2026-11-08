import { router, useLocalSearchParams } from 'expo-router';
import { Fragment, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, LoadError, Loading, ProgressBar, Screen, Text, toast, TopBar } from '@/components/ui';
import { confirmWake, getEarlyWake, getMorningPlan, getWakeCheck, promptWake } from '@/features/alarm/api';
import { EarlyWakeCard } from '@/features/alarm/components/EarlyWakeCard';
import { FormulaBox } from '@/features/alarm/components/FormulaBox';
import { MorningPlanLine } from '@/features/alarm/components/MorningPlanLine';
import { WAKE_OBSERVE_MINUTES, WAKE_RECENT_MINUTES, type WakeCheck } from '@/features/alarm/types';
import { useNextRing } from '@/features/alarm/hooks/useNextRing';
import { useNow } from '@/features/alarm/hooks/useNow';
import { formatUsage, judgeLines, pickAlarmId, WAKE_RECENT_RANGE } from '@/features/alarm/wake';
import { uploadEvents } from '@/lib/alarmSync';
import { addMinutes, formatTime, timeParts } from '@/lib/format';
import { isPreviewAlarmId } from '@/features/alarm/ringPreview';
import { isMock } from '@/lib/mode';
import { backOrHome, openGroupDetail } from '@/lib/nav';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

type Phase = 'observing' | 'prompt' | 'confirmed';
type WakeState = { phase: Phase; usage: number; recent: number; at: Date | null; how: 'self' | 'auto' | null };
type How = WakeState['how'];

const METER_MAX = 5; // 분
const POLL_MS = 15_000; // 실데이터: 관찰 중에는 이만큼마다 판정을 다시 읽음 (관찰 10분이 끝나면 확정 · 확인 알림으로 넘어감)

// 단계 · 사용 시간은 가짜 db에 있음(api) — 시연 값도 api가 정함
function toState(check: WakeCheck): WakeState {
  const use = { usage: check.usage, recent: check.recent };
  const c = check.confirmed;
  if (c) return { phase: 'confirmed', ...use, at: c.at, how: c.how };
  return { phase: check.phase, ...use, at: null, how: null };
}

// H08 기상 확인 — 기상 알람을 끈 뒤 10분 동안 화면 사용으로 판정, 모자라면 확인 알림
// 실제 판정(사용 정보 접근)은 #35 · #40. 지금은 목업처럼 "시연용" 버튼으로 두 경우를 보여 줌
//   열리는 길: 알람을 끄면 알람 코어가 respecalarm://wake?alarmId=<id>로 엶(그 알람의 기상 확인), 앱 안에서는 ?alarm=<id> (pickAlarmId가 둘 다 읽음)
//   실데이터 모드에서는 들어올 때 폰에 쌓인 울림 기록(방금 한 해제 포함)을 먼저 서버에 올림 — 기상 확인 기록이 해제 기록보다 먼저 들어가지 않게 (가짜 모드에서는 아무 일 없음)
export default function WakeScreen() {
  const params = useLocalSearchParams<{ alarmId?: string; alarm?: string }>();
  const alarm = pickAlarmId(params);
  const { data, error, reload } = useLoad(async () => {
    await uploadEvents().catch(() => {}); // 못 올려도 화면은 열림 — 다음 기회에 올라감
    return getWakeCheck(alarm);
  });

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="H08" />
        {error ? <LoadError onRetry={reload} /> : <Loading text="기상 확인을 불러오는 중" />}
      </Screen>
    );
  }
  // 확정 전인데 기상 알람을 아직 안 껐으면(울리기 전 · 울리는 중) 목업 빈 화면 — 알람을 못 찾아도 같음
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="H08" />
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
        <EarlyWake />
      </Screen>
    );
  }
  return <WakeFlow check={data} />;
}

// [먼저 깼어요] — 기상 알람이 울리기 전 60분 안이면 (D61 · 친구 7장). 카드는 홈과 같이 씀
function EarlyWake() {
  const { data } = useLoad(getEarlyWake);
  return data ? <EarlyWakeCard early={data} /> : null;
}

// 단계는 가짜 db에 남아 있어서(api) 화면을 나갔다 와도 이어짐 — 확인 알림 단계면 확인 알림부터
function WakeFlow({ check }: { check: WakeCheck }) {
  const [state, setState] = useState(() => toState(check));
  // 두 번 눌러도 한 단계에서 한 번만 기록 (H07 handled와 같음) — 단계가 바뀌면 다시 누를 수 있음
  const handled = useRef<Phase | null>(null);
  const [confirming, setConfirming] = useState(false); // '일어났어요' 기록 중 — 버튼에 돌아가는 표시
  // 실제로 끈 시각부터 10분 — 미룬 뒤 다시 울려 끄면 그 시각부터. 판정 시점(확정 · 확인 알림)으로만 씀
  // 자동 판정의 기록 시각은 api가 누적 사용이 θ를 넘은 시각으로 남김 (D14)
  const observeEnd = addMinutes(check.dismissedAt, WAKE_OBSERVE_MINUTES);
  // 두 번째 막대 구간(해제 5~10분 뒤)이 아직 안 왔으면 0초 대신 "아직" (#225)
  const current = useNow(POLL_MS);
  const recentPending = state.phase === 'observing' && state.recent === 0 && current < addMinutes(check.dismissedAt, WAKE_OBSERVE_MINUTES - WAKE_RECENT_MINUTES);
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
    setConfirming(true);
    try {
      await confirmWake(check.alarmId, how, observeEnd);
    } catch {
      // 실데이터에서 기록하지 못했을 때(네트워크 등) — 다시 누를 수 있게 풀어 줌 (가짜 데이터는 실패하지 않음)
      handled.current = null;
      setConfirming(false);
      toast('기상을 확인하지 못했어요. 다시 눌러 주세요');
      return;
    }
    // 기록은 끝났으니 화면을 다시 읽다 실패해도 "확인하지 못했어요"라고 하지 않음 — 풀어 두면 다시 눌러 새로 읽을 수 있음 (이미 확정이라 기록은 다시 안 씀)
    await refresh().catch(() => {
      handled.current = null;
    });
    setConfirming(false);
    toast(`기상을 확인했어요${shared}`);
  }

  // 실데이터: 관찰 10분 동안은 판정을 다시 읽어, 끝나면 확정(자동 판정) 또는 확인 알림 단계로 넘어감. 가짜 데이터는 시연 버튼으로 넘김
  // 웹 실데이터 울림 미리보기(ringPreview.ts)도 서버 판정 없이 시연 버튼으로 넘기고, 확정 뒤 다음 알람으로 이어 봄
  const preview = !isMock() && isPreviewAlarmId(check.alarmId);
  const mock = isMock() || preview;
  const next = useNextRing(preview ? check.alarmId : null);
  useEffect(() => {
    if (mock || state.phase !== 'observing') return;
    let stopped = false;
    const timer = setInterval(() => {
      getWakeCheck(check.alarmId)
        .then((next) => {
          if (!stopped && next) setState(toState(next));
        })
        .catch(() => {}); // 못 읽으면 다음 주기에 다시
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [mock, state.phase, check.alarmId]);

  // 시연용: 폰을 보며 일어나면 누적 사용이 θ를 넘어 자동 판정
  const useAndWake = () => confirm('auto');
  // 시연용: 알람만 끄고 다시 자면 조건을 못 채워 관찰이 끝날 때 확인 알림
  async function sleepAgain() {
    if (!first()) return;
    await promptWake(check.alarmId, observeEnd);
    await refresh();
  }
  const meters = (
    <>
      <Meter label={`알람 끈 뒤 ${WAKE_OBSERVE_MINUTES}분 동안 폰 사용`} value={state.usage} threshold={check.thetaMinutes} />
      <Meter label={`알람 끈 뒤 ${WAKE_RECENT_RANGE}분 폰 사용`} value={state.recent} pending={recentPending} />
      <FormulaBox lines={judgeLines(state.usage, state.recent, check.thetaMinutes)} />
    </>
  );

  return (
    <Screen>
      <TopBar onBack={backOrHome} screenId="H08" />
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
              {formatTime(check.dismissedAt)}에 알람을 껐어요 · {WAKE_OBSERVE_MINUTES}분 동안 폰 사용을 보고 있어요
            </Text>
            {meters}
          </Card>
          {mock ? (
            <View style={styles.sim}>
              <Text variant="label" tone="sub" style={styles.simText}>
                시연용 · 알람을 끈 뒤 {WAKE_OBSERVE_MINUTES}분을 어떻게 보낼지 골라 보세요
              </Text>
              <View style={styles.simButtons}>
                <Button label="폰을 보며 일어나기" onPress={useAndWake} />
                <Button label="알람만 끄고 다시 잠들기" variant="ghost" onPress={sleepAgain} />
              </View>
            </View>
          ) : null}
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
            <Button label="일어났어요" small loading={confirming} onPress={() => confirm('self')} />
          </View>
          <Card>
            <Text variant="label" tone="sub">
              조건을 채우지 못해 확인 알림을 보냈어요
            </Text>
            {meters}
          </Card>
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
              {state.how === 'self'
                ? '확인 알림에 직접 응답했어요'
                : `폰 사용으로 자동 판정했어요 · 폰을 ${check.thetaMinutes}분 넘게 쓴 시각으로 기록했어요`}
              {shared}
            </Text>
          </View>
          <Card>{meters}</Card>
          <MorningLine />
          <View style={styles.stack}>
            {next ? <Button label={next.label} onPress={next.open} /> : null}
            <Button label="홈으로" variant={preview ? 'ghost' : 'primary'} onPress={() => router.dismissTo('/')} />
            {check.groupId != null ? (
              <Button
                label={`${check.groupName ?? '그룹'} 기상 현황 보기`}
                variant="ghost"
                onPress={() => openGroupDetail(check.groupId!, 'stack')}
              />
            ) : null}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

// 기상 확정 뒤 오늘 첫 일정 한 줄 (이슈 #230) — 일정 · 나갈 시각 · 다음 알림. 일정 줄을 누르면 알람 설정(H03)
// 덧붙임이라 못 읽어도 기상 확정 화면은 그대로 (LoadError와 다시 시도만 붙음)
function MorningLine() {
  const { data, error, reload } = useLoad(getMorningPlan);
  const current = useNow();
  if (data === undefined) return error ? <LoadError onRetry={reload} /> : null;
  const open = () => {
    if (data) router.push({ pathname: '/alarm/[id]', params: { id: data.appointmentId } });
  };
  return <MorningPlanLine plan={data} current={current} onPress={open} />;
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
function Meter({ label, value, threshold, pending }: { label: string; value: number; threshold?: number; pending?: boolean }) {
  return (
    <View style={styles.meter}>
      <View style={styles.meterHead}>
        <Text variant="note">
          {label}
        </Text>
        <Text variant="note" weight={600} tone={pending ? 'faint' : undefined}>
          {pending ? '아직' : formatUsage(value)}
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
  sim: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.faintDecor, borderRadius: 18, padding: 14, marginTop: 14 },
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
