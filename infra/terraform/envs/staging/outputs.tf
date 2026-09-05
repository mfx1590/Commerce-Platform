# Pass-through of the environment module. Names match .env.example — see
# infra/terraform/modules/environment/outputs.tf for why.

output "DATABASE_URL" {
  description = "Owner role connection string (migrations only)."
  value       = module.environment.DATABASE_URL
  sensitive   = true
}

output "DATABASE_URL_APP" {
  description = "Application role connection string, subject to RLS."
  value       = module.environment.DATABASE_URL_APP
  sensitive   = true
}

output "REDIS_URL" {
  description = "Redis connection string."
  value       = module.environment.REDIS_URL
  sensitive   = true
}

output "KAFKA_BROKERS" {
  description = "Redpanda Cloud bootstrap servers."
  value       = module.environment.KAFKA_BROKERS
}

output "KEYCLOAK_URL" {
  description = "Keycloak base URL."
  value       = module.environment.KEYCLOAK_URL
}

output "OPENFGA_API_URL" {
  description = "OpenFGA base URL."
  value       = module.environment.OPENFGA_API_URL
}

output "MOCK_API_URL" {
  description = "Prism Store API mock URL."
  value       = module.environment.MOCK_API_URL
}

output "MOCK_ADMIN_API_URL" {
  description = "Prism Admin API mock URL."
  value       = module.environment.MOCK_ADMIN_API_URL
}

output "DATABASE_URL_MEDUSA_OWNER" {
  description = "Medusa migration role connection string."
  value       = module.environment.DATABASE_URL_MEDUSA_OWNER
  sensitive   = true
}

output "app_secret_arn" {
  description = "Secrets Manager ARN holding JWT_SECRET, COOKIE_SECRET and ADMIN_SESSION_SECRET."
  value       = module.environment.app_secret_arn
}

output "cluster_name" {
  description = "EKS cluster name."
  value       = module.environment.cluster_name
}

output "ci_role_arn" {
  description = "GitHub Actions deploy role ARN."
  value       = module.environment.ci_role_arn
}

output "ecr_repository_urls" {
  description = "app name -> ECR repository URL."
  value       = module.environment.ecr_repository_urls
}

output "oidc_provider_arn" {
  description = "IRSA provider ARN."
  value       = module.environment.oidc_provider_arn
}

output "database_secret_arns" {
  description = "Secrets Manager ARNs for the database roles."
  value       = module.environment.database_secret_arns
}

output "redis_secret_arn" {
  description = "Secrets Manager ARN for Redis."
  value       = module.environment.redis_secret_arn
}

output "bootstrap_db_env" {
  description = "Inputs for the infra/kubernetes/bootstrap-db Job."
  value       = module.environment.bootstrap_db_env
}

output "dotenv" {
  description = "Whole environment as a .env file. Contains secrets; never commit the result."
  value       = module.environment.dotenv
  sensitive   = true
}
