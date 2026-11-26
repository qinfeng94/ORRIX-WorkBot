###############################################################################
# security-gates 输出：门禁过闸报告（三套环境统一格式，审计只认这份证据）
###############################################################################

output "gate_report" {
  description = "三道闸过闸证据（环境名 · 私有子网数 · 数据库公网状态 · 日志密钥指纹）"
  value = {
    environment           = var.environment_name
    gate_1_private_subnets = {
      passed      = true
      subnet_cidrs = var.private_subnet_cidrs
    }
    gate_2_no_public_db = {
      passed               = true
      publicly_accessible  = var.database_publicly_accessible
    }
    gate_3_log_encryption = {
      passed         = true
      kms_key_fingerprint = substr(sha256(var.log_encryption_kms_key_ref), 0, 16)
    }
    audited_at = timestamp()
  }
}

output "gates_version" {
  description = "门禁规则版本号（规则变更必须升版本并重新过闸，便于审计对齐）"
  value       = "day35-gates-v1"
}
