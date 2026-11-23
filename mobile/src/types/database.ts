
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "ai_calls": {
                  Row: {
                    "attempts": number,"cache_read_tokens": number | null,"cache_write_tokens": number | null,"call_id": string,"cost_usd": number | null,"created_at": string,"error_code": string | null,"flags": (string)[],"input_tokens": number | null,"io": Json | null,"latency_ms": number,"model": string,"ok": boolean,"output_tokens": number | null,"point": string,"prompt_id": string,"prompt_version": string,"request_id": string | null,"session_id": string | null,"stop_reason": string | null,"thinking_tokens": number | null,"user_id": string
                  }
                  Insert: {
                    "attempts"?: number,"cache_read_tokens"?: number | null,"cache_write_tokens"?: number | null,"call_id"?: string,"cost_usd"?: number | null,"created_at"?: string,"error_code"?: string | null,"flags"?: (string)[],"input_tokens"?: number | null,"io"?: Json | null,"latency_ms": number,"model": string,"ok": boolean,"output_tokens"?: number | null,"point": string,"prompt_id": string,"prompt_version": string,"request_id"?: string | null,"session_id"?: string | null,"stop_reason"?: string | null,"thinking_tokens"?: number | null,"user_id": string
                  }
                  Update: {
                    "attempts"?: number,"cache_read_tokens"?: number | null,"cache_write_tokens"?: number | null,"call_id"?: string,"cost_usd"?: number | null,"created_at"?: string,"error_code"?: string | null,"flags"?: (string)[],"input_tokens"?: number | null,"io"?: Json | null,"latency_ms"?: number,"model"?: string,"ok"?: boolean,"output_tokens"?: number | null,"point"?: string,"prompt_id"?: string,"prompt_version"?: string,"request_id"?: string | null,"session_id"?: string | null,"stop_reason"?: string | null,"thinking_tokens"?: number | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ai_calls_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "conversation_sessions"
      referencedColumns: ["session_id"]
    },{
      foreignKeyName: "ai_calls_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"alarm_events": {
                  Row: {
                    "alarm_id": string,"client_event_id": string | null,"created_at": string,"event_at": string,"event_id": number,"event_type": Database["public"]['Enums']["alarm_event_type"],"feedback_type": Database["public"]['Enums']["alarm_feedback_type"] | null,"input_source": Database["public"]['Enums']["event_input_source"] | null,"sequence_no": number,"snooze_minutes": number | null,"user_id": string
                  }
                  Insert: {
                    "alarm_id": string,"client_event_id"?: string | null,"created_at"?: string,"event_at"?: string,"event_id"?: number,"event_type": Database["public"]['Enums']["alarm_event_type"],"feedback_type"?: Database["public"]['Enums']["alarm_feedback_type"] | null,"input_source"?: Database["public"]['Enums']["event_input_source"] | null,"sequence_no"?: number,"snooze_minutes"?: number | null,"user_id": string
                  }
                  Update: {
                    "alarm_id"?: string,"client_event_id"?: string | null,"created_at"?: string,"event_at"?: string,"event_id"?: number,"event_type"?: Database["public"]['Enums']["alarm_event_type"],"feedback_type"?: Database["public"]['Enums']["alarm_feedback_type"] | null,"input_source"?: Database["public"]['Enums']["event_input_source"] | null,"sequence_no"?: number,"snooze_minutes"?: number | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "alarm_events_alarm_id_fkey"
      columns: ["alarm_id"]
isOneToOne: false
      referencedRelation: "alarms"
      referencedColumns: ["alarm_id"]
    },{
      foreignKeyName: "alarm_events_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"alarm_proposals": {
                  Row: {
                    "alarm_id": string,"created_at": string,"from_at": string,"owner_id": string,"proposal_id": string,"proposer_id": string,"responded_at": string | null,"status": string,"to_at": string
                  }
                  Insert: {
                    "alarm_id": string,"created_at"?: string,"from_at": string,"owner_id": string,"proposal_id"?: string,"proposer_id": string,"responded_at"?: string | null,"status"?: string,"to_at": string
                  }
                  Update: {
                    "alarm_id"?: string,"created_at"?: string,"from_at"?: string,"owner_id"?: string,"proposal_id"?: string,"proposer_id"?: string,"responded_at"?: string | null,"status"?: string,"to_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "alarm_proposals_alarm_id_fkey"
      columns: ["alarm_id"]
isOneToOne: false
      referencedRelation: "alarms"
      referencedColumns: ["alarm_id"]
    },{
      foreignKeyName: "alarm_proposals_owner_id_fkey"
      columns: ["owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "alarm_proposals_proposer_id_fkey"
      columns: ["proposer_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"alarm_suggestions": {
                  Row: {
                    "created_at": string,"current_value": string | null,"evidence": Json | null,"responded_at": string | null,"result_value": string | null,"source_event_id": number | null,"status": Database["public"]['Enums']["alarm_suggestion_status"],"suggested_value": string,"suggestion_id": string,"suggestion_type": Database["public"]['Enums']["alarm_suggestion_type"],"suppress_until": string | null,"target_alarm_id": string | null,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"current_value"?: string | null,"evidence"?: Json | null,"responded_at"?: string | null,"result_value"?: string | null,"source_event_id"?: number | null,"status"?: Database["public"]['Enums']["alarm_suggestion_status"],"suggested_value": string,"suggestion_id"?: string,"suggestion_type": Database["public"]['Enums']["alarm_suggestion_type"],"suppress_until"?: string | null,"target_alarm_id"?: string | null,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"current_value"?: string | null,"evidence"?: Json | null,"responded_at"?: string | null,"result_value"?: string | null,"source_event_id"?: number | null,"status"?: Database["public"]['Enums']["alarm_suggestion_status"],"suggested_value"?: string,"suggestion_id"?: string,"suggestion_type"?: Database["public"]['Enums']["alarm_suggestion_type"],"suppress_until"?: string | null,"target_alarm_id"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "alarm_suggestions_source_event_id_fkey"
      columns: ["source_event_id"]
isOneToOne: false
      referencedRelation: "alarm_events"
      referencedColumns: ["event_id"]
    },{
      foreignKeyName: "alarm_suggestions_target_alarm_id_fkey"
      columns: ["target_alarm_id"]
isOneToOne: false
      referencedRelation: "alarms"
      referencedColumns: ["alarm_id"]
    },{
      foreignKeyName: "alarm_suggestions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"alarms": {
                  Row: {
                    "alarm_id": string,"alarm_type": Database["public"]['Enums']["alarm_type"],"created_at": string,"intensity": Database["public"]['Enums']["alarm_intensity"],"intensity_source": Database["public"]['Enums']["alarm_value_source"],"is_enabled": boolean,"last_calculated_at": string,"occurrence_on": string | null,"original_scheduled_at": string | null,"original_time_source": Database["public"]['Enums']["alarm_value_source"] | null,"participant_id": string | null,"recurrence_rule": string | null,"routine_id": string | null,"scheduled_at": string,"series_id": string | null,"snooze_limit": number,"sound_key": string | null,"step_order": number | null,"time_source": Database["public"]['Enums']["alarm_value_source"],"updated_at": string,"user_id": string,"vibration": string | null,"voice_tone": Database["public"]['Enums']["voice_tone"]
                  }
                  Insert: {
                    "alarm_id"?: string,"alarm_type": Database["public"]['Enums']["alarm_type"],"created_at"?: string,"intensity"?: Database["public"]['Enums']["alarm_intensity"],"intensity_source"?: Database["public"]['Enums']["alarm_value_source"],"is_enabled"?: boolean,"last_calculated_at"?: string,"occurrence_on"?: string | null,"original_scheduled_at"?: string | null,"original_time_source"?: Database["public"]['Enums']["alarm_value_source"] | null,"participant_id"?: string | null,"recurrence_rule"?: string | null,"routine_id"?: string | null,"scheduled_at": string,"series_id"?: string | null,"snooze_limit"?: number,"sound_key"?: string | null,"step_order"?: number | null,"time_source"?: Database["public"]['Enums']["alarm_value_source"],"updated_at"?: string,"user_id": string,"vibration"?: string | null,"voice_tone"?: Database["public"]['Enums']["voice_tone"]
                  }
                  Update: {
                    "alarm_id"?: string,"alarm_type"?: Database["public"]['Enums']["alarm_type"],"created_at"?: string,"intensity"?: Database["public"]['Enums']["alarm_intensity"],"intensity_source"?: Database["public"]['Enums']["alarm_value_source"],"is_enabled"?: boolean,"last_calculated_at"?: string,"occurrence_on"?: string | null,"original_scheduled_at"?: string | null,"original_time_source"?: Database["public"]['Enums']["alarm_value_source"] | null,"participant_id"?: string | null,"recurrence_rule"?: string | null,"routine_id"?: string | null,"scheduled_at"?: string,"series_id"?: string | null,"snooze_limit"?: number,"sound_key"?: string | null,"step_order"?: number | null,"time_source"?: Database["public"]['Enums']["alarm_value_source"],"updated_at"?: string,"user_id"?: string,"vibration"?: string | null,"voice_tone"?: Database["public"]['Enums']["voice_tone"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "alarms_participant_id_fkey"
      columns: ["participant_id"]
isOneToOne: false
      referencedRelation: "appointment_participants"
      referencedColumns: ["participant_id"]
    },{
      foreignKeyName: "alarms_routine_id_fkey"
      columns: ["routine_id"]
isOneToOne: false
      referencedRelation: "routines"
      referencedColumns: ["routine_id"]
    },{
      foreignKeyName: "alarms_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"appointment_participants": {
                  Row: {
                    "actual_travel_minutes": number | null,"appointment_id": string,"arrived_at": string | null,"arrived_source": Database["public"]['Enums']["event_input_source"] | null,"buffer_minutes": number,"departed_at": string | null,"departed_source": Database["public"]['Enums']["event_input_source"] | null,"est_travel_minutes": number | null,"is_late": boolean | null,"late_minutes": number | null,"origin_lat": number | null,"origin_lng": number | null,"origin_name": string | null,"outing_prep_minutes": number | null,"outing_prep_model": string | null,"outing_prep_source": string | null,"participant_id": string,"prepare_advance_minutes": number,"prepare_minutes": number,"self_reported_prep_started_at": string | null,"prepare_started_at": string | null,"prepare_started_source": Database["public"]['Enums']["prepare_start_source"] | null,"prepare_value_source": string,"transport_type": Database["public"]['Enums']["transport_type"],"travel_source": Database["public"]['Enums']["travel_source"],"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "actual_travel_minutes"?: number | null,"appointment_id": string,"arrived_at"?: string | null,"arrived_source"?: Database["public"]['Enums']["event_input_source"] | null,"buffer_minutes"?: number,"departed_at"?: string | null,"departed_source"?: Database["public"]['Enums']["event_input_source"] | null,"est_travel_minutes"?: number | null,"is_late"?: boolean | null,"late_minutes"?: number | null,"origin_lat"?: number | null,"origin_lng"?: number | null,"origin_name"?: string | null,"outing_prep_minutes"?: number | null,"outing_prep_model"?: string | null,"outing_prep_source"?: string | null,"participant_id"?: string,"prepare_advance_minutes"?: number,"prepare_minutes"?: number,"prepare_started_at"?: string | null,"prepare_started_source"?: Database["public"]['Enums']["prepare_start_source"] | null,"prepare_value_source"?: string,"transport_type"?: Database["public"]['Enums']["transport_type"],"travel_source"?: Database["public"]['Enums']["travel_source"],"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "actual_travel_minutes"?: number | null,"appointment_id"?: string,"arrived_at"?: string | null,"arrived_source"?: Database["public"]['Enums']["event_input_source"] | null,"buffer_minutes"?: number,"departed_at"?: string | null,"departed_source"?: Database["public"]['Enums']["event_input_source"] | null,"est_travel_minutes"?: number | null,"is_late"?: boolean | null,"late_minutes"?: number | null,"origin_lat"?: number | null,"origin_lng"?: number | null,"origin_name"?: string | null,"outing_prep_minutes"?: number | null,"outing_prep_model"?: string | null,"outing_prep_source"?: string | null,"participant_id"?: string,"prepare_advance_minutes"?: number,"prepare_minutes"?: number,"prepare_started_at"?: string | null,"prepare_started_source"?: Database["public"]['Enums']["prepare_start_source"] | null,"prepare_value_source"?: string,"transport_type"?: Database["public"]['Enums']["transport_type"],"travel_source"?: Database["public"]['Enums']["travel_source"],"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointment_participants_appointment_id_fkey"
      columns: ["appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["appointment_id"]
    },{
      foreignKeyName: "appointment_participants_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"appointments": {
                  Row: {
                    "appointment_at": string,"appointment_id": string,"created_at": string,"creator_id": string | null,"dest_lat": number | null,"dest_lng": number | null,"dest_name": string,"dest_radius_m": number | null,"exception_kind": string | null,"group_id": string | null,"importance": Database["public"]['Enums']["importance_level"],"memo": string | null,"occurrence_on": string,"recurrence_rule": string | null,"series_id": string,"title": string,"updated_at": string
                  }
                  Insert: {
                    "appointment_at": string,"appointment_id"?: string,"created_at"?: string,"creator_id"?: string | null,"dest_lat"?: number | null,"dest_lng"?: number | null,"dest_name": string,"dest_radius_m"?: number | null,"exception_kind"?: string | null,"group_id"?: string | null,"importance"?: Database["public"]['Enums']["importance_level"],"memo"?: string | null,"occurrence_on": string,"recurrence_rule"?: string | null,"series_id": string,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "appointment_at"?: string,"appointment_id"?: string,"created_at"?: string,"creator_id"?: string | null,"dest_lat"?: number | null,"dest_lng"?: number | null,"dest_name"?: string,"dest_radius_m"?: number | null,"exception_kind"?: string | null,"group_id"?: string | null,"importance"?: Database["public"]['Enums']["importance_level"],"memo"?: string | null,"occurrence_on"?: string,"recurrence_rule"?: string | null,"series_id"?: string,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointments_creator_id_fkey"
      columns: ["creator_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "appointments_group_id_fkey"
      columns: ["group_id"]
isOneToOne: false
      referencedRelation: "groups"
      referencedColumns: ["group_id"]
    }
                  ]
                },"briefing_devices": {
                  Row: {
                    "created_at": string,"device_id": string,"expires_at": string,"last_used_at": string | null,"token_hash": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"device_id": string,"expires_at": string,"last_used_at"?: string | null,"token_hash": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"device_id"?: string,"expires_at"?: string,"last_used_at"?: string | null,"token_hash"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "briefing_devices_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"conversation_sessions": {
                  Row: {
                    "apply_status": Database["public"]['Enums']["apply_status"],"created_at": string,"ended_at": string | null,"extracted_data": Json | null,"input_mode": Database["public"]['Enums']["input_mode"],"server_state": NonNullable<Json>,"session_id": string,"session_type": Database["public"]['Enums']["session_type"],"started_at": string,"transcript": string | null,"turns": NonNullable<Json>,"user_id": string
                  }
                  Insert: {
                    "apply_status"?: Database["public"]['Enums']["apply_status"],"created_at"?: string,"ended_at"?: string | null,"extracted_data"?: Json | null,"input_mode"?: Database["public"]['Enums']["input_mode"],"server_state"?: NonNullable<Json>,"session_id"?: string,"session_type": Database["public"]['Enums']["session_type"],"started_at"?: string,"transcript"?: string | null,"turns"?: NonNullable<Json>,"user_id": string
                  }
                  Update: {
                    "apply_status"?: Database["public"]['Enums']["apply_status"],"created_at"?: string,"ended_at"?: string | null,"extracted_data"?: Json | null,"input_mode"?: Database["public"]['Enums']["input_mode"],"server_state"?: NonNullable<Json>,"session_id"?: string,"session_type"?: Database["public"]['Enums']["session_type"],"started_at"?: string,"transcript"?: string | null,"turns"?: NonNullable<Json>,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "conversation_sessions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"daily_journals": {
                  Row: {
                    "ai_summary": string | null,"coaching_insight": string | null,"edited_summary": string | null,"encouragement": string | null,"generated_at": string | null,"is_edited": boolean,"journal_id": string,"record_date": string,"routine_suggestion": string | null,"sentiment": number | null,"source_session_id": string | null,"suggestion_status": Database["public"]['Enums']["apply_status"],"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "ai_summary"?: string | null,"coaching_insight"?: string | null,"edited_summary"?: string | null,"encouragement"?: string | null,"generated_at"?: string | null,"is_edited"?: boolean,"journal_id"?: string,"record_date": string,"routine_suggestion"?: string | null,"sentiment"?: number | null,"source_session_id"?: string | null,"suggestion_status"?: Database["public"]['Enums']["apply_status"],"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "ai_summary"?: string | null,"coaching_insight"?: string | null,"edited_summary"?: string | null,"encouragement"?: string | null,"generated_at"?: string | null,"is_edited"?: boolean,"journal_id"?: string,"record_date"?: string,"routine_suggestion"?: string | null,"sentiment"?: number | null,"source_session_id"?: string | null,"suggestion_status"?: Database["public"]['Enums']["apply_status"],"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "daily_journals_source_session_id_fkey"
      columns: ["source_session_id"]
isOneToOne: false
      referencedRelation: "conversation_sessions"
      referencedColumns: ["session_id"]
    },{
      foreignKeyName: "daily_journals_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"daily_records": {
                  Row: {
                    "actual_prepare_minutes": number | null,"condition_note": string | null,"data_source": Database["public"]['Enums']["record_source"],"record_date": string,"record_id": string,"routine_done_rate": number | null,"sleep_at": string | null,"sleep_satisfaction": number | null,"updated_at": string,"user_id": string,"wake_confirmed_at": string | null,"wake_reported_at": string | null
                  }
                  Insert: {
                    "actual_prepare_minutes"?: number | null,"condition_note"?: string | null,"data_source"?: Database["public"]['Enums']["record_source"],"record_date": string,"record_id"?: string,"routine_done_rate"?: number | null,"sleep_at"?: string | null,"sleep_satisfaction"?: number | null,"updated_at"?: string,"user_id": string,"wake_confirmed_at"?: string | null,"wake_reported_at"?: string | null
                  }
                  Update: {
                    "actual_prepare_minutes"?: number | null,"condition_note"?: string | null,"data_source"?: Database["public"]['Enums']["record_source"],"record_date"?: string,"record_id"?: string,"routine_done_rate"?: number | null,"sleep_at"?: string | null,"sleep_satisfaction"?: number | null,"updated_at"?: string,"user_id"?: string,"wake_confirmed_at"?: string | null,"wake_reported_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "daily_records_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"decision_comments": {
                  Row: {
                    "author": string,"body": string,"created_at": string,"decision_id": string,"deleted_at": string | null,"id": number
                  }
                  Insert: {
                    "author": string,"body": string,"created_at"?: string,"decision_id": string,"deleted_at"?: string | null,"id"?: never
                  }
                  Update: {
                    "author"?: string,"body"?: string,"created_at"?: string,"decision_id"?: string,"deleted_at"?: string | null,"id"?: never
                  }
                  Relationships: [
                    
                  ]
                },"decision_states": {
                  Row: {
                    "choice": string | null,"code_ref": string,"code_status": string,"decided_at": string | null,"decided_by": string,"decision_id": string,"result": string,"status": string,"updated_at": string,"updated_by": string,"via": string
                  }
                  Insert: {
                    "choice"?: string | null,"code_ref"?: string,"code_status"?: string,"decided_at"?: string | null,"decided_by"?: string,"decision_id": string,"result"?: string,"status": string,"updated_at"?: string,"updated_by"?: string,"via"?: string
                  }
                  Update: {
                    "choice"?: string | null,"code_ref"?: string,"code_status"?: string,"decided_at"?: string | null,"decided_by"?: string,"decision_id"?: string,"result"?: string,"status"?: string,"updated_at"?: string,"updated_by"?: string,"via"?: string
                  }
                  Relationships: [
                    
                  ]
                },"decision_votes": {
                  Row: {
                    "block": number,"created_at": string,"decision_id": string,"option_key": string,"voter": string
                  }
                  Insert: {
                    "block"?: number,"created_at"?: string,"decision_id": string,"option_key": string,"voter": string
                  }
                  Update: {
                    "block"?: number,"created_at"?: string,"decision_id"?: string,"option_key"?: string,"voter"?: string
                  }
                  Relationships: [
                    
                  ]
                },"friend_links": {
                  Row: {
                    "created_at": string,"expires_at": string,"owner_id": string,"token": string
                  }
                  Insert: {
                    "created_at"?: string,"expires_at": string,"owner_id": string,"token": string
                  }
                  Update: {
                    "created_at"?: string,"expires_at"?: string,"owner_id"?: string,"token"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "friend_links_owner_id_fkey"
      columns: ["owner_id"]
isOneToOne: true
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"friends": {
                  Row: {
                    "accepted_at": string | null,"addressee_id": string,"friend_id": string,"requested_at": string,"requester_id": string,"status": Database["public"]['Enums']["friend_status"]
                  }
                  Insert: {
                    "accepted_at"?: string | null,"addressee_id": string,"friend_id"?: string,"requested_at"?: string,"requester_id": string,"status"?: Database["public"]['Enums']["friend_status"]
                  }
                  Update: {
                    "accepted_at"?: string | null,"addressee_id"?: string,"friend_id"?: string,"requested_at"?: string,"requester_id"?: string,"status"?: Database["public"]['Enums']["friend_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "friends_addressee_id_fkey"
      columns: ["addressee_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "friends_requester_id_fkey"
      columns: ["requester_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"group_members": {
                  Row: {
                    "group_id": string,"group_member_id": string,"invite_status": Database["public"]['Enums']["invite_status"],"invited_at": string | null,"invited_by": string | null,"joined_at": string | null,"notifications_off": boolean,"trip_share_opt_in": boolean,"user_id": string,"wake_share_opt_in": boolean
                  }
                  Insert: {
                    "group_id": string,"group_member_id"?: string,"invite_status"?: Database["public"]['Enums']["invite_status"],"invited_at"?: string | null,"invited_by"?: string | null,"joined_at"?: string | null,"notifications_off"?: boolean,"trip_share_opt_in"?: boolean,"user_id": string,"wake_share_opt_in"?: boolean
                  }
                  Update: {
                    "group_id"?: string,"group_member_id"?: string,"invite_status"?: Database["public"]['Enums']["invite_status"],"invited_at"?: string | null,"invited_by"?: string | null,"joined_at"?: string | null,"notifications_off"?: boolean,"trip_share_opt_in"?: boolean,"user_id"?: string,"wake_share_opt_in"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "group_members_group_id_fkey"
      columns: ["group_id"]
isOneToOne: false
      referencedRelation: "groups"
      referencedColumns: ["group_id"]
    },{
      foreignKeyName: "group_members_invited_by_fkey"
      columns: ["invited_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "group_members_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"groups": {
                  Row: {
                    "created_at": string,"description": string | null,"group_id": string,"group_name": string,"invite_code": string,"invite_code_expires_at": string,"invite_code_issued_at": string,"owner_id": string | null,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"description"?: string | null,"group_id"?: string,"group_name": string,"invite_code"?: string,"invite_code_expires_at"?: string,"invite_code_issued_at"?: string,"owner_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string | null,"group_id"?: string,"group_name"?: string,"invite_code"?: string,"invite_code_expires_at"?: string,"invite_code_issued_at"?: string,"owner_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "groups_owner_id_fkey"
      columns: ["owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"prepare_ml_verified_profiles": {
                  Row: {
                    "codebook_version": string,"consent_at": string,"ml_age_code": string,"ml_economic_code": string | null,"ml_education_code": string | null,"ml_holiday_code": string | null,"user_id": string,"verified_at": string
                  }
                  Insert: {
                    "codebook_version": string,"consent_at": string,"ml_age_code": string,"ml_economic_code"?: string | null,"ml_education_code"?: string | null,"ml_holiday_code"?: string | null,"user_id": string,"verified_at"?: string
                  }
                  Update: {
                    "codebook_version"?: string,"consent_at"?: string,"ml_age_code"?: string,"ml_economic_code"?: string | null,"ml_education_code"?: string | null,"ml_holiday_code"?: string | null,"user_id"?: string,"verified_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "prepare_ml_verified_profiles_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "alarm_voice_prefs": NonNullable<Json>,"created_at": string,"default_buffer_minutes": number,"default_outing_prep_minutes": number | null,"default_prepare_minutes": number,"default_transport": Database["public"]['Enums']["transport_type"],"handle": string | null,"handle_changed_at": string | null,"handle_next_change_at": string | null,"home_lat": number | null,"home_lng": number | null,"home_name": string | null,"home_radius_m": number | null,"intensity_offset": number,"ml_age_code": string | null,"ml_age_years": number | null,"ml_codes_verified": boolean,"ml_economic_code": string | null,"ml_education_code": string | null,"ml_holiday_code": string | null,"ml_profile_consented_at": string | null,"ml_school_status": string | null,"ml_work_status": string | null,"nickname": string,"onboarded_at": string | null,"preferred_sound_key": string | null,"preferred_voice_tone": Database["public"]['Enums']["voice_tone"] | null,"privacy_agreed_at": string | null,"privacy_version": number | null,"profile_image_url": string | null,"timezone": string,"updated_at": string,"user_id": string,"wake_margin": string,"wake_ping_enabled": boolean,"wake_sensitivity": string
                  }
                  Insert: {
                    "alarm_voice_prefs"?: NonNullable<Json>,"created_at"?: string,"default_buffer_minutes"?: number,"default_outing_prep_minutes"?: number | null,"default_prepare_minutes"?: number,"default_transport"?: Database["public"]['Enums']["transport_type"],"handle"?: string | null,"handle_changed_at"?: string | null,"handle_next_change_at"?: string | null,"home_lat"?: number | null,"home_lng"?: number | null,"home_name"?: string | null,"home_radius_m"?: number | null,"intensity_offset"?: number,"ml_age_code"?: string | null,"ml_age_years"?: number | null,"ml_codes_verified"?: boolean,"ml_economic_code"?: string | null,"ml_education_code"?: string | null,"ml_holiday_code"?: string | null,"ml_profile_consented_at"?: string | null,"ml_school_status"?: string | null,"ml_work_status"?: string | null,"nickname": string,"onboarded_at"?: string | null,"preferred_sound_key"?: string | null,"preferred_voice_tone"?: Database["public"]['Enums']["voice_tone"] | null,"privacy_agreed_at"?: string | null,"privacy_version"?: number | null,"profile_image_url"?: string | null,"timezone"?: string,"updated_at"?: string,"user_id": string,"wake_margin"?: string,"wake_ping_enabled"?: boolean,"wake_sensitivity"?: string
                  }
                  Update: {
                    "alarm_voice_prefs"?: NonNullable<Json>,"created_at"?: string,"default_buffer_minutes"?: number,"default_outing_prep_minutes"?: number | null,"default_prepare_minutes"?: number,"default_transport"?: Database["public"]['Enums']["transport_type"],"handle"?: string | null,"handle_changed_at"?: string | null,"handle_next_change_at"?: string | null,"home_lat"?: number | null,"home_lng"?: number | null,"home_name"?: string | null,"home_radius_m"?: number | null,"intensity_offset"?: number,"ml_age_code"?: string | null,"ml_age_years"?: number | null,"ml_codes_verified"?: boolean,"ml_economic_code"?: string | null,"ml_education_code"?: string | null,"ml_holiday_code"?: string | null,"ml_profile_consented_at"?: string | null,"ml_school_status"?: string | null,"ml_work_status"?: string | null,"nickname"?: string,"onboarded_at"?: string | null,"preferred_sound_key"?: string | null,"preferred_voice_tone"?: Database["public"]['Enums']["voice_tone"] | null,"privacy_agreed_at"?: string | null,"privacy_version"?: number | null,"profile_image_url"?: string | null,"timezone"?: string,"updated_at"?: string,"user_id"?: string,"wake_margin"?: string,"wake_ping_enabled"?: boolean,"wake_sensitivity"?: string
                  }
                  Relationships: [
                    
                  ]
                },"push_sends": {
                  Row: {
                    "day": string | null,"kind": string,"send_id": number,"sender_id": string | null,"sent_at": string,"subject_id": string | null,"target_id": string
                  }
                  Insert: {
                    "day"?: string | null,"kind": string,"send_id"?: never,"sender_id"?: string | null,"sent_at"?: string,"subject_id"?: string | null,"target_id": string
                  }
                  Update: {
                    "day"?: string | null,"kind"?: string,"send_id"?: never,"sender_id"?: string | null,"sent_at"?: string,"subject_id"?: string | null,"target_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "push_sends_sender_id_fkey"
      columns: ["sender_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "push_sends_subject_id_fkey"
      columns: ["subject_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "push_sends_target_id_fkey"
      columns: ["target_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"push_tickets": {
                  Row: {
                    "created_at": string,"kind": string,"ticket_id": string,"token": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"kind": string,"ticket_id": string,"token": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"kind"?: string,"ticket_id"?: string,"token"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "push_tickets_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"push_tokens": {
                  Row: {
                    "created_at": string,"id": string,"last_seen_at": string,"platform": string,"token": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"last_seen_at"?: string,"platform"?: string,"token": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"last_seen_at"?: string,"platform"?: string,"token"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "push_tokens_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"rate_limit_events": {
                  Row: {
                    "action": string,"created_at": string,"event_id": number,"user_id": string
                  }
                  Insert: {
                    "action": string,"created_at"?: string,"event_id"?: never,"user_id": string
                  }
                  Update: {
                    "action"?: string,"created_at"?: string,"event_id"?: never,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rate_limit_events_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"reports": {
                  Row: {
                    "created_at": string,"evidence": Json | null,"handled_at": string | null,"handled_by": string | null,"note": string | null,"reason": string,"report_id": string,"reporter_id": string | null,"resolution": string | null,"status": string,"target_group_id": string | null,"target_type": string,"target_user_id": string | null
                  }
                  Insert: {
                    "created_at"?: string,"evidence"?: Json | null,"handled_at"?: string | null,"handled_by"?: string | null,"note"?: string | null,"reason": string,"report_id"?: string,"reporter_id"?: string | null,"resolution"?: string | null,"status"?: string,"target_group_id"?: string | null,"target_type": string,"target_user_id"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"evidence"?: Json | null,"handled_at"?: string | null,"handled_by"?: string | null,"note"?: string | null,"reason"?: string,"report_id"?: string,"reporter_id"?: string | null,"resolution"?: string | null,"status"?: string,"target_group_id"?: string | null,"target_type"?: string,"target_user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "reports_handled_by_fkey"
      columns: ["handled_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "reports_reporter_id_fkey"
      columns: ["reporter_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "reports_target_group_id_fkey"
      columns: ["target_group_id"]
isOneToOne: false
      referencedRelation: "groups"
      referencedColumns: ["group_id"]
    },{
      foreignKeyName: "reports_target_user_id_fkey"
      columns: ["target_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"roll_attempts": {
                  Row: {
                    "last_error": string | null,"next_try_at": string,"occurrence_on": string,"series_id": string,"skipped": boolean,"tries": number,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "last_error"?: string | null,"next_try_at": string,"occurrence_on": string,"series_id": string,"skipped"?: boolean,"tries"?: number,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "last_error"?: string | null,"next_try_at"?: string,"occurrence_on"?: string,"series_id"?: string,"skipped"?: boolean,"tries"?: number,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "roll_attempts_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"routine_suggestions": {
                  Row: {
                    "cause": Database["public"]['Enums']["routine_suggestion_cause"],"created_at": string,"draft": NonNullable<Json>,"evidence": NonNullable<Json>,"reason": string,"responded_at": string | null,"routine_id": string | null,"status": Database["public"]['Enums']["routine_suggestion_status"],"suggestion_id": string,"title": string,"user_id": string
                  }
                  Insert: {
                    "cause": Database["public"]['Enums']["routine_suggestion_cause"],"created_at"?: string,"draft": NonNullable<Json>,"evidence"?: NonNullable<Json>,"reason": string,"responded_at"?: string | null,"routine_id"?: string | null,"status"?: Database["public"]['Enums']["routine_suggestion_status"],"suggestion_id"?: string,"title": string,"user_id": string
                  }
                  Update: {
                    "cause"?: Database["public"]['Enums']["routine_suggestion_cause"],"created_at"?: string,"draft"?: NonNullable<Json>,"evidence"?: NonNullable<Json>,"reason"?: string,"responded_at"?: string | null,"routine_id"?: string | null,"status"?: Database["public"]['Enums']["routine_suggestion_status"],"suggestion_id"?: string,"title"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "routine_suggestions_routine_id_fkey"
      columns: ["routine_id"]
isOneToOne: false
      referencedRelation: "routines"
      referencedColumns: ["routine_id"]
    },{
      foreignKeyName: "routine_suggestions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"routines": {
                  Row: {
                    "created_at": string,"goal": string | null,"is_active": boolean,"origin": Database["public"]['Enums']["routine_origin"],"repeat_days": string,"routine_id": string,"source_journal_id": string | null,"steps": NonNullable<Json>,"title": string,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"goal"?: string | null,"is_active"?: boolean,"origin"?: Database["public"]['Enums']["routine_origin"],"repeat_days"?: string,"routine_id"?: string,"source_journal_id"?: string | null,"steps"?: NonNullable<Json>,"title": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"goal"?: string | null,"is_active"?: boolean,"origin"?: Database["public"]['Enums']["routine_origin"],"repeat_days"?: string,"routine_id"?: string,"source_journal_id"?: string | null,"steps"?: NonNullable<Json>,"title"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "routines_source_journal_id_fkey"
      columns: ["source_journal_id"]
isOneToOne: false
      referencedRelation: "daily_journals"
      referencedColumns: ["journal_id"]
    },{
      foreignKeyName: "routines_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"server_heartbeat": {
                  Row: {
                    "alive_at": string | null,"job_name": string,"last_success_at": string | null
                  }
                  Insert: {
                    "alive_at"?: string | null,"job_name": string,"last_success_at"?: string | null
                  }
                  Update: {
                    "alive_at"?: string | null,"job_name"?: string,"last_success_at"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"server_route_users": {
                  Row: {
                    "kind": string,"name": string,"user_id": string
                  }
                  Insert: {
                    "kind"?: string,"name": string,"user_id": string
                  }
                  Update: {
                    "kind"?: string,"name"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "server_route_users_route_fkey"
      columns: ["kind","name"]
isOneToOne: false
      referencedRelation: "server_routes"
      referencedColumns: ["kind","name"]
    },{
      foreignKeyName: "server_route_users_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"server_routes": {
                  Row: {
                    "kind": string,"mode": string,"name": string,"updated_at": string
                  }
                  Insert: {
                    "kind": string,"mode"?: string,"name": string,"updated_at"?: string
                  }
                  Update: {
                    "kind"?: string,"mode"?: string,"name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"server_settings": {
                  Row: {
                    "key": string,"updated_at": string,"value": string
                  }
                  Insert: {
                    "key": string,"updated_at"?: string,"value"?: string
                  }
                  Update: {
                    "key"?: string,"updated_at"?: string,"value"?: string
                  }
                  Relationships: [
                    
                  ]
                },"sharing_permissions": {
                  Row: {
                    "can_edit_alarm": boolean,"can_view_alarm": boolean,"can_view_wake": boolean,"created_at": string,"grantee_id": string,"owner_id": string,"permission_id": string,"source_id": string,"source_type": Database["public"]['Enums']["permission_source"],"updated_at": string
                  }
                  Insert: {
                    "can_edit_alarm"?: boolean,"can_view_alarm"?: boolean,"can_view_wake"?: boolean,"created_at"?: string,"grantee_id": string,"owner_id": string,"permission_id"?: string,"source_id": string,"source_type": Database["public"]['Enums']["permission_source"],"updated_at"?: string
                  }
                  Update: {
                    "can_edit_alarm"?: boolean,"can_view_alarm"?: boolean,"can_view_wake"?: boolean,"created_at"?: string,"grantee_id"?: string,"owner_id"?: string,"permission_id"?: string,"source_id"?: string,"source_type"?: Database["public"]['Enums']["permission_source"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sharing_permissions_grantee_id_fkey"
      columns: ["grantee_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "sharing_permissions_owner_id_fkey"
      columns: ["owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"team_members": {
                  Row: {
                    "added_at": string,"user_id": string
                  }
                  Insert: {
                    "added_at"?: string,"user_id": string
                  }
                  Update: {
                    "added_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "team_members_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"todos": {
                  Row: {
                    "appointment_id": string | null,"created_at": string,"done_at": string | null,"due_date": string | null,"is_done": boolean,"source_session_id": string | null,"title": string,"todo_id": string,"todo_type": Database["public"]['Enums']["todo_type"],"user_id": string
                  }
                  Insert: {
                    "appointment_id"?: string | null,"created_at"?: string,"done_at"?: string | null,"due_date"?: string | null,"is_done"?: boolean,"source_session_id"?: string | null,"title": string,"todo_id"?: string,"todo_type"?: Database["public"]['Enums']["todo_type"],"user_id": string
                  }
                  Update: {
                    "appointment_id"?: string | null,"created_at"?: string,"done_at"?: string | null,"due_date"?: string | null,"is_done"?: boolean,"source_session_id"?: string | null,"title"?: string,"todo_id"?: string,"todo_type"?: Database["public"]['Enums']["todo_type"],"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "todos_appointment_id_fkey"
      columns: ["appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["appointment_id"]
    },{
      foreignKeyName: "todos_source_session_id_fkey"
      columns: ["source_session_id"]
isOneToOne: false
      referencedRelation: "conversation_sessions"
      referencedColumns: ["session_id"]
    },{
      foreignKeyName: "todos_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"user_blocks": {
                  Row: {
                    "blocked_id": string,"blocker_id": string,"created_at": string
                  }
                  Insert: {
                    "blocked_id": string,"blocker_id": string,"created_at"?: string
                  }
                  Update: {
                    "blocked_id"?: string,"blocker_id"?: string,"created_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_blocks_blocked_id_fkey"
      columns: ["blocked_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "user_blocks_blocker_id_fkey"
      columns: ["blocker_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"user_edit_logs": {
                  Row: {
                    "alarm_id": string | null,"alarm_type": Database["public"]['Enums']["alarm_type"] | null,"appointment_id": string | null,"auto_value": Json | null,"created_at": string,"edit_id": string,"edited_value": Json | null,"field": string,"screen": string,"user_id": string
                  }
                  Insert: {
                    "alarm_id"?: string | null,"alarm_type"?: Database["public"]['Enums']["alarm_type"] | null,"appointment_id"?: string | null,"auto_value"?: Json | null,"created_at"?: string,"edit_id"?: string,"edited_value"?: Json | null,"field": string,"screen": string,"user_id"?: string
                  }
                  Update: {
                    "alarm_id"?: string | null,"alarm_type"?: Database["public"]['Enums']["alarm_type"] | null,"appointment_id"?: string | null,"auto_value"?: Json | null,"created_at"?: string,"edit_id"?: string,"edited_value"?: Json | null,"field"?: string,"screen"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_edit_logs_alarm_id_fkey"
      columns: ["alarm_id"]
isOneToOne: false
      referencedRelation: "alarms"
      referencedColumns: ["alarm_id"]
    },{
      foreignKeyName: "user_edit_logs_appointment_id_fkey"
      columns: ["appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["appointment_id"]
    },{
      foreignKeyName: "user_edit_logs_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"user_places": {
                  Row: {
                    "address": string | null,"created_at": string,"label": string,"lat": number,"lng": number,"name": string,"place_id": string,"radius_m": number | null,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "address"?: string | null,"created_at"?: string,"label": string,"lat": number,"lng": number,"name": string,"place_id"?: string,"radius_m"?: number | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "address"?: string | null,"created_at"?: string,"label"?: string,"lat"?: number,"lng"?: number,"name"?: string,"place_id"?: string,"radius_m"?: number | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_places_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"user_questions": {
                  Row: {
                    "answer": string | null,"answered_at": string | null,"asked_at": string,"channel": string,"kind": string,"question_id": string,"session_id": string | null,"subject_key": string,"user_id": string
                  }
                  Insert: {
                    "answer"?: string | null,"answered_at"?: string | null,"asked_at"?: string,"channel": string,"kind": string,"question_id"?: string,"session_id"?: string | null,"subject_key": string,"user_id": string
                  }
                  Update: {
                    "answer"?: string | null,"answered_at"?: string | null,"asked_at"?: string,"channel"?: string,"kind"?: string,"question_id"?: string,"session_id"?: string | null,"subject_key"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_questions_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "conversation_sessions"
      referencedColumns: ["session_id"]
    },{
      foreignKeyName: "user_questions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"wake_hides": {
                  Row: {
                    "created_at": string,"hidden_from_id": string,"owner_id": string
                  }
                  Insert: {
                    "created_at"?: string,"hidden_from_id": string,"owner_id": string
                  }
                  Update: {
                    "created_at"?: string,"hidden_from_id"?: string,"owner_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wake_hides_hidden_from_id_fkey"
      columns: ["hidden_from_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "wake_hides_owner_id_fkey"
      columns: ["owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"wake_scripts": {
                  Row: {
                    "alarm_id": string,"input_hash": string,"model": string,"scripts": NonNullable<Json>,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "alarm_id": string,"input_hash": string,"model": string,"scripts": NonNullable<Json>,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "alarm_id"?: string,"input_hash"?: string,"model"?: string,"scripts"?: NonNullable<Json>,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wake_scripts_alarm_id_fkey"
      columns: ["alarm_id"]
isOneToOne: true
      referencedRelation: "alarms"
      referencedColumns: ["alarm_id"]
    },{
      foreignKeyName: "wake_scripts_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                }
          }
          Views: {
            "v_prepare_time_stats": {
                  Row: {
                    "p80_minutes": number | null,"sample_count": number | null,"user_id": string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "daily_records_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                }
          }
          Functions: {
            "accept_friend_request":
{ Args: { "p_requester_id": string }; Returns: Json
                           },
"accept_group_invite":
{ Args: { "p_group_id": string,"p_wake_share"?: boolean }; Returns: Json
                           },
"alarm_commit_apply":
{ Args: { "p_alarm_inserts": Json,"p_alarm_removes": (string)[],"p_alarm_updates": Json,"p_appointment": Json,"p_appointment_ref": Json,"p_before": Json,"p_edit_logs": Json,"p_key": string,"p_mode": string,"p_participant": Json,"p_request_hash": string,"p_user_id": string }; Returns: Json
                           },
"appointment_joiners":
{ Args: { "p_appointment_id": string }; Returns: {
              "hidden": boolean,"joined": boolean,"user_id": string
            }[]
                           },
"block_user":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"can_send_push":
{ Args: { "p_kind": string,"p_sender_id": string,"p_target_id": string }; Returns: boolean
                           },
"cancel_friend_request":
{ Args: { "p_addressee_id": string }; Returns: Json
                           },
"change_my_handle":
{ Args: { "p_handle": string }; Returns: Json
                           },
"claim_wake_nudges":
{ Args: { "p_now"?: string }; Returns: {
              "event_key": string,"group_id": string,"kind": string,"recipient_id": string,"sleeper_id": string
            }[]
                           },
"decline_friend_request":
{ Args: { "p_requester_id": string }; Returns: Json
                           },
"delete_decision_comment":
{ Args: { "p_author": string,"p_id": number }; Returns: boolean
                           },
"dev_reset_my_data":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"find_missed_wake_alarms":
{ Args: { "p_lookback_hours"?: number,"p_now"?: string }; Returns: {
              "alarm_id": string,"appointment_at": string,"appointment_id": string,"event_key": string,"group_id": string,"intensity": Database["public"]['Enums']["alarm_intensity"],"missed_at": string,"participant_id": string,"scheduled_at": string,"snooze_minutes": number,"user_id": string
            }[]
                           },
"find_profile_by_handle":
{ Args: { "p_handle": string }; Returns: {
              "handle": string,"nickname": string,"profile_image_url": string,"user_id": string
            }[]
                           },
"get_group_wake":
{ Args: { "p_date"?: string,"p_group_id": string }; Returns: {
              "arrived_at": string,"departed_at": string,"is_me": boolean,"nickname": string,"prepare_alarm_at": string,"prepare_started_at": string,"profile_image_url": string,"trip_appointment_at": string,"trip_visible": boolean,"user_id": string,"wake_alarm_at": string,"wake_confirmed_at": string,"wake_status": string
            }[]
                           },
"get_group_wake_status":
{ Args: { "p_date"?: string,"p_group_id": string }; Returns: {
              "arrived_at": string,"departed_at": string,"dismissed_at": string,"is_me": boolean,"missed_at": string,"nickname": string,"prepare_alarm_at": string,"prepare_started_at": string,"profile_image_url": string,"rang_at": string,"snooze_count": number,"trip_appointment_at": string,"trip_visible": boolean,"user_id": string,"wake_alarm_at": string,"wake_confirmed_at": string,"wake_status": string
            }[]
                           },
"get_public_profiles":
{ Args: { "p_user_ids"?: (string)[] }; Returns: {
              "handle": string,"nickname": string,"profile_image_url": string,"user_id": string
            }[]
                           },
"confirm_prep_start_self_report":
{ Args: { "p_appointment_id": string }; Returns: string
                           },
"get_server_routes":
{ Args: Record<PropertyKey, never>; Returns: {
              "mode": string,"name": string
            }[]
                           },
"get_shared_alarm_appointments":
{ Args: { "p_owner_id"?: string }; Returns: {
              "alarm_id": string,"appointment_at": string,"appointment_id": string,"dest_name": string,"title": string,"user_id": string
            }[]
                           },
"get_wake_announcement":
{ Args: Record<PropertyKey, never>; Returns: {
              "group_id": string,"group_name": string,"up_count": number
            }[]
                           },
"group_appointment_counts":
{ Args: { "p_group_id": string }; Returns: {
              "appointment_id": string,"i_joined": boolean,"joined_count": number
            }[]
                           },
"group_wake_for_device":
{ Args: { "p_user_id": string }; Returns: {
              "arrived_at": string,"departed_at": string,"group_id": string,"group_name": string,"is_me": boolean,"nickname": string,"prepare_alarm_at": string,"prepare_started_at": string,"trip_appointment_at": string,"trip_visible": boolean,"user_id": string,"wake_alarm_at": string,"wake_confirmed_at": string,"wake_status": string
            }[]
                           },
"invite_to_group":
{ Args: { "p_group_id": string,"p_user_id": string }; Returns: Json
                           },
"join_group":
{ Args: { "p_code": string,"p_wake_share"?: boolean }; Returns: Json
                           },
"join_group_by_invite_code":
{ Args: { "p_invite_code": string }; Returns: string
                           },
"list_reports":
{ Args: { "p_limit"?: number,"p_status"?: string }; Returns: Json
                           },
"my_account_delete_summary":
{ Args: Record<PropertyKey, never>; Returns: {
              "friends": number,"group_appointments_staying": number,"groups_disappearing": number,"groups_leaving": number
            }[]
                           },
"my_alarm_proposals":
{ Args: Record<PropertyKey, never>; Returns: {
              "alarm_id": string,"alarm_type": string,"created_at": string,"from_at": string,"proposal_id": string,"proposer_id": string,"proposer_nickname": string,"to_at": string
            }[]
                           },
"my_blocks":
{ Args: Record<PropertyKey, never>; Returns: {
              "blocked_at": string,"handle": string,"nickname": string,"profile_image_url": string,"user_id": string
            }[]
                           },
"my_friend_link":
{ Args: { "p_renew"?: boolean }; Returns: Json
                           },
"my_group_code":
{ Args: { "p_group_id": string }; Returns: Json
                           },
"my_group_invites":
{ Args: Record<PropertyKey, never>; Returns: {
              "group_id": string,"group_name": string,"invited_at": string,"invited_by": string,"invited_by_nickname": string,"member_count": number
            }[]
                           },
"my_wake_pings":
{ Args: { "p_date"?: string }; Returns: {
              "sender_id": string,"sender_nickname": string,"sent_at": string
            }[]
                           },
"open_friend_link":
{ Args: { "p_token": string }; Returns: Json
                           },
"plan_group_push":
{ Args: { "p_appointment_id"?: string,"p_group_id": string,"p_kind": string,"p_sender_id": string }; Returns: Json
                           },
"plan_wake_ping":
{ Args: { "p_group_id"?: string,"p_now"?: string,"p_reserve"?: boolean,"p_sender": string,"p_target": string }; Returns: Json
                           },
"prepare_account_delete":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"prepare_suggestion_inputs":
{ Args: { "p_now"?: string }; Returns: {
              "before_prepare_minutes": number,"cap_minutes": number,"current_advance": number,"participant_id": string,"residuals": (number)[],"target_alarm_id": string,"user_id": string
            }[]
                           },
"preview_group_by_code":
{ Args: { "p_code": string }; Returns: Json
                           },
"propose_alarm_time":
{ Args: { "p_alarm_id": string,"p_new_at": string }; Returns: Json
                           },
"regenerate_invite_code":
{ Args: { "p_group_id": string }; Returns: string
                           },
"register_push_token":
{ Args: { "p_platform"?: string,"p_token": string }; Returns: undefined
                           },
"remove_friend":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"reserve_alarm_tts":
{ Args: { "p_day_limit": number,"p_minute_limit": number,"p_model": string,"p_user_day_limit": number,"p_user_id": string }; Returns: string
                           },
"resolve_report":
{ Args: { "p_action": string,"p_report_id": string }; Returns: Json
                           },
"respond_alarm_proposal":
{ Args: { "p_apply": boolean,"p_proposal_id": string }; Returns: Json
                           },
"roll_due_series":
{ Args: { "p_limit"?: number,"p_now"?: string }; Returns: {
              "kind": string,"series_id": string,"template_id": string,"user_id": string
            }[]
                           },
"roll_insert_occurrence":
{ Args: { "p_alarms": Json,"p_appointment": Json,"p_items": Json,"p_participant": Json }; Returns: string
                           },
"routine_suggestion_inputs":
{ Args: { "p_days"?: number,"p_now"?: string }; Returns: {
              "items_due": number,"items_late": number,"prepare_alarm_at": string,"prepare_started_at": string,"record_date": string,"user_id": string,"wake_alarm_at": string,"wake_confirmed_at": string,"wake_missed": boolean,"weekday": number
            }[]
                           },
"save_group_permissions":
{ Args: { "p_can_edit_alarm": boolean,"p_can_view_alarm": boolean,"p_group_id": string }; Returns: Json
                           },
"search_by_handle":
{ Args: { "p_query": string }; Returns: Json
                           },
"search_related_by_name":
{ Args: { "p_query": string }; Returns: {
              "handle": string,"nickname": string,"profile_image_url": string,"relation": string,"user_id": string
            }[]
                           },
"send_friend_request":
{ Args: { "p_target_id": string }; Returns: Json
                           },
"sent_alarm_proposals":
{ Args: { "p_owner_id": string }; Returns: {
              "alarm_id": string,"created_at": string,"from_at": string,"proposal_id": string,"status": string,"to_at": string
            }[]
                           },
"set_wake_hidden":
{ Args: { "p_hidden": boolean,"p_user_id": string }; Returns: Json
                           },
"submit_report":
{ Args: { "p_note"?: string,"p_reason": string,"p_target_id": string,"p_target_type": string }; Returns: Json
                           },
"unblock_user":
{ Args: { "p_user_id": string }; Returns: Json
                           }
          }
          Enums: {
            "alarm_event_type": "TRIGGERED"|"SNOOZED"|"DISMISSED"|"WAKE_CONFIRMED"|"ARRIVAL_CONFIRMED"|"MISSED"|"FEEDBACK"|"ACKNOWLEDGED"|"WAKE_CORRECTED","alarm_feedback_type": "GOOD"|"TOO_LOUD"|"TOO_QUIET"|"VOICE_DISLIKE"|"SOUND_DISLIKE","alarm_intensity": "SOFT"|"NORMAL"|"STRONG","alarm_suggestion_status": "PENDING"|"APPLIED"|"EDITED"|"IGNORED","alarm_suggestion_type": "VOICE_TONE"|"SOUND"|"INTENSITY"|"PREPARE_ADVANCE","alarm_type": "WAKE"|"PREPARE"|"DEPARTURE"|"ARRIVE"|"ROUTINE","alarm_value_source": "AUTO"|"MANUAL","apply_status": "PENDING"|"APPLIED"|"REJECTED","event_input_source": "BUTTON"|"LOCATION"|"VOICE"|"MANUAL"|"USAGE","friend_status": "PENDING"|"ACCEPTED"|"BLOCKED","importance_level": "LOW"|"NORMAL"|"HIGH","input_mode": "VOICE"|"TEXT","invite_status": "INVITED"|"JOINED"|"LEFT","permission_source": "FRIEND"|"GROUP","prepare_start_source": "ROUTINE_STEP"|"PREPARE_ALARM","record_source": "MANUAL"|"ALARM"|"AI","routine_origin": "USER"|"AI_SUGGESTED","routine_suggestion_cause": "OVERSLEEP"|"LATE_START"|"NIGHT_PREP","routine_suggestion_status": "PENDING"|"ACCEPTED"|"IGNORED","session_type": "BEFORE_SLEEP"|"AFTER_WAKE"|"ANYTIME","todo_type": "TASK"|"ITEM","transport_type": "WALK"|"TRANSIT"|"BUS"|"SUBWAY"|"CAR","travel_source": "API"|"CACHED"|"MANUAL"|"ESTIMATE","voice_tone": "CALM"|"NEUTRAL"|"DIRECT"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "alarm_event_type": ["TRIGGERED", "SNOOZED", "DISMISSED", "WAKE_CONFIRMED", "ARRIVAL_CONFIRMED", "MISSED", "FEEDBACK", "ACKNOWLEDGED", "WAKE_CORRECTED"],"alarm_feedback_type": ["GOOD", "TOO_LOUD", "TOO_QUIET", "VOICE_DISLIKE", "SOUND_DISLIKE"],"alarm_intensity": ["SOFT", "NORMAL", "STRONG"],"alarm_suggestion_status": ["PENDING", "APPLIED", "EDITED", "IGNORED"],"alarm_suggestion_type": ["VOICE_TONE", "SOUND", "INTENSITY", "PREPARE_ADVANCE"],"alarm_type": ["WAKE", "PREPARE", "DEPARTURE", "ARRIVE", "ROUTINE"],"alarm_value_source": ["AUTO", "MANUAL"],"apply_status": ["PENDING", "APPLIED", "REJECTED"],"event_input_source": ["BUTTON", "LOCATION", "VOICE", "MANUAL", "USAGE"],"friend_status": ["PENDING", "ACCEPTED", "BLOCKED"],"importance_level": ["LOW", "NORMAL", "HIGH"],"input_mode": ["VOICE", "TEXT"],"invite_status": ["INVITED", "JOINED", "LEFT"],"permission_source": ["FRIEND", "GROUP"],"prepare_start_source": ["ROUTINE_STEP", "PREPARE_ALARM"],"record_source": ["MANUAL", "ALARM", "AI"],"routine_origin": ["USER", "AI_SUGGESTED"],"routine_suggestion_cause": ["OVERSLEEP", "LATE_START", "NIGHT_PREP"],"routine_suggestion_status": ["PENDING", "ACCEPTED", "IGNORED"],"session_type": ["BEFORE_SLEEP", "AFTER_WAKE", "ANYTIME"],"todo_type": ["TASK", "ITEM"],"transport_type": ["WALK", "TRANSIT", "BUS", "SUBWAY", "CAR"],"travel_source": ["API", "CACHED", "MANUAL", "ESTIMATE"],"voice_tone": ["CALM", "NEUTRAL", "DIRECT"]
          }
        }
} as const
