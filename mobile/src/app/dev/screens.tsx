import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, confirm, Screen, SectionHeader, Segmented, Text, toast, TopBar } from '@/components/ui';
import { sectionsFor } from '@/dev/screenList';
import { useAuth } from '@/features/auth/AuthProvider';
import { DataModeToggle, goAfterRender } from '@/features/auth/DataModeToggle';
import { DevLoginForm } from '@/features/auth/DevLoginForm';
import { resetMyTestData } from '@/features/dev/api';
import { showNotifyPrompt } from '@/features/permissions/components/PermissionPromptHost';
import { PERMISSION_SAMPLES, type PermissionSample } from '@/features/permissions/sample';
import { permissionSample, setPermissionSample } from '@/features/permissions/read';
import { resetOnboarding } from '@/features/profile/api';
import { scenarioTime, setScenarioTime, type ScenarioTime } from '@/lib/clock';
import { userMessage } from '@/lib/errors';
import { ONBOARDING_IN_FLOW } from '@/lib/flags';
import { canUseRealData, devLoginVisible, modeLocked, useMode } from '@/lib/mode';
import { cleanupAfterDataReset, signOutAndCleanup } from '@/lib/session';
import { useAction } from '@/lib/useAction';
import { colors } from '@/theme';

// 개발용 화면 목록 — 탭에는 없고 주소로만 들어옴: /dev/screens (앱은 respecalarm://dev/screens)
// 목업의 데모 패널 대신 화면 번호로 바로 열고, 시나리오 시각(아침 · 전날 밤)을 바꿔 봄
// 실데이터를 쓸 수 있고 모드를 바꿀 수 있는 빌드(웹 · 폰 개발용, lib/modePolicy.ts)일 때만 맨 위에서 데이터 모드를 바꿈 — 로그인 · 온보딩부터 E2E로 돌릴 때
// 폰 출시용 빌드는 모드가 실데이터로 고정이라 토글이 없음. 가짜 데이터 시나리오 시각도 가짜 모드에서만 보임
// 실데이터 모드에서 로그인 전이면 이메일 로그인(시드 계정, 웹 · 폰 개발용만), 로그인 후에는 로그아웃(폰 알람 · 기록 정리 포함)
// 목업에 없는 로그인 · 온보딩 · 설정은 목록 맨 아래 "처음 · 설정" (dev/screenList)
// "내 시험 데이터 지우기"는 실데이터 + 로그인 + 모드를 바꿀 수 있는 빌드(폰 출시용이 아님, D16)에서만 보임 — 내 일정 · 알람 · 기록 · AI 대화를 서버에서 지우고 폰 알람도 정리한 뒤 온보딩부터 다시 함. 계정 · 친구 · 그룹은 그대로
// "온보딩부터 다시"는 온보딩이 흐름에 있을 때(lib/flags ONBOARDING_IN_FLOW)만 보임 — 아이디 · 집 · 기본값 · 온보딩 끝난 시각을 비워 처음 단계부터 다시 함
const TIMES = [
  ['morning', '아침 오전 7:55'],
  ['evening', '전날 밤 9:00'],
  ['moving', '이동 중 오전 9:10'],
  ['arrived', '도착 오전 9:50'],
] as const;

export default function ScreenListScreen() {
  const [time, setTime] = useState<ScenarioTime>(scenarioTime());
  const { mode } = useMode();
  const { session, refreshProfile } = useAuth();
  const [busy, setBusy] = useState(false);
  const { busy: resetting, run: runReset } = useAction();
  const [sample, setSample] = useState<PermissionSample>(permissionSample());

  // E2E 반복용 — 계정은 그대로, 다음 화면에서 로그인 또는 온보딩으로 감
  async function run(task: () => Promise<void>, done: string, next: Href) {
    setBusy(true);
    try {
      await task();
      toast(done);
      goAfterRender(next);
    } catch (e) {
      toast(userMessage(e, '하지 못했어요')); // 로그아웃 오류 원문(영어 · 서버 문구)이 토스트로 새지 않게 — UserError일 때만 이유를 보임
    } finally {
      setBusy(false);
    }
  }

  // 지우기 → 서버 → 폰 정리 → 프로필 다시 읽기 → 온보딩. 서버 함수는 두 번 불러도 같으므로 중간에 실패해도 다시 누르면 됨
  async function resetMyData() {
    const ok = await confirm({
      title: '내 시험 데이터를 지울까요?',
      message: '일정 · 알람 · 기록 · AI 대화를 지우고 온보딩부터 다시 해요. 친구 · 그룹은 그대로예요.',
      okLabel: '지우기',
      destructive: true,
    });
    if (!ok) return;
    await runReset(async () => {
      await resetMyTestData();
      await cleanupAfterDataReset();
      await refreshProfile();
      toast('지웠어요');
      goAfterRender('/onboarding');
    });
  }

  function changeSample(next: PermissionSample) {
    setPermissionSample(next);
    setSample(next);
  }

  function changeTime(next: ScenarioTime) {
    setScenarioTime(next);
    setTime(next);
    toast('시나리오 시각을 바꿨어요. 화면을 다시 열면 반영돼요');
  }

  return (
    <Screen>
      <TopBar onBack={router.canGoBack() ? router.back : undefined} screenId="DEV" />
      <Text variant="title">화면 목록</Text>
      <Text variant="lead">화면 번호로 바로 열어요. 가짜 데이터 모드는 목업과 같은 데이터예요. 목업에 없는 로그인 · 온보딩 · 설정은 맨 아래예요.</Text>
      <Card>
        <Text variant="bodyStrong">순수 준비시간 · 웹 실데이터 점검</Text>
        <Text variant="small" tone="sub">
          로그인한 내 DB의 스키마를 읽기 전용으로 확인하고, 순수 준비시간의 기상·준비·출발 역산을 직접 시험해요.
          DB 저장이나 실제 폰 알람 예약은 하지 않아요.
        </Text>
        <Button label="순수 준비시간 테스트 열기" onPress={() => router.push('/dev/pure-prep')} />
      </Card>

      {canUseRealData && !modeLocked ? (
        <>
          <SectionHeader title="데이터 모드" right={mode === 'real' ? (session ? `로그인됨${session.user.email ? ` · ${session.user.email}` : ''}` : '로그인 전') : ''} />
          <DataModeToggle />
        </>
      ) : null}
      {devLoginVisible && mode === 'real' && !session ? <DevLoginForm /> : null}
      {canUseRealData && mode === 'real' && session ? (
        <View style={styles.actions}>
          <Button
            small
            variant="ghost"
            label="로그아웃"
            disabled={busy || resetting}
            onPress={() => run(signOutAndCleanup, '로그아웃했어요', '/login')}
          />
          {/* 온보딩을 흐름에서 빼면(ONBOARDING_IN_FLOW = false) 가면 막다른 곳이라 버튼을 숨김 */}
          {ONBOARDING_IN_FLOW ? (
            <Button
              small
              variant="ghost"
              label="온보딩부터 다시"
              disabled={busy || resetting}
              onPress={() =>
                run(async () => {
                  await resetOnboarding(session.user.id);
                  await refreshProfile();
                }, '아이디 · 집 · 기본값 · 온보딩 기록을 비웠어요', '/onboarding')
              }
            />
          ) : null}
          {/* 출시용 빌드(모드 고정)에서는 숨김 — 토글과 같은 가드 */}
          {!modeLocked ? <Button small variant="danger" label="내 시험 데이터 지우기" disabled={busy || resetting} loading={resetting} onPress={resetMyData} /> : null}
        </View>
      ) : null}
      {canUseRealData ? (
        <Text variant="caption" style={styles.note}>
          아직 실데이터로 안 붙인 화면은 실데이터 모드에서도 가짜 데이터를 보여 줘요. 시각은 실데이터 모드면 지금 시각이에요.
        </Text>
      ) : null}

      {mode === 'mock' ? (
        <>
          <SectionHeader title="시나리오 시각 (가짜 데이터)" right="5월 22일 목요일" />
          <Segmented options={TIMES} value={time} onChange={changeTime} />
        </>
      ) : null}

      {/* 웹은 폰 권한을 못 읽어 점검표(L04) · 홈 빨간 줄이 비어 보임 — 샘플 상태를 골라 봄. 웹 · 가짜 모드에서만 (폰의 진짜 권한을 가리지 않게) */}
      {Platform.OS === 'web' && !modeLocked && mode === 'mock' ? (
        <>
          <SectionHeader title="샘플 권한 상태 (웹)" right="L04 · 홈 빨간 줄" />
          <Segmented options={PERMISSION_SAMPLES} value={sample} onChange={changeSample} />
          <View style={styles.actions}>
            <Button
              small
              variant="ghost"
              label="안내 시트 열어 보기"
              onPress={() =>
                void showNotifyPrompt({
                  title: '알람이 잠금화면에 뜨려면 알림이 필요해요',
                  message: "알림을 켜야 기상 알람 화면과 준비 · 출발 알림이 떠요. 다음 화면에서 '허용'을 눌러 주세요.",
                  okLabel: '알림 켜기',
                  cancelLabel: '나중에',
                })
              }
            />
          </View>
        </>
      ) : null}

      {sectionsFor(mode).map((section) => (
        <View key={section.title}>
          <SectionHeader title={section.title} right={section.issue} />
          <Card>
            {section.rows.map((row, i) => (
              <Pressable
                key={`${row.id}-${row.name}`}
                onPress={() => router.push(row.href)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.row, i > 0 && styles.divider, pressed && styles.pressed]}
              >
                <Text variant="screenId" style={styles.id}>
                  {row.id}
                </Text>
                <Text variant="body" style={styles.name}>
                  {row.name}
                </Text>
                <Text variant="body" tone="faint">
                  ›
                </Text>
              </Pressable>
            ))}
          </Card>
        </View>
      ))}

      <Text variant="caption" style={styles.note}>
        AI 화면(A02 · A03 · A04)은 AI 대기라 목업 대본대로 움직여요. 일기(A03)는 A02에서 대화를 마치면 생겨요. 실제 알람 울림은 알람 코어의 네이티브 화면이고, 울림 시험은 /dev/alarm-test에서 해요.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  id: { width: 36 },
  name: { flex: 1 },
  note: { marginTop: 4, marginHorizontal: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
});
