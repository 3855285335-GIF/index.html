set -euo pipefail
echo "Starting isolated, unlinked Supabase stack. Production host is forbidden."
WORKDIR="$RUNNER_TEMP/chatter-isolated-supabase"
mkdir -p "$WORKDIR"
cd "$WORKDIR"
supabase init --yes
supabase start -x realtime,imgproxy,studio,edge-runtime,logflare,vector,supavisor,postgres-meta,mailpit
# The CLI wraps values in quotes; GitHub ENV stores quotes literally unless removed.
while IFS='=' read -r name value; do
  case "$name" in
    API_URL|ANON_KEY|SERVICE_ROLE_KEY)
      value="${value#\"}"
      value="${value%\"}"
      printf '%s=%s\n' "$name" "$value" >> "$GITHUB_ENV"
      ;;
  esac
done < <(supabase status -o env)
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$GITHUB_WORKSPACE/tests/fixtures/private-storage-local.sql"
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$GITHUB_WORKSPACE/supabase/migrations/20261119115703_chatter_private_attachments.sql"
