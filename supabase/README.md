# SingScope analysis-report backend

This directory contains a private Supabase Storage bucket, a minimal receipt table, the public
`analysis-report` Edge Function, and the private `analysis-report-cleanup` maintenance function.
Applying the migrations installs the database objects and hourly schedules, but deploying the Edge
Functions and adding the environment-specific project URL to Vault remain explicit operator steps.

## Request contract

Send `POST /functions/v1/analysis-report` from the configured browser origin with a raw
`application/zip` body and these headers:

- `X-SingScope-Package-Id`: RFC UUID
- `X-SingScope-Package-Sha256`: 64 lowercase hexadecimal SHA-256 characters
- `X-SingScope-Schema-Version`: `1`
- optional `apikey`: the project's publishable key, handled by the Supabase gateway

The body is streamed into a bounded 16 MiB buffer and hashed before Storage is called. The server
then opens it with the pinned `@zip.js/zip.js@2.8.28` reader with ambiguity, overlap, and CRC checks
enabled. It accepts exactly six non-encrypted, single-disk entries: `manifest.json`,
`diagnostics.json`, `contour.csv`, `estimated-notes.csv`, `README.txt`, and exactly one STORE-compressed
`source-audio.{aac,m4a,mp3,mp4,webm,wav}`. Raw filenames must byte-match that allowlist; ZIP64,
directories, symlinks, executable entries, duplicate names, comments, extra entries, central/local
header disagreement, and prepended/appended data are rejected.

Before extraction, the function enforces per-file limits and a 16 MiB aggregate expanded-size limit.
Extraction writes into fixed bounded buffers and rejects excessive compression ratios. The request
package ID must match the strict version-1 manifest, every listed file length and SHA-256 is verified,
and the diagnostics source/count fields must agree with the manifest. JSON is strict-schema parsed;
CSV files must be valid UTF-8 with the fixed headers, exact row counts, and no formula-leading cells;
the audio extension/media type and bounded container signature must agree. Only after all of those
checks does the function write the original ZIP to private Storage. A successful response is either
`201` (new) or `200` (idempotent replay):

```json
{
  "format": "singscope-analysis-report-receipt",
  "schemaVersion": 1,
  "reportId": "00000000-0000-4000-8000-000000000000",
  "receivedAt": "2026-07-14T18:30:00.000Z"
}
```

`X-Request-Id` is returned on every function response for log correlation. Reusing a package ID
with different bytes returns `409`; an identical retry returns the original receipt.

## Configuration and deployment

Deploy this backend to a dedicated SingScope Supabase project. Setting `bucket.public = false`
does not override broad `storage.objects` policies that may already exist in a reused project. A
production gate must prove that anonymous and publishable-key clients cannot read or list the report
bucket before the first real submission is accepted.

Use Supabase CLI `2.109.1` (the version used to create this scaffold):

```sh
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase secrets set REPORT_ALLOWED_ORIGIN=https://joeypshell.github.io
supabase functions deploy analysis-report
supabase functions deploy analysis-report-cleanup
```

The cleanup-auth migration generates a 256-bit token inside Postgres, stores its plaintext only in
Vault under `singscope_cleanup_token`, and stores only its SHA-256 digest in the private
`analysis_report_cleanup_auth` table. Do not set `REPORT_CLEANUP_TOKEN` on the hosted function; the
hosted path validates the supplied scheduler token through the service-role-only
`verify_analysis_report_cleanup_token` RPC before any cleanup work. The hosted runtime supplies
`SUPABASE_URL` and `SUPABASE_SECRET_KEYS`. Local/legacy runtimes may
supply `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` instead. Never put any secret/server key
in Vite variables or browser code. `REPORT_ALLOWED_ORIGIN` must be one serialized origin with no
path; it defaults to `https://joeypshell.github.io`.

For local browser testing, put the exact development origin in the ignored
`supabase/functions/.env` file (copy `.env.example`), for example
`REPORT_ALLOWED_ORIGIN=http://127.0.0.1:4173`, then serve the functions with that env file. The root
README documents the GitHub Actions variables that pass the production endpoint and optional
publishable key into the Pages build.

`verify_jwt = false` is intentional because reporting does not require an account. The browser first
requests a 120-second HMAC-signed ticket bound to the exact package identity, then solves a bundled
14-bit WebCrypto proof of work. The upload handler verifies both and atomically claims a private
single-use reservation before touching `request.body`. The reservation ledger permits at most four
active uploads, 30 claimed attempts, and 96 MiB of declared attempts per UTC day. Consumed ticket IDs
remain through their accounting day, so one proof cannot authorize repeated invalid ZIP parsing.

The handler also rejects mismatched Origins, unsupported methods/headers/media types, oversized
bodies, malformed UUIDs, invalid ZIP signatures, and digest mismatches. Origin checks protect the
browser flow but are not authentication, and a publishable key is not a secret. A second serialized
database ceiling caps successfully accepted reports at 10 packages and 32 MiB per UTC day. Exact
completed retries return their existing receipt without another proof or upload. A new report over
the accepted ceiling returns `429` and its newly uploaded object is removed. If that cleanup fails,
the function returns a generic `503` and logs only the request ID and failure stage. The bounded
gate deliberately fails closed under a targeted exhaustion attack; a managed challenge would resist
that more strongly but would add a remote runtime dependency that this PWA intentionally excludes.

The migration grants no `anon` or `authenticated` table/Storage policy. The server secret is used
only inside the function, objects remain in the private `singscope-analysis-reports` bucket, and no
public or signed URL is generated. SingScope-authored function logs contain only request IDs and
failure stages. Supabase's infrastructure access logs may separately record endpoint metadata,
bucket names, deterministic package UUID/hash object paths, status, IP/user-agent data, and timing;
they do not contain the ZIP body or a server secret.

Supabase recommends resumable TUS uploads for payloads larger than 6 MiB. This MVP keeps the raw
POST adapter isolated and capped at 16 MiB to match the current app contract; use a short-lived
signed/resumable flow if physical-iPhone testing shows unreliable large uploads.

Each receipt row gets an `expires_at` deadline 30 days after receipt. The repository includes a
bounded cleanup function and hourly schedule, but every deployment must still verify its pg_net
response and an end-to-end Storage-first deletion fixture before describing retention as enforced.
Never delete `storage.objects` metadata with SQL.

## Private retention cleanup

`analysis-report-cleanup` has no CORS support and authorizes only
`X-SingScope-Cleanup-Token: <the Vault value named singscope_cleanup_token>`. The migration creates
that value; retrieve it only inside SQL from `vault.decrypted_secrets` when configuring or invoking
the scheduler. Never copy it into browser code, logs, a `VITE_` variable, or a hosted Edge Function
secret. The handler asks the service-role-only digest-verification RPC to authorize the header,
accepts only `POST` with an empty JSON body, and returns `401` before performing any privileged work
when authentication fails. `REPORT_CLEANUP_TOKEN` remains an optional fallback solely for local
function development and must be omitted from hosted deployments.

Each invocation claims a five-minute database lease, processes at most 25 expired receipts, scans
at most 50 Storage roots, and checks at most 50 aged object candidates using a persisted, wrapping
cursor. It removes an expired object via
the Storage API before deleting its receipt. Failed object deletion leaves the receipt for an
idempotent retry. Orphan reconciliation considers only a valid UUID/hash `.zip` path in the dedicated
bucket, only after a 24-hour creation-time grace period, and only after confirming that no receipt
references it. If concurrent failures leave several valid hash objects in one UUID folder, each is
checked independently; unexpected paths and entries without trustworthy metadata are never deleted. A
partial run returns `503` with counts (never paths or report IDs), while a concurrent invocation
returns `200` with `status: "already-running"`.

Supabase's current scheduled-function pattern uses `pg_cron` plus `pg_net`, with credentials held in
Vault. The migrations enable both extensions and idempotently install the hourly jobs. After
deploying and validating the function manually, create only the additional Vault secret named
`singscope_project_url`; the cleanup-auth migration has already created
`singscope_cleanup_token`:

```sql
select vault.create_secret(
  'https://YOUR_PROJECT_REF.supabase.co',
  'singscope_project_url',
  'Base URL used only by the SingScope cleanup scheduler'
)
where not exists (
  select 1 from vault.decrypted_secrets where name = 'singscope_project_url'
);

select jobid, jobname, schedule, active
from cron.job
where jobname in (
  'singscope-analysis-report-gate-prune',
  'singscope-analysis-report-cleanup'
)
order by jobname;
```

The gate-prune job deletes only expired reservations from an earlier UTC accounting day, so the
daily anti-replay ledger does not persist indefinitely when reporting goes quiet. The cleanup job's
explicit `timeout_milliseconds := 60000` is required; pg_net otherwise defaults to a much shorter
timeout. After its first run, read its `request_id` from the job result, then check
`cron.job_run_details`, Edge Function logs, and the row with that exact ID in
`net._http_response` during rollout. A successful cron row proves only that Postgres queued the
asynchronous HTTP call. The matching pg_net row must have
`timed_out = false`, `error_msg is null`, HTTP status `200`, and a JSON body whose cleanup status is
`completed` (or the documented `already-running` result for an overlapping manual check). The job
is not an enforced retention control until a test object and expired receipt have both been removed
and the security/performance advisors are clear.

```sql
select
  id,
  status_code,
  timed_out,
  error_msg,
  content::jsonb ->> 'status' as cleanup_status
from net._http_response
where id = YOUR_RECORDED_REQUEST_ID;
```

## Operator retrieval runbook

The app gives the reporter a receipt ID. An authorized operator can locate the private object in
the Supabase SQL editor without exposing the table through the Data API:

```sql
select
  report_id,
  received_at,
  expires_at,
  package_sha256,
  package_bytes,
  object_path
from public.analysis_reports
where report_id = '00000000-0000-4000-8000-000000000000'::uuid;
```

Use `object_path` to navigate to the object in Storage > `singscope-analysis-reports`, then download
it while signed into the Dashboard. Do not make the bucket public or generate a broadly shared
signed URL. Verify the downloaded ZIP's SHA-256 against `package_sha256` before opening it. For a
manual deletion, remove the object through the Dashboard or Storage API first, then delete the
receipt row; deleting only Storage metadata through SQL can orphan the actual bytes.

## Local verification

Docker is required for the full Supabase stack. Pure request-contract tests do not require Docker:

```sh
pnpm exec vitest run --config supabase/vitest.config.mjs
supabase start
supabase db reset
supabase functions serve --env-file supabase/functions/.env
```

Verify that a missing or incorrect cleanup token returns `401`, a correct token returns a bounded
summary, an expired fixture is deleted Storage-first, and an old unreferenced fixture is reconciled.
After a local reset, run the database advisors and review every Storage, function-privilege, and RLS
finding before applying the migration to a hosted project.
