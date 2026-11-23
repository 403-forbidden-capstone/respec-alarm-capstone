
-- Read-only QA of preparation signals. Returns only aggregates, no identifiers.
-- PREPARE_ALARM: dismissal; LOCATION: geofence departure estimate;
-- self_reported_prep_started_at: user tap, not verified physical activity.
with signals as (
 select user_id, (departed_at at time zone 'Asia/Seoul')::date as day_kst,
   prepare_started_at, prepare_started_source::text as ps,
   self_reported_prep_started_at as self_report, departed_at,
   departed_source::text as ds,
   extract(epoch from departed_at-prepare_started_at)/60 as dismiss_mins,
   extract(epoch from departed_at-self_reported_prep_started_at)/60 as report_mins,
   extract(epoch from self_reported_prep_started_at-prepare_started_at)/60 as report_gap_mins
 from public.appointment_participants
), classified as (
 select *,
   (ps='PREPARE_ALARM' and ds='LOCATION' and
     dismiss_mins between 10 and 240 and departed_at<now()) as valid_dismiss_proxy,
   (self_report is not null and ds='LOCATION' and
     report_mins between 10 and 240 and departed_at<now()) as valid_self_proxy
 from signals
), duplicates as (
 select user_id,day_kst,count(*) as n from classified
 where valid_dismiss_proxy group by user_id,day_kst having count(*)>1
), counts as (
 select count(*) as total_rows,
   count(*) filter(where valid_dismiss_proxy) as valid_alarm_dismiss_rows,
   count(*) filter(where valid_self_proxy) as valid_self_report_rows,
   count(*) filter(where self_report is not null) as self_report_rows,
   count(*) filter(where self_report is not null and departed_at is null) as self_report_no_departure,
   count(*) filter(where self_report is not null and departed_at is not null and
       (report_mins<=0 or report_mins>240)) as implausible_self_report,
   count(*) filter(where self_report is not null and prepare_started_at is not null) as paired_start_signals,
   count(distinct user_id) filter(where valid_dismiss_proxy) as users_with_dismiss_proxy,
   round((percentile_cont(.5) within group(order by report_gap_mins)
        filter(where self_report is not null and prepare_started_at is not null))::numeric,2)
       as median_dismiss_to_report_minutes,
   round((percentile_cont(.5) within group(order by report_mins)
        filter(where valid_self_proxy))::numeric,2)
       as median_report_to_depart_minutes
 from classified
), per_user as (
 select user_id,count(*) valid_sessions from classified
 where valid_dismiss_proxy group by user_id
)
select counts.*,
  (select count(*) from per_user where valid_sessions>=10) as users_with_10_history,
  (select coalesce(max(valid_sessions),0) from per_user) as max_history_per_user,
  (select count(*) from duplicates) as user_day_duplicates_for_review
from counts;
