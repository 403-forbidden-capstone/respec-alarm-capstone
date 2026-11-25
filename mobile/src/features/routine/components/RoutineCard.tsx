import { Fragment } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card, ProgressBar, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';

import type { RoutineProgress } from '../types';

// 오늘 루틴 카드 (.rcard) — 누를 때마다 다음 단계를 끝냄, 끝낸 단계는 줄을 그음 (사이 구분자 ' · '에는 줄을 긋지 않음)
//   onVoice — 남은 단계가 있으면 카드 아래 "음성으로 진행 ›" (아침 루틴 음성 진행 H09). 기상 확인 뒤 못 들어갔거나 나중에 할 때
//   카드 밖에 둠 — 카드 전체가 "다음 단계 끝내기" 버튼이라, 안에 두면 누를 때 단계도 끝나고 화면 읽기도 섞임
//   bare — 카드 바깥 틀 없이 안쪽만 (홈에서 준비물과 한 카드 안 두 구역으로 묶을 때)
export function RoutineCard({ routine, onPress, onVoice, bare }: { routine: RoutineProgress; onPress: () => void; onVoice?: () => void; bare?: boolean }) {
  const label = `${routine.title} 다음 단계 끝내기 · ${routine.steps.length}단계 중 ${routine.done}단계 끝냄`;
  const body = (
    <>
      <Text variant="bodyLarge" weight={600}>
        {routine.title}
      </Text>
      <Text variant="small" tone="sub" style={styles.steps}>
        {routine.steps.map((step, i) => (
          <Fragment key={i}>
            <Text variant="small" tone={i < routine.done ? 'faint' : 'sub'} style={i < routine.done && styles.done}>
              {step}
            </Text>
            {i < routine.steps.length - 1 ? ' · ' : ''}
          </Fragment>
        ))}
      </Text>
      <View>
        <ProgressBar value={routine.done / routine.steps.length} />
      </View>
    </>
  );
  const voice = (
    <>
    {onVoice && routine.done < routine.steps.length ? (
      <View style={styles.voice}>
        <TextLink label="음성으로 진행 ›" onPress={onVoice} />
      </View>
    ) : null}
    </>
  );
  if (bare) {
    return (
      <>
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => pressed && styles.pressed}>
          {body}
        </Pressable>
        {voice}
      </>
    );
  }
  return (
    <>
      <Card onPress={onPress} accessibilityLabel={label}>
        {body}
      </Card>
      {voice}
    </>
  );
}

const styles = StyleSheet.create({
  steps: { marginTop: 2 },
  done: { textDecorationLine: 'line-through' },
  voice: { marginTop: 8, alignItems: 'flex-end' },
  pressed: { opacity: 0.7 },
});
