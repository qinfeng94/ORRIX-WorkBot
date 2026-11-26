###############################################################################
# 环境三：gcp-landing-zone —— GCP VPC-SC 服务边界着陆区
# 溯源：AGENTS.md 红区（严禁公网裸露数据 / 审计日志只增不改）。
#
# 落地三件事：
#   1) 纯私有子网（private_ip_google_access = 只出不进公网入站）；
#   2) Cloud SQL Postgres：ipv4_enabled = false（公网 IP 物理关闭，只走 VPC 内网）；
#   3) 日志强制加密：Cloud Logging 审计桶挂 CMEK（BYOK：密钥路径由统一变量传入）。
# 附带：VPC-SC 服务边界（可选，填组织 ID 即启用）——把项目 + 存储库圈进数据护城河；
#      审计归档桶 public_access_prevention = enforced（公网访问物理阻断）。
# Non-Goal：GKE 应用算力编排不在本模板范围（应用层统一走 workbot-app 模块）。
###############################################################################

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
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
  default     = "gcp-landing-zone"
}

variable "private_subnet_cidrs" {
  description = "GATE-1 · 私有子网网段（至少 2 个）"
  type        = list(string)
  default     = ["10.50.1.0/24", "10.50.2.0/24"]
}

variable "database_publicly_accessible" {
  description = "GATE-2 · 数据库公网开关（门禁只认 false）"
  type        = bool
  default     = false
}

variable "log_encryption_kms_key_ref" {
  description = "GATE-3 · 日志加密密钥（BYOK：GCP CMEK 完整路径 projects/*/locations/*/keyRings/*/cryptoKeys/*）"
  type        = string
}

# ---- 本环境专属变量 ----
variable "gcp_project" {
  description = "GCP 项目 ID"
  type        = string
}

variable "gcp_region" {
  description = "GCP 区域"
  type        = string
  default     = "asia-east1"
}

# VPC-SC 可选：填 12 位组织 ID + 项目号即启用服务边界；留空则跳过（不影响三道闸）
variable "organization_id" {
  description = "GCP 组织 ID（VPC-SC 服务边界的宿主；留空 = 不启用 VPC-SC）"
  type        = string
  default     = ""
}

variable "gcp_project_number" {
  description = "GCP 项目编号（VPC-SC 边界内圈定的资源；启用 VPC-SC 时必填）"
  type        = string
  default     = ""
}

###############################################################################
# 网络：VPC + 纯私有子网
###############################################################################
resource "google_compute_network" "main" {
  name                    = "${var.project_name}-${var.environment}-vpc"
  auto_create_subnetworks = false # 自定义子网模式：不给 GCP 自动开公网网段的机会
}

resource "google_compute_subnetwork" "private" {
  count = length(var.private_subnet_cidrs)

  name                     = "${var.project_name}-${var.environment}-private-${count.index + 1}"
  ip_cidr_range            = var.private_subnet_cidrs[count.index]
  region                   = var.gcp_region
  network                  = google_compute_network.main.id
  private_ip_google_access = true # 只出不进：实例可访问 Google API，公网无法入站
}

###############################################################################
# 数据库：Cloud SQL Postgres（公网 IP 物理关闭，只走 VPC 对等内网）
###############################################################################
resource "google_compute_global_address" "sql_peering" {
  name          = "${var.project_name}-sql-peering-range"
  purpose       = "VPC_PEERING"
  prefix_length = 16
  address_type  = "INTERNAL"
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "main" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql_peering.name]
}

resource "google_sql_database_instance" "main" {
  name             = "${var.project_name}-${var.environment}-db"
  database_version = "POSTGRES_16"
  region           = var.gcp_region

  settings {
    tier = "db-f1-micro"

    ip_configuration {
      # —— GATE-2 落点：ipv4_enabled = false 是物理开关，
      #    公网 IP 根本不会分配（想裸露连 IP 都没有）——
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
    }
  }

  deletion_protection = true # 业务数据零删库：防止误删实例，回滚只退镜像不退数据

  depends_on = [google_service_networking_connection.main]
}

###############################################################################
# 日志：Cloud Logging 审计桶挂 CMEK（GATE-3 云端落点）
###############################################################################
resource "google_logging_project_bucket_config" "audit" {
  project        = var.gcp_project
  location       = "global"
  bucket_id      = "${var.project_name}-audit-logs"
  retention_days = 365

  cmek_settings {
    kms_key_name = var.log_encryption_kms_key_ref # BYOK：统一变量传入的 CMEK 路径
  }
}

###############################################################################
# 审计归档桶：公网访问物理阻断 + CMEK 加密（审计日志只增不改的云端存放点）
###############################################################################
resource "google_storage_bucket" "audit_logs" {
  name          = "${var.gcp_project}-${var.project_name}-audit-logs"
  location      = var.gcp_region
  force_destroy = false # 关键保险丝：terraform destroy 也删不掉桶内容

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced" # 公网访问物理阻断

  encryption {
    default_kms_key_name = var.log_encryption_kms_key_ref
  }
}

###############################################################################
# VPC-SC 服务边界（可选：填组织 ID + 项目号即启用）
###############################################################################
resource "google_access_context_manager_access_policy" "main" {
  count = var.organization_id != "" && var.gcp_project_number != "" ? 1 : 0

  parent = "organizations/${var.organization_id}"
  title  = "${var.project_name}-access-policy"
}

resource "google_access_context_manager_service_perimeter" "main" {
  count = var.organization_id != "" && var.gcp_project_number != "" ? 1 : 0

  policy_name    = google_access_context_manager_access_policy.main[0].name
  perimeter_type = "REGULAR"
  title          = "${var.project_name}-perimeter"

  status {
    resources = ["projects/${var.gcp_project_number}"]

    restricted_services = [
      "storage.googleapis.com",
      "sqladmin.googleapis.com",
      "logging.googleapis.com",
    ]
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
