import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, LoadError, Loading, Screen, Text, toast, TopBar } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { checkRoutineStep, getRoutineLiveToken, getTodayRoutine } from '@/features/routine/api';
import { applyTool, buttonNote, coachLine, currentIndex, markStep, startRun, type RunState } from '@/features/routine/run';
import type { RoutineProgress } from '@/features/routine/types';
import { useLiveVoice } from '@/features/voice/hooks/useLiveVoice';
import type { LiveToolCall } from '@/features/voice/live';
import { isMock } from '@/lib/mode';
import { backOrHome } from '@/lib/nav';
import { useAccent } from '@/lib/skyTone';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

// H09 아침 루틴 음성 진행 — 기상 확인이 끝나면 자동으로 열림(H08). 열리면 AI(Gemini Live)가 저절로 오늘 루틴을 한 단계씩 말로 안내 (UI 단순화: [시작] 버튼 없음)
//   연결 페이지는 사람이 누르지 않아도 소리를 낼 수 있게 열어 둠(LiveFrame mediaPlaybackRequiresUserAction=false) — 연결이 안 되거나 끊기면 "음성 다시 켜기"
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

function RoutineRun({ routine }: { routine: RoutineProgress }) {
  const mock = isMock();
  const accent = useAccent(); // 지금 단계 점 — 포인트 색 (lib/skyTone)
  const [run, setRunState] = useState<RunState>(() => startRun(routine.steps, routine.done));
  const runRef = useRef(run); // Live 도구가 렌더 사이에 와도 지금 상태로 처리
  const setRun = (next: RunState) => {
    runRef.current = next;
    setRunState(next);
  };

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

  // 화면이 열리면 저절로 시작 — 한 번만 (live는 렌더마다 새 객체라 ref로 막음). 다 끝낸 루틴은 시작하지 않음
  const autoStarted = useRef(false);
  useEffect(() => {
    if (mock || autoStarted.current || runRef.current.finished) return;
    autoStarted.current = true;
    void live.start();
  }, [mock, live]);

  const index = currentIndex(run);
  const lastAi = [...live.lines].reverse().find((l) => l.who === 'ai')?.text ?? null;
  const line = mock ? coachLine(run) : lastAi;

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

  // 가짜 데이터는 AI 말소리 줄이 곧 안내라 상태 글을 따로 안 둠
  const status = mock
    ? null
    : live.phase === 'connecting'
      ? 'AI와 연결하는 중…'
      : live.phase === 'live'
        ? live.micMuted
          ? 'AI가 말하는 중'
          : '듣고 있어요 — 다 하면 "했어"라고 말해 주세요'
        : (live.error ?? '음성이 꺼져 있어요 — 버튼으로 진행하거나 음성을 다시 켜 주세요');

  return (
    <Screen
      footer={
        <View style={styles.footer}>
          {/* 진행 중 말소리 한 줄 — 가짜 데이터는 지금 단계 문장 */}
          {line ? (
            <View style={styles.say} accessibilityLabel={`AI 말소리: ${line}`}>
              <View style={[styles.sayDot, { backgroundColor: accent }]} />
              <Text variant="small" tone="ink" style={styles.sayText} numberOfLines={2}>
                {line}
              </Text>
            </View>
          ) : null}
          {status ? (
            <Text variant="small" tone="sub">
              {status}
            </Text>
          ) : null}
          {run.finished ? (
            <>
              <Text variant="bodyLarge" weight={600}>
                오늘 아침 루틴을 마쳤어요
              </Text>
              <Button label="홈으로" onPress={home} />
            </>
          ) : (
            <>
              <Button label="했어" onPress={() => press('done')} />
              <View style={styles.links}>
                <TextLink label="건너뛰기" onPress={() => press('skipped')} />
                {!mock && live.phase === 'idle' ? <TextLink label="음성 다시 켜기 ›" onPress={() => void live.start()} /> : null}
              </View>
            </>
          )}
        </View>
      }
    >
      <TopBar onBack={backOrHome} screenId="H09" />
      <Text variant="title" style={styles.title}>
        아침 루틴
      </Text>
      <Text variant="small" style={styles.sub}>
        {routine.title} · {routine.steps.length}단계
      </Text>

      {/* 세로 점 줄 — 지난 단계는 채움, 지금 단계만 포인트 색 */}
      <Card style={styles.steps}>
        {run.steps.map((name, i) => {
          const now = i === index && !run.finished;
          const mark = run.marks[i];
          return (
            <View key={`${i}-${name}`} style={styles.step} accessibilityLabel={`${i + 1}단계 ${name}, ${mark === 'done' ? '했어요' : mark === 'skipped' ? '건너뜀' : now ? '지금' : '아직'}`}>
              <View style={styles.rail}>
                <View style={[styles.dot, mark !== 'todo' && styles.dotDone, now && { backgroundColor: accent, borderColor: accent }]} />
                {i < run.steps.length - 1 ? <View style={styles.bar} /> : null}
              </View>
              <Text
                variant="bodyLarge"
                weight={now ? 700 : undefined}
                tone={now ? 'ink' : mark === 'skipped' || mark === 'todo' ? 'faint' : 'sub'}
                style={[styles.stepName, i === run.steps.length - 1 && styles.stepLast]}
              >
                {name}
              </Text>
            </View>
          );
        })}
      </Card>
      {live.frame}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8 },
  sub: { marginTop: 4 },
  steps: { marginTop: 16 },
  step: { flexDirection: 'row', gap: 14 },
  rail: { width: 14, alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: colors.faint, backgroundColor: colors.card, marginTop: 6 },
  dotDone: { backgroundColor: colors.faint },
  bar: { flex: 1, width: 1.5, backgroundColor: colors.line, marginTop: 4, marginBottom: -2 },
  stepName: { flex: 1, paddingBottom: 18 },
  stepLast: { paddingBottom: 0 },
  actions: { marginTop: 16, gap: 8 },
  footer: { gap: 10 },
  say: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  sayDot: { width: 8, height: 8, borderRadius: 4 },
  sayText: { flex: 1 },
  links: { flexDirection: 'row', justifyContent: 'center', gap: 24 },
});
