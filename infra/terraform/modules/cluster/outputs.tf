output "cluster_name" {
  description = "EKS cluster name (also the ArgoCD destination name)."
  value       = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = aws_eks_cluster.this.endpoint
}

output "cluster_certificate_authority_data" {
  description = "Base64 CA bundle for the kubeconfig."
  value       = aws_eks_cluster.this.certificate_authority[0].data
}

output "cluster_security_group_id" {
  description = "Security group EKS created for the cluster; the RDS and Redis modules allow ingress from it."
  value       = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
}

output "oidc_provider_arn" {
  description = "IAM OIDC provider ARN, for IRSA trust policies (External Secrets, the load balancer controller, ...)."
  value       = aws_iam_openid_connect_provider.this.arn
}

output "oidc_provider_url" {
  description = "IAM OIDC provider URL without the scheme, as IRSA conditions expect it."
  value       = replace(aws_iam_openid_connect_provider.this.url, "https://", "")
}

output "cluster_arn" {
  description = "EKS cluster ARN, for the CI role's eks:DescribeCluster permission."
  value       = aws_eks_cluster.this.arn
}
