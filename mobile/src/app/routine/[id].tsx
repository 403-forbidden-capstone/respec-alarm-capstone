import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, KeyValueRow, Screen, Sheet, Text, toast, Toggle, TopBar } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { getRoutine, saveRoutine } from '@/features/routine/api';
import { DayPicker } from '@/features/routine/components/DayPicker';
import { RoutineStepRow } from '@/features/routine/components/RoutineStepRow';
import { StepEditor } from '@/features/routine/components/StepEditor';
import { addStep, canSave, moveStep, removeStep, savedMessage, stepTimes, toggleDay, updateStep } from '@/features/routine/draft';
import type { Routine } from '@/features/routine/types';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

// A04 루틴 편집 — 일기(A03)의 루틴 제안을 내 생활에 맞게 고쳐 저장 (저장해야 루틴 · 단계 알람이 생김)
// /routine/new?journal=2025-05-22 = 그 일기의 제안으로 만든 초안, /routine/r2 = 저장한 루틴
export default function RoutineScreen() {
  const { id, journal } = useLocalSearchParams<{ id: string; journal?: string }>();
  const { data } = useLoad(() => getRoutine(id, journal));

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="A04" />
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="A04" />
        <Text variant="body" tone="sub">
          편집할 루틴이 없어요.
        </Text>
      </Screen>
    );
  }
  return <RoutineEditor key={data.id ?? 'new'} initial={data} />;
}

function RoutineEditor({ initial }: { initial: Routine }) {
  const [routine, setRoutine] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null); // 편집 시트를 연 단계
  const { busy: saving, run: runSave } = useAction(); // 두 번 눌러도 루틴이 한 벌만 생기게
  const times = stepTimes(routine);
  const index = routine.steps.findIndex((s) => s.id === editing);
  const step = index >= 0 ? routine.steps[index] : null;

  // 저장 — 제안에서 왔으면 일기로 돌아감. 주소로 바로 열었으면 저장한 루틴 주소로 바꿈. 한 번에 하나씩, 실패하면 토스트 (lib/useAction)
  const save = () =>
    runSave(async () => {
      const saved = await saveRoutine(routine);
      toast(savedMessage(saved));
      if (router.canGoBack()) router.back();
      else if (saved.id) router.replace({ pathname: '/routine/[id]', params: { id: saved.id } });
    }, '루틴을 저장하지 못했어요');

  function removeEditing() {
    if (!step) return;
    setRoutine((r) => removeStep(r, step.id));
    setEditing(null);
  }

  return (
    <Screen>
      <TopBar onBack={backOrHome} screenId="A04" />
      <Text variant="title" style={styles.title}>
        {routine.title}
      </Text>
      <Text variant="lead" style={styles.lead}>
        제안된 루틴을 확인하고 내 생활에 맞게 조정하세요.
      </Text>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          루틴 정보
        </Text>
        <KeyValueRow first label="이름" value={routine.title} />
        <KeyValueRow label="목표" value={routine.goal} />
      </Card>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          반복 요일
        </Text>
        <DayPicker value={routine.days} onToggle={(day) => setRoutine((r) => toggleDay(r, day))} />
      </Card>

      <Card>
        <View style={styles.between}>
          <Text variant="label" tone="sub">
            단계별 실행
          </Text>
          <TextLink label="+ 단계 추가" onPress={() => setRoutine(addStep)} />
        </View>
        {routine.steps.map((s, i) => (
          <RoutineStepRow
            key={s.id}
            first={i === 0}
            step={s}
            time={times[i]}
            onPress={() => setEditing(s.id)}
            onToggleAlarm={(alarm) => setRoutine((r) => updateStep(r, s.id, { alarm }))}
          />
        ))}
      </Card>

      <Card>
        <View style={styles.between}>
          <View style={styles.flex}>
            <Text variant="bodyStrong">루틴 활성화</Text>
            <Text variant="small" tone="sub">
              {routine.days.length ? `다음 ${routine.days[0]}요일부터 시작해요.` : '반복 요일을 골라 주세요.'}
            </Text>
          </View>
          <Toggle value={routine.active} onChange={(active) => setRoutine((r) => ({ ...r, active }))} label="루틴 활성화" />
        </View>
      </Card>

      <View style={styles.stack}>
        <Button label="루틴 저장" onPress={save} disabled={!canSave(routine) || saving} />
      </View>

      <Sheet visible={step != null} onClose={() => setEditing(null)} title="단계 편집">
        {step ? (
          <StepEditor
            step={step}
            time={times[index]}
            index={index}
            count={routine.steps.length}
            onChange={(patch) => setRoutine((r) => updateStep(r, step.id, patch))}
            onMove={(by) => setRoutine((r) => moveStep(r, step.id, by))}
            onRemove={removeEditing}
            onClose={() => setEditing(null)}
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  label: { marginBottom: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  flex: { flex: 1 },
  stack: { gap: 10, marginTop: 16 },
});
