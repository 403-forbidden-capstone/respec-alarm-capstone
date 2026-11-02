import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenId, Text, toast } from '@/components/ui';
import { dismissRing, getRing, snoozeRing, startRing, stopRing } from '@/features/alarm/api';
import { useNextRing } from '@/features/alarm/components/NextRingButton';
import { VoiceWave } from '@/features/alarm/components/VoiceWave';
import { isPreviewAlarmId } from '@/features/alarm/ringPreview';
import { snoozeView } from '@/features/alarm/snooze';
import type { Appointment, RingKind } from '@/features/alarm/types';
import { formatTime, timeParts } from '@/lib/format';
import { isMock } from '@/lib/mode';
import { backOrHome } from '@/lib/nav';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

// 알람 코어의 순수 계산 파일만 직접 가져옴 (index는 네이티브 모듈을 찾으므로 — 같은 선례: lib/alarmSync 시험)
import {
  canSnooze,
  SNOOZE_LATE_CHIP,
  SNOOZE_MINUTES_OPTIONS,
  snoozeButtonLabel,
  snoozeCountLabel,
  snoozeLateLine,
  snoozeLimitNotice,
  wakeNowBanner,
} from '../../modules/alarm-core/src/plan';

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

// H07 알람 울림 — 실제 울림은 알람 코어의 네이티브 화면이 띄움 (#33에서 이 디자인과 맞춤)
// 이 화면은 디자인 · 웹 미리 보기용: /ring?alarm=a1:WAKE
// 미루기 규칙(D3 기본안 A)은 네이티브 화면과 같음 — 5 · 10 · 15분 중 고르기, 알람 한 개당 3번까지 ("미루기 N/3회"),
//   한도에 닿으면 미루기를 끄고 "지금 바로 준비 · 출발 시각".
//   늦어요는 막지 않고 보여 주기만 함: 늦는 칩은 경고색 + 칩 안 "늦어요", 고른 칩이 늦으면 미루기 버튼 위에 경고 한 줄 · 버튼 "N분 미루기 · 늦어요",
//   5분만 미뤄도 늦으면 시각 위에 "지금 일어나야 9:00 출발에 맞아요" 띠 (계산은 알람 코어의 순수 함수 → features/alarm/snooze.ts)
// 준비 · 출발 알람의 머리글은 폰 알림과 같은 글자(data.notice, 서버 알림 문구 함수) — 없으면 종류별 기본 머리글
export default function RingScreen() {
  const params = useLocalSearchParams<{ alarm?: string }>();
  const alarmId = params.alarm ?? 'a1:WAKE';
  const { data, error } = useLoad(() => getRing(alarmId));
  const preview = !isMock() && isPreviewAlarmId(alarmId); // 웹 실데이터 미리보기 — 저장된 일정으로 보여 주기만, 기록 없음 (ringPreview.ts)
  // 읽는 동안에도 맞는 배경이 보이게 알람 id(<일정>:<종류>)의 종류를 먼저 씀
  const fromId = params.alarm?.split(':')[1];
  const kind: RingKind = data?.kind ?? (fromId && Object.keys(HEAD).includes(fromId) ? (fromId as RingKind) : 'WAKE');
  const [minutes, setMinutes] = useState<number>(SNOOZE_MINUTES_OPTIONS[0]);
  const [done, setDone] = useState(false); // 준비 · 출발 알람을 끈 뒤 — 안내를 화면에 남김
  const handled = useRef(false); // 두 번 눌러도 해제 · 미루기는 한 번만 기록

  // 울리는 동안 안드로이드 뒤로 가기는 막음 — 해제 · 미루기 없이 나가면 알람이 그냥 사라짐 (웹은 해당 없음)
  const ringing = data != null && !done;
  useEffect(() => {
    if (Platform.OS === 'web' || !ringing) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [ringing]);

  // 울림을 읽은 뒤 내 상태를 '알람 울리는 중'으로 (기상 알람만), 미루기 · 해제 없이 나가면(안드로이드 · 웹 뒤로 가기) 그 표시만 지움
  // 불러오는 함수가 아니라 여기서 시작해야, 읽는 도중에 나가도 지우기가 시작보다 먼저 돌지 않음
  const ringId = data?.alarmId ?? null;
  const ringAt = data?.at.getTime() ?? null;
  useEffect(() => {
    if (!ringId || ringAt == null) return;
    void startRing(ringId, new Date(ringAt));
    return () => {
      if (!handled.current) void stopRing(ringId);
    };
  }, [ringId, ringAt]);

  // 미루기는 3번까지 — 실데이터에서는 알람 코어가 셈 (이 화면은 미리 보기라 가짜 데이터가 셈)
  const snoozeAllowed = data != null && canSnooze(data.snoozeCount, data.snoozeLimit);
  const view = data ? snoozeView(data) : null;
  const departClock = data?.departAt ? timeParts(data.departAt).hm : null; // "9:00"
  const selectedLate = view?.chips.find((chip) => chip.minutes === minutes)?.lateMinutes ?? 0;
  async function snooze() {
    if (!data || handled.current || !canSnooze(data.snoozeCount, data.snoozeLimit)) return;
    handled.current = true;
    await snoozeRing(data.alarmId, minutes, data.at);
    toast(preview ? '미리보기라 다시 울리지 않아요' : `${minutes}분 뒤 다시 울려요`);
    backOrHome();
  }

  // 기상 알람을 끄면 기상 확인(H08)으로, 준비 · 출발은 결과 안내 화면
  // 끈 시각 = 지금 울리는 시각 — 기상 확인이 이 시각부터 10분을 봄
  async function dismiss() {
    if (!data || handled.current) return;
    handled.current = true;
    await dismissRing(data.alarmId, data.at);
    if (data.kind === 'WAKE') {
      // 목업 A.dismiss처럼 [홈, 기상 확인] — 기상 확인에서 뒤로 가면 홈
      router.dismissTo('/');
      router.push({ pathname: '/wake', params: { alarm: data.alarmId } });
      return;
    }
    // 준비 · 출발은 잠깐 뜨는 토스트 대신 화면에 안내를 남기고 "확인"으로 홈에
    setDone(true);
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: BACKGROUND[kind] }]} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      {data && done && data.kind !== 'WAKE' ? (
        <DonePanel kind={data.kind} appointment={data.appointment} next={preview ? data.alarmId : null} />
      ) : data ? (
        <View style={styles.body} accessibilityRole="alert" accessibilityLabel={data.notice ?? HEAD[kind]}>
          <View style={styles.top}>
            <View><ScreenId id="H07" tone="inverse" style={styles.faded45} /></View>
            {preview ? (
              <Text variant="caption" tone="inverse" style={styles.faded65}>
                미리보기 · 기록 안 남음
              </Text>
            ) : null}
            {data.important ? (
              <View style={styles.chip}>
                <Text variant="label" tone="inverse">
                  중요 일정
                </Text>
              </View>
            ) : null}
          </View>

          <Text variant="bodyLarge" tone="inverse" align="center" style={styles.head}>
            {data.notice ?? HEAD[kind]}
          </Text>
          {view?.wakeNow && departClock ? (
            <View style={styles.warnStrip} accessibilityRole="alert">
              <Text variant="bodyStrong" tone="inverse" align="center">
                {wakeNowBanner(departClock)}
              </Text>
            </View>
          ) : null}
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

          <View style={styles.bottom}>
            <View style={styles.optionsHead}>
              <Text variant="label" tone="inverse" style={styles.faded70}>
                미루기 시간
              </Text>
              <Text variant="label" tone="inverse" style={styles.faded70}>
                {snoozeCountLabel(data.snoozeCount, data.snoozeLimit)}
              </Text>
            </View>
            {snoozeAllowed ? null : (
              <Text variant="bodyStrong" tone="inverse" style={styles.limitNotice}>
                {snoozeLimitNotice(data.departAt ? formatTime(data.departAt) : null)}
              </Text>
            )}
            <View style={styles.options} accessibilityRole="radiogroup" accessibilityLabel="미루기 시간">
              {SNOOZE_MINUTES_OPTIONS.map((m) => {
                const on = m === minutes;
                // 울리는 시각 기준으로 다시 울릴 시각이 출발 시각을 넘으면 늦음 (네이티브는 지금 시각 기준)
                const late = (view?.chips.find((chip) => chip.minutes === m)?.lateMinutes ?? 0) > 0;
                const textColor = late ? (on ? colors.danger : colors.inverse) : on ? colors.ringWake : colors.inverse;
                return (
                  <Pressable
                    key={m}
                    onPress={() => setMinutes(m)}
                    disabled={!snoozeAllowed}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on, disabled: !snoozeAllowed }}
                    accessibilityHint={late ? SNOOZE_LATE_CHIP : undefined}
                    style={[styles.option, late ? (on ? styles.optionLateOn : styles.optionLate) : on && styles.optionOn, !snoozeAllowed && styles.disabled]}
                  >
                    <Text variant="body" weight={on || late ? 600 : 400} style={{ color: textColor }}>
                      {m}분
                    </Text>
                    {late ? (
                      <Text variant="caption" weight={700} style={{ color: textColor }}>
                        {SNOOZE_LATE_CHIP}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
            {selectedLate > 0 && departClock ? (
              <View style={styles.warnLine} accessibilityRole="alert">
                <Text variant="bodyStrong" tone="inverse" align="center">
                  {snoozeLateLine(minutes, departClock, selectedLate)}
                </Text>
              </View>
            ) : null}
            <View style={styles.buttons}>
              <Pressable
                onPress={snooze}
                disabled={!snoozeAllowed}
                accessibilityRole="button"
                accessibilityState={{ disabled: !snoozeAllowed }}
                style={[styles.button, styles.snooze, selectedLate > 0 && styles.snoozeLate, !snoozeAllowed && styles.disabled]}
              >
                <Text variant="button" tone="inverse">
                  {snoozeButtonLabel(minutes, selectedLate > 0)}
                </Text>
              </Pressable>
              <Pressable onPress={dismiss} accessibilityRole="button" style={[styles.button, styles.main]}>
                {/* 목업 .rbtn.main 글자색은 종류와 상관없이 #141414 */}
                <Text variant="button" style={{ color: colors.ringWake }}>
                  알람 해제
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : data === null || (data === undefined && error) ? (
        // 웹 미리 보기에서 알람 id가 틀렸거나 도착(울리지 않는 알림)일 때
        <View style={styles.missing}>
          <Text variant="body" tone="inverse" align="center">
            울릴 알람을 찾을 수 없어요
          </Text>
          <Pressable onPress={backOrHome} accessibilityRole="button" style={[styles.button, styles.closeButton]}>
            <Text variant="button" style={{ color: BACKGROUND[kind] }}>
              닫기
            </Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

// 준비 · 출발 알람을 끈 뒤 안내 — 준비물 체크(준비) · 이동 시간과 도착 목표(출발), "확인"을 누르면 홈
// next = 웹 미리보기에서 이어 볼 알람의 기준(지금 끈 알람 id) — 있으면 [다음 알람 울려 보기]
function DonePanel({ kind, appointment: a, next: from }: { kind: Exclude<RingKind, 'WAKE'>; appointment: Appointment; next: string | null }) {
  const [checked, setChecked] = useState<string[]>([]);
  const next = useNextRing(from);
  const arrive = a.alarms.find((x) => x.kind === 'ARRIVE');
  return (
    <View style={styles.body}>
      <View style={styles.top}>
        <View><ScreenId id="H07" tone="inverse" style={styles.faded45} /></View>
      </View>
      <Text variant="bodyLarge" tone="inverse" align="center" style={styles.head}>
        {kind === 'PREPARE' ? '준비를 시작해요' : '출발해요'}
      </Text>
      <Text variant="big" tone="inverse" align="center" weight={600} style={styles.title}>
        {a.title}
      </Text>
      <Text variant="small" tone="inverse" align="center" style={styles.faded65}>
        {formatTime(a.at)} · {a.place}
      </Text>

      <View style={styles.voice}>
        {kind === 'PREPARE' ? (
          <>
            <Text variant="caption" tone="inverse" style={styles.faded60}>
              챙길 준비물
            </Text>
            {a.items.length ? (
              a.items.map((name) => {
                const on = checked.includes(name);
                return (
                  <Pressable
                    key={name}
                    onPress={() => setChecked((list) => (on ? list.filter((x) => x !== name) : [...list, name]))}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    style={styles.checkRow}
                  >
                    <View style={[styles.checkBox, on && styles.checkBoxOn]}>
                      {on ? (
                        <Text variant="label" style={{ color: colors.ringWake }}>
                          ✓
                        </Text>
                      ) : null}
                    </View>
                    <Text variant="reading" tone="inverse" style={on && styles.checked}>
                      {name}
                    </Text>
                  </Pressable>
                );
              })
            ) : (
              <Text variant="reading" tone="inverse" style={styles.voiceText}>
                챙길 준비물이 없어요. 준비를 시작해요.
              </Text>
            )}
          </>
        ) : (
          <>
            <Text variant="caption" tone="inverse" style={styles.faded60}>
              이동
            </Text>
            <Text variant="reading" tone="inverse" style={styles.voiceText}>
              이동 {a.travelMinutes}분{arrive ? ` · 도착 목표 ${formatTime(arrive.at)}` : ''}
            </Text>
            <Text variant="note" tone="inverse" style={[styles.voiceText, styles.faded65]}>
              집을 벗어나면 출발이 자동으로 기록돼요.
            </Text>
          </>
        )}
      </View>

      <View style={styles.bottom}>
        {next ? (
          <Pressable onPress={next.open} accessibilityRole="button" style={[styles.button, styles.closeButton, styles.nextButton]}>
            <Text variant="button" style={{ color: colors.ringWake }}>
              {next.label}
            </Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => router.dismissTo('/')} accessibilityRole="button" style={[styles.button, styles.closeButton]}>
          <Text variant="button" style={{ color: colors.ringWake }}>
            확인
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, paddingTop: 10, paddingHorizontal: 22, paddingBottom: 28 },
  missing: { flex: 1, justifyContent: 'center', gap: 16, paddingHorizontal: 22 },
  closeButton: { backgroundColor: colors.inverse },
  nextButton: { marginBottom: 10 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 26 },
  chip: {
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.ringLine,
    justifyContent: 'center',
  },
  head: { marginTop: 30, opacity: 0.8 },
  time: { marginTop: 4 },
  title: { marginTop: 14, marginBottom: 2 },
  voice: { marginTop: 22, backgroundColor: colors.ringPanel, borderRadius: 20, paddingVertical: 16, paddingHorizontal: 18 },
  voiceText: { marginTop: 6 },
  bottom: { marginTop: 'auto' },
  optionsHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  limitNotice: { marginTop: 8 },
  options: { flexDirection: 'row', alignItems: 'stretch', gap: 8, marginTop: 8, marginBottom: 16 },
  warnStrip: { marginTop: 14, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: colors.danger },
  warnLine: { marginBottom: 12, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: colors.danger },
  disabled: { opacity: 0.35 },
  option: {
    flex: 1,
    minHeight: 42,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.ringOption,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionOn: { backgroundColor: colors.inverse },
  optionLate: { backgroundColor: colors.danger }, // 늦게 되는 칩 — 경고 바탕
  optionLateOn: { backgroundColor: colors.inverse, borderColor: colors.warn }, // 고른 늦는 칩 — 흰 바탕 + 경고 테두리
  buttons: { flexDirection: 'row', gap: 10 },
  button: { height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  snooze: { flex: 1, backgroundColor: colors.ringButton, borderWidth: 2, borderColor: 'transparent' },
  snoozeLate: { borderColor: colors.warn }, // 늦는 분을 골랐을 때 경고 테두리 (눌림 — 막지 않음)
  main: { flex: 1.3, backgroundColor: colors.inverse },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  checkBox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: colors.ringLine, alignItems: 'center', justifyContent: 'center' },
  checkBoxOn: { backgroundColor: colors.inverse, borderColor: colors.inverse },
  checked: { textDecorationLine: 'line-through', opacity: 0.6 },
  faded45: { opacity: 0.45 },
  faded60: { opacity: 0.6 },
  faded65: { opacity: 0.65 },
  faded70: { opacity: 0.7 },
});
