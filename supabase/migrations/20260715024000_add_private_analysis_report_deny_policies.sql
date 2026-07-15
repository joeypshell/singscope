-- These tables live in a non-exposed schema and their privileges are already
-- revoked. Explicit restrictive policies document the deny-all intent and
-- keep it effective if schema exposure or a permissive policy is added later.

create policy analysis_report_gate_reservations_deny_direct_client_access
on private.analysis_report_gate_reservations
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

create policy analysis_report_cleanup_auth_deny_direct_client_access
on private.analysis_report_cleanup_auth
as restrictive
for all
to anon, authenticated
using (false)
with check (false);
