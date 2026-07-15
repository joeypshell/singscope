-- Hosted retention uses Supabase's documented pg_cron + pg_net pattern. The
-- environment-specific project URL is added to Vault during deployment, not
-- committed to this migration.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
