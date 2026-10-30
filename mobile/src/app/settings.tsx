import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, KeyValueRow, Screen, SectionHeader, Sheet, Text, toast, TopBar } from '@/components/ui';
import { listPlaces, reverseAddress } from '@/features/alarm/api';
import { MapPlaceSheet } from '@/features/alarm/components/MapPlaceSheet';
import { homeOf } from '@/features/alarm/placeSheet';
import type { Place } from '@/features/alarm/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { DataModeToggle } from '@/features/auth/DataModeToggle';
import { locateOnce } from '@/features/location/currentPosition';
import { openAppNotificationSettings } from '@/features/permissions';
import { homePatchOf } from '@/features/onboarding/home';
import { ImportEntryCard } from '@/features/onboarding/components/ImportEntryCard';
import { usePhotoImport } from '@/features/onboarding/hooks/usePhotoImport';
import { shouldSaveHandle } from '@/features/onboarding/validate';
import { isHandleTaken, saveProfileFields } from '@/features/profile/api';
import { EditRow } from '@/features/profile/components/EditRow';
import { HandleEditor, NicknameEditor, PrepareEditor, SleepEditor } from '@/features/profile/components/ProfileEditors';
import { prepareValuesOf } from '@/features/profile/edit';
import { TRANSPORT_NAME, WAKE_MARGIN_NAME, WAKE_SENSITIVITY_NAME } from '@/features/profile/labels';
import type { ProfileFields } from '@/features/profile/types';
import { UserError, userMessage } from '@/lib/errors';
import { TIMETABLE_PATHS } from '@/lib/flags';
import { setImportBatch } from '@/features/onboarding/importHandoff';
import { canUseRealData, modeLocked } from '@/lib/mode';
import { backOrHome } from '@/lib/nav';
import { signOutAndCleanup } from '@/lib/session';
import { useAction } from '@/lib/useAction';
import { colors, size } from '@/theme';

const PROVIDER_NAME: Record<string, string> = { kakao: '카카오', google: 'Google' };

// 열려 있는 편집 시트 — 집은 지도 고르기 시트(placeOpen)가 따로 맡음
type Editing = 'nickname' | 'handle' | 'sleep' | 'prepare' | null;

// 설정 — 계정 · 아침 준비 기본값 · 알람 · 로그아웃 · 개발(데이터 모드)
// 값 줄을 누르면 편집 시트가 열리고 [저장]하면 profiles에 씀 (실데이터 + 로그인일 때만, 가짜 모드는 보기만)
export default function SettingsScreen() {
  const { session, profile, enabled, refreshProfile } = useAuth();
  const { run } = useAction();
  const logout = useAction(); // 로그아웃 연타 막기 · 돌아가는 표시 — 프로필 저장 중에 로그아웃 버튼이 같이 돌지 않게 따로
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [placeOpen, setPlaceOpen] = useState(false);
  const photoImport = usePhotoImport();
  const user = session?.user;
  const provider = (user?.app_metadata?.provider as string | undefined) ?? '';
  const userId = enabled ? user?.id : undefined;
  const canEdit = userId != null && profile != null;

  const closeEditor = () => setEditing(null);
  const open = (which: Exclude<Editing, null>) => (canEdit ? () => setEditing(which) : undefined);

  // 편집기의 [저장] — 쓰고, 프로필을 다시 읽고, 시트를 닫고, 토스트. 실패하면 시트를 열어 둔 채 토스트 (useAction)
  const saveEdit = (fields: ProfileFields) =>
    run(async () => {
      if (!userId) return;
      if (fields.handle != null) {
        // L3 changeHandle 오면 교체 (30일에 한 번 바꾸는 제한 D95도 L3 몫)
        if (!shouldSaveHandle(fields.handle, profile?.handle)) {
          closeEditor();
          return;
        }
        if (await isHandleTaken(fields.handle, userId)) throw new UserError('이미 쓰는 아이디예요');
      }
      await saveProfileFields(userId, fields);
      let note = '바꿨어요';
      try {
        await refreshProfile();
      } catch {
        note = '바꿨어요 · 화면을 새로 불러오지 못했어요'; // 저장은 됐음 — 실패로 보이지 않게
      }
      closeEditor();
      setPlaceOpen(false);
      toast(note);
    }, '저장하지 못했어요');

  const pickHome = (place: Place) => {
    const patch = homePatchOf(place);
    // 좌표가 없는 장소는 집으로 못 정함 — 이름만 바꾸면 이전 좌표와 어긋나고, 지우면 새 일정의 이동시간 계산이 막힘 (시트는 열어 둠)
    if (!patch) {
      toast('이 장소는 위치를 몰라 집으로 정할 수 없어요. 다른 장소를 골라 주세요');
      return;
    }
    void saveEdit(patch);
  };

  return (
    <Screen>
      <TopBar onBack={backOrHome} screenId="L03" />
      <Text variant="title">설정</Text>

      <SectionHeader title="계정" />
      <Card>
        <KeyValueRow first label="로그인" value={enabled ? (PROVIDER_NAME[provider] ?? (provider || '-')) : '가짜 데이터 모드'} />
        <EditRow label="닉네임" value={profile?.nickname ?? '-'} onPress={open('nickname')} />
        <EditRow label="아이디" value={profile?.handle ? `@${profile.handle}` : '-'} onPress={open('handle')} />
      </Card>

      {profile ? (
        <>
          <SectionHeader title="아침 준비 기본값" />
          <Card>
            <EditRow first label="준비 시간" value={`${profile.default_prepare_minutes}분`} onPress={open('prepare')} />
            <EditRow label="여유 시간" value={`${profile.default_buffer_minutes}분`} onPress={open('prepare')} />
            <EditRow label="이동 수단" value={TRANSPORT_NAME[profile.default_transport]} onPress={open('prepare')} />
            <EditRow label="집(출발지)" value={profile.home_name ?? '정하지 않았어요'} onPress={canEdit ? () => setPlaceOpen(true) : undefined} />
          </Card>

          {canEdit && (TIMETABLE_PATHS.photo || TIMETABLE_PATHS.calendar) ? (
            <>
              <SectionHeader title="수업 시간표" />
              <ImportEntryCard
                onPhoto={
                  TIMETABLE_PATHS.photo
                    ? async () => {
                        const batch = await photoImport.pick();
                        if (batch) {
                          setImportBatch(batch);
                          router.push('/timetable-import');
                        }
                      }
                    : undefined
                }
                busy={photoImport.reading}
                reading={photoImport.reading ? 'photo' : null}
              />
            </>
          ) : null}

          <SectionHeader title="알람" />
          <Card>
            <EditRow first label="잠귀" value={WAKE_SENSITIVITY_NAME[profile.wake_sensitivity]} onPress={open('sleep')} />
            <EditRow label="깨우는 여유" value={WAKE_MARGIN_NAME[profile.wake_margin]} onPress={open('prepare')} />
          </Card>
        </>
      ) : null}

      {/* 알람이 잘 울리게 하는 폰 설정 — 값이 아니라 길이라 프로필 값(위 "알람" 절)과 나눔. 가짜 모드에서도 보임 */}
      <SectionHeader title="알람 점검" />
      <Card>
        {profile ? (
          <Pressable
            onPress={() => void openAppNotificationSettings()}
            accessibilityRole="button"
            accessibilityLabel="알림 설정 열기"
            style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
          >
            <Text variant="body">알림 설정 열기</Text>
            <Text variant="body" tone="sub">
              ›
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => router.push('/ring-check')}
          accessibilityRole="button"
          accessibilityLabel="알람이 안 울릴 때"
          style={({ pressed }) => [styles.linkRow, profile && styles.linkDivider, pressed && styles.pressed]}
        >
          <Text variant="body">알람이 안 울릴 때</Text>
          <Text variant="body" tone="sub">
            ›
          </Text>
        </Pressable>
      </Card>

      {enabled && user ? (
        <View style={styles.stack}>
          <Button
            label="로그아웃"
            variant="ghost"
            loading={logout.busy}
            onPress={() =>
              logout.run(async () => {
                setError(null);
                await signOutAndCleanup().catch((e) => setError(userMessage(e, '로그아웃하지 못했어요')));
              })
            }
          />
          {error ? (
            <Text variant="small" tone="warn">
              {error}
            </Text>
          ) : null}
        </View>
      ) : (
        <Text variant="small">
          {canUseRealData ? '실데이터 모드로 바꾸면 로그인 정보가 여기에 보여요.' : '이 빌드에서는 실데이터를 쓸 수 없어 로그인 정보가 없어요.'}
        </Text>
      )}

      {/* 폰 출시용 빌드는 실데이터로 고정이라 개발 절이 없음 (lib/modePolicy.ts) */}
      {modeLocked ? null : (
        <>
          <SectionHeader title="개발" right={canUseRealData ? undefined : '실데이터를 쓸 수 없음'} />
          <DataModeToggle />
          <Text variant="caption" style={styles.note}>
            가짜 데이터는 목업 시나리오(5월 22일)로 로그인 없이 돌아요. 화면 목록은 /dev/screens
          </Text>
        </>
      )}

      {/* 편집 시트 — 내용은 루트에서 그려지므로 편집기가 자기 draft를 가짐. 한 번에 하나만 열림 */}
      {profile ? (
        <>
          <Sheet visible={editing === 'nickname'} onClose={closeEditor} title="닉네임">
            <NicknameEditor initial={profile.nickname} onSave={saveEdit} onCancel={closeEditor} />
          </Sheet>
          <Sheet visible={editing === 'handle'} onClose={closeEditor} title="아이디">
            <HandleEditor initial={profile.handle} onSave={saveEdit} onCancel={closeEditor} />
          </Sheet>
          <Sheet visible={editing === 'sleep'} onClose={closeEditor} title="잠귀">
            <SleepEditor initial={profile.wake_sensitivity} onSave={saveEdit} onCancel={closeEditor} />
          </Sheet>
          <Sheet visible={editing === 'prepare'} onClose={closeEditor} title="아침 준비">
            <PrepareEditor initial={prepareValuesOf(profile)} onSave={saveEdit} onCancel={closeEditor} />
          </Sheet>
        </>
      ) : null}
      {/* 집 — 지도에서 핀으로 고름 (검색 · 현재 위치도 됨). 첫 중심은 지금 집, 없으면 서울 시청 */}
      <MapPlaceSheet
        visible={placeOpen}
        onClose={() => setPlaceOpen(false)}
        onPick={pickHome}
        search={(query) => listPlaces(query, homeOf(profile))}
        reverse={reverseAddress}
        locate={locateOnce}
        center={homeOf(profile)}
        suggestedNames={['집']}
        areaWarning="캠퍼스 대표 위치예요. 건물을 고르면 더 정확해요"
        title="집 찾기"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8, marginTop: 16 },
  note: { marginTop: 4, marginHorizontal: 4 },
  linkRow: { minHeight: size.touch, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  linkDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
});
