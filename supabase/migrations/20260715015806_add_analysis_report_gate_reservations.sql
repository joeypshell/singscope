-- Short-lived, server-only reservations make a signed report ticket single-use
-- before the Edge Function reads any ZIP bytes. The committed receipt table
-- remains reserved for fully validated packages whose private Storage object
-- was successfully written.

create table private.analysis_report_gate_reservations (
  ticket_id uuid primary key,
  package_id uuid not null,
  schema_version smallint not null,
  package_sha256 text not null,
  package_bytes bigint not null,
  reserved_at timestamptz not null default statement_timestamp(),
  ticket_expires_at timestamptz not null,
  reservation_expires_at timestamptz not null,
  accounting_day date not null,
  active boolean not null default true,
  finished_at timestamptz,
  constraint analysis_report_gate_schema_version_check
    check (schema_version = 1),
  constraint analysis_report_gate_package_sha256_check
    check (package_sha256 ~ '^[0-9a-f]{64}$'),
  constraint analysis_report_gate_package_bytes_check
    check (package_bytes between 4 and 16777216),
  constraint analysis_report_gate_ticket_expiry_check
    check (
      ticket_expires_at > reserved_at
      and ticket_expires_at <= reserved_at + interval '2 minutes'
    ),
  constraint analysis_report_gate_reservation_expiry_check
    check (reservation_expires_at = reserved_at + interval '3 minutes'),
  constraint analysis_report_gate_active_state_check
    check (
      (active and finished_at is null)
      or (not active and finished_at is not null)
    )
);

create unique index analysis_report_gate_active_package_idx
  on private.analysis_report_gate_reservations (package_id)
  where active;

create index analysis_report_gate_active_expiry_idx
  on private.analysis_report_gate_reservations (reservation_expires_at)
  where active;

create index analysis_report_gate_accounting_day_idx
  on private.analysis_report_gate_reservations (accounting_day);

comment on table private.analysis_report_gate_reservations is
  'Proof-of-work-authorized report claims: at most four active, with consumed tickets retained through their UTC abuse-accounting day.';

alter table private.analysis_report_gate_reservations enable row level security;
alter table private.analysis_report_gate_reservations force row level security;

revoke all on table private.analysis_report_gate_reservations
  from public, anon, authenticated, service_role;
grant select, insert, delete on table private.analysis_report_gate_reservations
  to service_role;
grant update (active, finished_at) on table private.analysis_report_gate_reservations
  to service_role;

create function public.claim_analysis_report_gate_ticket(
  p_ticket_id uuid,
  p_package_id uuid,
  p_schema_version smallint,
  p_package_sha256 text,
  p_package_bytes bigint,
  p_ticket_expires_at timestamptz
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  active_reservations integer;
  claimed_today integer;
  claimed_bytes_today bigint;
  claim_time timestamptz := statement_timestamp();
  claim_day date := (statement_timestamp() at time zone 'UTC')::date;
begin
  if p_ticket_id is null
    or p_package_id is null
    or p_schema_version is distinct from 1
    or p_package_sha256 is null
    or p_package_sha256 !~ '^[0-9a-f]{64}$'
    or p_package_bytes is null
    or p_package_bytes not between 4 and 16777216
    or p_ticket_expires_at is null
    or p_ticket_expires_at <= claim_time
    or p_ticket_expires_at > claim_time + interval '2 minutes' then
    return 'invalid';
  end if;

  -- Serialize the tiny delete/check/insert transaction. No lock is held while
  -- the Edge Function receives or validates the package.
  perform pg_catalog.pg_advisory_xact_lock(1936945219, 20260715);

  -- A function crash cannot hold an active package/capacity slot forever.
  -- The three-minute lease exceeds the hosted function's 150-second wall
  -- clock, and is independent of how little ticket validity remained at claim.
  update private.analysis_report_gate_reservations
  set
    active = false,
    finished_at = claim_time
  where active
    and reservation_expires_at <= claim_time;

  -- Keep every consumed ticket ID through its UTC accounting day. Besides
  -- preventing proof replay, this ledger supplies a hard pre-body daily claim
  -- ceiling even when every submitted package is malformed.
  delete from private.analysis_report_gate_reservations
  where not active
    and accounting_day < claim_day
    and ticket_expires_at <= claim_time;

  if exists (
    select 1
    from private.analysis_report_gate_reservations
    where ticket_id = p_ticket_id
  ) then
    return 'replay';
  end if;

  if exists (
    select 1
    from private.analysis_report_gate_reservations
    where package_id = p_package_id
      and active
  ) then
    return 'busy';
  end if;

  select count(*)
  into active_reservations
  from private.analysis_report_gate_reservations
  where active;

  if active_reservations >= 4 then
    return 'capacity';
  end if;

  select count(*), coalesce(sum(package_bytes), 0)
  into claimed_today, claimed_bytes_today
  from private.analysis_report_gate_reservations
  where accounting_day = claim_day;

  if claimed_today >= 30
    or claimed_bytes_today + p_package_bytes > 100663296 then
    return 'daily-capacity';
  end if;

  insert into private.analysis_report_gate_reservations (
    ticket_id,
    package_id,
    schema_version,
    package_sha256,
    package_bytes,
    ticket_expires_at,
    reservation_expires_at,
    accounting_day
  ) values (
    p_ticket_id,
    p_package_id,
    p_schema_version,
    p_package_sha256,
    p_package_bytes,
    p_ticket_expires_at,
    claim_time + interval '3 minutes',
    claim_day
  );

  return 'claimed';
end;
$$;

revoke all on function public.claim_analysis_report_gate_ticket(
  uuid,
  uuid,
  smallint,
  text,
  bigint,
  timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.claim_analysis_report_gate_ticket(
  uuid,
  uuid,
  smallint,
  text,
  bigint,
  timestamptz
) to service_role;

-- Release active capacity and the package lock after any terminal handler
-- outcome, while retaining the ticket ID so the same proof remains consumed.
create function public.finish_analysis_report_gate_ticket(p_ticket_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with finished as (
    update private.analysis_report_gate_reservations
    set
      active = false,
      finished_at = statement_timestamp()
    where ticket_id = p_ticket_id
      and active
    returning true as finished
  )
  select coalesce(bool_or(finished), false) from finished;
$$;

revoke all on function public.finish_analysis_report_gate_ticket(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_analysis_report_gate_ticket(uuid)
  to service_role;
