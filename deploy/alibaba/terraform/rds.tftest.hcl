mock_provider "alicloud" {}

variables {
  environment        = "staging"
  zones              = ["us-east-1a", "us-east-1b"]
  vpc_cidr           = "10.62.0.0/16"
  app_cidrs          = ["10.62.10.0/24", "10.62.11.0/24"]
  database_cidrs     = ["10.62.20.0/24", "10.62.21.0/24"]
  rds_instance_class = "pg.synthetic-ha-class"
  rds_kms_key_id     = "synthetic-kms-key-for-tests-only"
}

run "private_ha_postgres_with_recovery" {
  command = plan
  assert {
    condition     = alicloud_db_instance.main.engine == "PostgreSQL" && alicloud_db_instance.main.engine_version == "17.0"
    error_message = "Use PostgreSQL 17."
  }
  assert {
    condition     = alicloud_db_instance.main.category == "HighAvailability" && alicloud_db_instance.main.zone_id != alicloud_db_instance.main.zone_id_slave_a
    error_message = "Primary and standby must span zones."
  }
  assert {
    condition     = alicloud_db_instance.main.deletion_protection && alicloud_db_instance.main.ssl_action == "Open"
    error_message = "Deletion protection and TLS are required."
  }
  assert {
    condition     = alicloud_db_backup_policy.main.enable_backup_log && alicloud_db_backup_policy.main.log_backup_retention_period <= alicloud_db_backup_policy.main.backup_retention_period
    error_message = "PITR must have valid log retention."
  }
  assert {
    condition     = toset(alicloud_db_instance.main.security_ips) == toset(var.app_cidrs)
    error_message = "Only application subnets may connect."
  }
}

run "reject_single_zone" {
  command = plan
  variables { zones = ["us-east-1a", "us-east-1a"] }
  expect_failures = [var.zones]
}

run "reject_public_database_access" {
  command = plan
  variables { app_cidrs = ["0.0.0.0/0", "10.62.11.0/24"] }
  expect_failures = [alicloud_db_instance.main]
}

run "reject_unconfirmed_class" {
  command = plan
  variables { rds_instance_class = "REPLACE_WITH_CONFIRMED_HA_CLASS" }
  expect_failures = [var.rds_instance_class]
}
