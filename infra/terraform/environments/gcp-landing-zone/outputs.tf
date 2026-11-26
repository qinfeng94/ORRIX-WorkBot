###############################################################################
# gcp-landing-zone 输出
###############################################################################

output "gate_report" {
  description = "三道闸过闸报告（审计留档）"
  value       = module.security_gates.gate_report
}

output "network_id" {
  value = google_compute_network.main.id
}

output "private_subnet_ids" {
  description = "私有子网清单（应用算力落地位置）"
  value       = google_compute_subnetwork.private[*].id
}

output "db_connection_name" {
  description = "Cloud SQL 私有连接串（仅 VPC 内可达，公网 IP 未分配）"
  value       = google_sql_database_instance.main.connection_name
}

output "audit_logging_bucket" {
  description = "Cloud Logging 审计桶（已挂 CMEK 加密）"
  value       = google_logging_project_bucket_config.audit.bucket_id
}

output "audit_archive_bucket" {
  description = "审计归档桶（公网阻断 enforced + CMEK 加密）"
  value       = google_storage_bucket.audit_logs.name
}

output "vpc_sc_enabled" {
  description = "VPC-SC 服务边界是否启用（填了组织 ID + 项目号即为 true）"
  value       = var.organization_id != "" && var.gcp_project_number != ""
}
