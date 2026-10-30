// 개발용 미리보기 — 실제 온보딩은 L7이 이 부품에 함수를 붙임
// 온보딩 단계 부품 5개(집 위치 → 수업 시간표 → 권한 안내 → 끝)를 한 화면에서 넘겨 봄. 값은 모두 이 파일 안 가짜 state — 저장 · 이동 · 권한 요청은 하지 않음
// 주소로만 열림: /dev/onboarding?mode=mock (앱은 respecalarm://dev/onboarding). 목업에 없는 화면이라 /dev/screens 목록에는 두지 않음 (#116)
import { router } from 'expo-router';
import { useRef, useState } from 'react';

import { toast } from '@/components/ui';
import { listPlaces } from '@/features/alarm/api';
import { PlaceSearchSheet } from '@/features/alarm/components/PlaceSearchSheet';
import { TimeSheet } from '@/features/alarm/components/TimePicker';
import { HomePlaceStep } from '@/features/onboarding/components/HomePlaceStep';
import { OnboardingDoneStep } from '@/features/onboarding/components/OnboardingDoneStep';
import { OnboardingFrame } from '@/features/onboarding/components/OnboardingFrame';
import { PermissionsStep, type PermissionRow } from '@/features/onboarding/components/PermissionsStep';
import { TimetableStep, type ClassRow } from '@/features/onboarding/components/TimetableStep';
import { now } from '@/lib/clock';
import { addMinutes, minuteOfDay, startOfDay } from '@/lib/format';

const TOTAL = 4;
const DEFAULT_START = 9 * 60; // 시각을 처음 고를 때 보일 값 (오전 9:00)

const FIRST_PERMISSIONS: PermissionRow[] = [
  { key: 'notification', label: '알림', why: '알람이 울리려면 알림이 필요해요', state: 'off' },
  { key: 'fullscreen', label: '전체화면 알림', why: '잠금화면에서도 알람이 뜨게 해요', state: 'off' },
  { key: 'exact', label: '정확한 알람', why: '정한 시각에 맞춰 울리게 해요', state: 'off', actionLabel: '설정 열기' },
  { key: 'usage', label: '사용 정보', why: '폰을 쓰기 시작하면 일어난 걸 알아요', state: 'ok' },
  { key: 'battery', label: '배터리', why: '절전 때문에 알람이 막히지 않게 해요', state: 'unknown' },
];

// 장소 시트를 연 이유 — 집인지, 어느 수업 줄인지
type PlaceTarget = { kind: 'home' } | { kind: 'class'; id: string };

export default function OnboardingPreviewScreen() {
  const [step, setStep] = useState(1);
  const [homeName, setHomeName] = useState<string | null>(null);
  const [rows, setRows] = useState<ClassRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [permissions, setPermissions] = useState(FIRST_PERMISSIONS);
  const [placeTarget, setPlaceTarget] = useState<PlaceTarget | null>(null);
  const [timeRowId, setTimeRowId] = useState<string | null>(null);
  const nextId = useRef(1);

  const go = (to: number) => setStep(Math.min(TOTAL, Math.max(1, to)));
  const next = () => go(step + 1);

  function changeRow(id: string, patch: Partial<ClassRow>) {
    // 고치면 지난 저장 결과는 지움
    setRows((list) => list.map((row) => (row.id === id ? { ...row, ...patch, result: undefined, resultNote: undefined } : row)));
  }

  function addRow() {
    setRows((list) => [...list, { id: `class-${nextId.current++}`, name: '', days: [], startMinutes: null, place: '' }]);
  }

  function pickTime(id: string) {
    // 처음 열 때 보이는 값(오전 9:00)을 그대로 값으로 잡아 둠
    setRows((list) => list.map((row) => (row.id === id && row.startMinutes == null ? { ...row, startMinutes: DEFAULT_START } : row)));
    setTimeRowId(id);
  }

  function pickPlace(place: { name: string }) {
    if (placeTarget?.kind === 'home') setHomeName(place.name);
    if (placeTarget?.kind === 'class') changeRow(placeTarget.id, { place: place.name });
    setPlaceTarget(null);
  }

  // 가짜 저장 — 과목 · 요일 · 시각 · 장소가 다 있으면 ok, 하나라도 비면 줄에 이유를 보임. 모두 ok면 다음 단계로
  function saveRows() {
    setSaving(true);
    setTimeout(() => {
      const checked = rows.map((row): ClassRow => {
        if (!row.name.trim()) return { ...row, result: 'error', resultNote: '과목 이름을 적어 주세요' };
        if (row.days.length === 0) return { ...row, result: 'error', resultNote: '요일을 하나 이상 골라 주세요' };
        if (row.startMinutes == null) return { ...row, result: 'error', resultNote: '시작 시각을 골라 주세요' };
        if (!row.place) return { ...row, result: 'error', resultNote: '장소를 골라 주세요' };
        return { ...row, result: 'ok' };
      });
      setRows(checked);
      setSaving(false);
      if (checked.every((row) => row.result === 'ok')) next();
    }, 600);
  }

  const timeRow = rows.find((row) => row.id === timeRowId);
  const summary = [
    { label: '집', value: homeName ?? '정하지 않았어요' },
    { label: '수업', value: rows.length ? `${rows.length}개` : '넣지 않았어요' },
    { label: '켠 권한', value: `${permissions.filter((p) => p.state === 'ok').length} / ${permissions.length}` },
  ];

  const onBack = step > 1 ? () => go(step - 1) : router.canGoBack() ? router.back : undefined;

  return (
    <>
      {step === 1 ? (
        <OnboardingFrame
          step={1}
          total={TOTAL}
          title="집은 어디예요?"
          primaryLabel="다음"
          onPrimary={next}
          primaryDisabled={!homeName}
          secondaryLabel="나중에"
          onSecondary={next}
          onBack={onBack}
        >
          <HomePlaceStep homeName={homeName} onOpenSearch={() => setPlaceTarget({ kind: 'home' })} onClear={() => setHomeName(null)} />
        </OnboardingFrame>
      ) : null}
      {step === 2 ? (
        <OnboardingFrame
          step={2}
          total={TOTAL}
          title="수업 시간표"
          lead="수업 시간을 알려 주면 수업 전 알람을 맞춰요"
          primaryLabel="저장하고 다음"
          onPrimary={saveRows}
          primaryBusy={saving}
          secondaryLabel="건너뛰기"
          onSecondary={next}
          onBack={onBack}
        >
          <TimetableStep
            rows={rows}
            saving={saving}
            onChangeRow={changeRow}
            onAddRow={addRow}
            onRemoveRow={(id) => setRows((list) => list.filter((row) => row.id !== id))}
            onPickPlace={(id) => setPlaceTarget({ kind: 'class', id })}
            onPickTime={pickTime}
          />
        </OnboardingFrame>
      ) : null}
      {step === 3 ? (
        <OnboardingFrame
          step={3}
          total={TOTAL}
          title="알람이 확실히 울리게"
          lead="아래 권한을 켜 두면 잠금화면에서도 알람이 울려요"
          primaryLabel="다음"
          onPrimary={next}
          secondaryLabel="나중에"
          onSecondary={next}
          onBack={onBack}
        >
          <PermissionsStep
            rows={permissions}
            onAction={(key) => setPermissions((list) => list.map((p) => (p.key === key ? { ...p, state: 'ok' } : p)))}
            onOpenChecklist={() => toast('미리보기라 점검표는 열지 않아요')}
          />
        </OnboardingFrame>
      ) : null}
      {step === 4 ? (
        <OnboardingFrame
          step={4}
          total={TOTAL}
          title="준비 끝났어요"
          primaryLabel="첫 일정 만들기"
          onPrimary={() => toast('미리보기라 일정 화면으로 가지 않아요')}
          secondaryLabel="나중에"
          onSecondary={() => toast('미리보기라 홈으로 가지 않아요')}
          onBack={onBack}
        >
          <OnboardingDoneStep summary={summary} />
        </OnboardingFrame>
      ) : null}

      <PlaceSearchSheet
        visible={placeTarget != null}
        onClose={() => setPlaceTarget(null)}
        onPick={pickPlace}
        search={(query) => listPlaces(query)}
        title={placeTarget?.kind === 'home' ? '집 찾기' : '장소 찾기'}
      />
      <TimeSheet
        visible={timeRow != null}
        onClose={() => setTimeRowId(null)}
        title="시작 시각"
        value={addMinutes(startOfDay(now()), timeRow?.startMinutes ?? DEFAULT_START)}
        onChange={(picked) => timeRowId && changeRow(timeRowId, { startMinutes: minuteOfDay(picked) })}
      />
    </>
  );
}
