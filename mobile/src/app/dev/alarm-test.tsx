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
  cancelAllAlarms,
  canScheduleExactAlarms,
  canUseFullScreenIntent,
  getScheduledAlarms,
  isAlarmCoreAvailable,
  scheduleOneShotAlarm,
  type ScheduledAlarm,
} from '@capstone/alarm-core';

// 개발용 — 잠금화면 위로 알람이 울리는지 실기기에서 확인하는 화면 (#26 첫 관문)
// 탭에 연결하지 않음. 들어오는 법: respecalarm://dev/alarm-test

type Permissions = { exact: boolean; fullScreen: boolean };

const PERMISSION_NOTE =
  "꺼짐이 있으면 설정 → 앱 → 특별한 앱 접근에서 '알람 및 리마인더' · '전체 화면 알림'을 켜 주세요. (폰마다 이름이 조금 다름)";

export default function AlarmTestScreen() {
  const [alarms, setAlarms] = useState<ScheduledAlarm[]>([]);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isAlarmCoreAvailable) return;
    try {
      const [list, exact, fullScreen] = await Promise.all([
        getScheduledAlarms(),
        canScheduleExactAlarms(),
        canUseFullScreenIntent(),
      ]);
      setAlarms(list);
      setPermissions({ exact, fullScreen });
    } catch (error) {
      setMessage(`불러오기 실패: ${errorText(error)}`);
    }
  }, []);

  // 처음 열 때와 앱으로 돌아올 때(알람 해제 뒤 잠금 해제 등) 다시 읽음
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  async function scheduleTest(minutes: number) {
    setMessage(null);
    try {
      if (!(await requestNotificationPermission())) {
        setMessage('알림 권한이 없으면 잠금화면에 알람 화면이 안 뜸. 앱 설정에서 알림을 허용해 주세요.');
        return;
      }
      const at = Date.now() + minutes * 60_000;
      await scheduleOneShotAlarm(`dev-test-${Date.now()}`, `테스트 알람 (${minutes}분)`, at);
      setMessage(`${formatTime(at)}에 울림. 화면을 끄고 기다려 주세요.`);
    } catch (error) {
      setMessage(`예약 실패: ${errorText(error)}`);
    }
    refresh();
  }

  async function cancelAll() {
    try {
      await cancelAllAlarms();
      setMessage('모든 알람을 취소함 (울리는 중이면 멈춤)');
    } catch (error) {
      setMessage(`취소 실패: ${errorText(error)}`);
    }
    refresh();
  }

  function openSettings() {
    Linking.openSettings().catch(() => setMessage('설정을 열지 못함'));
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>알람 테스트 (개발용)</Text>
        <Text style={styles.body}>
          예약 → 화면 끄기 → 잠금화면 위로 울리는지 확인. 울리면 해제 또는 10분 미루기.
        </Text>

        {!isAlarmCoreAvailable ? (
          <Text style={styles.warning}>
            {Platform.OS === 'android'
              ? '이 APK에는 알람 모듈이 없음. 개발 빌드를 다시 설치해 주세요.'
              : 'Android 전용 화면. 웹에서는 알람이 울리지 않음.'}
          </Text>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>권한</Text>
          <Text style={styles.body}>정확한 알람: {permissionText(permissions?.exact)}</Text>
          <Text style={styles.body}>잠금화면 위 알람 화면: {permissionText(permissions?.fullScreen)}</Text>
          <Text style={styles.note}>{PERMISSION_NOTE}</Text>
          <Button title="앱 설정 열기" onPress={openSettings} disabled={Platform.OS !== 'android'} />
        </View>

        <View style={styles.section}>
          <Button
            title="1분 뒤 테스트 알람"
            onPress={() => scheduleTest(1)}
            disabled={!isAlarmCoreAvailable}
          />
          <Button
            title="5분 뒤 테스트 알람 (재부팅 확인용)"
            onPress={() => scheduleTest(5)}
            disabled={!isAlarmCoreAvailable}
          />
          <Button
            title="모든 알람 취소"
            color="#B42318"
            onPress={cancelAll}
            disabled={!isAlarmCoreAvailable}
          />
          {message ? <Text style={styles.message}>{message}</Text> : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>예약된 알람 {alarms.length}개</Text>
          {alarms.length === 0 ? (
            <Text style={styles.note}>없음</Text>
          ) : (
            alarms.map((alarm) => (
              <View key={alarm.id} style={styles.row}>
                <Text style={styles.body}>
                  {`${formatTime(alarm.triggerAtMillis)} · ${alarm.repeat === 'DAILY' ? '매일' : '한 번'} · ${alarm.title}`}
                </Text>
                <Text style={styles.note}>{alarm.id}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
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
  row: { gap: 2, paddingVertical: 6 },
});
