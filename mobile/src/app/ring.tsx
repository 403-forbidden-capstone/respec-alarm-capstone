import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Text, toast } from '@/components/ui';
import { getRing } from '@/features/alarm/api';
import { VoiceWave } from '@/features/alarm/components/VoiceWave';
import type { RingKind } from '@/features/alarm/types';
import { formatTime, timeParts } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

const HEAD: Record<RingKind, string> = {
  WAKE: '일어날 시간이에요',
  PREPARE: '준비할 시간이에요',
  DEPARTURE: '출발할 시간이에요',
};
const BACKGROUND: Record<RingKind, string> = {
  WAKE: colors.ringWake,
  PREPARE: colors.ringPrepare,
  DEPARTURE: colors.ringDepart,
};
const SNOOZE_MINUTES = [5, 10, 15] as const;

// H07 알람 울림 — 실제 울림은 알람 코어의 네이티브 화면이 띄움 (#33에서 이 디자인과 맞춤)
// 이 화면은 디자인 · 웹 미리 보기용: /ring?alarm=a1:WAKE (again=1이면 기상 확인 실패 뒤 다시 울림)
export default function RingScreen() {
  const params = useLocalSearchParams<{ alarm?: string; again?: string }>();
  const { data } = useLoad(() => getRing(params.alarm ?? 'a1:WAKE', params.again === '1'));
  const kind: RingKind = data?.kind ?? 'WAKE';
  const [minutes, setMinutes] = useState<number>(5);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // 미루기는 3번까지 (횟수는 알람 코어가 셈, #33)
  function snooze() {
    toast(`${minutes}분 뒤 다시 울려요`);
    close();
  }

  // 기상 알람을 끄면 기상 확인(H08)으로, 준비 · 출발은 안내만
  function dismiss() {
    if (kind === 'WAKE') {
      router.replace({ pathname: '/wake', params: { alarm: data?.alarmId ?? 'a1:WAKE' } });
      return;
    }
    if (kind === 'PREPARE') {
      const items = data?.appointment.items ?? [];
      toast(items.length ? `준비물: ${items.join(', ')}` : '준비를 시작해요');
    } else {
      toast('집을 벗어나면 출발이 자동으로 기록돼요');
    }
    close();
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: BACKGROUND[kind] }]} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      {data ? (
        <View style={styles.body} accessibilityRole="alert" accessibilityLabel={HEAD[kind]}>
          <View style={styles.top}>
            <Text variant="screenId" tone="inverse" style={styles.faded45}>
              H07
            </Text>
            {data.important ? (
              <View style={styles.chip}>
                <Text variant="label" tone="inverse">
                  중요 일정
                </Text>
              </View>
            ) : null}
          </View>

          <Text variant="body" tone="inverse" align="center" style={styles.head}>
            {HEAD[kind]}
          </Text>
          <Text variant="ringTime" tone="inverse" align="center" style={styles.time}>
            {timeParts(data.at).hm}
          </Text>
          <Text variant="big" tone="inverse" align="center" weight={600} style={styles.title}>
            {data.appointment.title}
          </Text>
          <Text variant="small" tone="inverse" align="center" style={styles.faded65}>
            {formatTime(data.appointment.at)} · {data.appointment.place}
          </Text>

          <View style={styles.voice}>
            <Text variant="caption" tone="inverse" style={styles.faded60}>
              음성 안내 · {data.voiceTone}
            </Text>
            <Text variant="reading" tone="inverse" style={styles.voiceText}>
              “{data.voiceLine}”
            </Text>
            <VoiceWave />
          </View>
          <Text variant="caption" tone="inverse" style={styles.levelLine}>
            {data.levelLine}
          </Text>

          <View style={styles.bottom}>
            <Text variant="label" tone="inverse" style={styles.faded70}>
              미루기 시간
            </Text>
            <View style={styles.options} accessibilityRole="radiogroup" accessibilityLabel="미루기 시간">
              {SNOOZE_MINUTES.map((m) => {
                const on = m === minutes;
                return (
                  <Pressable
                    key={m}
                    onPress={() => setMinutes(m)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    style={[styles.option, on && styles.optionOn]}
                  >
                    <Text variant="body" weight={on ? 600 : 400} style={{ color: on ? colors.ringWake : colors.inverse }}>
                      {m}분
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.buttons}>
              <Pressable onPress={snooze} accessibilityRole="button" style={[styles.button, styles.snooze]}>
                <Text variant="button" tone="inverse">
                  {minutes}분 미루기
                </Text>
              </Pressable>
              <Pressable onPress={dismiss} accessibilityRole="button" style={[styles.button, styles.main]}>
                <Text variant="button" style={{ color: colors.ringWake }}>
                  알람 해제
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, paddingTop: 10, paddingHorizontal: 22, paddingBottom: 28 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 26 },
  chip: {
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.ringLine,
    justifyContent: 'center',
  },
  head: { marginTop: 30, fontSize: 15, opacity: 0.8 },
  time: { marginTop: 4 },
  title: { marginTop: 14, marginBottom: 2 },
  voice: { marginTop: 22, backgroundColor: colors.ringPanel, borderRadius: 20, paddingVertical: 16, paddingHorizontal: 18 },
  voiceText: { marginTop: 6 },
  levelLine: { marginTop: 10, marginHorizontal: 2, opacity: 0.55 },
  bottom: { marginTop: 'auto' },
  options: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 16 },
  option: { flex: 1, height: 42, borderRadius: 14, backgroundColor: colors.ringOption, alignItems: 'center', justifyContent: 'center' },
  optionOn: { backgroundColor: colors.inverse },
  buttons: { flexDirection: 'row', gap: 10 },
  button: { height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  snooze: { flex: 1, backgroundColor: colors.ringButton },
  main: { flex: 1.3, backgroundColor: colors.inverse },
  faded45: { opacity: 0.45 },
  faded60: { opacity: 0.6 },
  faded65: { opacity: 0.65 },
  faded70: { opacity: 0.7 },
});
