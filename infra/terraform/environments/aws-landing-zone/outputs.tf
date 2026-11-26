###############################################################################
# aws-landing-zone 输出
###############################################################################

output "gate_report" {
  description = "三道闸过闸报告（审计留档）"
  value       = module.security_gates.gate_report
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "私有子网清单（应用算力落地位置）"
  value       = aws_subnet.private[*].id
}

output "db_endpoint" {
  description = "RDS 内网接入点（仅 VPC 内可达，公网无路由）"
  value       = aws_db_instance.main.address
}

output "db_publicly_accessible" {
  description = "数据库公网状态（恒为 false，改 true 根本过不了 plan）"
  value       = aws_db_instance.main.publicly_accessible
}

output "app_log_group" {
  description = "应用日志组（已挂 KMS 加密）"
  value       = aws_cloudwatch_log_group.app.name
}

output "audit_logs_bucket" {
  description = "审计日志归档桶（公网阻断 + KMS 加密）"
  value       = aws_s3_bucket.audit_logs.id
}
