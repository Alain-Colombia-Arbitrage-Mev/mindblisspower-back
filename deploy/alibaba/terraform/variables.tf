variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Use staging or production."
  }
}
variable "region" {
  type    = string
  default = "us-east-1"
}
variable "zones" {
  type = tuple([string, string])
  validation {
    condition     = var.zones[0] != var.zones[1]
    error_message = "RDS primary and standby must use different confirmed availability zones."
  }
}
variable "vpc_cidr" {
  type = string
}
variable "app_cidrs" {
  type = tuple([string, string])
}
variable "database_cidrs" {
  type = tuple([string, string])
}
variable "rds_instance_class" {
  description = "Confirm a PostgreSQL 17 HA class and its price in BOTH selected zones. No automatic cheapest selection."
  type        = string
  validation {
    condition     = length(var.rds_instance_class) > 5 && !strcontains(var.rds_instance_class, "REPLACE")
    error_message = "Supply a class confirmed in the Alibaba console."
  }
}
variable "rds_storage_gb" {
  type    = number
  default = 100
  validation {
    condition     = var.rds_storage_gb >= 100 && var.rds_storage_gb <= 2000 && floor(var.rds_storage_gb) == var.rds_storage_gb
    error_message = "Storage must be an integer from 100 to 2000 GB."
  }
}
variable "rds_kms_key_id" {
  description = "Existing authorized KMS key ID in this region. Never delete it while disks/backups need it."
  type        = string
  validation {
    condition     = length(var.rds_kms_key_id) > 10 && var.rds_kms_key_id != "ServiceKey" && !strcontains(var.rds_kms_key_id, "REPLACE")
    error_message = "A real KMS key ID is required when creating encrypted RDS disks."
  }
}
