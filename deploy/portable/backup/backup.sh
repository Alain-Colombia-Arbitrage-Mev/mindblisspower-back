#!/bin/sh
set -eu
set -o pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
require() { [ -n "$2" ] || fail "$1 is required"; }
require DATABASE_URL "${DATABASE_URL:-}"
work=$(mktemp -d /work/backup.XXXXXX)
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Parse the URI once into libpq environment variables. No credentials in argv,
# including pg_dumpall, which otherwise chooses a different default database.
connection=$(python3 /opt/backup/connection.py)
export PGHOST="$(printf '%s' "$connection" | jq -r .host)"
export PGPORT="$(printf '%s' "$connection" | jq -r .port)"
export PGUSER="$(printf '%s' "$connection" | jq -r .user)"
export PGPASSWORD="$(printf '%s' "$connection" | jq -r .password)"
export PGDATABASE="$(printf '%s' "$connection" | jq -r .database)"
export PGSSLMODE="$(printf '%s' "$connection" | jq -r .sslmode)"
export PGSSLROOTCERT="$(printf '%s' "$connection" | jq -r .sslrootcert)"
export PGSSLCERT="$(printf '%s' "$connection" | jq -r .sslcert)"
export PGSSLKEY="$(printf '%s' "$connection" | jq -r .sslkey)"
export PGAPPNAME=mindbliss-backup PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"
unset DATABASE_URL connection

sql() { psql -X -w -v ON_ERROR_STOP=1 -At -c "$1"; }
matching_tools() {
    client_major=$(pg_dump --version | awk '{print $3}' | cut -d . -f 1)
    case "$client_major" in 17|18) ;; *) fail 'Only PostgreSQL tools major 17 or 18 are supported';; esac
    server_version=$(sql 'SHOW server_version_num')
    case "$server_version" in ''|*[!0-9]*) fail 'Invalid PostgreSQL server version';; esac
    server_major=$((server_version / 10000))
    [ "$client_major" = "$server_major" ] || fail 'PostgreSQL tools major must match the connected server'
}
s3() {
    if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
        aws --endpoint-url "$BACKUP_S3_ENDPOINT" "$@"
    else
        aws "$@"
    fi
}

case "${1:-create}" in
create)
    [ "$PGPORT" != 6432 ] || fail 'Backups require a direct PostgreSQL connection, not PgBouncer port 6432'
    require DEPLOY_ENV "${DEPLOY_ENV:-}"
    case "$DEPLOY_ENV" in staging|production|drill) ;; *) fail 'Invalid DEPLOY_ENV';; esac
    require BACKUP_AGE_RECIPIENT "${BACKUP_AGE_RECIPIENT:-}"
    if [ "$DEPLOY_ENV" = production ]; then
        require BACKUP_S3_URI "${BACKUP_S3_URI:-}"
    fi
    [ -n "${BACKUP_OUTPUT_DIR:-}${BACKUP_S3_URI:-}" ] || fail 'No backup destination'
    case "${BACKUP_S3_URI:-s3://unused}" in s3://*) ;; *) fail 'BACKUP_S3_URI must use s3://';; esac
    matching_tools
    id="${DEPLOY_ENV}-$(date -u +%Y%m%dT%H%M%SZ)-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    # Stream directly into encryption; large databases do not need RAM-sized
    # tmpfs or a second, plaintext copy on disk. pipefail propagates dump errors.
    pg_dump -w --format=custom --lock-wait-timeout=30s | age -r "$BACKUP_AGE_RECIPIENT" -o "$work/$id.dump.age"
    roles=false
    if [ "${BACKUP_INCLUDE_ROLES:-1}" = 1 ]; then
        pg_dumpall -w --roles-only --no-role-passwords | age -r "$BACKUP_AGE_RECIPIENT" -o "$work/$id.roles.sql.age"
        roles=true
    fi
    extensions=$(sql "SELECT coalesce(json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname),'[]') FROM pg_extension")
    hash=$(sha256sum "$work/$id.dump.age" | cut -d ' ' -f 1)
    size=$(wc -c <"$work/$id.dump.age" | tr -d ' ')
    roles_hash=''
    if [ "$roles" = true ]; then roles_hash=$(sha256sum "$work/$id.roles.sql.age" | cut -d ' ' -f 1); fi
    jq -n --arg id "$id" --arg environment "$DEPLOY_ENV" --arg sha256 "$hash" \
        --argjson bytes "$size" --argjson extensions "$extensions" --argjson roles "$roles" \
        --argjson postgresMajor "$server_major" \
        --arg rolesSha256 "$roles_hash" --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{format:1,id:$id,environment:$environment,createdAt:$createdAt,postgresMajor:$postgresMajor,extensions:$extensions,
          database:{file:($id+".dump.age"),sha256:$sha256,bytes:$bytes},
          roles:(if $roles then {file:($id+".roles.sql.age"),sha256:$rolesSha256} else null end)}' >"$work/$id.manifest.json"
    # Publish the manifest LAST: readers treat it as the completion marker.
    if [ -n "${BACKUP_OUTPUT_DIR:-}" ]; then
        [ -d "$BACKUP_OUTPUT_DIR" ] || fail 'Local destination must already exist'
        for file in "$work/"*.age; do cp "$file" "$BACKUP_OUTPUT_DIR/"; done
        cp "$work/$id.manifest.json" "$BACKUP_OUTPUT_DIR/"
    fi
    if [ -n "${BACKUP_S3_URI:-}" ]; then
        destination="${BACKUP_S3_URI%/}/$DEPLOY_ENV/$id"
        for file in "$work/"*.age; do s3 s3 cp "$file" "$destination/$(basename "$file")" --only-show-errors; done
        s3 s3 cp "$work/$id.manifest.json" "$destination/$id.manifest.json" --only-show-errors
    fi
    printf 'Backup complete: %s (%s encrypted bytes)\n' "$id" "$size"
    ;;
restore)
    [ "$PGPORT" != 6432 ] || fail 'Restores require a direct PostgreSQL connection, not PgBouncer port 6432'
    require BACKUP_MANIFEST "${BACKUP_MANIFEST:-}"
    require AGE_IDENTITY_FILE "${AGE_IDENTITY_FILE:-}"
    require RESTORE_TARGET_NAME "${RESTORE_TARGET_NAME:-}"
    case "$RESTORE_TARGET_NAME" in mindbliss_restore_*|drill_restore_*) ;; *) fail 'Only a NEW *_restore_* database is accepted';; esac
    [ "${RESTORE_CONFIRM:-}" = "$RESTORE_TARGET_NAME" ] || fail 'RESTORE_CONFIRM must equal RESTORE_TARGET_NAME'
    matching_tools
    jq -e '.format == 1 and (.postgresMajor == 17 or .postgresMajor == 18)' "$BACKUP_MANIFEST" >/dev/null || fail 'Invalid manifest format or unsupported PostgreSQL major'
    source_major=$(jq -er '.postgresMajor' "$BACKUP_MANIFEST")
    [ "$source_major" -le "$server_major" ] || fail 'Restoring to an older PostgreSQL major is not supported'
    [ "$(sql 'SELECT current_database()')" = "$RESTORE_TARGET_NAME" ] || fail 'Connected database does not match confirmation'
    objects=$(sql "SELECT count(*) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')")
    [ "$objects" = 0 ] || fail 'Restore target has non-default schemas; refusing'
    objects=$(sql "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace")
    [ "$objects" = 0 ] || fail 'Restore target is not empty; refusing'
    directory=$(dirname "$BACKUP_MANIFEST")
    file=$(jq -er '.database.file' "$BACKUP_MANIFEST")
    case "$file" in *[!a-zA-Z0-9._-]*|.*|'') fail 'Unsafe archive filename';; esac
    expected=$(jq -er '.database.sha256' "$BACKUP_MANIFEST")
    [ "$(sha256sum "$directory/$file" | cut -d ' ' -f 1)" = "$expected" ] || fail 'Checksum mismatch'
    [ "$(wc -c <"$directory/$file" | tr -d ' ')" = "$(jq -r '.database.bytes' "$BACKUP_MANIFEST")" ] || fail 'Size mismatch'
    age -d -i "$AGE_IDENTITY_FILE" "$directory/$file" | pg_restore --list >/dev/null
    # Timescale needs restore mode for internal catalogs. Never ignore extension errors.
    timescale=$(jq -r '[.extensions[].name] | index("timescaledb") != null' "$BACKUP_MANIFEST")
    if [ "$timescale" = true ]; then
        sql 'CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();' >/dev/null
    fi
    age -d -i "$AGE_IDENTITY_FILE" "$directory/$file" | pg_restore -w --dbname="$PGDATABASE" --exit-on-error --single-transaction --no-owner --no-acl
    if [ "$timescale" = true ]; then sql 'SELECT timescaledb_post_restore();' >/dev/null; fi
    sql 'ANALYZE' >/dev/null
    printf 'Restore complete: %s. Roles/ACLs are NOT automatically applied.\n' "$RESTORE_TARGET_NAME"
    ;;
*) fail 'Usage: backup.sh create|restore';;
esac
