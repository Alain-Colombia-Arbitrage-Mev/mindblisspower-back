locals {
  name = "mindbliss-${var.environment}"
  tags = { Application = "mindbliss", Environment = var.environment, ManagedBy = "terraform" }
}

resource "alicloud_vpc" "main" {
  vpc_name   = local.name
  cidr_block = var.vpc_cidr
  tags       = local.tags
}

resource "alicloud_vswitch" "app" {
  count        = 2
  vpc_id       = alicloud_vpc.main.id
  zone_id      = var.zones[count.index]
  cidr_block   = var.app_cidrs[count.index]
  vswitch_name = "${local.name}-app-${count.index + 1}"
}

resource "alicloud_vswitch" "database" {
  count        = 2
  vpc_id       = alicloud_vpc.main.id
  zone_id      = var.zones[count.index]
  cidr_block   = var.database_cidrs[count.index]
  vswitch_name = "${local.name}-db-${count.index + 1}"
}

resource "alicloud_db_instance" "main" {
  engine                   = "PostgreSQL"
  engine_version           = "17.0"
  category                 = "HighAvailability"
  instance_type            = var.rds_instance_class
  instance_storage         = var.rds_storage_gb
  instance_charge_type     = "Postpaid"
  instance_name            = local.name
  db_instance_storage_type = "cloud_essd"
  zone_id                  = var.zones[0]
  zone_id_slave_a          = var.zones[1]
  vswitch_id               = join(",", alicloud_vswitch.database[*].id)
  security_ips             = tolist(var.app_cidrs)
  encryption_key           = var.rds_kms_key_id
  ssl_action               = "Open"
  deletion_protection      = true
  monitoring_period        = "60"
  tags                     = local.tags

  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = alltrue([for cidr in var.app_cidrs : can(cidrnetmask(cidr)) && try(tonumber(split("/", cidr)[1]) >= 24, false)])
      error_message = "RDS access must be restricted to valid application subnets of /24 or smaller."
    }
  }
}

resource "alicloud_db_backup_policy" "main" {
  instance_id                 = alicloud_db_instance.main.id
  preferred_backup_period     = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
  preferred_backup_time       = "03:00Z-04:00Z"
  backup_retention_period     = 30
  enable_backup_log           = true
  log_backup_retention_period = 7
}
