-- Explicit restrictive denials make the private intent visible to Supabase's
-- advisor and remain effective if a permissive policy is added accidentally.

create policy analysis_reports_deny_direct_client_access
on public.analysis_reports
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

create policy analysis_report_cleanup_state_deny_direct_client_access
on public.analysis_report_cleanup_state
as restrictive
for all
to anon, authenticated
using (false)
with check (false);
