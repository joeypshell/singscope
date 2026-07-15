-- Privileged, bounded cleanup state for the analysis-report cleanup Edge
-- Function. The job uses the Storage API for object deletion and only then
-- removes the corresponding receipt row.

grant delete on table public.analysis_reports to service_role;

create table public.analysis_report_cleanup_state (
  singleton boolean primary key default true,
  orphan_scan_offset integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint analysis_report_cleanup_state_singleton_check
    check (singleton),
  constraint analysis_report_cleanup_state_offset_check
    check (orphan_scan_offset between 0 and 100000),
  constraint analysis_report_cleanup_state_lease_check
    check (
      (lease_token is null and lease_expires_at is null)
      or (lease_token is not null and lease_expires_at is not null)
    )
);

comment on table public.analysis_report_cleanup_state is
  'Private singleton lease and cursor for bounded report cleanup runs.';

alter table public.analysis_report_cleanup_state enable row level security;
alter table public.analysis_report_cleanup_state force row level security;

revoke all on table public.analysis_report_cleanup_state
  from public, anon, authenticated, service_role;
grant select, update on table public.analysis_report_cleanup_state
  to service_role;

insert into public.analysis_report_cleanup_state (singleton)
values (true)
on conflict (singleton) do nothing;

-- A short database lease prevents scheduled and manual cleanup invocations
-- from overlapping. It expires automatically if an Edge Function terminates
-- before releasing it.
create function public.claim_analysis_report_cleanup(p_lease_token uuid)
returns table (orphan_scan_offset integer)
language sql
security invoker
set search_path = ''
as $$
  update public.analysis_report_cleanup_state as cleanup_state
  set
    lease_token = p_lease_token,
    lease_expires_at = statement_timestamp() + interval '5 minutes',
    updated_at = statement_timestamp()
  where singleton
    and p_lease_token is not null
    and (
      cleanup_state.lease_expires_at is null
      or cleanup_state.lease_expires_at <= statement_timestamp()
    )
  returning cleanup_state.orphan_scan_offset;
$$;

revoke all on function public.claim_analysis_report_cleanup(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_analysis_report_cleanup(uuid)
  to service_role;

-- Advance the reconciliation cursor and release only the caller's lease. A
-- stale invocation cannot release a newer invocation's lease.
create function public.finish_analysis_report_cleanup(
  p_lease_token uuid,
  p_next_orphan_scan_offset integer
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with released as (
    update public.analysis_report_cleanup_state as cleanup_state
    set
      orphan_scan_offset = p_next_orphan_scan_offset,
      lease_token = null,
      lease_expires_at = null,
      updated_at = statement_timestamp()
    where singleton
      and cleanup_state.lease_token = p_lease_token
      and p_next_orphan_scan_offset between 0 and 100000
    returning true as released
  )
  select coalesce(bool_or(released), false) from released;
$$;

revoke all on function public.finish_analysis_report_cleanup(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.finish_analysis_report_cleanup(uuid, integer)
  to service_role;
