###############################################################################
# workbot-app 输出
###############################################################################

output "deployment_name" {
  description = "Deployment 名（回滚命令 kubectl rollout undo deployment/<这个名字>）"
  value       = kubernetes_deployment.app.metadata[0].name
}

output "namespace" {
  description = "命名空间（回滚命令 -n 参数）"
  value       = kubernetes_namespace.app.metadata[0].name
}

output "service_cluster_ip" {
  description = "ClusterIP Service 地址（仅集群内可达，公网不可达 = GATE-1 应用层证据）"
  value       = kubernetes_service.app.spec[0].cluster_ip
}

output "active_image" {
  description = "当前部署的镜像版本（/api/health 的 release.image 与此一致）"
  value       = var.image
}
