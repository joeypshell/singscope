-- Supabase's default privileges grant service_role broad access to new public
-- tables. Keep this dedicated backend least-privileged even though its secret
-- key is never exposed to the browser.

revoke all on table public.analysis_reports from service_role;
grant select on table public.analysis_reports to service_role;
grant insert (
  package_id,
  schema_version,
  package_sha256,
  package_bytes,
  object_path
) on table public.analysis_reports to service_role;
grant delete on table public.analysis_reports to service_role;

revoke all on table public.analysis_report_cleanup_state from service_role;
grant select, update on table public.analysis_report_cleanup_state to service_role;
