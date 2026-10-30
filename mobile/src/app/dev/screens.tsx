import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, Screen, SectionHeader, Segmented, Text, toast, TopBar } from '@/components/ui';
import { SECTIONS } from '@/dev/screenList';
import { useAuth } from '@/features/auth/AuthProvider';
import { DataModeToggle, goAfterRender } from '@/features/auth/DataModeToggle';
import { DevLoginForm } from '@/features/auth/DevLoginForm';
import { showNotifyPrompt } from '@/features/permissions/components/PermissionPromptHost';
import { PERMISSION_SAMPLES, type PermissionSample } from '@/features/permissions/sample';
import { permissionSample, setPermissionSample } from '@/features/permissions/read';
import { resetOnboarding } from '@/features/profile/api';
import { scenarioTime, setScenarioTime, type ScenarioTime } from '@/lib/clock';
import { userMessage } from '@/lib/errors';
import { ONBOARDING_IN_FLOW } from '@/lib/flags';
import { canUseRealData, devLoginVisible, modeLocked, useMode } from '@/lib/mode';
import { signOutAndCleanup } from '@/lib/session';
import { colors } from '@/theme';

// 개발용 화면 목록 — 탭에는 없고 주소로만 들어옴: /dev/screens (앱은 respecalarm://dev/screens)
// 목업의 데모 패널 대신 화면 번호로 바로 열고, 시나리오 시각(아침 · 전날 밤)을 바꿔 봄
// 실데이터를 쓸 수 있고 모드를 바꿀 수 있는 빌드(웹 · 폰 개발용, lib/modePolicy.ts)일 때만 맨 위에서 데이터 모드를 바꿈 — 로그인 · 온보딩부터 E2E로 돌릴 때
// 폰 출시용 빌드는 모드가 실데이터로 고정이라 토글이 없음. 가짜 데이터 시나리오 시각도 가짜 모드에서만 보임
// 실데이터 모드에서 로그인 전이면 이메일 로그인(시드 계정, 웹 · 폰 개발용만), 로그인 후에는 로그아웃(폰 알람 · 기록 정리 포함)
// 목업에 없는 로그인 · 온보딩 · 설정은 목록에 두지 않음 (#116)
// "온보딩부터 다시"는 온보딩이 흐름에 있을 때(lib/flags ONBOARDING_IN_FLOW)만 보임 — 아이디 · 집 · 기본값 · 온보딩 끝난 시각을 비워 처음 단계부터 다시 함
const TIMES = [
  ['morning', '아침 오전 7:55'],
  ['evening', '전날 밤 9:00'],
] as const;

export default function ScreenListScreen() {
  const [time, setTime] = useState<ScenarioTime>(scenarioTime());
  const { mode } = useMode();
  const { session, refreshProfile } = useAuth();
  const [busy, setBusy] = useState(false);
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
      <Text variant="title">목업 화면 목록</Text>
      <Text variant="lead">클릭 목업(mockup.html)의 화면 번호로 바로 열어요. 가짜 데이터 모드는 목업과 같은 데이터예요.</Text>

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
            disabled={busy}
            onPress={() => run(signOutAndCleanup, '로그아웃했어요', '/login')}
          />
          {/* 온보딩을 흐름에서 빼면(ONBOARDING_IN_FLOW = false) 가면 막다른 곳이라 버튼을 숨김 */}
          {ONBOARDING_IN_FLOW ? (
            <Button
              small
              variant="ghost"
              label="온보딩부터 다시"
              disabled={busy}
              onPress={() =>
                run(async () => {
                  await resetOnboarding(session.user.id);
                  await refreshProfile();
                }, '아이디 · 집 · 기본값 · 온보딩 기록을 비웠어요', '/onboarding')
              }
            />
          ) : null}
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

      {SECTIONS.map((section) => (
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
  actions: { flexDirection: 'row', gap: 8, marginTop: 8 },
});
