import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Button, Card, Screen, SectionHeader, Stepper, Text, Toggle, TopBar } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { inspectMyUpcomingAlarms, inspectPurePrepDb, type LegacyAlarmSnapshot, type PurePrepDbStatus } from '@/features/dev/purePrepDiagnostics';
import {
  calculatePurePrepScenario, DEFAULT_PURE_SCENARIO, kstHm, type PurePrepScenarioInput,
} from '@/features/dev/purePrepScenario';
import { useMode } from '@/lib/mode';

// Developer-only WEB testing bench: read-only DB inspection + pure calculator.
// Never submits alarm-commit, modifies the user, deploys a migration,
// or schedules a phone alarm. Web cannot test Android native delivery.
export default function PurePrepWebTest() {
  const { mode } = useMode();
  const { session, profile } = useAuth();
  const [scenario, setScenario] = useState<PurePrepScenarioInput>(DEFAULT_PURE_SCENARIO);
  const [status, setStatus] = useState<PurePrepDbStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [realAlarms, setRealAlarms] = useState<LegacyAlarmSnapshot[] | null>(null);
  const [realAlarmError, setRealAlarmError] = useState(false);
  const result = calculatePurePrepScenario(scenario);

  const setField = (patch: Partial<PurePrepScenarioInput>) =>
    setScenario((old) => ({ ...old, ...patch }));
  async function checkSchema() {
    if (mode !== 'real' || !session || loading) return;
    setLoading(true);
    setStatus(null);
    try {
      setStatus(await inspectPurePrepDb(session.user.id));
    } catch {
      setStatus({ kind: 'error', reason: '읽기 전용 진단에서 네트워크 오류가 발생했습니다.' });
    } finally {
      setLoading(false);
    }
  }
  async function readExistingAlarms() {
    if (mode !== 'real' || !session || loading) return;
    setLoading(true);
    setRealAlarms(null);
    setRealAlarmError(false);
    try {
      setRealAlarms(await inspectMyUpcomingAlarms(session.user.id));
    } catch {
      setRealAlarmError(true);
    } finally {
      setLoading(false);
    }
  }
  const rows = [
    ['기상', result.WAKE],
    ['준비 시작', result.PREPARE],
    ['출발', result.DEPARTURE],
    ['도착 목표', result.ARRIVE],
  ] as const;

  return (
    <Screen>
      <TopBar onBack={router.canGoBack() ? router.back : undefined} screenId="DEV" />
      <Text variant="title">순수 준비시간 · 웹 통합 시험</Text>
      <Text variant="small" tone="sub">
        실제 서비스와 동일한 순수 준비시간 계산 모듈을 사용합니다.
        이 화면은 읽기 전용이며, 일정 생성·DB 수정·알람 예약을 하지 않습니다.
      </Text>

      <SectionHeader title="① 실행 환경" />
      <Card>
        <Text variant="bodyStrong">플랫폼: {Platform.OS === 'web' ? '웹' : Platform.OS}</Text>
        <Text>데이터 모드: {mode === 'real' ? '실데이터' : '가짜 데이터'}</Text>
        <Text>로그인: {mode === 'real' && session ? '현재 계정 로그인됨' : '실데이터 인증 없음'}</Text>
        <Text>기존 기상→출발 설정: {mode === 'real' && profile ? String(profile.default_prepare_minutes) + '분' : '미조회'}</Text>
        <Text variant="caption">실데이터 모드가 아니면 로그인/DB 검증 결과가 아닙니다.</Text>
        <Button small variant="ghost" label="개발 메뉴 · 로그인" onPress={() => router.push('/dev/screens')} />
      </Card>
      <SectionHeader title="② 실제 DB 스키마 · 읽기 전용" />
      <Card>
        <Text variant="small" tone="sub">로그인된 본인 프로필과 일정 참여 컬럼 존재 여부만 검사합니다. 기존 테스트 기록은 수정하지 않습니다.</Text>
        <Button label="현재 계정 DB 스키마 확인" onPress={() => void checkSchema()}
          disabled={mode !== 'real' || !session || loading} loading={loading} />
        {status?.kind === 'migration-needed' ? (
          <View style={styles.block}>
            <Text variant="bodyStrong" tone="warn">새 준비시간 DB 마이그레이션 미적용</Text>
            <Text>누락 위치: {status.missing === 'profiles' ? 'profiles' : 'appointment_participants'}</Text>
            <Text>기존 기상→출발 값: {status.legacyMinutes ?? '미설정'}분</Text>
            <Text variant="caption">웹 계산 실습은 가능하지만 신규 준비시간을 실제 DB에 저장하는 시험은 중단하세요.</Text>
          </View>
        ) : null}
        {status?.kind === 'ready' ? (
          <View style={styles.block}>
            <Text variant="bodyStrong">신규 컬럼 조회 가능</Text>
            <Text>기존 기상→출발: {status.legacyMinutes ?? '미설정'}분</Text>
            <Text>저장된 순수 준비시간: {status.pureMinutes ?? '미설정'}분</Text>
            <Text variant="caption">컬럼이 조회된다는 뜻입니다. 실제 쓰기·Edge 함수 배포가 검증됐다는 뜻은 아닙니다.</Text>
          </View>
        ) : null}
        {status?.kind === 'error' ? <Text tone="warn">{status.reason}</Text> : null}
      </Card>

      <SectionHeader title="③ 내 실제 저장 알람 · 조회만" />
      <Card>
        <Text variant="small" tone="sub">로그인된 본인 계정의 앞으로 예정된 알람 최대 5개를 DB에서 조회합니다. 휴대폰에 실제 예약됐다는 증거는 아닙니다.</Text>
        <Button label="실제 저장된 알람 읽기" onPress={() => void readExistingAlarms()}
          disabled={mode !== 'real' || !session || loading} loading={loading} />
        {realAlarms?.length === 0 ? <Text>예정된 알람이 없습니다.</Text> : null}
        {realAlarms?.map((item, index) => (
          <View style={styles.timeRow} key={index}>
            <Text>{item.kind}{item.enabled ? '' : ' (꺼짐)'}</Text>
            <Text>{new Date(item.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</Text>
          </View>
        ))}
        {realAlarmError ? <Text tone="warn">알람 조회에 실패했습니다. 권한·연결을 확인하세요.</Text> : null}
      </Card>
      <SectionHeader title="④ 순수 준비시간 계산 시나리오" />
      <Text variant="small" tone="sub">
        고정된 가상 약속: 2026년 11월 22일 오전 10시 (한국 시간).
        수치는 현재 계정의 값과 무관한 실습 입력입니다.
      </Text>
      <Card>
        <Stepper first label="순수 준비시간" value={scenario.pureMinutes}
          onChange={(pureMinutes) => setField({ pureMinutes })} min={5} max={240} step={5} unit="분" />
        <Stepper label="이동시간" value={scenario.travelMinutes}
          onChange={(travelMinutes) => setField({ travelMinutes })} min={0} max={180} step={5} unit="분" />
        <Stepper label="도착 여유" value={scenario.bufferMinutes}
          onChange={(bufferMinutes) => setField({ bufferMinutes })} min={0} max={60} step={5} unit="분" />
        <Stepper label="준비 전 활동" value={scenario.preTaskMinutes}
          onChange={(preTaskMinutes) => setField({ preTaskMinutes })} min={0} max={120} step={5} unit="분" />
        <Stepper label="기상 후 기본 여유" value={scenario.wakeLeadMinutes}
          onChange={(wakeLeadMinutes) => setField({ wakeLeadMinutes })} min={0} max={60} step={5} unit="분" />
        <Toggle value={scenario.withWake} onChange={(withWake) => setField({ withWake })} label="기상 알람 포함" />
      </Card>
      <Card>
        {rows.map(([name, at]) => (
          <View style={styles.timeRow} key={name}>
            <Text>{name}</Text>
            <Text variant="bodyStrong">{kstHm(at)}</Text>
          </View>
        ))}
        <Text variant="caption">
          출발 = 약속 − 이동 − 도착 여유. 준비 시작 = 출발 − 순수 준비시간.
          기상 = 준비 시작 − 준비 전 활동 − 기상 후 기본 여유.
        </Text>
      </Card>
      <Button small variant="ghost" label="기본 시나리오로 초기화"
        onPress={() => setScenario(DEFAULT_PURE_SCENARIO)} />
      <Text variant="caption">
        웹에서는 Android 잠금화면 울림, 알림 권한, 백그라운드 예약을 확인할 수 없습니다.
        실제 DB 저장은 마이그레이션과 Edge 배포 후 테스트 환경에서 별도로 검사해야 합니다.
      </Text>
    </Screen>
  );
}
const styles = StyleSheet.create({
  block: { gap: 4, paddingTop: 12 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7 },
});
