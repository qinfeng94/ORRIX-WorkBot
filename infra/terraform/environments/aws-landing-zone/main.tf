###############################################################################
# 环境二：aws-landing-zone —— AWS VPC 私有着陆区
# 溯源：AGENTS.md 红区（严禁公网裸露数据 / 审计日志只增不改）。
#
# 落地三件事：
#   1) 只有私有子网（本模板物理不存在任何公网子网资源）；
#   2) RDS Postgres：publicly_accessible 硬编码 false + 存储加密 + 仅 VPC 内 5432 放行；
#   3) 日志强制加密：CloudWatch 日志组挂 KMS（BYOK：密钥 ARN 由统一变量传入）。
# 附带：审计日志 S3 桶（阻断公网访问 + KMS 加密），承接「审计日志只增不改」云端落点。
# Non-Goal：EKS/ECS 应用算力编排不在本模板范围（应用层统一走 workbot-app 模块，
#           见 infra/README-DEPLOY.md「范围说明」）。
###############################################################################

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

###############################################################################
# 统一变量声明（三套环境同名同义）
###############################################################################
variable "project_name" {
  description = "项目名（资源统一命名前缀）"
  type        = string
  default     = "workbot"
}

variable "environment" {
  description = "环境标识"
  type        = string
  default     = "aws-landing-zone"
}

variable "private_subnet_cidrs" {
  description = "GATE-1 · 私有子网网段（至少 2 个，跨可用区）"
  type        = list(string)
  default     = ["10.40.1.0/24", "10.40.2.0/24"]
}

variable "database_publicly_accessible" {
  description = "GATE-2 · 数据库公网开关（门禁只认 false）"
  type        = bool
  default     = false
}

variable "log_encryption_kms_key_ref" {
  description = "GATE-3 · 日志加密密钥（BYOK：预先建好的 AWS KMS 密钥 ARN）"
  type        = string
}

# ---- 本环境专属变量 ----
variable "aws_region" {
  description = "AWS 区域"
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "VPC 主网段（必须为 RFC1918 私有网段）"
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(regex("^(10\\.|172\\.(1[6-9]|2[0-9]|3[0-1])\\.|192\\.168\\.)", var.vpc_cidr))
    error_message = "VPC 主网段必须是 RFC1918 私有网段。"
  }
}

variable "db_username" {
  description = "RDS 主用户名（密码不进 Terraform，由 RDS 托管生成 / 密钥管理通道下发）"
  type        = string
  default     = "workbot_admin"
}

variable "log_retention_days" {
  description = "CloudWatch 日志保留天数"
  type        = number
  default     = 365
}

###############################################################################
# 网络：VPC + 纯私有子网（刻意不创建 Internet Gateway / 公网子网 / NAT 网关出站口）
###############################################################################
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project_name}-${var.environment}-vpc" }
}

resource "aws_subnet" "private" {
  count = length(var.private_subnet_cidrs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = "${var.aws_region}${["a", "b", "c", "d"][count.index]}"

  tags = {
    Name = "${var.project_name}-${var.environment}-private-${count.index + 1}"
    # 着陆区标签：声明这是私有子网，配合组织级 SCP 双保险
    NetworkScope = "private"
  }
}

###############################################################################
# 数据库：RDS Postgres（公网硬关 + 存储加密 + 仅 VPC 内放行）
###############################################################################
resource "aws_kms_key" "db" {
  description             = "${var.project_name} 数据库存储加密密钥"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_db_subnet_group" "private" {
  name       = "${var.project_name}-${var.environment}-db-subnets"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "db" {
  name_prefix = "${var.project_name}-db-"
  vpc_id      = aws_vpc.main.id
  description = "数据库仅允许 VPC 内部 5432（公网网段一律不进规则）"

  ingress {
    description = "仅 VPC 内部访问"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "出站全放行（仅限 VPC 内主机实际可达范围）"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "main" {
  identifier     = "${var.project_name}-${var.environment}-db"
  engine         = "postgres"
  engine_version = "16.4"
  instance_class = "db.t4g.micro"

  allocated_storage     = 20
  db_name               = replace(var.project_name, "-", "_")
  username              = var.db_username
  manage_master_user_password = true # 密码由 Secrets Manager 托管生成，Terraform 零明文

  # —— GATE-2 双保险：门禁变量已校验 false，资源层再硬编码一次（想裸奔连代码都改不了）——
  publicly_accessible = false

  # —— 存储加密 + 专属 KMS 密钥 ——
  storage_encrypted = true
  kms_key_id        = aws_kms_key.db.arn

  db_subnet_group_name   = aws_db_subnet_group.private.name
  vpc_security_group_ids = [aws_security_group.db.id]

  backup_window      = "18:00-19:00"
  skip_final_snapshot = false
  final_snapshot_identifier = "${var.project_name}-${var.environment}-db-final"
}

###############################################################################
# 日志：CloudWatch 日志组挂 KMS（GATE-3 云端落点）
###############################################################################
resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.project_name}/${var.environment}/app"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_encryption_kms_key_ref # BYOK：统一变量传入的 KMS ARN

  tags = { Environment = var.environment }
}

###############################################################################
# 审计日志归档桶：阻断公网 + KMS 加密（审计日志只增不改的云端存放点）
###############################################################################
resource "aws_s3_bucket" "audit_logs" {
  bucket = "${var.project_name}-${var.environment}-audit-logs"

  tags = { Environment = var.environment, DataClass = "audit-immutable" }
}

resource "aws_s3_bucket_public_access_block" "audit_logs" {
  bucket = aws_s3_bucket.audit_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_logs" {
  bucket = aws_s3_bucket.audit_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.log_encryption_kms_key_ref
    }
    bucket_key_enabled = true
  }
}

###############################################################################
# 统一安全门禁：三道闸终审（任何一道不过，plan 直接终止）
###############################################################################
module "security_gates" {
  source = "../../modules/security-gates"

  environment_name             = var.environment
  private_subnet_cidrs         = var.private_subnet_cidrs
  database_publicly_accessible = var.database_publicly_accessible
  log_encryption_kms_key_ref   = var.log_encryption_kms_key_ref
}
