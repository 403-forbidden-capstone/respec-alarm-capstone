import { useFonts } from 'expo-font';
import { router, Stack, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';

import { DeviceFrame } from '@/components/dev/DeviceFrame';
import { ConfirmHost, SheetHost, ToastHost } from '@/components/ui';
import { useOneTapFollowUp } from '@/features/alarm/hooks/useOneTapFollowUp';
import { useWakeRecheck } from '@/features/alarm/hooks/useWakeRecheck';
import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
import { ConfigErrorScreen } from '@/features/auth/ConfigErrorScreen';
import { PermissionPromptHost } from '@/features/permissions';
import { ProfileRetryScreen } from '@/features/auth/ProfileRetryScreen';
import { useDetectionLinks } from '@/features/location/hooks/useDetectionLinks';
import { usePushLinks } from '@/features/push/usePushLinks';
import { useLocationSync } from '@/features/location/useLocationSync';
import { useAlarmSync } from '@/lib/alarmSync/useAlarmSync';
import { takeAfterOnboarding } from '@/lib/afterOnboarding';
import { takePendingInvite } from '@/lib/pendingInvite';
import { ONBOARDING_IN_FLOW, TIMETABLE_PATHS } from '@/lib/flags';
import { canUseRealData, configError } from '@/lib/mode';
import { ensureNotificationChannels } from '@/lib/push/channels';
import { usePushRegistration } from '@/lib/push/usePushRegistration';
import { colors, fontFiles } from '@/theme';
// 지오펜스 신호를 받는 작업 정의 — 앱이 꺼진 채 받는 길은 진입 파일(index.js)이 먼저 불러 줌. 여기 import는 같은 모듈이라 한 번만 평가됨 (features/location/task)
import '@/features/location/task';
// 조용한 데이터 푸시(공동 약속 변경 · 취소)를 받아 알람을 다시 맞추는 작업 정의 — 마찬가지로 진입 파일(index.js)이 먼저 불러 줌 (features/push/backgroundTask)
import '@/features/push/backgroundTask';

// 글꼴 · 로그인 상태를 다 읽을 때까지 시작 화면을 유지함
SplashScreen.preventAutoHideAsync();

// 알림 채널 만들기 (감지 안내 등, 안드로이드만 — 웹 · iOS는 아무 일도 안 함, 실패해도 앱은 계속) — lib/push/channels
void ensureNotificationChannels();

// 웹 로그인 팝업이 /auth/callback으로 돌아오면 팝업 주소(토큰 포함)를 원래 창에 넘기고 팝업이 닫힘
// 팝업에서 확실히 실행되는 모듈은 이 루트 레이아웃뿐이라 여기서 부름 (화면 파일은 열릴 때만 읽히고, 폰에서는 아무 일도 안 함)
WebBrowser.maybeCompleteAuthSession();

export default function RootLayout() {
  const [loaded, error] = useFonts(fontFiles);

  // 글꼴을 못 읽어도 시스템 글꼴로 계속 진행함
  if (!loaded && !error) return null;

  return (
    <AuthProvider>
      <DeviceFrame>
        <StatusBar style="dark" />
        <RootStack />
        <SheetHost />
        <PermissionPromptHost />
        <ConfirmHost />
        <ToastHost />
      </DeviceFrame>
    </AuthProvider>
  );
}

// 로그인 전에는 login만, 그 뒤에는 탭 · 앱 화면만 열림
// 온보딩을 끝내기 전(profiles.onboarded_at이 비어 있음)에는 onboarding만 — 어느 단계를 거칠지는 lib/flags ONBOARDING_STEPS. 흐름에서 빼려면 ONBOARDING_IN_FLOW = false: 로그인하면 바로 탭 홈
// 로그인은 됐는데 프로필을 못 읽었으면(오프라인 등) 다시 시도 화면 (온보딩이 흐름에 있으면 온보딩 대신)
// 폰 출시용 빌드(lib/modePolicy.ts)는 실데이터만 — 로그인해야만 탭이 열리고, Supabase 값이 없으면 가짜로 돌지 않고 설정 오류 화면
// 가짜 데이터 모드(enabled=false, lib/mode.ts)는 웹 · 폰 개발용에서만. 로그인 없이 바로 탭이고 login · onboarding은 주소로 열어 볼 수만 있음 (onboarding은 흐름에 넣었을 때만, 저장 없이 단계만 넘어감)
// 실데이터를 못 쓰면(Supabase 값 없음 · lib/flags REAL_DATA_READY = false) login · onboarding · settings를 아예 뺌 — 주소로 열어도 탭 홈 (#116)
// ring(H07 알람 울림, #332)은 알람 코어가 잠금화면 위로 불러 오는 화면이라 로그인 · 온보딩 · 프로필 읽기를 기다리지 않고 바로 열림 — 해제 · 미루기는 알람 코어 호출뿐이라 서버 값이 필요 없음
//   (로그아웃 상태에서 울려도 끌 수 있게). 해제 · 미루기 뒤 갈 곳은 지금 열 수 있는 화면으로 고름 — 로그인 전이면 로그인, 시험 알람이면 알람 테스트 (features/alarm/ringExit.ts, 막힌 화면으로 가면 울림 화면에 갇혔음 · 11/12 에뮬레이터)
// dev/* · auth/callback은 어느 쪽에서도 열림 (로그인 화면의 "알람 테스트"가 dev/alarm-test로 감). 앱 화면을 새로 만들면 첫 번째 Protected 안에 넣음
function RootStack() {
  const { session, profile, loading, enabled, needsOnboarding, needsReconsent, profileError, refreshProfile } = useAuth();
  const needsLogin = enabled && !session;
  const ready = !needsLogin && !needsOnboarding && !needsReconsent;
  const preview = !enabled && canUseRealData; // 가짜 모드에서 login · onboarding을 열어 보기 (실데이터를 쓸 수 있을 때만)
  const ringEntry = usePathname() === '/ring'; // 알람 울림 화면으로 들어옴 (알람 코어의 길잡이 화면 · 딥링크)

  useEffect(() => {
    if (!loading || ringEntry) SplashScreen.hideAsync();
  }, [loading, ringEntry]);

  // 알람 기능 훅(원탭 뒤처리 · 로그아웃 정리) — useAlarmSync보다 먼저 등록해야 앱을 열자마자 올리는 원탭 기록도 뒤처리됨
  useOneTapFollowUp();

  // 로그인한 동안 폰 예약 · 울림 기록을 서버와 맞춤 (로그인 직후 · 앱이 앞에 올 때, 실데이터 모드만) — lib/alarmSync
  const syncActive = enabled && ready && !loading && profileError == null;
  const userId = session?.user.id ?? null;
  useAlarmSync({ active: syncActive, userId, timeZone: profile?.timezone });

  // 출발 · 도착 자동 기록용 지오펜스 등록 (로그인 직후 · 앱이 앞에 올 때, 안드로이드 · 실데이터 · 위치 권한이 있을 때만) — features/location
  useLocationSync({ active: syncActive, userId });

  // 감지 안내 알림("출발 8:30 감지")을 누르면 정정 화면(/detection)으로 — 앱이 꺼진 채 알림으로 열린 경우도. 화면이 열릴 수 있을 때까지 기억해 둠
  useDetectionLinks({ active: ready && !loading && profileError == null });

  // 친구 · 그룹 푸시 — 토큰 등록(로그인 직후 · 앞에 올 때) + 알림을 누르면 그 화면으로(받는 사람이 지금 계정일 때만, 아니면 홈) · 받으면 폰 알람 맞추기 — features/push, lib/push
  usePushRegistration({ active: syncActive, userId });
  usePushLinks({ active: ready && !loading && profileError == null, userId });

  // 같은 때에 최근에 끈 기상 알람 중 확정이 없는 것을 다시 판정 — 해제 뒤 앱을 안 열었어도 서버가 기상 미확인(MISSED)으로 적기 전에 확정되게
  useWakeRecheck({ active: syncActive, userId });

  // 온보딩 끝에서 [첫 일정 만들기]를 눌렀으면 앱 화면이 열린 뒤 일정 화면으로 — 시간을 추측해 기다리지 않고 가드(ready)가 열린 것을 기다림
  // (온보딩 화면은 판정이 꺼지면 사라져서 화면 안에서는 이동할 수 없음, lib/afterOnboarding)
  useEffect(() => {
    if (!ready || loading) return;
    if (takeAfterOnboarding() === 'schedule') router.push({ pathname: '/schedule/new', params: { from: 'home' } });
    // 로그인 전에 연 친구 링크 — 로그인 · 온보딩이 끝난 뒤 같은 화면으로 이어감 (lib/pendingInvite, 친구 2장)
    // 프로필 읽기에 실패해 다시 시도 화면이 떠 있는 동안은 읽지 않음 — 읽으면 비워져서 링크를 잃음
    if (profileError != null) return;
    const invite = takePendingInvite();
    if (invite) router.push({ pathname: '/invite', params: { t: invite } });
  }, [ready, loading, profileError]);

  if (configError && !ringEntry) return <ConfigErrorScreen />;
  if (loading && !ringEntry) return null;
  if (profileError != null && !ringEntry) return <ProfileRetryScreen message={profileError} onRetry={refreshProfile} />;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={ready}>
        <Stack.Screen name="(tabs)" />
        {/* 목업 화면 (M1) — 화면 번호 · 데이터는 docs/screen-data-map.md, 한눈에 보기는 /dev/screens */}
        <Stack.Screen name="alarm/[id]" />
        <Stack.Screen name="schedule/new" />
        <Stack.Screen name="wake" />
        <Stack.Screen name="friends/[id]/index" />
        <Stack.Screen name="friends/[id]/alarms" />
        <Stack.Screen name="permissions" />
        {/* 목업에 없는 화면(L04 알람이 안 울릴 때)이지만 홈 빨간 줄에서 가짜 모드에서도 열려야 해서 여기에 둠 */}
        <Stack.Screen name="ring-check" />
        <Stack.Screen name="groups/[id]/index" />
        <Stack.Screen name="groups/[id]/members/[userId]" />
        <Stack.Screen name="suggestion/[id]" />
        <Stack.Screen name="journal/[date]" />
        <Stack.Screen name="routine/[id]" />
        {/* 감지 안내 알림에서 열리는 1탭 정정 (목업에 없는 화면) — features/location/hooks/useDetectionLinks */}
        <Stack.Screen name="detection" />
        {/* 학교 시간표 (목업에 없는 화면, 11/2) — 반복 일정 보기 · 지우기. 가져오기 입구는 실데이터에서만 보임 */}
        <Stack.Screen name="timetable" />
      </Stack.Protected>
      {/* 목업에 없는 설정 · 로그인 · 온보딩 — 실데이터를 못 쓰면 빠짐. 온보딩은 ONBOARDING_IN_FLOW가 꺼져도 따로 빠짐 */}
      <Stack.Protected guard={ready && canUseRealData}>
        <Stack.Screen name="settings" />
        <Stack.Screen name="blocks" />
      </Stack.Protected>
      {/* 시간표 가져오기 확인 — 사진 · 캘린더 길이 둘 다 꺼져 있으면 주소로도 안 열림 (TIMETABLE_PATHS) */}
      <Stack.Protected guard={ready && canUseRealData && (TIMETABLE_PATHS.photo || TIMETABLE_PATHS.calendar)}>
        <Stack.Screen name="timetable-import" />
      </Stack.Protected>
      <Stack.Protected guard={needsLogin || preview}>
        <Stack.Screen name="login" />
      </Stack.Protected>
      {/* 온보딩을 흐름에서 빼면(ONBOARDING_IN_FLOW = false) 가짜 모드 미리 보기에서도 주소로 안 열림 — 열면 막다른 곳이 아니라 홈 */}
      <Stack.Protected guard={ONBOARDING_IN_FLOW && (needsOnboarding || preview)}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      {/* 개인정보 안내 판이 올라갔을 때 동의만 다시 받는 화면 (친구 13-14) — 동의를 저장하면 프로필을 다시 읽어 이 화면은 사라지고 홈으로 */}
      <Stack.Protected guard={needsReconsent}>
        <Stack.Screen name="reconsent" />
      </Stack.Protected>
      {/* 알람 울림(H07) — 가드 없이 늘 열림(로그인 · 온보딩 · 읽는 중에도). 이미 켜진 앱에 길잡이 화면의 딥링크가 와도 열려야 함
          — 예전 가드(ready || 지금 주소가 /ring)는 로그인 전에 켜져 있던 앱에서 /ring으로 가는 길을 막아 6초 뒤 네이티브 대체 화면이 떴음 (11/5 에뮬레이터)
          맨 끝에 두는 이유: 막힌 화면으로 가면 열린 화면 중 앞의 것으로 보내므로, 앞에 두면 로그인 전 사용자가 홈 대신 울림 화면으로 감 */}
      <Stack.Screen name="ring" options={{ animation: 'fade' }} />
      {/* 초대 · 친구 링크 착지 (친구 2장) — 로그인 전에 열려도 화면이 토큰을 적어 두고 로그인으로 보냄. 가드가 막으면 토큰이 사라지므로 가드 없이 늘 열어 둠 */}
      <Stack.Screen name="invite" />
      {/* 웹 계정 삭제 요청 안내 (친구 12-사) — 로그인 없이 열려야 하는 Play 의무 페이지라 가드 없음 */}
      <Stack.Screen name="account-deletion" />
    </Stack>
  );
}
