import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, LoadError, Loading, Screen, Text, toast, TopBar } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { checkRoutineStep, getRoutineLiveToken, getTodayRoutine } from '@/features/routine/api';
import { applyTool, buttonNote, coachLine, currentIndex, markStep, startRun, type RunState, type StepMark } from '@/features/routine/run';
import type { RoutineProgress } from '@/features/routine/types';
import { useLiveVoice } from '@/features/voice/hooks/useLiveVoice';
import type { LiveToolCall } from '@/features/voice/live';
import { isMock } from '@/lib/mode';
import { backOrHome } from '@/lib/nav';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

// H09 아침 루틴 음성 진행 — 기상 확인이 끝나면 자동으로 열림(H08). [시작]을 한 번 누르면 AI(Gemini Live)가 오늘 루틴을 한 단계씩 말로 안내
//   \"했어\"라고 하면 AI가 step_done을 불러 단계를 체크(홈 \"오늘 루틴\" 카드와 같은 기록), 건너뛰면 step_skipped, 다 하면 routine_finished
//   토큰은 서버 routine-live-token — 지침 · 오늘 루틴 · 다음 알람 · 도구가 잠김. 단계를 하는 동안 몇 분씩 말이 없어도 끊지 않음(30초 무발화 끔, 10분 상한은 그대로)
//   [했어] · [건너뛰기] 버튼은 음성이 안 될 때도 같은 일 — 누르면 Live에 앱 글을 넣어 AI가 다음 단계로 넘어감
//   가짜 데이터: 음성 대신 대본(coachLine)으로 AI가 할 말을 보여 주고 버튼으로 진행
export default function RoutineRunScreen() {
  const { data, error, reload } = useLoad(getTodayRoutine);
  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="H09" />
        {error ? <LoadError onRetry={reload} /> : <Loading text="오늘 루틴을 불러오는 중" />}
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="H09" />
        <Text variant="title" style={styles.title}>
          오늘 아침 루틴이 없어요
        </Text>
        <Text variant="small" style={styles.sub}>
          아침 루틴을 만들어 두면 일어난 뒤 AI가 단계를 하나씩 말로 안내해요.
        </Text>
        <View style={styles.actions}>
          <Button label="홈으로" onPress={() => router.dismissTo('/')} />
        </View>
      </Screen>
    );
  }
  return <RoutineRun routine={data} />;
}

const MARK_ICON: Record<StepMark, string> = { done: '✓', skipped: '–', todo: '○' };

function RoutineRun({ routine }: { routine: RoutineProgress }) {
  const mock = isMock();
  const [run, setRunState] = useState<RunState>(() => startRun(routine.steps, routine.done));
  const runRef = useRef(run); // Live 도구가 렌더 사이에 와도 지금 상태로 처리
  const setRun = (next: RunState) => {
    runRef.current = next;
    setRunState(next);
  };
  const [began, setBegan] = useState(false);

  // 끝낸 단계 기록 — 실패해도 화면은 끝낸 것으로 두고 알림 (홈 카드에서 다시 체크할 수 있음)
  const record = (step: number, mark: 'done' | 'skipped', source: 'VOICE' | 'BUTTON') => {
    if (mark !== 'done') return;
    checkRoutineStep(routine.id, step, source).catch(() => toast('단계를 기록하지 못했어요 — 홈의 오늘 루틴에서 다시 체크해 주세요'));
  };

  const live = useLiveVoice(() => getRoutineLiveToken(routine.id), undefined, {
    idle: false,
    onTool: (calls: LiveToolCall[]) =>
      calls.map((call) => {
        const r = applyTool(runRef.current, call);
        if (r.state !== runRef.current) setRun(r.state);
        if (r.changed) record(r.changed.step, r.changed.mark, 'VOICE');
        return r.response;
      }),
  });

  const index = currentIndex(run);
  const lastAi = [...live.lines].reverse().find((l) => l.who === 'ai')?.text ?? null;
  const line = mock ? (began ? coachLine(run) : null) : lastAi;

  function start() {
    setBegan(true);
    if (!mock) void live.start();
  }

  function press(mark: 'done' | 'skipped') {
    if (index < 0) return;
    const step = index + 1;
    const next = markStep(run, step, mark);
    setRun(next);
    record(step, mark, 'BUTTON');
    if (!mock && live.phase === 'live') live.ask(buttonNote(step, mark, next.finished));
  }

  function home() {
    live.stop();
    router.dismissTo('/');
  }

  const status = mock
    ? began
      ? '가짜 데이터 — 실제로는 AI가 이 말을 소리로 하고, "했어"라고 답하면 넘어가요'
      : '시작을 누르면 AI가 단계를 하나씩 말로 안내해요'
    : live.phase === 'connecting'
      ? 'AI와 연결하는 중…'
      : live.phase === 'live'
        ? live.micMuted
          ? 'AI가 말하는 중'
          : '듣고 있어요 — 다 하면 "했어"라고 말해 주세요'
        : (live.error ?? '시작을 누르면 AI가 단계를 하나씩 말로 안내해요');

  return (
    <Screen>
      <TopBar onBack={backOrHome} screenId="H09" />
      <Text variant="title" style={styles.title}>
        아침 루틴
      </Text>
      <Text variant="small" style={styles.sub}>
        {routine.title} · {routine.steps.length}단계
      </Text>

      {line ? (
        <Card style={styles.say}>
          <Text variant="caption">AI</Text>
          <Text variant="bodyLarge" style={styles.sayText}>
            {line}
          </Text>
        </Card>
      ) : null}

      <Card style={styles.steps}>
        {run.steps.map((name, i) => {
          const now = i === index && !run.finished;
          return (
            <View key={`${i}-${name}`} style={styles.step} accessibilityLabel={`${i + 1}단계 ${name}, ${run.marks[i] === 'done' ? '했어요' : run.marks[i] === 'skipped' ? '건너뜀' : now ? '지금' : '아직'}`}>
              <Text variant="bodyLarge" weight={600} tone={run.marks[i] === 'todo' && !now ? 'faint' : 'ink'} style={styles.icon}>
                {now ? '●' : MARK_ICON[run.marks[i]]}
              </Text>
              <Text variant="bodyLarge" weight={now ? 600 : undefined} tone={run.marks[i] === 'skipped' ? 'faint' : 'ink'}>
                {name}
              </Text>
            </View>
          );
        })}
      </Card>

      <Text variant="small" style={styles.status}>
        {status}
      </Text>

      <View style={styles.actions}>
        {run.finished ? (
          <>
            <Text variant="bodyLarge" weight={600}>
              오늘 아침 루틴을 마쳤어요
            </Text>
            <Button label="홈으로" onPress={home} />
          </>
        ) : !began ? (
          <Button label="시작" onPress={start} />
        ) : (
          <>
            <Button label="했어" onPress={() => press('done')} />
            <Button label="건너뛰기" variant="ghost" onPress={() => press('skipped')} />
            {!mock && live.phase === 'idle' ? <TextLink label="음성 다시 켜기 ›" onPress={() => void live.start()} /> : null}
          </>
        )}
      </View>
      {live.frame}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8 },
  sub: { marginTop: 4 },
  say: { marginTop: 16, gap: 4, borderColor: colors.ink },
  sayText: { marginTop: 2 },
  steps: { marginTop: 12, gap: 12 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 20, textAlign: 'center' },
  status: { marginTop: 12 },
  actions: { marginTop: 16, gap: 8 },
});
