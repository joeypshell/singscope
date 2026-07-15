-- Generate the private cleanup credential inside Postgres. The plaintext token
-- is written only to Vault; application tables retain only its SHA-256 digest.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault cascade;

create table private.analysis_report_cleanup_auth (
  singleton boolean primary key default true,
  token_sha256 bytea not null,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default statement_timestamp(),
  constraint analysis_report_cleanup_auth_singleton_check
    check (singleton),
  constraint analysis_report_cleanup_auth_digest_length_check
    check (pg_catalog.octet_length(token_sha256) = 32)
);

comment on table private.analysis_report_cleanup_auth is
  'Digest-only authorization state for the private analysis-report cleanup function.';
comment on column private.analysis_report_cleanup_auth.vault_secret_id is
  'Identifier of the encrypted singscope_cleanup_token Vault secret; never the plaintext token.';

alter table private.analysis_report_cleanup_auth enable row level security;
alter table private.analysis_report_cleanup_auth force row level security;

revoke all on table private.analysis_report_cleanup_auth
  from public, anon, authenticated, service_role;

do $$
declare
  cleanup_token text := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  cleanup_vault_secret_id uuid;
begin
  if exists (
    select 1
    from vault.secrets
    where name = 'singscope_cleanup_token'
  ) then
    raise exception 'SINGSCOPE_CLEANUP_VAULT_SECRET_ALREADY_EXISTS'
      using errcode = 'P0001';
  end if;

  cleanup_vault_secret_id := vault.create_secret(
    cleanup_token,
    'singscope_cleanup_token',
    'Private token for the SingScope analysis-report retention scheduler.'
  );

  insert into private.analysis_report_cleanup_auth (
    singleton,
    token_sha256,
    vault_secret_id
  ) values (
    true,
    extensions.digest(cleanup_token, 'sha256'),
    cleanup_vault_secret_id
  );

  -- PL/pgSQL variables are transaction-local, but clear the plaintext as soon
  -- as both durable writes are complete to minimize its lifetime in memory.
  cleanup_token := null;
end;
$$;

-- This function is SECURITY DEFINER solely so service_role can validate a
-- supplied token without direct SELECT access to the digest table. It returns
-- only a boolean, uses a fixed empty search_path, and has no mutation surface.
create function public.verify_analysis_report_cleanup_token(p_token text)
returns boolean
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if p_token is null
    or pg_catalog.octet_length(p_token) < 32
    or pg_catalog.octet_length(p_token) > 512 then
    return false;
  end if;

  return exists (
    select 1
    from private.analysis_report_cleanup_auth as cleanup_auth
    where cleanup_auth.singleton
      and cleanup_auth.token_sha256 = extensions.digest(p_token, 'sha256')
  );
end;
$$;

revoke all on function public.verify_analysis_report_cleanup_token(text)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_analysis_report_cleanup_token(text)
  to service_role;
