// Read-only real-data health check for the web test bench.
// Do not mutate production data, create appointments, or call Edge functions.
import { supabase } from '@/lib/supabase';
import { isMissingOutingColumn } from '@/features/profile/api';

export type PurePrepDbStatus =
  | { kind: 'ready'; legacyMinutes: number | null; pureMinutes: number | null; participantProvenance: 'ready' }
  | { kind: 'migration-needed'; legacyMinutes: number | null; missing: 'profiles' | 'appointment_participants' }
  | { kind: 'error'; reason: string };

export async function inspectPurePrepDb(userId: string): Promise<PurePrepDbStatus> {
  const profile = await supabase.from('profiles')
    .select('default_prepare_minutes, default_outing_prep_minutes').eq('user_id', userId).maybeSingle();
  if (profile.error) {
    if (isMissingOutingColumn(profile.error)) {
      const legacy = await supabase.from('profiles')
        .select('default_prepare_minutes').eq('user_id', userId).maybeSingle();
      if (legacy.error) return { kind: 'error', reason: '기존 프로필을 읽지 못했습니다. 권한·로그인 상태를 확인하세요.' };
      return { kind: 'migration-needed', legacyMinutes: legacy.data?.default_prepare_minutes ?? null, missing: 'profiles' };
    }
    return { kind: 'error', reason: '프로필 조회에 실패했습니다. 권한·연결 상태를 확인하세요.' };
  }
  // RLS-scoped self rows; select limit 1 checks that all participant
  // provenance columns exist even when the account has zero appointments.
  const participants = await supabase.from('appointment_participants')
    .select('outing_prep_minutes, outing_prep_source, outing_prep_model, prepare_value_source')
    .eq('user_id', userId).limit(1);
  if (participants.error) {
    if (participants.error.code === '42703') {
      return { kind: 'migration-needed', legacyMinutes: profile.data?.default_prepare_minutes ?? null, missing: 'appointment_participants' };
    }
    return { kind: 'error', reason: '일정 참여 데이터의 스키마 조회에 실패했습니다. 권한을 확인하세요.' };
  }
  return {
    kind: 'ready',
    legacyMinutes: profile.data?.default_prepare_minutes ?? null,
    pureMinutes: profile.data?.default_outing_prep_minutes ?? null,
    participantProvenance: 'ready',
  };
}

export type LegacyAlarmSnapshot = {
  kind: string;
  at: string;
  enabled: boolean;
};

// Read only the authenticated account's next five saved DB alarms.
// This does not claim that Android has scheduled them; local notification
// delivery is a separate native E2E.
export async function inspectMyUpcomingAlarms(userId: string): Promise<LegacyAlarmSnapshot[]> {
  const { data, error } = await supabase.from('alarms')
    .select('alarm_type, scheduled_at, is_enabled')
    .eq('user_id', userId)
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(5);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    kind: row.alarm_type,
    at: row.scheduled_at,
    enabled: row.is_enabled,
  }));
}
