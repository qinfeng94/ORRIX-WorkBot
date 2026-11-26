###############################################################################
# workbot-app —— WorkBot 应用在 Kubernetes 上的统一部署模块
# 溯源：AGENTS.md 红区（无「AI 自动打款」类按钮；Kill Switch = 随时 kubectl rollout undo）
#      + 04 号文档权限边界（应用只读业务快照；数据库连接串只经 Secret 引用，模板零明文）。
#
# 无损设计两根支柱：
#   1) RollingUpdate max_unavailable=0 —— 旧 Pod 全部活着时才换新 Pod，滚动全程服务不断；
#   2) readiness/liveness 探针直连 /api/health —— 新版本「验活不过」就永远不接流量，
#      配合 Day 35 回滚脚本实现 90 秒内退回上一版镜像。
#
# 安全设计：数据库凭据不进 Terraform（严禁暴露密钥红线）——只引用集群里
#   事先建好的 Secret（名字由 database_url_secret_name 传入），值永远不落 .tf / .tfvars。
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

###############################################################################
# 变量
###############################################################################
variable "namespace" {
  description = "应用所在命名空间（本地/私有云 K8s 一律专用命名空间，不混部）"
  type        = string
  default     = "workbot"
}

variable "app_name" {
  description = "应用名（Deployment / Service 同名）"
  type        = string
  default     = "workbot-app"
}

variable "image" {
  description = "应用镜像（仓库:标签）。回滚 = 把它换回上一版标签再 apply，数据库永不重放历史"
  type        = string
}

variable "replicas" {
  description = "副本数（≥2 才谈得上无损滚动）"
  type        = number
  default     = 2

  validation {
    condition     = var.replicas >= 2
    error_message = "副本数至少 2：单副本谈不上无损回滚（滚动更新期间服务必须始终有活着的 Pod）。"
  }
}

variable "container_port" {
  description = "容器端口（Next.js 默认 3000）"
  type        = number
  default     = 3000
}

variable "health_path" {
  description = "验活探针路径（唯一真源 = /api/health 只读健康检查）"
  type        = string
  default     = "/api/health"

  validation {
    condition     = var.health_path == "/api/health"
    error_message = "探针必须指向 /api/health（Day 35 统一验活入口），禁止指到会写数据的接口。"
  }
}

variable "database_url_secret_name" {
  description = "集群内既有的数据库凭据 Secret 名（值由运维通道建，Terraform 只引用名字，零明文）"
  type        = string
  default     = "workbot-db-url"
}

###############################################################################
# 资源
###############################################################################
resource "kubernetes_namespace" "app" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/part-of" = "workbot"
    }
  }
}

resource "kubernetes_config_map" "app" {
  metadata {
    name      = "${var.app_name}-config"
    namespace = kubernetes_namespace.app.metadata[0].name
  }

  data = {
    NODE_ENV = "production"
  }
}

resource "kubernetes_deployment" "app" {
  metadata {
    name      = var.app_name
    namespace = kubernetes_namespace.app.metadata[0].name
    labels = {
      "app.kubernetes.io/name" = var.app_name
    }
  }

  spec {
    replicas = var.replicas

    selector {
      match_labels = {
        "app.kubernetes.io/name" = var.app_name
      }
    }

    # 无损回滚的关键开关：旧版本一个都不下线时，新版本才逐个上线
    strategy {
      type = "RollingUpdate"
      rolling_update {
        max_unavailable = "0"
        max_surge       = "1"
      }
    }

    template {
      metadata {
        labels = {
          "app.kubernetes.io/name" = var.app_name
        }
      }

      spec {
        container {
          name  = "workbot"
          image = var.image
          image_pull_policy = "IfNotPresent"

          # /api/health 会回报这个版本号，回滚验活时肉眼可见「版本真的退回去了」
          env {
            name  = "WORKBOT_IMAGE"
            value = var.image
          }

          port {
            container_port = var.container_port
          }

          env_from {
            config_map_ref {
              name = kubernetes_config_map.app.metadata[0].name
            }
          }

          # 数据库凭据：只引用运维通道预先建好的 Secret，Terraform 全程不碰值
          env_from {
            secret_ref {
              name = var.database_url_secret_name
            }
          }

          readiness_probe {
            http_get {
              path = var.health_path
              port = var.container_port
            }
            initial_delay_seconds = 3
            period_seconds        = 5
            failure_threshold     = 3
          }

          liveness_probe {
            http_get {
              path = var.health_path
              port = var.container_port
            }
            initial_delay_seconds = 10
            period_seconds        = 10
            failure_threshold     = 3
          }

          resources {
            limits = {
              cpu    = "500m"
              memory = "512Mi"
            }
            requests = {
              cpu    = "100m"
              memory = "128Mi"
            }
          }
        }
      }
    }
  }
}

# 仅 ClusterIP：集群内可达，公网天然摸不到（GATE-1 私有子网的应用层落点）
resource "kubernetes_service" "app" {
  metadata {
    name      = var.app_name
    namespace = kubernetes_namespace.app.metadata[0].name
  }

  spec {
    selector = {
      "app.kubernetes.io/name" = var.app_name
    }
    port {
      port        = 80
      target_port = var.container_port
    }
    type = "ClusterIP"
  }
}
