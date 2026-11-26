###############################################################################
# security-gates —— WorkBot 统一安全策略门禁（三套环境共用，单一真源）
# 溯源：AGENTS.md 红区（严禁公网裸露 / 审计日志只增不改 / Kill Switch）；
#      04 号文档权限边界（绿区只读 / 黄区起草 / 红区物理剔除）。
#
# 三道闸（在 terraform plan/apply 阶段物理拦截，不是提示词劝阻）：
#   GATE-1 强制私有子网   —— 所有工作负载子网必须是 RFC1918 私有网段
#   GATE-2 禁止公网裸库   —— 数据库 publicly_accessible 必须为 false（写死，改 true 直接报错）
#   GATE-3 强制日志加密   —— 日志必须挂 KMS / CMEK 密钥引用，缺钥不发货
#
# 用法：三套环境（local-k8s / aws-landing-zone / gcp-landing-zone）各自把真实值
#       传入本模块；任何一套想「裸奔」都会在 plan 阶段被 validation 硬拦。
###############################################################################

terraform {
  required_version = ">= 1.5.0" # check 块 / 变量 validation 需 1.5+
}

###############################################################################
# GATE-1 输入：私有子网网段清单
###############################################################################
variable "private_subnet_cidrs" {
  description = "工作负载子网网段清单（必须全部为 RFC1918 私有网段）"
  type        = list(string)
}

variable "database_publicly_accessible" {
  description = "GATE-2 输入：数据库是否允许公网访问（本门禁只接受 false）"
  type        = bool
}

variable "log_encryption_kms_key_ref" {
  description = "GATE-3 输入：日志加密密钥引用（AWS KMS ARN / GCP CMEK 路径 / local:// 演习密钥）"
  type        = string
}

variable "environment_name" {
  description = "环境名（写入门禁报告，便于审计定位是哪套环境在过闸）"
  type        = string
}

###############################################################################
# 三道闸 · 硬校验（validation 失败 = terraform plan 直接终止，无法绕过）
###############################################################################
variable "validations" {
  description = "占位变量：承载三道闸的硬校验逻辑（值恒为 true，校验失败即报错）"
  type        = bool
  default     = true

  # GATE-1：每个网段必须既合法（cidrhost 可解析）又落在 RFC1918 私有区间
  validation {
    condition = alltrue([
      for cidr in var.private_subnet_cidrs :
      can(cidrhost(cidr, 0)) &&
      can(regex("^(10\\.|172\\.(1[6-9]|2[0-9]|3[0-1])\\.|192\\.168\\.)", cidr))
    ])
    error_message = "门禁 GATE-1 拦截：所有工作负载子网必须是 RFC1918 私有网段（10.x / 172.16-31.x / 192.168.x），公网网段一律不放行。"
  }

  validation {
    condition     = length(var.private_subnet_cidrs) >= 2
    error_message = "门禁 GATE-1 拦截：私有子网至少 2 个（跨可用区容灾，不允许单子网裸奔）。"
  }
}

variable "database_gate" {
  description = "占位变量：GATE-2 硬校验载体"
  type        = bool
  default     = true

  validation {
    condition     = var.database_publicly_accessible == false
    error_message = "门禁 GATE-2 拦截：数据库严禁公网裸露（database_publicly_accessible 必须为 false）。这是 AGENTS.md 红线，不是可选项。"
  }
}

variable "log_gate" {
  description = "占位变量：GATE-3 硬校验载体"
  type        = bool
  default     = true

  validation {
    condition = can(regex(
      "^(arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/.+|projects/[a-z][a-z0-9-]*/locations/[a-z]+/keyRings/[a-z][a-z0-9-]*/cryptoKeys/[a-z][a-z0-9-]*|local://[a-z0-9][a-z0-9-/]*)$",
      var.log_encryption_kms_key_ref,
    ))
    error_message = "门禁 GATE-3 拦截：日志必须挂加密密钥——AWS KMS ARN、GCP CMEK 路径或 local:// 演习密钥三选一，留空 / 裸路径一律不发货。"
  }
}

###############################################################################
# check 块：plan 时的运行时断言（与 validation 互为双保险，输出告警便于审计阅卷）
###############################################################################
check "gate_1_private_subnets_runtime" {
  assert {
    condition = alltrue([
      for cidr in var.private_subnet_cidrs :
      can(regex("^(10\\.|172\\.(1[6-9]|2[0-9]|3[0-1])\\.|192\\.168\\.)", cidr))
    ])
    error_message = "GATE-1 运行时复查：检测到非私有网段子网。"
  }
}

check "gate_2_no_public_db_runtime" {
  assert {
    condition     = var.database_publicly_accessible == false
    error_message = "GATE-2 运行时复查：数据库公网访问被打开。"
  }
}

check "gate_3_log_encryption_runtime" {
  assert {
    condition     = length(var.log_encryption_kms_key_ref) > 0
    error_message = "GATE-3 运行时复查：日志加密密钥引用为空。"
  }
}
