-- =====================================================================
-- 개발 화면 [내 시험 데이터 지우기] 서버 함수 (지형 10/30 — "웹에서 테스트한 내용을 지우고 내 계정으로 다시 테스트")
--   public.dev_reset_my_data() — 부른 사람(auth.uid()) 본인의 시험 데이터를 지우고 프로필을 온보딩 전 상태로 되돌림
--   계정 · 친구 · 그룹 · 공유 권한 · 푸시 토큰은 그대로. 개발용 — 출시 빌드에서는 앱이 부르지 않음 (D16)
--   함수 하나만 더함 (표 · 칸 없음). 이 파일만 먼저 들어가도 지금 동작은 그대로임 — 부르는 곳은 앱 개발 화면 하나뿐
-- 파일 이름의 시각은 머지 직전에 npx supabase migration new로 다시 받음 (마이그레이션 머지 큐)
-- =====================================================================
--
-- 남의 행에 닿지 않는 것이 최우선. 모든 delete · update는 user_id(또는 creator_id) = auth.uid() 하나로만 좁힘.
-- 아래는 이 함수를 쓰기 전에 public 스키마에서 사용자 칸(user_id · creator_id · owner_id 등)을 가진 표를 모두 확인한 결과
--
--   표                          처리         이유
--   ------------------------------------------------------------------
--   alarms                      지움         내 알람 전부 (약속 · 루틴 · 일정 없는 알람). user_id = 나
--   alarm_events                지움         내 울림 · 반응 기록. alarms 삭제로 cascade되지만 user_id = 나로 한 번 더 좁혀 지움
--   alarm_suggestions           지움         내 수정 제안 이력 (대상 알람 · 근거 기록이 같이 사라지므로)
--   appointment_participants    지움         내 참여 행 전부. 남의 참여 행은 안 건드림
--   appointments                조건부 지움   내가 만든 일정(creator_id = 나)만, 그중 "나 혼자"인 것만 (아래 2절). 남이 만든 일정은 안 건드림
--   daily_records               지움         내 생활 기록
--   daily_journals              지움         내 일기 · 코칭
--   conversation_sessions       지움         내 AI 대화 (turns · server_state 포함)
--   user_edit_logs              지움         내 고친 값 기록 (개인화 입력이라 시험 흔적)
--   profiles (내 행)            되돌림       온보딩 판정 칸 · 온보딩에서 받는 값 · 기본값 (3절). handle · nickname 등은 그대로
--   routines                    둠           지형님 지울 목록에 없음. (알람은 지워지므로 단계 알람 없는 루틴이 남음 — 루틴 알람은 다시 만들 때 생김)
--   todos                       둠           지울 목록에 없음. 지운 일정 · 대화에 달려 있던 것은 FK(set null)로 연결만 끊김
--   friends · groups · group_members · sharing_permissions
--                               둠           친구 · 그룹 · 공유 권한은 그대로 (남과 맺은 관계라 한쪽이 지우면 남의 화면이 바뀜)
--   push_tokens                 둠           푸시 토큰 — 기기 등록은 앱을 켤 때 다시 하지만 지울 이유가 없음
--   ai_calls · user_questions   둠           하루 AI 호출 상한 · 질문 예산(하루 1 · 주 3)을 세는 서버 기록. 지우면 상한을 되돌리는 우회가 됨.
--                               (대화를 지우면 두 표의 session_id만 FK(set null)로 NULL이 됨 — 줄은 그대로. ai_calls.io에 든 대화 글은 남음)
--   roll_attempts               둠           반복 회차 재시도 기록(서버 전용). 묶음이 지워지면 읽는 쪽이 만나지 않는 줄이 됨
--   decision_comments · decision_votes · decision_states
--                               둠           사용자 칸 없는 회의 도구 표
-- =====================================================================


create function public.dev_reset_my_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                uuid := auth.uid();
  v_alone              uuid[];    -- 지울 일정 (내가 만들었고 나 혼자인 것)
  v_alarm_suggestions  integer;
  v_user_edit_logs     integer;
  v_alarm_events       integer;
  v_alarms             integer;
  v_daily_journals     integer;
  v_daily_records      integer;
  v_conversations      integer;
  v_participants       integer;
  v_appointments       integer;
  v_kept               integer;
  v_profile            integer;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  -- -------------------------------------------------------------------
  -- 1. 내가 만든 일정을 잠금 — 아래 "나 혼자" 판정과 지우기 사이에 남이 그 일정에 참여하지 못하게
  --    (참여 행을 넣는 쪽은 일정 행에 FK 공유 잠금을 걸어서 이 잠금이 풀릴 때까지 기다리고, 그때는 일정이 없어 거절됨)
  --    다음 문장부터 새 스냅샷으로 읽으므로 잠금을 푼 뒤 들어온 참여 행도 판정에 보임
  -- -------------------------------------------------------------------
  perform 1 from public.appointments a where a.creator_id = v_uid order by a.appointment_id for update;

  -- -------------------------------------------------------------------
  -- 2. 지울 일정 = 내가 만들었고 나 혼자인 일정 (반복 묶음은 회차마다 따로 판정 — 혼자인 묶음은 회차가 모두 혼자라 묶음 전체가 지워짐)
  --    "나 혼자" = 남의 참여 행이 없음. 거기에 더해, 남의 할 일(todos) · 고친 값 기록(user_edit_logs)이 이 일정을 가리키고 있지 않음
  --    (일정을 지우면 FK set null로 그 남의 행이 고쳐지므로, 남의 행이 닿으면 공동 일정으로 보고 남김)
  --    다른 사람이 참여 중인 공동 일정은 일정 자체를 지우지 않음 — 아래 참여 행 삭제로 내 참여 행(과 내 알람)만 사라짐
  -- -------------------------------------------------------------------
  select coalesce(array_agg(a.appointment_id), '{}'::uuid[])
    into v_alone
  from public.appointments a
  where a.creator_id = v_uid
    and not exists (select 1 from public.appointment_participants p
                    where p.appointment_id = a.appointment_id and p.user_id <> v_uid)
    and not exists (select 1 from public.todos t
                    where t.appointment_id = a.appointment_id and t.user_id <> v_uid)
    and not exists (select 1 from public.user_edit_logs l
                    where l.appointment_id = a.appointment_id and l.user_id <> v_uid);

  -- -------------------------------------------------------------------
  -- 3. 지우기 — 자식 → 부모 순서. 전부 내 user_id로만 좁힘
  -- -------------------------------------------------------------------
  delete from public.alarm_suggestions s where s.user_id = v_uid;
  get diagnostics v_alarm_suggestions = row_count;

  delete from public.user_edit_logs l where l.user_id = v_uid;
  get diagnostics v_user_edit_logs = row_count;

  delete from public.alarm_events e where e.user_id = v_uid;
  get diagnostics v_alarm_events = row_count;

  delete from public.alarms al where al.user_id = v_uid;
  get diagnostics v_alarms = row_count;

  delete from public.daily_journals j where j.user_id = v_uid;
  get diagnostics v_daily_journals = row_count;

  delete from public.daily_records r where r.user_id = v_uid;
  get diagnostics v_daily_records = row_count;

  -- 대화: turns · server_state를 앱이 못 쓰게 막는 트리거는 insert · update에만 걸려서 delete는 막히지 않음
  delete from public.conversation_sessions c where c.user_id = v_uid;
  get diagnostics v_conversations = row_count;

  -- 내 참여 행 전부 — 공동 일정은 여기서 내 몫만 사라지고 일정과 남의 참여 행 · 알람은 그대로
  delete from public.appointment_participants p where p.user_id = v_uid;
  get diagnostics v_participants = row_count;

  -- 나 혼자인 일정만 일정째 (남은 참여 행이 있다면 내 것뿐이라 위에서 이미 지워짐). creator_id = 나를 한 번 더 걸어 둠
  delete from public.appointments a
  where a.appointment_id = any (v_alone)
    and a.creator_id = v_uid;
  get diagnostics v_appointments = row_count;

  select count(*)::integer into v_kept from public.appointments a where a.creator_id = v_uid;

  -- -------------------------------------------------------------------
  -- 4. 프로필(내 행) — 온보딩부터 다시 할 수 있게 온보딩이 채우는 값을 비우거나 기본값으로
  --    비우는 것: 온보딩 끝난 시각 · 집(이름 · 좌표 · 반경) · 개인정보 동의(시각 · 판 번호는 짝 제약 때문에 둘 다) — 동의도 온보딩에서 다시 받음
  --    기본값으로: 잠귀 · 깨우는 여유 · 기본 준비 · 여유 시간 · 이동 수단 · 제안 결과 반영값(intensity_offset)
  --    그대로 두는 것: handle · nickname · profile_image_url(계정 정보) · timezone · preferred_voice_tone · preferred_sound_key(고른 취향)
  -- -------------------------------------------------------------------
  update public.profiles p
     set onboarded_at            = null,
         wake_sensitivity        = 'NORMAL',
         wake_margin             = 'NORMAL',
         home_name               = null,
         home_lat                = null,
         home_lng                = null,
         home_radius_m           = null,
         default_prepare_minutes = 60,
         default_buffer_minutes  = 10,
         default_transport       = 'TRANSIT',
         intensity_offset        = 0,
         privacy_agreed_at       = null,
         privacy_version         = null
   where p.user_id = v_uid;
  get diagnostics v_profile = row_count;

  return jsonb_build_object(
    'appointments',        v_appointments,
    'appointments_kept',   v_kept,
    'participants',        v_participants,
    'alarms',              v_alarms,
    'alarm_events',        v_alarm_events,
    'alarm_suggestions',   v_alarm_suggestions,
    'daily_records',       v_daily_records,
    'daily_journals',      v_daily_journals,
    'conversation_sessions', v_conversations,
    'user_edit_logs',      v_user_edit_logs,
    'profile',             v_profile
  );
end;
$$;

comment on function public.dev_reset_my_data() is
  '개발용 — 부른 사람 본인의 시험 데이터(일정 · 알람 · 기록 · 일기 · AI 대화 · 고친 값 기록 · 제안)를 지우고 프로필을 온보딩 전으로 되돌림. 남이 참여 중인 공동 일정은 내 참여 행만 지움. 친구 · 그룹 · 푸시 토큰 · ai_calls · user_questions는 그대로. 출시 빌드에서는 앱이 부르지 않음';

-- 로그인한 사용자만 (anon · public은 막음). 새 함수는 기본으로 API 역할에 열려 있을 수 있어서 직접 정함
revoke all on function public.dev_reset_my_data() from public, anon;
grant execute on function public.dev_reset_my_data() to authenticated;
