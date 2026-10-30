import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';

import { Text } from '@/components/ui';
import { listPlaces } from '@/features/alarm/api';
import { PlaceSearchSheet } from '@/features/alarm/components/PlaceSearchSheet';
import { TimeSheet } from '@/features/alarm/components/TimePicker';
import { useAuth } from '@/features/auth/AuthProvider';
import { hasHome } from '@/features/onboarding/home';
import { CampusCard } from '@/features/onboarding/components/CampusCard';
import { ImportNoticeCard } from '@/features/onboarding/components/ImportNoticeCard';
import { HomePlaceStep } from '@/features/onboarding/components/HomePlaceStep';
import { consentItems, PRIVACY_VERSION } from '@/features/onboarding/consent';
import { OnboardingDoneStep } from '@/features/onboarding/components/OnboardingDoneStep';
import { OnboardingFrame } from '@/features/onboarding/components/OnboardingFrame';
import { CalendarPickSheet } from '@/features/onboarding/components/CalendarPickSheet';
import { ImportEntryCard } from '@/features/onboarding/components/ImportEntryCard';
import { PermissionsStep } from '@/features/onboarding/components/PermissionsStep';
import { TimetableStep } from '@/features/onboarding/components/TimetableStep';
import { useHomeStep } from '@/features/onboarding/hooks/useHomeStep';
import { useCalendarImport } from '@/features/onboarding/hooks/useCalendarImport';
import { usePhotoImport } from '@/features/onboarding/hooks/usePhotoImport';
import { useTimetableStep } from '@/features/onboarding/hooks/useTimetableStep';
import { permissionRows } from '@/features/onboarding/permissionRows';
import { activeSteps, nextStep, ONBOARDING_ORDER, prevStep, stepNumber, type OnboardingStepId, type StepFlags } from '@/features/onboarding/steps';
import { cleanHandle, cleanNickname, isHandleFormat, isNicknameOk, NICKNAME_MAX, shouldSaveHandle } from '@/features/onboarding/validate';
import { ConsentStep } from '@/features/onboarding/views/ConsentStep';
import { HandleStep } from '@/features/onboarding/views/HandleStep';
import { NicknameStep } from '@/features/onboarding/views/NicknameStep';
import { PrepareStep, type PrepareValues } from '@/features/onboarding/views/PrepareStep';
import { ShareStep } from '@/features/onboarding/views/ShareStep';
import { SleepStep } from '@/features/onboarding/views/SleepStep';
import {
  askNotifications,
  openBatterySettings,
  openExactAlarmSettings,
  openFullScreenSettings,
  openUsageAccessSettings,
  usePermissions,
} from '@/features/permissions';
import { finishOnboarding, isHandleTaken, saveProfileFields } from '@/features/profile/api';
import type { WakeSensitivity } from '@/features/profile/types';
import { setAfterOnboarding } from '@/lib/afterOnboarding';
import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';
import { ONBOARDING_STEPS, TIMETABLE_PATHS } from '@/lib/flags';
import { addMinutes, minuteOfDay, startOfDay } from '@/lib/format';
import { useAction } from '@/lib/useAction';

// 이 화면에 단계 화면이 있는 단계 — 켜 놓았어도 여기 없으면 건너뜀 (진행 표시의 전체 수에서도 빠짐)
// 자리: mic(L4 뒤). 화면을 만들면 여기에 더함
const SCREEN_STEPS: ReadonlySet<OnboardingStepId> = new Set(['handle', 'nickname', 'sleep', 'home', 'prepare', 'timetable', 'consent', 'permissions', 'share', 'first']);
const FLAGS = Object.fromEntries(ONBOARDING_ORDER.map((id) => [id, ONBOARDING_STEPS[id] && SCREEN_STEPS.has(id)])) as StepFlags;

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
// 단계마다 [다음]에서 그 단계 값을 저장하고, 마지막 단계에서 온보딩 끝낸 시각(onboarded_at)을 적은 뒤 프로필을 다시 읽음
// 다시 읽어 온보딩 판정이 꺼지면 이 화면은 사라지고 루트(_layout.tsx)가 홈으로 보냄 — 첫 일정으로 갈지는 lib/afterOnboarding에 적어 둠
// 앱을 껐다 켜면 처음 단계부터 다시지만, 저장해 둔 값은 미리 채워져 있음
// 가짜 데이터 모드(미리 보기)는 저장 없이 단계만 넘김
export default function OnboardingScreen() {
  const { session, profile, enabled, refreshProfile } = useAuth();
  const { busy, run } = useAction();
  const userId = enabled ? (session?.user.id ?? null) : null; // null = 저장하지 않음

  const [step, setStep] = useState<OnboardingStepId>(() => activeSteps(FLAGS)[0]);
  const [handle, setHandle] = useState(profile?.handle ?? '');
  const [savedHandle, setSavedHandle] = useState<string | null>(profile?.handle ?? null); // 지금까지 저장한 아이디 — profile은 단계 사이에 안 바뀌어서 따로 둠
  const [handleError, setHandleError] = useState<string | null>(null);
  const [nickname, setNickname] = useState(profile?.nickname ?? '');
  const [sleep, setSleep] = useState<WakeSensitivity>(profile?.wake_sensitivity ?? 'NORMAL');
  const [prepare, setPrepare] = useState<PrepareValues>({
    prepare: Math.min(300, Math.max(5, profile?.default_prepare_minutes ?? 60)),
    buffer: Math.min(60, Math.max(0, profile?.default_buffer_minutes ?? 10)),
    transport: profile?.default_transport ?? 'TRANSIT',
    margin: profile?.wake_margin ?? 'NORMAL',
  });
  const homeStep = useHomeStep(profile, userId);
  const photoImport = usePhotoImport();
  const timetable = useTimetableStep(prepare.transport); // 수업은 '아침 준비'에서 고른 이동 수단으로 계산
  const calendarImport = useCalendarImport(timetable.addImported); // 캘린더에서 가져온 수업도 같은 시간표 단계 줄로 들어감
  const importing = photoImport.reading || calendarImport.busy; // 사진을 읽거나 캘린더를 가져오는 동안 시간표 단계를 막음
  // 집 좌표가 없으면 서버가 출발지 '집'을 못 채워 이동시간을 못 구함 — 실데이터만 (가짜 데이터는 집 없이도 계산)
  const noHome = userId != null && !hasHome(homeStep.saved, profile);
  const [finished, setFinished] = useState(false); // 온보딩 끝난 시각을 이미 적었음 (다시 읽기만 실패해 한 번 더 누를 때 또 적지 않게)
  const { snapshot: permissionSnapshot } = usePermissions(); // 설정에서 돌아오면 다시 읽어 줄이 갱신됨
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
        // 이미 저장한 아이디 그대로면 중복 확인도 저장도 건너뜀
        if (!userId || !shouldSaveHandle(clean, savedHandle)) return true;
        if (await isHandleTaken(clean, userId)) {
          setHandleError('이미 쓰는 아이디예요');
          return false;
        }
        await saveProfileFields(userId, { handle: clean });
        setSavedHandle(clean);
        return true;
      }
      case 'nickname':
        if (userId) await saveProfileFields(userId, { nickname: cleanNickname(nickname) });
        return true;
      case 'sleep':
        if (userId) await saveProfileFields(userId, { wake_sensitivity: sleep });
        return true;
      case 'home':
        await homeStep.save();
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
      case 'timetable':
        return timetable.save(); // 줄 하나라도 못 만들면 false — 그 단계에 머묾
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
        return true; // permissions · share 등 저장할 것이 없는 단계
    }
  }

  const next = () =>
    run(async () => {
      if (await save()) advance();
    }, '저장하지 못했어요');

  // 마지막 단계 — 끝낸 시각을 적고 프로필을 다시 읽음. 온보딩 중에는 앱 화면이 막혀 있어서(_layout.tsx RootStack ready) 여기서는 이동하지 않고,
  // 다시 읽어 판정이 꺼지면 이 화면이 사라지고 루트가 홈으로 보냄 (첫 일정이면 lib/afterOnboarding에 적어 둔 걸 루트가 읽고 일정 화면을 엶)
  const finish = (to: 'schedule' | 'home') =>
    run(async () => {
      if (!userId) {
        // 가짜 데이터 모드(미리 보기)는 가드가 안 막으니 바로 이동
        router.replace('/');
        if (to === 'schedule') router.push({ pathname: '/schedule/new', params: { from: 'home' } });
        return;
      }
      if (!finished) {
        await finishOnboarding(userId);
        setFinished(true);
      }
      setAfterOnboarding(to === 'schedule' ? 'schedule' : null);
      try {
        await refreshProfile();
      } catch {
        // 적는 건 끝났고 다시 읽기만 실패 — 저장 실패로 보이지 않게
        throw new UserError('저장했어요 · 다시 불러오지 못했어요. 한 번 더 눌러 주세요');
      }
    }, '저장하지 못했어요');

  // 줄의 [켜기] · [설정 열기] — 사용자가 누를 때만 시스템 창 · 설정을 엶 (안건 2 A). 돌아오면 usePermissions가 다시 읽음
  const openPermission = (key: string) => {
    switch (key) {
      case 'notifications':
        void askNotifications('onboarding');
        break;
      case 'fullScreen':
        void openFullScreenSettings();
        break;
      case 'exactAlarm':
        void openExactAlarmSettings();
        break;
      case 'usageAccess':
        void openUsageAccessSettings();
        break;
      case 'battery':
        void openBatterySettings();
        break;
    }
  };

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
    home: {
      title: '집 위치',
      body: (
        <>
          <HomePlaceStep homeName={homeStep.homeName} onOpenSearch={homeStep.openSearch} onClear={homeStep.clear} />
          <PlaceSearchSheet
            visible={homeStep.searchOpen}
            onClose={homeStep.closeSearch}
            onPick={homeStep.pick}
            search={(query) => listPlaces(query)}
            title="집 찾기"
          />
        </>
      ),
      primaryLabel: '다음',
      primaryDisabled: !homeStep.picked,
      onPrimary: next,
      secondaryLabel: '나중에',
      onSecondary: advance, // 저장 없이 다음
    },
    prepare: {
      title: '아침 준비',
      lead: '알람 계산의 처음 값이에요',
      body: <PrepareStep values={prepare} onChange={(patch) => setPrepare((prev) => ({ ...prev, ...patch }))} />,
      primaryLabel: '다음',
      onPrimary: next,
    },
    timetable: {
      title: '수업 시간표',
      lead: '수업 전 알람을 자동으로 맞춰요',
      body: (
        <>
          {noHome ? (
            <Text variant="small" tone="warn" style={styles.noHome}>
              집 위치를 정하지 않아서 이동시간을 구하지 못해요. 이전으로 돌아가 집을 정하거나 건너뛰어 주세요
            </Text>
          ) : null}
          <ImportEntryCard
            onPhoto={
              TIMETABLE_PATHS.photo
                ? async () => {
                    const batch = await photoImport.pick();
                    if (batch) timetable.addImported(batch);
                  }
                : undefined
            }
            onCalendar={TIMETABLE_PATHS.calendar ? calendarImport.start : undefined}
            busy={busy || photoImport.reading || calendarImport.busy}
            reading={photoImport.reading ? 'photo' : calendarImport.reading ? 'calendar' : null}
          />
          <CalendarPickSheet
            visible={calendarImport.pickerOpen}
            calendars={calendarImport.calendars}
            picked={calendarImport.picked}
            onToggle={calendarImport.toggle}
            onConfirm={calendarImport.confirm}
            onClose={calendarImport.closePicker}
          />
          {timetable.notice ? <ImportNoticeCard notice={timetable.notice} onDismiss={timetable.dismissNotice} /> : null}
          {timetable.missingCoords > 0 ? (
            <Text variant="small" tone="warn" style={styles.noHome}>
              {timetable.campus ? '장소를 못 찾은 줄이 있어요. 그 줄의 [장소]에서 직접 골라 주세요' : '학교를 먼저 정해 주세요. 이동시간을 구하려면 수업 장소의 위치가 필요해요'}
            </Text>
          ) : null}
          {timetable.imported && timetable.rows.length > 0 ? <CampusCard campus={timetable.campus} onOpen={timetable.openCampus} disabled={busy} /> : null}
          <TimetableStep
            rows={timetable.rows}
            onChangeRow={timetable.onChangeRow}
            onAddRow={timetable.onAddRow}
            onRemoveRow={timetable.onRemoveRow}
            onPickPlace={timetable.onPickPlace}
            onPickTime={timetable.onPickTime}
            onToggleExisting={timetable.onToggleExisting}
            saving={busy || importing}
          />
          <PlaceSearchSheet
            visible={timetable.campusOpen}
            onClose={timetable.closeCampus}
            onPick={timetable.pickCampus}
            search={(query) => listPlaces(query)}
            title="학교 찾기"
          />
          <PlaceSearchSheet
            visible={timetable.placeOpen}
            onClose={timetable.closePlace}
            onPick={timetable.pickPlace}
            search={(query) => listPlaces(query)}
            title="수업 장소 찾기"
          />
          {timetable.timeRow?.startMinutes != null ? (
            <TimeSheet
              visible
              onClose={timetable.closeTime}
              title="시작 시각"
              value={addMinutes(startOfDay(now()), timetable.timeRow.startMinutes)}
              onChange={(at) => timetable.changeTime(minuteOfDay(at))}
            />
          ) : null}
        </>
      ),
      primaryLabel: '저장하고 다음',
      primaryDisabled: !timetable.canSave || noHome || importing,
      onPrimary: next,
      secondaryLabel: '건너뛰기',
      onSecondary: importing ? undefined : advance, // 저장 없이 다음 (사진 · 캘린더를 읽는 동안은 막음 — 뒤늦게 온 결과가 다음 단계에 쌓이지 않게)
    },
    consent: {
      title: '개인정보 안내',
      lead: '앱이 읽는 것과 읽지 않는 것이에요',
      body: <ConsentStep items={consentItems(TIMETABLE_PATHS)} />,
      primaryLabel: '동의하고 계속',
      onPrimary: next,
    },
    permissions: {
      title: '권한 안내',
      lead: '알람이 확실히 울리도록 켜 두면 좋은 것들이에요',
      body: <PermissionsStep rows={permissionRows(permissionSnapshot)} onAction={openPermission} />,
      primaryLabel: '다음', // 안 켜도 통과
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

const styles = StyleSheet.create({
  noHome: { marginBottom: 12 },
});
