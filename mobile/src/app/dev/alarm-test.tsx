import { useCallback, useEffect, useState } from 'react';
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
  makeUuid,
  markEventsUploaded,
  openUsageAccessSettings,
  ringNow,
  schedule,
  stop,
  toUseSpans,
  type AlarmEvent,
  type AlarmIntensity,
  type AlarmType,
  type RingPackage,
  type ScheduledAlarm,
} from '@capstone/alarm-core';

// 개발용 — 알람 코어를 실기기에서 확인하는 화면 (#26 첫 관문 → #79 새 함수 · #50 시연 버튼 · #35 사용 정보 읽기)
// 탭에 연결하지 않음. 들어오는 법: respecalarm://dev/alarm-test
// 출시 빌드에서 이 화면을 보일지는 D16이 정함 (지금은 /dev 안에만 둠)

type Permissions = { exact: boolean; fullScreen: boolean; usage: boolean };

const PERMISSION_NOTE =
  "꺼짐이 있으면 설정 → 앱 → 특별한 앱 접근에서 '알람 및 리마인더' · '전체 화면 알림' · '사용 정보 접근'을 켜 주세요. (폰마다 이름이 조금 다름)";

const KINDS: { type: AlarmType; label: string }[] = [
  { type: 'WAKE', label: '기상 (소리 + 잠금화면)' },
  { type: 'PREPARE', label: '준비 시작 (무음 알림)' },
  { type: 'DEPARTURE', label: '출발 (무음 알림)' },
  { type: 'ARRIVE', label: '도착 (무음 알림)' },
  { type: 'ROUTINE', label: '루틴 (무음 알림)' },
];

const INTENSITIES: { value: AlarmIntensity; label: string }[] = [
  { value: 'SOFT', label: '약 (볼륨 60%)' },
  { value: 'NORMAL', label: '보통 (80%)' },
  { value: 'STRONG', label: '강 (100%)' },
];

const USAGE_LOOKBACK_MINUTES = 30;

export default function AlarmTestScreen() {
  const [alarms, setAlarms] = useState<ScheduledAlarm[]>([]);
  const [events, setEvents] = useState<AlarmEvent[]>([]);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [intensity, setIntensity] = useState<AlarmIntensity>('NORMAL');
  const [usageLines, setUsageLines] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 다시 읽기 실패는 따로 보여 줌 (예약 · 취소 결과 메시지를 덮어쓰지 않게)
  const [loadError, setLoadError] = useState<string | null>(null);

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
          ? `${formatTime(at)}에 울림 (${type}${type === 'WAKE' ? ` · ${intensity}` : ''}). 화면을 끄고 기다려 주세요.`
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
      setMessage(`${type} 알람을 바로 울림`);
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
        <Text style={styles.title}>알람 테스트 (개발용)</Text>
        <Text style={styles.body}>
          예약 → 화면 끄기 → 울리는지 확인. 기상 알람은 해제 또는 10분 미루기. 안 끄면 3분 뒤 멈췄다가 쉬고 다시
          울림 (약 5분 쉬고 1번 · 보통 5분씩 쉬고 2번 · 강 3분씩 쉬고 3번). 소리 없는 알림은 버튼 하나(준비 시작 · 출발했어요 ·
          도착했어요 · 했어요)를 누르면 기록만 남음.
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
              disabled={!isAvailable}
            />
          ))}
          <Button
            title="5분 뒤 기상 알람 (재부팅 확인용)"
            onPress={() => scheduleTest('WAKE', 5)}
            disabled={!isAvailable}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>지금 바로 울리기 (예약 없이)</Text>
          {KINDS.map((kind) => (
            <Button
              key={kind.type}
              title={`지금: ${kind.label}`}
              onPress={() => ringTest(kind.type)}
              disabled={!isAvailable}
            />
          ))}
          <Button title="울리는 알람 끄기 (해제 처리)" onPress={stopRinging} disabled={!isAvailable} />
          <Button title="모든 알람 취소" color="#B42318" onPress={cancelEverything} disabled={!isAvailable} />
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
            disabled={!isAvailable || events.length === 0}
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

// 실제 폰 시각 (알람은 폰 시계로 울리므로 가짜 시계 lib/clock이 아니라 진짜 시각)
function nowMillis() {
  return Date.now();
}

// 서버 alarm_id처럼 UUID로 만든 테스트 꾸러미
function testPackage(type: AlarmType, atMillis: number, title: string, intensity: AlarmIntensity): RingPackage {
  return {
    alarmId: makeUuid(),
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
