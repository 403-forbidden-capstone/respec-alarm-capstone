import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Button,
  Linking,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TopBar } from '@/components/ui';
import { makeDevAlarmId, makeVoiceTestAlarmId } from '@/lib/alarmSync/devAlarm';
import {
  AUTO_STEP_MS,
  autoStageTest,
  departureVoiceTest,
  engineLabel,
  mixOptions,
  SAMPLE,
  sampleAppointmentAt,
  SEQUENCE,
  SEQUENCE_STEP_MS,
  GEMINI_SPEED,
  spokenText,
  stageVoice,
  wakeVoiceTest,
  type Mix,
  type Stage,
  type VoiceOpts,
} from '@/lib/alarmSync/voiceTest';
import { backOrHome } from '@/lib/nav';
import {
  addAlarmEventListener,
  cancelAll,
  canScheduleExactAlarms,
  canUseFullScreenIntent,
  getPendingEvents,
  getUsageSpans,
  hasUsageAccess,
  isAvailable,
  list,
  markEventsUploaded,
  openUsageAccessSettings,
  ringNow,
  ringVoiceTest,
  schedule,
  soundKeyOf,
  stop,
  stopVoiceTest,
  toUseSpans,
  voiceTestStatus,
  volumePercentFor,
  type AlarmEvent,
  type AlarmIntensity,
  type AlarmType,
  type AlarmVibration,
  type RingPackage,
  type ScheduledAlarm,
  type VoiceTestGemini,
  type VoiceTestInfo,
  type VoiceTestStatus,
} from '@capstone/alarm-core';

// 개발용 — 알람 코어를 실기기에서 확인하는 화면 (#26 첫 관문 → #79 새 함수 · #50 시연 버튼 · #35 사용 정보 읽기)
// 탭에 연결하지 않음. 들어오는 법: respecalarm://dev/alarm-test, 또는 로그인 화면의 "알람 테스트" 버튼 (출시용 APK에도 보임, #177)
// 출시 빌드에서 이 화면을 보일지는 D16이 정함 (지금은 /dev 안에만 둠). D16이 정해지면 로그인 화면 버튼도 같이 정리

type Permissions = { exact: boolean; fullScreen: boolean; usage: boolean };

const PERMISSION_NOTE =
  "꺼짐이 있으면 설정 → 앱 → 특별한 앱 접근에서 '알람 및 리마인더' · '전체 화면 알림' · '사용 정보 접근'을 켜 주세요. (폰마다 이름이 조금 다름)";

const KINDS: { type: AlarmType; label: string }[] = [
  { type: 'WAKE', label: '기상 (알람음 + 진동 + 잠금화면)' },
  { type: 'PREPARE', label: '준비 시작 (일반 알림)' },
  { type: 'DEPARTURE', label: '출발 (일반 알림)' },
  { type: 'ARRIVE', label: '도착 (일반 알림)' },
  { type: 'ROUTINE', label: '루틴 (일반 알림)' },
];

const INTENSITIES: { value: AlarmIntensity; label: string }[] = [
  { value: 'SOFT', label: '약 (볼륨 60%)' },
  { value: 'NORMAL', label: '보통 (80%)' },
  { value: 'STRONG', label: '강 (100%)' },
];

const USAGE_LOOKBACK_MINUTES = 30;

// AI 음성 시험 (기상 단계 · 소리 조합 · 출발 1회 안내) — 실제 알람 코어 재생 경로(ringNow와 같은 길)로 울림
const STAGES: Stage[] = [1, 2, 3, 4];
const STAGE_NOTE: Record<Stage, string> = {
  1: '기본 기상 브리핑',
  2: '첫 번째 스누즈 후 — 확실히 높고 빠르게 (미루기 1번 상태로 재현)',
  3: '두 번째 이상 스누즈 또는 여유 5분 이하 — 방문을 열고 소리치는 엄마 (미루기 2번 상태로 재현)',
  4: '남은 여유 0분 이하 — 다급한 긴급 목소리 (여유 0분 시각이 지난 상태로 재현)',
};
// 3 · 4단계 음성 출처 모의 — 어느 것도 Gemini API를 부르지 않음 (미리 받아 둔 · 앱에 든 WAV만)
const GEMINI_SOURCES: { value: VoiceTestGemini; label: string }[] = [
  { value: 'CACHE', label: '개인화 캐시 우선 (없으면 예비 WAV)' },
  { value: 'FALLBACK', label: '캐시 없음 = 한도 초과 · 네트워크 실패 · 비행기 모드 → 예비 WAV' },
  { value: 'BROKEN', label: '깨진 캐시 파일 → 예비 WAV' },
  { value: 'ANDROID', label: '예비 WAV도 못 씀 → Android TTS 대체' },
];
const VIBRATIONS: { value: AlarmVibration; label: string }[] = [
  { value: 'NONE', label: '진동 없음' },
  { value: 'SHORT_REPEAT', label: '짧은 반복' },
  { value: 'STRONG_CONTINUOUS', label: '강한 연속' },
];
const MIXES: { value: Mix; label: string }[] = [
  { value: 'SOUND', label: '알람음만' },
  { value: 'VIBRATION', label: '진동만' },
  { value: 'VOICE', label: 'AI 음성만' },
  { value: 'ALL', label: '전체 함께' },
];
const vibrationLabel = (value: AlarmVibration) => VIBRATIONS.find((item) => item.value === value)?.label ?? value;

type VoiceTestSetupResult = ReturnType<typeof wakeVoiceTest>;

type VoiceTestRun = {
  kind: 'WAKE' | 'DEPARTURE';
  alarmId: string;
  stage: Stage;
  /** 단계를 고른 방법 — 버튼으로 강제 · 시간 자동 전환(1 → 3 → 4) · 차례 시험(1 → 2 → 3 → 4) */
  how: 'STAGE' | 'AUTO' | 'SEQUENCE';
  geminiSource: VoiceTestGemini;
  intensity: AlarmIntensity;
  vibration: AlarmVibration;
  sound: boolean;
  info: VoiceTestInfo | null;
  error: string | null;
};

// 웹 · iOS는 메모리 대체(예약 목록 · 기록)를 눌러 볼 수 있고, 모듈이 없는 Android APK만 막음
const CAN_TRY = isAvailable || Platform.OS !== 'android';

export default function AlarmTestScreen() {
  const [alarms, setAlarms] = useState<ScheduledAlarm[]>([]);
  const [events, setEvents] = useState<AlarmEvent[]>([]);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [intensity, setIntensity] = useState<AlarmIntensity>('NORMAL');
  const [usageLines, setUsageLines] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 다시 읽기 실패는 따로 보여 줌 (예약 · 취소 결과 메시지를 덮어쓰지 않게)
  const [loadError, setLoadError] = useState<string | null>(null);
  const [vibration, setVibration] = useState<AlarmVibration>('SHORT_REPEAT');
  const [stage, setStage] = useState<Stage>(1);
  const [mix, setMix] = useState<Mix>('ALL');
  const [voiceRun, setVoiceRun] = useState<VoiceTestRun | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceTestStatus | null>(null);
  const [geminiSource, setGeminiSource] = useState<VoiceTestGemini>('CACHE');
  // 1 → 2 → 3 → 4 차례 시험의 다음 단계 예약 — [즉시 정지] · 다른 시험 · 화면 닫기에서 지움
  const sequenceTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearSequence = () => {
    sequenceTimers.current.forEach(clearTimeout);
    sequenceTimers.current = [];
  };
  useEffect(() => clearSequence, []);

  const refresh = useCallback(async () => {
    try {
      const [scheduled, pending, exact, fullScreen, usage] = await Promise.all([
        list(),
        getPendingEvents(),
        canScheduleExactAlarms(),
        canUseFullScreenIntent(),
        hasUsageAccess(),
      ]);
      setAlarms(scheduled);
      setEvents(pending);
      setPermissions({ exact, fullScreen, usage });
      setLoadError(null);
    } catch (error) {
      setLoadError(`불러오기 실패: ${errorText(error)}`);
    }
  }, []);

  // 처음 열 때와 앱으로 돌아올 때(알람 해제 뒤 잠금 해제 · 설정에서 권한을 켠 뒤 등) 다시 읽음
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  // 앱이 켜져 있는 동안 새 기록이 생기면 바로 목록에 반영
  useEffect(() => {
    const subscription = addAlarmEventListener(() => {
      refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  // 시험 중에는 1초마다 실제 재생 상태(알람음 주소 · 음성 상태)를 읽음
  useEffect(() => {
    if (!voiceRun || !isAvailable) return;
    const timer = setInterval(() => {
      voiceTestStatus()
        .then(setVoiceStatus)
        .catch(() => setVoiceStatus(null));
    }, 1000);
    return () => clearInterval(timer);
  }, [voiceRun]);

  // 시험 옵션 — 소리 조합 + 3 · 4단계 출처 모의
  const voiceOpts = (options: ReturnType<typeof mixOptions>): VoiceOpts => ({ sound: options.sound, voice: options.voice, gemini: geminiSource });

  // 기상 시험 — 단계 버튼은 지금 소리 조합으로, 소리 조합 버튼은 지금 단계로 바로 울림
  async function runWakeVoice(nextStage: Stage, nextMix: Mix, how: VoiceTestRun['how'] = 'STAGE') {
    if (how === 'STAGE') clearSequence();
    setStage(nextStage);
    setMix(nextMix);
    const options = mixOptions(nextMix, vibration);
    const opts = voiceOpts(options);
    await ringWake(nextStage, how, `AI 음성 시험 ${nextStage}단계`, options, opts, (now) => wakeVoiceTest(nextStage, now, opts));
  }

  // 시간 자동 전환 — 미루기 없이 울리는 동안 30초 뒤 3단계, 60초 뒤 4단계로 바뀌는지
  async function runAutoStage() {
    clearSequence();
    const options = mixOptions(mix, vibration);
    const opts = voiceOpts(options);
    await ringWake(1, 'AUTO', '시간 자동 전환 1 → 3 → 4', options, opts, (now) => autoStageTest(now, opts));
  }

  // 1 → 2 → 3 → 4 차례 — 단계마다 다시 울림 (각 단계 재현은 단계 버튼과 같음)
  function runSequence() {
    clearSequence();
    SEQUENCE.forEach((item, index) => {
      sequenceTimers.current.push(setTimeout(() => void runWakeVoice(item, mix, 'SEQUENCE'), index * SEQUENCE_STEP_MS));
    });
  }

  async function ringWake(
    runStage: Stage,
    how: VoiceTestRun['how'],
    title: string,
    options: ReturnType<typeof mixOptions>,
    opts: VoiceOpts,
    setup: (now: number) => VoiceTestSetupResult,
  ) {
    const now = nowMillis();
    const { snoozeCount, voice } = setup(now);
    const pkg: RingPackage = {
      ...testPackage('WAKE', now, title, intensity),
      alarmId: makeVoiceTestAlarmId(),
      subtitle: `테스트 샘플 · 오전 ${SAMPLE.hour}시 ${SAMPLE.title}`,
      vibration: options.vibration,
      departAt: sampleAppointmentAt(now) - SAMPLE.travelMinutes * 60_000,
    };
    const run = {
      kind: 'WAKE' as const,
      alarmId: pkg.alarmId,
      stage: runStage,
      how,
      intensity,
      vibration: options.vibration,
      sound: options.sound,
      geminiSource: opts.gemini ?? 'CACHE',
    };
    await runVoice(run, () => ringVoiceTest(pkg, snoozeCount, voice));
  }

  // 출발 시험 — 기존 출발 알림 그대로 (알림음 · 진동 한 번 + AI 브리핑 한 번, 기상 배경음 없음, "출발했어요" 버튼)
  async function runDepartureVoice() {
    clearSequence();
    const now = nowMillis();
    const { snoozeCount, voice } = departureVoiceTest(now);
    const pkg: RingPackage = {
      ...testPackage('DEPARTURE', now, `[테스트] ${SAMPLE.title}`, intensity),
      alarmId: makeVoiceTestAlarmId(),
      subtitle: '개발 화면 시험 (샘플 일정 · 출발 기록은 서버에 안 남음)',
    };
    const run = { kind: 'DEPARTURE' as const, alarmId: pkg.alarmId, stage: 1 as const, how: 'STAGE' as const, intensity, vibration, sound: false, geminiSource };
    await runVoice(run, () => ringVoiceTest(pkg, snoozeCount, voice));
  }

  async function runVoice(run: Omit<VoiceTestRun, 'info' | 'error'>, ring: () => Promise<VoiceTestInfo>) {
    setVoiceStatus(null);
    try {
      if (!(await requestNotificationPermission())) {
        setVoiceRun({ ...run, info: null, error: '알림 권한이 없어 알람 화면 · 알림이 안 뜸. 앱 설정에서 알림을 허용해 주세요.' });
        return;
      }
      setVoiceRun({ ...run, info: await ring(), error: null });
    } catch (error) {
      setVoiceRun({ ...run, info: null, error: `재생 못 함: ${errorText(error)}` });
    }
    refresh();
  }

  async function stopVoice() {
    clearSequence();
    try {
      await stopVoiceTest(voiceRun?.alarmId);
      setVoiceRun((run) => (run ? { ...run, error: '즉시 정지함 (AI 음성 시험 알람의 알람음 · 진동 · AI 음성 · 다시 울림 모두. 개발 예약 알람은 그대로)' } : run));
    } catch (error) {
      setMessage(`정지 실패: ${errorText(error)}`);
    }
    refresh();
  }

  async function scheduleTest(type: AlarmType, minutes: number) {
    setMessage(null);
    try {
      if (!(await requestNotificationPermission())) {
        setMessage('알림 권한이 없으면 알림 · 잠금화면 알람 화면이 안 뜸. 앱 설정에서 알림을 허용해 주세요.');
        return;
      }
      const at = nowMillis() + minutes * 60_000;
      const label = KINDS.find((kind) => kind.type === type)?.label ?? type;
      const status = await schedule(testPackage(type, at, `테스트 ${label} (${minutes}분)`, intensity));
      setMessage(
        status === 'scheduled'
          ? isAvailable
            ? `${formatTime(at)}에 울림 (${type}${type === 'WAKE' ? ` · ${intensity}` : ''}). 화면을 끄고 기다려 주세요.`
            : `${formatTime(at)} 예약을 목록에만 올림 (웹 · iOS 메모리 대체라 울리지 않음)`
          : status === 'deferred'
            ? '울리거나 미룬 중이라 새 예약을 미룸 (deferred). 해제 뒤 다시 맞춰 주세요'
            : '시각이 지나서 예약하지 않음 (skipped_past)',
      );
    } catch (error) {
      setMessage(`예약 실패: ${errorText(error)}`);
    }
    refresh();
  }

  async function ringTest(type: AlarmType) {
    setMessage(null);
    try {
      if (!(await requestNotificationPermission())) {
        setMessage('알림 권한이 없으면 알림 · 잠금화면 알람 화면이 안 뜸. 앱 설정에서 알림을 허용해 주세요.');
        return;
      }
      await ringNow(testPackage(type, nowMillis(), `지금 울리기 (${type})`, intensity));
      setMessage(isAvailable ? `${type} 알람을 바로 울림` : `${type} 울림 기록만 남김 (웹 · iOS 메모리 대체라 소리는 안 남)`);
    } catch (error) {
      setMessage(`울리기 실패: ${errorText(error)}`);
    }
    refresh();
  }

  async function cancelEverything() {
    try {
      await cancelAll();
      setMessage('모든 알람을 취소함 (울리는 중이면 멈춤)');
    } catch (error) {
      setMessage(`취소 실패: ${errorText(error)}`);
    }
    refresh();
  }

  async function stopRinging() {
    try {
      await stop();
      setMessage('울리는 알람을 해제 처리함 (해제 기록이 남음)');
    } catch (error) {
      setMessage(`끄기 실패: ${errorText(error)}`);
    }
    refresh();
  }

  async function clearEvents() {
    try {
      await markEventsUploaded(events.map((event) => event.clientEventId));
      setMessage(`기록 ${events.length}개를 서버에 올렸다 치고 폰에서 지움`);
    } catch (error) {
      setMessage(`기록 지우기 실패: ${errorText(error)}`);
    }
    refresh();
  }

  async function readUsage() {
    setUsageLines(null);
    try {
      const to = nowMillis();
      const from = to - USAGE_LOOKBACK_MINUTES * 60_000;
      const spans = await getUsageSpans(from, to);
      // 기상 판정(wake.ts)이 받는 모양 — 기준 시각(여기선 30분 전)부터 몇 분인지
      const minutes = toUseSpans(spans, from);
      const total = minutes.reduce((sum, [start, end]) => sum + (end - start), 0);
      setUsageLines([
        `최근 ${USAGE_LOOKBACK_MINUTES}분 화면 사용 구간 ${spans.length}개 · 합 ${total.toFixed(1)}분`,
        ...spans.map(
          (span, index) =>
            `${formatTime(span.startMillis)} ~ ${formatTime(span.endMillis)}  (${minutes[index][0].toFixed(1)} ~ ${minutes[index][1].toFixed(1)}분)`,
        ),
      ]);
    } catch (error) {
      setUsageLines([`읽기 실패: ${errorText(error)}`]);
    }
  }

  function openSettings() {
    Linking.openSettings().catch(() => setMessage('설정을 열지 못함'));
  }

  async function openUsageSettings() {
    try {
      await openUsageAccessSettings();
    } catch (error) {
      setMessage(`사용 정보 접근 설정을 열지 못함: ${errorText(error)}`);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* 로그인 화면의 "알람 테스트"에서 들어오므로 돌아갈 길을 둠 (안드로이드 뒤로 버튼과 같음). 앞 화면이 없으면 홈 */}
        <TopBar onBack={backOrHome} />
        <Text style={styles.title}>알람 테스트 (개발용)</Text>
        <Text style={styles.body}>
          예약 → 화면 끄기 → 울리는지 확인. 기상 알람은 해제 또는 미루기(5 · 10 · 15분 중 고르기, 최대 3번) 전까지 계속 울려요. AI는 5분 여유부터 3단계, 0분부터 4단계로 올라가요.
          준비 · 출발 · 도착 · 루틴은 보통 알림(알림음 ·
          진동 한 번)이고, 버튼 하나(준비 시작 · 출발했어요 · 도착했어요 · 했어요)를 누르면 기록만 남음.
        </Text>

        {!isAvailable ? (
          <Text style={styles.warning}>
            {Platform.OS === 'android'
              ? '이 APK에는 알람 모듈이 없음. 개발 빌드를 다시 설치해 주세요.'
              : '웹 · iOS에서는 알람이 울리지 않음. 예약 목록과 기록만 메모리에 보임.'}
          </Text>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>권한</Text>
          <Text style={styles.body}>정확한 알람: {permissionText(permissions?.exact)}</Text>
          <Text style={styles.body}>잠금화면 위 알람 화면: {permissionText(permissions?.fullScreen)}</Text>
          <Text style={styles.body}>사용 정보 접근(기상 자동 확인): {permissionText(permissions?.usage)}</Text>
          <Text style={styles.note}>{PERMISSION_NOTE}</Text>
          <Button title="앱 설정 열기" onPress={openSettings} disabled={Platform.OS !== 'android'} />
          <Button title="사용 정보 접근 설정 열기" onPress={openUsageSettings} disabled={!isAvailable} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>기상 AI 음성 테스트</Text>
          <Text style={styles.note}>
            실제 알람 코어로 바로 울림 (배경음 · 진동 · AI 음성 · 잠금화면 화면). 해제 전까지 같은 문장을 다시 읽음. 1 · 2단계는 Android
            오프라인 TTS, 3 · 4단계는 개인화 Gemini 캐시 → 앱에 든 단계별 예비 WAV → Android TTS 순서. 서버 · Gemini 호출 없음 (비행기 모드에서도 됨).
            AI 음성만 듣기는 아래 소리 조합에서 &quot;AI 음성만&quot;
          </Text>
          <View style={styles.chips}>
            {STAGES.map((item) => (
              <Button
                key={item}
                title={`${stage === item ? '● ' : ''}${item}단계 듣기`}
                onPress={() => runWakeVoice(item, mix)}
                disabled={!isAvailable}
              />
            ))}
          </View>
          <Text style={styles.note}>{`${stage}단계: ${STAGE_NOTE[stage]} · ${stageVoice(stage)}`}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>3 · 4단계 Gemini 음성 출처</Text>
          <Text style={styles.note}>
            출처 모의는 다음 시험부터 적용. 개인화 캐시는 실제 알람이 미리 받아 둔 파일이 있을 때만 (보통 없으니 예비 WAV가 나옴). 예비 WAV는 개인 정보 없는 일반 문장
          </Text>
          <View style={styles.chips}>
            {GEMINI_SOURCES.map((item) => (
              <Button
                key={item.value}
                title={`${geminiSource === item.value ? '● ' : '○ '}${item.label}`}
                onPress={() => setGeminiSource(item.value)}
              />
            ))}
          </View>
          <Text style={styles.note}>
            {`재생 속도 고정 (높낮이 그대로): 3단계 ${GEMINI_SPEED[3].toFixed(1)}배 · 4단계 ${GEMINI_SPEED[4].toFixed(1)}배 — 실제 알람과 같음`}
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>시간 자동 전환 (1 → 3 → 4)</Text>
          <Text style={styles.note}>
            {`미루기 없이 계속 울리는 동안 남은 여유가 줄어드는 상황을 앞당겨 재현: 처음 1단계 → ${AUTO_STEP_MS / 1000}초 뒤 여유 5분(3단계 Gemini 엄마) → ${(2 * AUTO_STEP_MS) / 1000}초 뒤 여유 0분(4단계 Gemini 긴급). 배경음 · 진동은 끊기지 않고 단계마다 세짐(진동 없음은 그대로). 아래 "지금 단계"로 확인`}
          </Text>
          <Button title="자동 전환 시험 시작" onPress={runAutoStage} disabled={!isAvailable} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>차례 시험 (1 → 2 → 3 → 4)</Text>
          <Text style={styles.note}>
            {`단계마다 ${SEQUENCE_STEP_MS / 1000}초씩 울린 뒤 다음 단계로 다시 울림 (2단계는 미루기로만 오므로 단계마다 새로 울림). 앱이 화면에 떠 있어야 다음 단계가 이어짐. [즉시 정지]로 멈춤`}
          </Text>
          <Button title="차례 시험 시작" onPress={runSequence} disabled={!isAvailable} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>알람 강도 · 진동</Text>
          <View style={styles.chips}>
            {INTENSITIES.map((item) => (
              <Button
                key={item.value}
                title={`${intensity === item.value ? '● ' : '○ '}${item.label}`}
                onPress={() => setIntensity(item.value)}
              />
            ))}
          </View>
          <View style={styles.chips}>
            {VIBRATIONS.map((item) => (
              <Button
                key={item.value}
                title={`${vibration === item.value ? '● ' : '○ '}${item.label}`}
                onPress={() => setVibration(item.value)}
              />
            ))}
          </View>
          <Text style={styles.note}>
            {`적용될 알람음: ${soundKeyOf({ intensity })} · 알람 볼륨 ${volumePercentFor(intensity)}% · 진동 ${vibrationLabel(vibration)}. 고른 뒤 단계 · 소리 조합 버튼을 누르면 이 값으로 울림`}
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>소리 조합</Text>
          <View style={styles.chips}>
            {MIXES.map((item) => (
              <Button
                key={item.value}
                title={`${mix === item.value ? '● ' : ''}${item.label}`}
                onPress={() => runWakeVoice(stage, item.value)}
                disabled={!isAvailable}
              />
            ))}
          </View>
          <Text style={styles.note}>
            지금 고른 단계로 울림. 알람음을 빼는 구성은 같은 재생 경로에서 크기만 0으로 둠. 전체 함께에서는 AI가 읽는 동안 배경음이 20%로
            줄었다가 다 읽으면 원래대로
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>출발 알림 테스트</Text>
          <Text style={styles.note}>
            {`테스트 샘플: 오전 ${SAMPLE.hour}시 ${SAMPLE.title} · 준비물 ${SAMPLE.items.join(', ')}. 알림음 · 진동 한 번 + AI 출발 브리핑 한 번(반복 없음, 기상 배경음 없음). 알림의 "출발했어요"는 기존과 같고, 시험 알람은 서버에 행이 없어 출발 기록이 남지 않음`}
          </Text>
          <Button title="출발 알림 실제 재생" onPress={runDepartureVoice} disabled={!isAvailable} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>공통</Text>
          <Button title="즉시 정지" color="#B42318" onPress={stopVoice} disabled={!isAvailable} />
          {voiceRun ? <VoiceRunView run={voiceRun} status={voiceStatus} /> : <Text style={styles.note}>아직 시험 안 함</Text>}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1분 뒤 울리기</Text>
          <Text style={styles.note}>강도는 기상 알람에만 적용됨</Text>
          <View style={styles.chips}>
            {INTENSITIES.map((item) => (
              <Button
                key={item.value}
                title={`${intensity === item.value ? '● ' : '○ '}${item.label}`}
                onPress={() => setIntensity(item.value)}
              />
            ))}
          </View>
          {KINDS.map((kind) => (
            <Button
              key={kind.type}
              title={`1분 뒤: ${kind.label}`}
              onPress={() => scheduleTest(kind.type, 1)}
              disabled={!CAN_TRY}
            />
          ))}
          <Button
            title="5분 뒤 기상 알람 (재부팅 확인용)"
            onPress={() => scheduleTest('WAKE', 5)}
            disabled={!CAN_TRY}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>지금 바로 울리기 (예약 없이)</Text>
          {KINDS.map((kind) => (
            <Button
              key={kind.type}
              title={`지금: ${kind.label}`}
              onPress={() => ringTest(kind.type)}
              disabled={!CAN_TRY}
            />
          ))}
          <Button title="울리는 알람 끄기 (해제 처리)" onPress={stopRinging} disabled={!CAN_TRY} />
          <Button title="모든 알람 취소" color="#B42318" onPress={cancelEverything} disabled={!CAN_TRY} />
          {message ? <Text style={styles.message}>{message}</Text> : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>예약된 알람 {alarms.length}개</Text>
          {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
          {alarms.length === 0 ? (
            <Text style={styles.note}>없음</Text>
          ) : (
            alarms.map((alarm) => (
              <View key={alarm.id} style={styles.row}>
                <Text style={styles.body}>
                  {`${alarm.type} · ${alarm.intensity} · ${formatTime(alarm.nextRingAt)} · ${alarm.title}`}
                </Text>
                <Text style={styles.note}>
                  {`처음 ${formatTime(alarm.atMillis)} · 미룬 횟수 ${alarm.snoozeCount} · ${alarm.id}`}
                </Text>
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>폰에 쌓인 기록 {events.length}개 (서버로 안 올린 것)</Text>
          {events.length === 0 ? (
            <Text style={styles.note}>없음</Text>
          ) : (
            events.map((event) => (
              <View key={event.clientEventId} style={styles.row}>
                <Text style={styles.body}>
                  {`${formatTime(event.at)} · ${event.eventType}${event.snoozeMinutes ? ` ${event.snoozeMinutes}분` : ''} · ${event.alarmType} · ${event.sequenceNo}회차`}
                </Text>
                <Text style={styles.note}>{`${event.inputSource} · ${event.clientEventId}`}</Text>
              </View>
            ))
          )}
          <Button
            title="서버에 올렸다 치고 지우기"
            onPress={clearEvents}
            disabled={!CAN_TRY || events.length === 0}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>화면 사용 읽기 (기상 자동 확인, #35)</Text>
          <Text style={styles.note}>
            권한을 켠 뒤 폰을 쓰다가 눌러 보기. 화면이 켜져 있고 잠금이 풀려 있던 구간을 보여 줌
          </Text>
          <Button
            title={`최근 ${USAGE_LOOKBACK_MINUTES}분 사용 구간 읽기`}
            onPress={readUsage}
            disabled={!isAvailable}
          />
          {usageLines
            ? usageLines.map((line, index) => (
                <Text key={index} style={index === 0 ? styles.body : styles.note}>
                  {line}
                </Text>
              ))
            : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// 시험 상태 — 무엇을 어떤 엔진 · 문장 · 진동 · 알람음으로 울렸는지와 지금 재생 상태
function VoiceRunView({ run, status }: { run: VoiceTestRun; status: VoiceTestStatus | null }) {
  const wake = run.kind === 'WAKE';
  const playing = wake ? status?.ringingAlarmId === run.alarmId : status?.departureSpeakingAlarmId === run.alarmId;
  // 울리는 중이면 지금 실제 단계 · 출처 (시간 전환 · 재생 실패로 바뀜), 아니면 울릴 때 고른 것
  const level = (playing ? status?.level : null) ?? run.info?.level ?? null;
  const source = (playing ? status?.source : null) ?? run.info?.source ?? null;
  const lines = [
    `알람 종류: ${wake ? '기상(WAKE)' : '출발(DEPARTURE)'}`,
    wake
      ? run.how === 'AUTO'
        ? 'AI 단계: 시간 자동 전환 시험 (1 → 3 → 4, 테스트 화면이 시각을 앞당김)'
        : `AI 단계: ${run.stage}단계 — ${run.how === 'SEQUENCE' ? '차례 시험 (1 → 2 → 3 → 4)' : '테스트 화면에서 강제 선택'}${run.stage === 4 ? ' (실제 지각 위험이 아님)' : ''}`
      : 'AI 단계: 1단계 출발 촉구 (테스트 샘플 일정)',
    wake ? `3 · 4단계 출처 모의: ${GEMINI_SOURCES.find((item) => item.value === run.geminiSource)?.label ?? run.geminiSource}` : null,
    wake && level != null ? `단계 음성: ${stageVoice(level as Stage)}` : null,
    wake && playing && status?.level != null ? `지금 단계: ${status.level}단계` : null,
    run.info ? `실제 음성 엔진: ${engineLabel({ ...run.info, level, source })}` : null,
    // 울리는 중 단계가 바뀌면(자동 전환) 처음 문장은 맞지 않음 — 예비 WAV만 고정 대사라 보여 줌
    run.info && (level === run.info.level || source === 'GEMINI_FALLBACK') ? `음성 문장: ${spokenText(level, source, run.info.text) ?? '-'}` : null,
    source === 'GEMINI_CACHE' || source === 'GEMINI_FALLBACK' ? `재생 속도: ${(run.info?.speed ?? 1).toFixed(1)}배 (높낮이 그대로)` : null,
    run.info && (source === 'ANDROID' || source === 'ANDROID_FALLBACK')
      ? `말하기: 높낮이 ${run.info.pitch} · 속도 ${run.info.rate} · 목소리 번호 ${run.info.voiceIndex} (폰의 오프라인 한국어 목소리 중)`
      : null,
    `진동: ${wake ? vibrationLabel(run.vibration) : '알림 진동 한 번 (폰 · 알림 설정에 따름)'}`,
    wake
      ? `알람음: ${soundKeyOf({ intensity: run.intensity })} · 알람 볼륨 ${volumePercentFor(run.intensity)}%${run.sound ? '' : ' (시험: 크기 0 — 재생 경로만)'}`
      : '알람음: 알림음 한 번 (기상 배경음 반복 없음)',
    status?.sound && wake ? `실제 튼 알람음: ${status.sound}` : null,
    `재생 상태: ${playing ? (wake ? '울리는 중' : '출발 안내 읽는 중') : '멈춤 또는 끝남'}`,
    status?.speech ? `음성 상태: ${status.speech}` : null,
  ].filter((line): line is string => line != null);
  return (
    <View style={styles.row}>
      {lines.map((line) => (
        <Text key={line} style={styles.body}>
          {line}
        </Text>
      ))}
      {run.error ? <Text style={styles.error}>{run.error}</Text> : null}
    </View>
  );
}

// 실제 폰 시각 (알람은 폰 시계로 울리므로 가짜 시계 lib/clock이 아니라 진짜 시각)
function nowMillis() {
  return Date.now();
}

// 서버 alarm_id처럼 UUID로 만든 테스트 꾸러미 — 앞머리로 개발 알람임을 알려 맞추기가 지우지 않게 함
function testPackage(type: AlarmType, atMillis: number, title: string, intensity: AlarmIntensity): RingPackage {
  return {
    alarmId: makeDevAlarmId(),
    type,
    atMillis,
    title,
    subtitle: '개발 화면 테스트',
    intensity,
    snoozeLimit: 3,
  };
}

// 13 이상은 알림 권한이 있어야 알람 알림 · 잠금화면 위 화면이 뜸
async function requestNotificationPermission() {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

function permissionText(allowed: boolean | undefined) {
  if (allowed === undefined) return '-';
  return allowed ? '허용' : '꺼짐';
}

function formatTime(ms: number) {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 20, gap: 16 },
  title: { fontSize: 22, fontWeight: '700', color: '#1F2328' },
  section: { gap: 8, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#D0D7DE' },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: '#1F2328' },
  body: { fontSize: 15, color: '#1F2328' },
  note: { fontSize: 13, color: '#57606A' },
  warning: { fontSize: 14, color: '#B42318', backgroundColor: '#FEF3F2', padding: 12 },
  message: { fontSize: 14, color: '#0B4F8A' },
  error: { fontSize: 14, color: '#B42318' },
  row: { gap: 2, paddingVertical: 6 },
  chips: { gap: 4 },
});
