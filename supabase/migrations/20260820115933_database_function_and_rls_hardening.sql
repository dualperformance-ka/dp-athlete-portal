-- Close pre-existing advisor warnings without changing application behaviour.
-- Trigger helpers use a fixed lookup path and cannot be invoked through RPC;
-- triggers themselves continue to execute normally.
alter function public.reject_daily_macro_override_delete() set search_path = public, pg_temp;
alter function public.touch_updated_at() set search_path = public, pg_temp;
alter function public.sync_session_lock() set search_path = public, pg_temp;
alter function public.classify_exercise(text) set search_path = public, pg_temp;
alter function public.reject_weekly_sport_target_delete() set search_path = public, pg_temp;

revoke execute on function public.reject_daily_macro_override_delete() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.sync_session_lock() from public, anon, authenticated;
revoke execute on function public.reject_weekly_sport_target_delete() from public, anon, authenticated;
revoke execute on function public.log_run_step_change() from public, anon, authenticated;
revoke execute on function public.log_session_exercise_change() from public, anon, authenticated;
revoke execute on function public.reject_locked_session_edit() from public, anon, authenticated;

-- Cache auth.uid() once per statement instead of once per athlete row.
alter policy "athlete reads own roster row"
on public.athletes
using (auth_user_id = (select auth.uid()));
