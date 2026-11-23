// Optional research pilot. This self-report does not replace alarm
// dismissal prepare_started_at or change alarm scheduling.
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

export type PrepStartSelfReport = {
  self_reported_prep_started_at: string | null;
  departed_at: string | null;
};

// Exactly matches the server RPC's appointment-time eligibility window.
export function canConfirmPrepStartAt(appointmentAt: Date, at: Date): boolean {
  const diffMinutes = (appointmentAt.getTime() - at.getTime()) / 60000;
  return Number.isFinite(diffMinutes) && diffMinutes >= -60 && diffMinutes <= 180;
}

export async function loadPrepStartSelfReport(appointmentId: string): Promise<PrepStartSelfReport | null> {
  const userId = await requireUserId();
  const { data, error } = await supabase.from('appointment_participants')
    .select('self_reported_prep_started_at, departed_at')
    .eq('appointment_id', appointmentId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function confirmPrepStartSelfReport(appointmentId: string): Promise<string> {
  await requireUserId();
  // Server generates now() and enforces authenticated ownership, pilot
  // allowlist, no prior departure, group exclusion, and idempotent first tap.
  const { data, error } = await supabase.rpc('confirm_prep_start_self_report', {
    p_appointment_id: appointmentId,
  });
  if (error) throw error;
  if (typeof data !== 'string' || !Number.isFinite(Date.parse(data)))
    throw new Error('Missing confirmed start timestamp');
  return data;
}
