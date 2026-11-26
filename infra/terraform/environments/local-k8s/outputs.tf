###############################################################################
# local-k8s 输出
###############################################################################

output "gate_report" {
  description = "三道闸过闸报告（审计留档）"
  value       = module.security_gates.gate_report
}

output "app_deployment" {
  description = "应用 Deployment（回滚命令：kubectl rollout undo deployment/<名> -n <命名空间>）"
  value       = module.workbot_app.deployment_name
}

output "app_namespace" {
  value = module.workbot_app.namespace
}

output "active_image" {
  description = "当前镜像版本（回滚后应变回上一版）"
  value       = module.workbot_app.active_image
}

output "service_cluster_ip" {
  description = "ClusterIP（仅集群内可达，公网不可达）"
  value       = module.workbot_app.service_cluster_ip
}
