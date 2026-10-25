import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import restore_plan as subject


def environment(**updates):
    return {"RESTORE_CREDENTIAL_ROTATION_CONFIRMED": "yes", "SOURCE_DATABASE_READY_CONFIRMED": "yes",
            "RESTORE_DATABASE_URL": "postgresql://restore:synthetic-password@fixture.pg.psdb.cloud:5432/postgres?sslmode=verify-full",
            "RESTORE_EXPECTED_DATABASE": "postgres", "SOURCE_REFERENCE": "docker:mindbliss-local-recovery-20261022",
            "SOURCE_DATABASE_NAME": "recovered", **updates}


def snapshot(**updates):
    return {"database": "postgres", "serverVersionNum": 180006, "replica": False,
            "canCreateSchema": True, "canCreatePublic": True,
            "schemas": ["public", "pscale_extensions"], "customRelations": 0,
            "customRoutines": 0, "customTypes": 0,
            "extensions": [{"name": "plpgsql", "version": "1.0", "schema": "pg_catalog"},
                           {"name": "ltree", "version": "1.3", "schema": "public"}], **updates}


def archive():
    return {"postgresMajor": 17, "sha256": "a" * 64, "bytes": 123,
            "extensions": [{"name": "plpgsql", "version": "1.0"}, {"name": "ltree", "version": "1.2"}]}


def policy():
    return subject.policy_from({"schemas": ["mlm"], "extensionVersions": {"ltree": {"source": "1.2", "target": "1.3"}}})


class RestorePlanningTests(unittest.TestCase):
    def plan(self, state=None, rules=None, backup=None):
        return subject.build_plan(subject.target_from(environment()), state or snapshot(), rules or policy(), backup or archive())

    def test_real_targets_require_rotated_credentials_before_any_network(self):
        with patch.dict(os.environ, environment(RESTORE_CREDENTIAL_ROTATION_CONFIRMED="no"), clear=True), patch.object(subject, "inspect_target") as inspect:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                status = subject.main(["--policy", "does-not-exist.json"])
            self.assertEqual(status, 2)
            self.assertEqual(json.loads(output.getvalue())["code"], "CREDENTIAL_ROTATION_REQUIRED")
            inspect.assert_not_called()

    def test_source_readiness_is_required(self):
        with self.assertRaisesRegex(subject.PlanError, "SOURCE_READINESS_REQUIRED"):
            subject.target_from(environment(SOURCE_DATABASE_READY_CONFIRMED="no"))

    def test_direct_verified_target_and_database_are_mandatory(self):
        for uri in ["postgres://u:p@fixture.pg.psdb.cloud:6432/postgres?sslmode=verify-full",
                    "postgres://u:p@fixture.pg.psdb.cloud/postgres?sslmode=require",
                    "postgres://u:p@fixture.pg.psdb.cloud.evil.invalid/postgres?sslmode=verify-full",
                    "postgres://u:p@localhost/postgres?sslmode=verify-full",
                    "postgres://u:p@fixture.pg.psdb.cloud/other?sslmode=verify-full",
                    "postgres://u:p@fixture.pg.psdb.cloud/postgres?sslmode=verify-full&options=unsafe"]:
            with self.subTest(uri=uri), self.assertRaises(subject.PlanError):
                subject.target_from(environment(RESTORE_DATABASE_URL=uri))

    def test_source_name_and_selected_docker_reference_cannot_be_guessed(self):
        for changes in [{"SOURCE_REFERENCE": "other"}, {"SOURCE_DATABASE_NAME": ""}, {"SOURCE_DATABASE_NAME": "replace_with_verified_source_db"}]:
            with self.subTest(changes=changes), self.assertRaises(subject.PlanError):
                subject.target_from(environment(**changes))

    def test_synthetic_mode_cannot_point_at_planetscale(self):
        with self.assertRaises(subject.PlanError):
            subject.target_from(environment(), synthetic=True)
        local = environment(RESTORE_DATABASE_URL="postgres://u:p@mindbliss-psrestore-012345abcdef-db/postgres?sslmode=disable", SOURCE_REFERENCE="synthetic:postgres17")
        self.assertEqual(subject.target_from(local, synthetic=True)["sslmode"], "disable")

    def test_no_implicit_schema_selection_or_provider_schemas(self):
        for schemas in [[], ["mlm", "mlm"], ["pscale_extensions"], ["pg_catalog"], ["information_schema"], ["mlm*"], ["mlm; DROP SCHEMA public"], ["Uppercase"]]:
            with self.subTest(schemas=schemas), self.assertRaises(subject.PlanError):
                subject.policy_from({"schemas": schemas})

    def test_invalid_policy_fields_and_extension_approvals_are_rejected(self):
        for document in [{"schemas": ["mlm"], "ignoreErrors": True},
                         {"schemas": ["mlm"], "extensionVersions": {"ltree": {"source": "1.2"}}},
                         {"schemas": ["mlm"], "extensionVersions": {"ltree": {"source": "1.2", "target": "latest"}}}]:
            with self.subTest(document=document), self.assertRaises(subject.PlanError):
                subject.policy_from(document)

    def test_plan_is_never_an_execution_or_production_approval(self):
        result = self.plan()
        self.assertEqual(result["status"], "requires-manual-review")
        self.assertFalse(result["writeCapable"])
        self.assertTrue(result["manualReviews"])
        self.assertEqual(result["filter"], "include schema mlm\n")
        self.assertNotIn("synthetic-password", json.dumps(result))
        self.assertNotIn("restore:synthetic", json.dumps(result))

    def test_wrong_major_replica_or_database_blocks(self):
        for changes in [{"serverVersionNum": 170011}, {"replica": True}, {"database": "other"}]:
            with self.subTest(changes=changes):
                self.assertEqual(self.plan(state=snapshot(**changes))["status"], "blocked")

    def test_existing_tables_functions_types_or_other_schemas_block(self):
        for changes in [{"customRelations": 1}, {"customRoutines": 1}, {"customTypes": 1}, {"schemas": ["public", "mlm"]}]:
            with self.subTest(changes=changes):
                self.assertIn("TARGET_CONTAINS_UNREVIEWED_OBJECTS", self.plan(state=snapshot(**changes))["blockers"])

    def test_missing_restore_permissions_block(self):
        self.assertIn("RESTORE_ROLE_PERMISSIONS_REQUIRED", self.plan(state=snapshot(canCreateSchema=False))["blockers"])
        rules = subject.policy_from({"schemas": ["public"]})
        self.assertIn("RESTORE_ROLE_PERMISSIONS_REQUIRED", self.plan(state=snapshot(canCreatePublic=False), rules=rules)["blockers"])

    def test_archive_is_not_optional_for_an_eligible_plan(self):
        result = subject.build_plan(subject.target_from(environment()), snapshot(), policy(), None)
        self.assertIn("VERIFIED_ARCHIVE_REQUIRED", result["blockers"])

    def test_missing_extensions_require_explicit_installation_outside_the_planner(self):
        self.assertIn("EXTENSION_INSTALLATION_REQUIRED:ltree", self.plan(state=snapshot(extensions=[]))["blockers"])

    def test_extension_versions_require_an_exact_reviewed_pair(self):
        rules = subject.policy_from({"schemas": ["mlm"]})
        self.assertIn("EXTENSION_VERSION_REVIEW_REQUIRED:ltree", self.plan(rules=rules)["blockers"])
        state = snapshot(extensions=[{"name": "ltree", "version": "1.4", "schema": "public"}])
        self.assertIn("EXTENSION_VERSION_REVIEW_REQUIRED:ltree", self.plan(state=state)["blockers"])

    def test_timescale_and_unreviewed_extensions_are_not_silently_discarded(self):
        for name in ["timescaledb", "pg_cron", "unreviewed"]:
            record = archive()
            record["extensions"].append({"name": name, "version": "1.0"})
            self.assertIn(f"UNREVIEWED_EXTENSION:{name}", self.plan(backup=record)["blockers"])

    def test_plan_digest_binds_target_state_source_archive_and_policy(self):
        result = self.plan()
        changed = snapshot()
        changed["extensions"].append({"name": "pgcrypto", "version": "1.4", "schema": "pscale_extensions"})
        self.assertNotEqual(result["planSha256"], self.plan(state=changed)["planSha256"])
        record = archive()
        record["sha256"] = "b" * 64
        self.assertNotEqual(result["planSha256"], self.plan(backup=record)["planSha256"])
        other = subject.target_from(environment(SOURCE_DATABASE_NAME="other"))
        self.assertNotEqual(result["planSha256"], subject.build_plan(other, snapshot(), policy(), archive())["planSha256"])

    def test_restore_arguments_preserve_atomicity_and_exclude_provider_management(self):
        args = self.plan()["restoreArgumentsForReview"]
        for required in ["--single-transaction", "--exit-on-error", "--use-list=/input/approved.list", "--no-owner", "--no-acl", "--no-publications", "--no-subscriptions"]:
            self.assertIn(required, args)
        for forbidden in ["--clean", "--create", "--disable-triggers", "--jobs"]:
            self.assertNotIn(forbidden, args)

    def test_encrypted_manifest_integrity_and_filename_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ciphertext = b"synthetic encrypted fixture; not a usable company backup"
            (root / "fixture.dump.age").write_bytes(ciphertext)
            record = {"format": 1, "postgresMajor": 17, "extensions": [],
                      "database": {"file": "fixture.dump.age", "bytes": len(ciphertext), "sha256": hashlib.sha256(ciphertext).hexdigest()}}
            manifest = root / "fixture.manifest.json"
            manifest.write_text(json.dumps(record), encoding="utf-8")
            self.assertEqual(subject.archive_from(manifest)["postgresMajor"], 17)
            variants = []
            for key, value in [("file", "../fixture.dump.age"), ("bytes", len(ciphertext) + 1), ("sha256", "0" * 64)]:
                bad = copy.deepcopy(record)
                bad["database"][key] = value
                variants.append(bad)
            variants.extend([{**record, "postgresMajor": 19}, {**record, "format": True}, {**record, "extensions": [{"name": "unsafe;value", "version": "1.0"}]}])
            for bad in variants:
                manifest.write_text(json.dumps(bad), encoding="utf-8")
                with self.subTest(bad=bad), self.assertRaises(subject.PlanError):
                    subject.archive_from(manifest)

    def test_cli_has_no_apply_mode_and_never_echoes_invalid_arguments(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch.object(subject, "inspect_target") as inspect:
            self.assertEqual(subject.main(["--policy", "x", "--apply", "never-log-this-secret"]), 2)
            inspect.assert_not_called()
        self.assertNotIn("never-log-this-secret", output.getvalue())

    def test_query_is_transaction_scoped_read_only(self):
        self.assertIn("BEGIN READ ONLY", subject.CATALOG_SQL)
        self.assertIn("ROLLBACK", subject.CATALOG_SQL)
        self.assertNotIn("CREATE EXTENSION", subject.CATALOG_SQL)
        self.assertNotIn("INSERT INTO", subject.CATALOG_SQL)
        self.assertNotIn("LIKE 'pg_%'", subject.CATALOG_SQL)

    def test_toc_preserves_native_order_and_adds_only_approved_schema_definitions(self):
        full = "; header\n1; 2615 100 SCHEMA - mlm owner\n2; 2615 101 SCHEMA - excluded owner\n3; 1259 102 TABLE mlm a owner\n4; 1259 103 TABLE excluded b owner\n"
        selected = "3; 1259 102 TABLE mlm a owner\n"
        result = subject.compile_toc(policy(), full, selected)
        self.assertIn("SCHEMA - mlm", result)
        self.assertLess(result.index("SCHEMA - mlm"), result.index("TABLE mlm a"))
        self.assertNotIn("excluded", result)

    def test_toc_rejects_unknown_ids_changed_lines_duplicates_and_missing_schemas(self):
        full = "1; 2615 100 SCHEMA - mlm owner\n2; 1259 101 TABLE mlm a owner\n"
        for selected in ["9; 0 0 TABLE mlm x owner", "2; 1259 101 TABLE mlm changed owner", "2; 1259 101 TABLE mlm a owner\n2; 1259 101 TABLE mlm a owner", "not a TOC"]:
            with self.subTest(selected=selected), self.assertRaises(subject.PlanError):
                subject.compile_toc(policy(), full, selected)
        with self.assertRaisesRegex(subject.PlanError, "APPROVED_SCHEMA_NOT_IN_ARCHIVE"):
            subject.compile_toc(policy(), "2; 1259 101 TABLE mlm a owner", "2; 1259 101 TABLE mlm a owner")

    def test_toc_does_not_recreate_public_schema(self):
        rules = subject.policy_from({"schemas": ["public"]})
        result = subject.compile_toc(rules, "1; 2615 100 SCHEMA - public owner\n2; 1259 101 TABLE public a owner", "1; 2615 100 SCHEMA - public owner\n2; 1259 101 TABLE public a owner")
        self.assertNotIn("SCHEMA - public", result)

    def test_psql_gets_credentials_only_in_a_clean_environment(self):
        target = subject.target_from(environment())
        result = SimpleNamespace(returncode=0, stdout=json.dumps(snapshot()), stderr="")
        with patch.dict(os.environ, {"PGSERVICE": "untrusted", "PGHOST": "untrusted", "PGOPTIONS": "untrusted"}), patch.object(subject.subprocess, "run", return_value=result) as run:
            subject.inspect_target(target)
        args, kwargs = run.call_args
        self.assertNotIn("synthetic-password", json.dumps(args))
        self.assertNotIn("PGSERVICE", kwargs["env"])
        self.assertEqual(kwargs["env"]["PGHOST"], target["host"])
        self.assertEqual(kwargs["env"]["PGOPTIONS"], "-c default_transaction_read_only=on")
        self.assertEqual(kwargs["env"]["PGSSLROOTCERT"], "system")

    def test_database_errors_are_never_echoed(self):
        with tempfile.TemporaryDirectory() as directory:
            rules = Path(directory) / "policy.json"
            rules.write_text(json.dumps({"schemas": ["mlm"]}), encoding="utf-8")
            with patch.dict(os.environ, environment(), clear=True), patch.object(subject, "inspect_target", side_effect=RuntimeError("never-log-this-secret")):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(subject.main(["--policy", str(rules)]), 2)
                self.assertNotIn("never-log-this-secret", output.getvalue())
                self.assertEqual(json.loads(output.getvalue())["code"], "REDACTED_PREFLIGHT_FAILURE")


if __name__ == "__main__":
    unittest.main()
