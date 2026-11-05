output "vpc_id" {
  value = alicloud_vpc.main.id
}
output "app_vswitch_ids" {
  value = alicloud_vswitch.app[*].id
}
output "rds_instance_id" {
  value = alicloud_db_instance.main.id
}
output "rds_private_endpoint" {
  value = alicloud_db_instance.main.connection_string
}
