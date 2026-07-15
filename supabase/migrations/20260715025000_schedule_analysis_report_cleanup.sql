-- Recreate the retention schedules on every fresh database deployment. The
-- environment-specific project URL must exist in Vault before the HTTP job can
-- succeed; keeping the job installed makes a missing deployment step visible
-- in cron.job_run_details instead of silently disabling retention.

create function private.prune_analysis_report_gate_reservations()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  prune_time timestamptz := statement_timestamp();
  prune_day date := (statement_timestamp() at time zone 'UTC')::date;
  pruned_rows integer;
begin
  -- Use the same lock as ticket claims so an hourly prune cannot race the
  -- claim/check/insert transaction.
  perform pg_catalog.pg_advisory_xact_lock(1936945219, 20260715);

  update private.analysis_report_gate_reservations
  set
    active = false,
    finished_at = prune_time
  where active
    and reservation_expires_at <= prune_time;

  delete from private.analysis_report_gate_reservations
  where accounting_day < prune_day
    and reservation_expires_at <= prune_time;

  get diagnostics pruned_rows = row_count;
  return pruned_rows;
end;
$$;

revoke all on function private.prune_analysis_report_gate_reservations()
  from public, anon, authenticated, service_role;

do $migration$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid
    from cron.job
    where jobname in (
      'singscope-analysis-report-gate-prune',
      'singscope-analysis-report-cleanup'
    )
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'singscope-analysis-report-gate-prune',
    '12 * * * *',
    $cron$select private.prune_analysis_report_gate_reservations();$cron$
  );

  perform cron.schedule(
    'singscope-analysis-report-cleanup',
    '17 * * * *',
    $cron$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'singscope_project_url'
      ) || '/functions/v1/analysis-report-cleanup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-SingScope-Cleanup-Token', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'singscope_cleanup_token'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    ) as request_id;
    $cron$
  );
end;
$migration$;
