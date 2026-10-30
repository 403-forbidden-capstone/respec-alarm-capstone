import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';

import { useAuth } from '@/features/auth/AuthProvider';
import { CONSENT_ITEMS, PRIVACY_VERSION } from '@/features/onboarding/consent';
import { OnboardingDoneStep } from '@/features/onboarding/components/OnboardingDoneStep';
import { OnboardingFrame } from '@/features/onboarding/components/OnboardingFrame';
import { activeSteps, nextStep, ONBOARDING_ORDER, prevStep, stepNumber, type OnboardingStepId, type StepFlags } from '@/features/onboarding/steps';
import { cleanHandle, cleanNickname, isHandleFormat, isNicknameOk, NICKNAME_MAX } from '@/features/onboarding/validate';
import { ConsentStep } from '@/features/onboarding/views/ConsentStep';
import { HandleStep } from '@/features/onboarding/views/HandleStep';
import { NicknameStep } from '@/features/onboarding/views/NicknameStep';
import { PrepareStep, type PrepareValues } from '@/features/onboarding/views/PrepareStep';
import { ShareStep } from '@/features/onboarding/views/ShareStep';
import { SleepStep } from '@/features/onboarding/views/SleepStep';
import { finishOnboarding, isHandleTaken, saveProfileFields } from '@/features/profile/api';
import type { WakeSensitivity } from '@/features/profile/types';
import { ONBOARDING_STEPS } from '@/lib/flags';
import { useAction } from '@/lib/useAction';

// 이 화면에 단계 화면이 있는 단계 — 켜 놓았어도 여기 없으면 건너뜀 (진행 표시의 전체 수에서도 빠짐)
// 자리: home · timetable(PR 5 — 집 검색 · 시간표 입력), permissions(PR 7 — 권한 안내), mic(L4 뒤). 화면을 만들면 여기에 더함
const SCREEN_STEPS: ReadonlySet<OnboardingStepId> = new Set(['handle', 'nickname', 'sleep', 'prepare', 'consent', 'share', 'first']);
const FLAGS = Object.fromEntries(ONBOARDING_ORDER.map((id) => [id, ONBOARDING_STEPS[id] && SCREEN_STEPS.has(id)])) as StepFlags;

// 프로필을 다시 읽은 뒤 루트 레이아웃이 앱 화면(홈 · 일정)을 열 때까지 잠깐 기다림 — 온보딩 중에는 앱 화면이 막혀 있어서 (_layout.tsx RootStack ready)
const waitForAppScreens = () => new Promise<void>((resolve) => setTimeout(resolve, 150));

// 단계에 따라 틀(OnboardingFrame)에 넣을 것
type StepView = {
  title: string;
  lead?: string;
  body: ReactNode;
  primaryLabel: string;
  primaryDisabled?: boolean;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
};

// 처음 설정 — 켜진 단계를 순서대로 한 번에 하나씩 (단계 표 · 켜고 끄기: features/onboarding/steps.ts, lib/flags ONBOARDING_STEPS)
// 단계마다 [다음]에서 그 단계 값을 저장하고, 마지막 단계에서 온보딩 끝낸 시각(onboarded_at)을 적은 뒤 프로필을 다시 읽어 앱으로 보냄
// 앱을 껐다 켜면 처음 단계부터 다시지만, 저장해 둔 값은 미리 채워져 있음
// 가짜 데이터 모드(미리 보기)는 저장 없이 단계만 넘김
export default function OnboardingScreen() {
  const { session, profile, enabled, refreshProfile } = useAuth();
  const { busy, run } = useAction();
  const userId = enabled ? (session?.user.id ?? null) : null; // null = 저장하지 않음

  const [step, setStep] = useState<OnboardingStepId>(() => activeSteps(FLAGS)[0]);
  const [handle, setHandle] = useState(profile?.handle ?? '');
  const [handleError, setHandleError] = useState<string | null>(null);
  const [nickname, setNickname] = useState(profile?.nickname ?? '');
  const [sleep, setSleep] = useState<WakeSensitivity>(profile?.wake_sensitivity ?? 'NORMAL');
  const [prepare, setPrepare] = useState<PrepareValues>({
    prepare: Math.min(300, Math.max(5, profile?.default_prepare_minutes ?? 60)),
    buffer: Math.min(60, Math.max(0, profile?.default_buffer_minutes ?? 10)),
    transport: profile?.default_transport ?? 'TRANSIT',
    margin: profile?.wake_margin ?? 'NORMAL',
  });
  const [consentSaved, setConsentSaved] = useState(false); // 이 화면에서 이미 동의를 저장했음 (뒤로 갔다 와도 다시 저장하지 않게)

  const changeHandle = (next: string) => {
    setHandle(next);
    setHandleError(null);
  };

  function advance() {
    const to = nextStep(step, FLAGS);
    if (to) setStep(to);
  }

  // 지금 단계 값 저장. false면 막혀서 다음 단계로 못 감
  async function save(): Promise<boolean> {
    switch (step) {
      case 'handle': {
        const clean = cleanHandle(handle);
        if (!userId) return true;
        // 원래 내 아이디 그대로면 중복 확인을 건너뜀
        if (clean !== profile?.handle && (await isHandleTaken(clean, userId))) {
          setHandleError('이미 쓰는 아이디예요');
          return false;
        }
        await saveProfileFields(userId, { handle: clean });
        return true;
      }
      case 'nickname':
        if (userId) await saveProfileFields(userId, { nickname: cleanNickname(nickname) });
        return true;
      case 'sleep':
        if (userId) await saveProfileFields(userId, { wake_sensitivity: sleep });
        return true;
      case 'prepare':
        if (userId) {
          await saveProfileFields(userId, {
            default_prepare_minutes: prepare.prepare,
            default_buffer_minutes: prepare.buffer,
            default_transport: prepare.transport,
            wake_margin: prepare.margin,
          });
        }
        return true;
      case 'consent': {
        // 이미 이 판에 동의한 계정이면 다시 저장하지 않고 통과
        const agreed = (profile?.privacy_version ?? 0) >= PRIVACY_VERSION;
        if (userId && !agreed && !consentSaved) {
          await saveProfileFields(userId, { privacy_agreed_at: new Date().toISOString(), privacy_version: PRIVACY_VERSION });
          setConsentSaved(true);
        }
        return true;
      }
      default:
        return true; // share 등 저장할 것이 없는 단계
    }
  }

  const next = () =>
    run(async () => {
      if (await save()) advance();
    }, '저장하지 못했어요');

  // 마지막 단계 — 끝낸 시각을 적고 프로필을 다시 읽은 뒤에 이동 (읽기 전에는 앱 화면이 막혀 있음)
  const finish = (to: 'schedule' | 'home') =>
    run(async () => {
      if (userId) {
        await finishOnboarding(userId);
        await refreshProfile();
        await waitForAppScreens();
      }
      router.replace('/');
      if (to === 'schedule') router.push({ pathname: '/schedule/new', params: { from: 'home' } });
    }, '저장하지 못했어요');

  const views: Partial<Record<OnboardingStepId, StepView>> = {
    handle: {
      title: '내 아이디',
      lead: '친구가 @아이디로 나를 찾아요',
      body: <HandleStep value={handle} onChange={changeHandle} error={handleError} />,
      primaryLabel: '다음',
      primaryDisabled: !isHandleFormat(handle),
      onPrimary: next,
    },
    nickname: {
      title: '닉네임',
      lead: '친구에게 보이는 이름이에요',
      body: <NicknameStep value={nickname} onChange={setNickname} max={NICKNAME_MAX} />,
      primaryLabel: '다음',
      primaryDisabled: !isNicknameOk(nickname),
      onPrimary: next,
    },
    sleep: {
      title: '잠귀',
      body: <SleepStep value={sleep} onChange={setSleep} />,
      primaryLabel: '다음',
      onPrimary: next,
    },
    prepare: {
      title: '아침 준비',
      lead: '알람 계산의 처음 값이에요',
      body: <PrepareStep values={prepare} onChange={(patch) => setPrepare((prev) => ({ ...prev, ...patch }))} />,
      primaryLabel: '다음',
      onPrimary: next,
    },
    consent: {
      title: '개인정보 안내',
      lead: '앱이 읽는 것과 읽지 않는 것이에요',
      body: <ConsentStep items={CONSENT_ITEMS} />,
      primaryLabel: '동의하고 계속',
      onPrimary: next,
    },
    share: {
      title: '기상 공유 안내',
      body: <ShareStep />,
      primaryLabel: '다음',
      onPrimary: next,
    },
    first: {
      title: '첫 일정',
      body: (
        <OnboardingDoneStep
          summary={[
            { label: '아이디', value: `@${cleanHandle(handle)}` },
            { label: '닉네임', value: cleanNickname(nickname) },
          ]}
        />
      ),
      primaryLabel: '첫 일정 만들기',
      onPrimary: () => finish('schedule'),
      secondaryLabel: '나중에',
      onSecondary: () => finish('home'),
    },
  };

  const view = views[step];
  if (!view) return null; // 화면이 없는 단계 — SCREEN_STEPS로 이미 걸러져 여기 오지 않음
  const prev = prevStep(step, FLAGS);
  const { step: n, total } = stepNumber(step, FLAGS);

  return (
    <OnboardingFrame
      step={n}
      total={total}
      title={view.title}
      lead={view.lead}
      primaryLabel={view.primaryLabel}
      onPrimary={view.onPrimary}
      primaryDisabled={view.primaryDisabled}
      primaryBusy={busy}
      secondaryLabel={view.secondaryLabel}
      onSecondary={view.onSecondary}
      onBack={prev ? () => setStep(prev) : undefined}
    >
      {view.body}
    </OnboardingFrame>
  );
}
