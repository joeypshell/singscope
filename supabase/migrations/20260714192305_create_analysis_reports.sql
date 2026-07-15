-- SingScope analysis reports are accepted only by the analysis-report Edge
-- Function. The browser never receives database or Storage credentials.

create table public.analysis_reports (
  report_id uuid primary key default gen_random_uuid(),
  package_id uuid not null unique,
  schema_version smallint not null,
  package_sha256 text not null,
  package_bytes bigint not null,
  object_path text not null unique,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  constraint analysis_reports_schema_version_check
    check (schema_version = 1),
  constraint analysis_reports_package_sha256_check
    check (package_sha256 ~ '^[0-9a-f]{64}$'),
  constraint analysis_reports_package_bytes_check
    check (package_bytes between 4 and 16777216),
  constraint analysis_reports_object_path_check
    check (
      object_path = package_id::text || '/' || package_sha256 || '.zip'
    ),
  constraint analysis_reports_expiry_check
    check (expires_at > received_at)
);

create index analysis_reports_received_at_idx
  on public.analysis_reports (received_at);
create index analysis_reports_expires_at_idx
  on public.analysis_reports (expires_at);

comment on table public.analysis_reports is
  'Minimal private receipts for SingScope analysis debug packages.';
comment on column public.analysis_reports.object_path is
  'Private Storage path; never expose it as a public URL.';
comment on column public.analysis_reports.expires_at is
  'Deletion deadline; a separately deployed privileged cleanup job must enforce it.';

alter table public.analysis_reports enable row level security;
alter table public.analysis_reports force row level security;

revoke all on table public.analysis_reports from public, anon, authenticated, service_role;
grant select on table public.analysis_reports to service_role;
grant insert (
  package_id,
  schema_version,
  package_sha256,
  package_bytes,
  object_path
) on table public.analysis_reports to service_role;

-- This public, account-free endpoint needs a hard server-side abuse ceiling;
-- Origin and publishable-key checks are not authentication. Serialize quota
-- checks across Edge Function transactions so concurrent requests cannot race
-- past either daily limit. Exact package-ID retries do not consume quota.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create function private.enforce_analysis_report_daily_quota()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  utc_day_start timestamptz := date_trunc('day', statement_timestamp(), 'UTC');
  accepted_count bigint;
  accepted_bytes bigint;
begin
  -- Two fixed int4 keys namespace this transaction lock to SingScope reports.
  perform pg_catalog.pg_advisory_xact_lock(1936945219, 20260714);

  -- The lock makes a concurrent identical insert wait for the first receipt to
  -- commit. Let its unique constraint resolve normally so the Edge Function can
  -- return the original idempotent receipt even when the daily quota is full.
  if exists (
    select 1
    from public.analysis_reports
    where package_id = new.package_id
  ) then
    return new;
  end if;

  select count(*), coalesce(sum(package_bytes), 0)
  into accepted_count, accepted_bytes
  from public.analysis_reports
  where received_at >= utc_day_start
    and received_at < utc_day_start + interval '1 day';

  if accepted_count >= 10
    or accepted_bytes + new.package_bytes > 33554432 then
    raise exception 'SINGSCOPE_REPORT_DAILY_QUOTA_EXCEEDED'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_analysis_report_daily_quota() from public, anon, authenticated;
grant execute on function private.enforce_analysis_report_daily_quota() to service_role;

create trigger enforce_analysis_report_daily_quota
before insert on public.analysis_reports
for each row execute function private.enforce_analysis_report_daily_quota();

-- Storage buckets are private by default, and every bucket restriction is set
-- explicitly. This does not neutralize pre-existing broad storage.objects RLS
-- policies, so production deployment requires a dedicated Supabase project.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'singscope-analysis-reports',
  'singscope-analysis-reports',
  false,
  16777216,
  array['application/zip']::text[]
)
on conflict (id) do update
set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Deliberately create no anon/authenticated policies on storage.objects. Only
-- the server-side secret client used by the Edge Function may access reports.
