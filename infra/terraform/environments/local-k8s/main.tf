###############################################################################
# 环境一：local-k8s —— 本地 / 私有云 Kubernetes 着陆区（kind / minikube / 私有集群）
# 特点：整套餐不申请任何云账号；子网 = 集群 Pod/Service 网段（天然 RFC1918 私有）；
#      日志密钥用 local:// 演习密钥引用（本地无 KMS，门禁规则三选一里唯一允许的演习通道）。
###############################################################################

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.33"
    }
  }
}

provider "kubernetes" {
  # 默认读 ~/.kube/config（kind/minikube 自动写入）；私有云集群请先配置好 kubeconfig
}

###############################################################################
# 统一变量声明（三套环境同名同义，换环境不用重新学一遍）
###############################################################################
variable "project_name" {
  description = "项目名（资源统一打标签用）"
  type        = string
  default     = "workbot"
}

variable "environment" {
  description = "环境标识"
  type        = string
  default     = "local-k8s"
}

variable "private_subnet_cidrs" {
  description = "GATE-1 · 工作负载子网（kind 默认 Pod 网段 + Service 网段，均为私有网段）"
  type        = list(string)
  default     = ["10.244.0.0/16", "10.96.0.0/12"]
}

variable "database_publicly_accessible" {
  description = "GATE-2 · 数据库公网开关（门禁只认 false）"
  type        = bool
  default     = false
}

variable "log_encryption_kms_key_ref" {
  description = "GATE-3 · 日志加密密钥引用（本地演习通道：local:// 前缀；云环境换 KMS ARN / CMEK 路径）"
  type        = string
  default     = "local://day35/audit-log-key"
}

# ---- 本环境专属变量 ----
variable "app_image" {
  description = "WorkBot 应用镜像（回滚 = 换回上一版标签）"
  type        = string
  default     = "workbot:v4.0.35"
}

variable "app_replicas" {
  description = "应用副本数"
  type        = number
  default     = 2
}

###############################################################################
# 门禁 + 应用
###############################################################################
module "security_gates" {
  source = "../../modules/security-gates"

  environment_name               = var.environment
  private_subnet_cidrs           = var.private_subnet_cidrs
  database_publicly_accessible   = var.database_publicly_accessible
  log_encryption_kms_key_ref     = var.log_encryption_kms_key_ref
}

module "workbot_app" {
  source = "../../modules/workbot-app"

  image    = var.app_image
  replicas = var.app_replicas
}
