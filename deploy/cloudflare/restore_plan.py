"""Read-only PlanetScale restore planning. This module never executes a restore."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import parse_qs, unquote, urlsplit


class PlanError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise PlanError(code)


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", value)


def policy_from(document):
    require(isinstance(document, dict) and set(document) <= {"schemas", "extensionVersions"}, "INVALID_POLICY")
    schemas = document.get("schemas")
    require(isinstance(schemas, list) and 0 < len(schemas) <= 50, "SCHEMAS_REQUIRE_REVIEW")
    require(all(identifier(s) and not s.startswith("pg_") and s not in {"information_schema", "pscale_extensions"} for s in schemas), "UNSAFE_SCHEMA")
    require(len(schemas) == len(set(schemas)), "DUPLICATE_SCHEMA")
    versions = document.get("extensionVersions", {})
    require(isinstance(versions, dict), "INVALID_EXTENSION_APPROVAL")
    for name, approval in versions.items():
        require(isinstance(name, str) and re.fullmatch(r"[a-z][a-z0-9_-]{0,62}", name), "INVALID_EXTENSION_APPROVAL")
        require(isinstance(approval, dict) and set(approval) == {"source", "target"}, "INVALID_EXTENSION_APPROVAL")
        require(all(isinstance(v, str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", v) for v in approval.values()), "INVALID_EXTENSION_APPROVAL")
    return {"schemas": sorted(schemas), "extensionVersions": versions}


def target_from(env, synthetic=False):
    # No network contact is permitted before these operator attestations.
    require(env.get("RESTORE_CREDENTIAL_ROTATION_CONFIRMED") == "yes", "CREDENTIAL_ROTATION_REQUIRED")
    require(env.get("SOURCE_DATABASE_READY_CONFIRMED") == "yes", "SOURCE_READINESS_REQUIRED")
    uri = urlsplit(env.get("RESTORE_DATABASE_URL", ""))
    query = parse_qs(uri.query, keep_blank_values=True, strict_parsing=True)
    require(uri.scheme in {"postgres", "postgresql"} and uri.hostname and uri.username and uri.password and not uri.fragment, "INVALID_TARGET_URL")
    require(set(query) <= {"sslmode", "sslrootcert"} and all(len(v) == 1 for v in query.values()), "INVALID_TLS_CONFIGURATION")
    require((uri.port or 5432) == 5432, "DIRECT_CONNECTION_REQUIRED")
    host = uri.hostname
    if synthetic:
        require(re.fullmatch(r"mindbliss-psrestore-[a-f0-9]{12}-db", host), "INVALID_SYNTHETIC_TARGET")
        require(query.get("sslmode") == ["disable"], "INVALID_SYNTHETIC_TLS")
    else:
        require(host.endswith(".psdb.cloud") and re.fullmatch(r"[a-z0-9.-]+", host), "PLANETSCALE_TARGET_REQUIRED")
        require(query.get("sslmode") == ["verify-full"], "VERIFIED_TLS_REQUIRED")
    database = unquote(uri.path.removeprefix("/"))
    require(identifier(database) and database == env.get("RESTORE_EXPECTED_DATABASE"), "TARGET_DATABASE_MISMATCH")
    source = env.get("SOURCE_REFERENCE")
    require(source == ("synthetic:postgres17" if synthetic else "docker:mindbliss-local-recovery-20261022"), "SOURCE_REFERENCE_REQUIRED")
    require(identifier(env.get("SOURCE_DATABASE_NAME")) and not env["SOURCE_DATABASE_NAME"].startswith("replace_"), "SOURCE_DATABASE_NAME_REQUIRED")
    fields = {"host": host, "port": "5432", "database": database, "user": unquote(uri.username), "password": unquote(uri.password)}
    require(all(not any(c in v for c in "\x00\r\n") for v in fields.values()), "INVALID_TARGET_URL")
    public = {k: v for k, v in fields.items() if k != "password"}
    fields["fingerprint"] = hashlib.sha256(json.dumps(public, sort_keys=True).encode()).hexdigest()
    fields["sourceFingerprint"] = hashlib.sha256(json.dumps([source, env["SOURCE_DATABASE_NAME"]]).encode()).hexdigest()
    fields["sslmode"] = "disable" if synthetic else "verify-full"
    fields["sslrootcert"] = query.get("sslrootcert", ["system" if not synthetic else ""])[0]
    return fields


def archive_from(path):
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    require(isinstance(document, dict) and type(document.get("format")) is int and document["format"] == 1, "INVALID_MANIFEST")
    require(type(document.get("postgresMajor")) is int and document["postgresMajor"] in {17, 18}, "UNSUPPORTED_SOURCE_MAJOR")
    record = document.get("database", {})
    require(isinstance(record, dict), "INVALID_ARCHIVE")
    name = record.get("file", "")
    require(isinstance(name, str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*\.dump\.age", name), "UNSAFE_ARCHIVE_FILENAME")
    require(isinstance(record.get("sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", record["sha256"]), "INVALID_ARCHIVE_HASH")
    require(type(record.get("bytes")) is int and record["bytes"] > 0, "INVALID_ARCHIVE_SIZE")
    archive = Path(path).resolve().parent / name
    require(not archive.is_symlink() and archive.is_file(), "ARCHIVE_NOT_FOUND")
    require(archive.stat().st_size == record["bytes"], "ARCHIVE_SIZE_MISMATCH")
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    require(digest.hexdigest() == record["sha256"], "ARCHIVE_CHECKSUM_MISMATCH")
    extensions = document.get("extensions")
    require(isinstance(extensions, list), "INVALID_EXTENSIONS")
    names = []
    for extension in extensions:
        require(isinstance(extension, dict) and isinstance(extension.get("name"), str) and re.fullmatch(r"[a-z][a-z0-9_-]{0,62}", extension["name"]), "INVALID_EXTENSIONS")
        require(isinstance(extension.get("version"), str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", extension["version"]), "INVALID_EXTENSIONS")
        names.append(extension["name"])
    require(len(names) == len(set(names)), "DUPLICATE_EXTENSION")
    return {"postgresMajor": document["postgresMajor"], "sha256": record["sha256"], "bytes": record["bytes"], "extensions": extensions}


def compile_toc(policy, full_text, selected_text):
    """Preserve native selection/order, adding only reviewed SCHEMA definitions."""
    def entries(text):
        result = {}
        for line in text.splitlines():
            if not line.strip() or line.lstrip().startswith(";"):
                continue
            match = re.fullmatch(r"([0-9]+); [0-9]+ [0-9]+ .+", line)
            require(match is not None and match[1] not in result, "INVALID_TOC")
            result[match[1]] = line
        return result
    full, selected = entries(full_text), entries(selected_text)
    require(full and selected, "EMPTY_TOC_SELECTION")
    require(all(key in full and full[key] == line for key, line in selected.items()), "TOC_SELECTION_MISMATCH")
    allowed = set(selected)
    schemas = set()
    for key, line in full.items():
        match = re.fullmatch(r"[0-9]+; [0-9]+ [0-9]+ SCHEMA - ([a-z_][a-z0-9_]*) .+", line)
        if match:
            schema = match[1]
            require(key not in selected or schema in policy["schemas"], "UNREVIEWED_SCHEMA_IN_TOC")
            if schema in policy["schemas"]:
                schemas.add(schema)
                if schema != "public":
                    allowed.add(key)
                else:
                    allowed.discard(key)  # Never recreate the provider's existing public schema.
    require(set(policy["schemas"]) - {"public"} <= schemas, "APPROVED_SCHEMA_NOT_IN_ARCHIVE")
    return "; Reviewed native TOC selection; preserve archive order.\n" + "\n".join(line for key, line in full.items() if key in allowed) + "\n"


CATALOG_SQL = """
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5000ms';
SELECT json_build_object(
 'serverVersionNum', current_setting('server_version_num')::int,
 'database', current_database(), 'replica', pg_is_in_recovery(),
 'canCreateSchema', has_database_privilege(current_database(), 'CREATE'),
 'canCreatePublic', has_schema_privilege('public', 'CREATE'),
 'schemas', (SELECT coalesce(json_agg(nspname ORDER BY nspname),'[]') FROM pg_namespace
             WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'),
 'customRelations', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')),
 'customRoutines', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')),
 'customTypes', (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
       AND t.typrelid=0 AND t.typelem=0 AND t.typtype IN ('b','d','e','r','m')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')),
 'extensions', (SELECT coalesce(json_agg(json_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname) ORDER BY e.extname),'[]')
                FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace)
);
ROLLBACK;
"""


def inspect_target(target):
    # Do not inherit PGHOST, PGSERVICE, PGOPTIONS, .pgpass or arbitrary client settings.
    env = {"PATH": os.environ.get("PATH", ""), "LANG": "C", "HOME": "/nonexistent",
           "PGHOST": target["host"], "PGPORT": target["port"], "PGDATABASE": target["database"],
           "PGUSER": target["user"], "PGPASSWORD": target["password"], "PGSSLMODE": target["sslmode"],
           "PGSSLROOTCERT": target["sslrootcert"], "PGCONNECT_TIMEOUT": "10", "PGAPPNAME": "mindbliss-restore-plan",
           "PGOPTIONS": "-c default_transaction_read_only=on"}
    result = subprocess.run(["psql", "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1"], input=CATALOG_SQL,
                            text=True, capture_output=True, env=env, timeout=20, check=False)
    require(result.returncode == 0, "READ_ONLY_INSPECTION_FAILED")
    return json.loads(result.stdout)


SAFE_EXTENSIONS = {"plpgsql", "ltree", "pgcrypto", "citext", "btree_gist", "btree_gin", "pg_trgm", "uuid-ossp"}


def build_plan(target, snapshot, policy, archive):
    blockers = []
    if snapshot["database"] != target["database"]:
        blockers.append("TARGET_DATABASE_MISMATCH")
    if snapshot["serverVersionNum"] // 10000 != 18:
        blockers.append("POSTGRESQL_18_TARGET_REQUIRED")
    if snapshot["replica"]:
        blockers.append("PRIMARY_TARGET_REQUIRED")
    if not snapshot["canCreateSchema"] or ("public" in policy["schemas"] and not snapshot["canCreatePublic"]):
        blockers.append("RESTORE_ROLE_PERMISSIONS_REQUIRED")
    if set(snapshot["schemas"]) - {"public", "pscale_extensions"} or any(snapshot[k] for k in ["customRelations", "customRoutines", "customTypes"]):
        blockers.append("TARGET_CONTAINS_UNREVIEWED_OBJECTS")
    if archive is None:
        blockers.append("VERIFIED_ARCHIVE_REQUIRED")
    else:
        installed = {e["name"]: e["version"] for e in snapshot["extensions"]}
        for extension in archive["extensions"]:
            name, version = extension["name"], extension["version"]
            if name not in SAFE_EXTENSIONS:
                blockers.append(f"UNREVIEWED_EXTENSION:{name}")
            elif name not in installed:
                blockers.append(f"EXTENSION_INSTALLATION_REQUIRED:{name}")
            elif installed[name] != version and policy["extensionVersions"].get(name) != {"source": version, "target": installed[name]}:
                blockers.append(f"EXTENSION_VERSION_REVIEW_REQUIRED:{name}")
    filter_text = "".join(f"include schema {name}\n" for name in policy["schemas"])
    plan = {"format": 1, "mode": "plan-only", "writeCapable": False,
            "status": "blocked" if blockers else "requires-manual-review", "blockers": blockers,
            "targetFingerprint": target["fingerprint"], "targetMajor": snapshot["serverVersionNum"] // 10000,
            "sourceFingerprint": target["sourceFingerprint"],
            "targetBaselineSha256": hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest(),
            "providerSchemaPreserved": "pscale_extensions", "schemas": policy["schemas"],
            "extensionVersionApprovals": policy["extensionVersions"],
            "archive": archive, "filter": filter_text,
            "restoreArgumentsForReview": ["--single-transaction", "--exit-on-error", "--use-list=/input/approved.list",
                                          "--no-owner", "--no-acl", "--no-comments", "--no-security-labels", "--no-publications", "--no-subscriptions", "--no-tablespaces"],
            "manualReviews": ["archive trust and full TOC including excluded schemas", "dedicated empty PlanetScale branch identity",
                              "source snapshot and latest transaction", "roles grants RLS and security-definer ownership", "tree positions unavailable nodes ledger Stripe totals sequences",
                              "provider PITR and independent backup restore drill", "maintenance window jobs disabled rollback and cutover approval"]}
    plan["planSha256"] = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
    return plan


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise PlanError("INVALID_ARGUMENTS")


def main(argv=None):
    try:
        parser = SafeParser(description=__doc__)
        parser.add_argument("--policy", required=True)
        parser.add_argument("--manifest")
        parser.add_argument("--synthetic-docker", action="store_true")
        parser.add_argument("--full-toc")
        parser.add_argument("--selected-toc")
        args = parser.parse_args(argv)
        if args.full_toc or args.selected_toc:
            require(args.full_toc and args.selected_toc and not args.manifest and not args.synthetic_docker, "INVALID_TOC_ARGUMENTS")
            policy = policy_from(json.loads(Path(args.policy).read_text(encoding="utf-8")))
            toc = compile_toc(policy, Path(args.full_toc).read_text(encoding="utf-8"), Path(args.selected_toc).read_text(encoding="utf-8"))
            print(json.dumps({"mode": "toc-only", "writeCapable": False, "toc": toc, "tocSha256": hashlib.sha256(toc.encode()).hexdigest()}))
            return 0
        target = target_from(os.environ, args.synthetic_docker)
        policy = policy_from(json.loads(Path(args.policy).read_text(encoding="utf-8")))
        archive = archive_from(args.manifest) if args.manifest else None
        plan = build_plan(target, inspect_target(target), policy, archive)
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 2 if plan["blockers"] else 0
    except PlanError as error:
        print(json.dumps({"mode": "plan-only", "writeCapable": False, "status": "blocked", "code": str(error)}))
        return 2
    except Exception:
        # PostgreSQL errors and malformed inputs can contain credentials or row data.
        print(json.dumps({"mode": "plan-only", "writeCapable": False, "status": "blocked", "code": "REDACTED_PREFLIGHT_FAILURE"}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
