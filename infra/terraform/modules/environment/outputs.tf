# Outputs are named after the variables in .env.example, so the same application configuration
# works locally and in the cloud and nobody has to translate between two vocabularies.
#
#   cd infra/terraform/envs/dev
#   terraform output -raw dotenv > /tmp/dev.env      # never commit this file
#
# The URL outputs carry passwords and are marked sensitive; Terraform refuses to print them without
# `-raw`, and CI never runs `terraform output`.

output "DATABASE_URL" {
  description = "Owner role. Migrations only — applications use DATABASE_URL_APP."
  value       = module.postgres.database_url
  sensitive   = true
}

output "DATABASE_URL_APP" {
  description = "Application role, subject to RLS. Valid once the bootstrap job has created it."
  value       = module.postgres.database_url_app
  sensitive   = true
}

output "REDIS_URL" {
  description = "rediss:// — transit encryption is enabled on the replication group."
  value       = module.redis.redis_url
  sensitive   = true
}

output "KAFKA_BROKERS" {
  description = "Redpanda Cloud bootstrap servers, passed in as a variable (managed-first decision)."
  value       = var.kafka_brokers
}

output "SCHEMA_REGISTRY_URL" {
  description = "Redpanda Cloud schema registry."
  value       = var.schema_registry_url
}

output "KEYCLOAK_URL" {
  description = "Keycloak ingress hostname. The deployment itself is a Helm release (task 2.3)."
  value       = "https://auth.${local.host}"
}

output "KEYCLOAK_REALM_STAFF" {
  description = "Staff realm name — identical in every environment."
  value       = "staff"
}

output "KEYCLOAK_REALM_CUSTOMERS" {
  description = "Customer realm name — identical in every environment."
  value       = "customers"
}

output "OPENFGA_API_URL" {
  description = "OpenFGA ingress hostname."
  value       = "https://openfga.${local.host}"
}

output "MOCK_API_URL" {
  description = "Prism Store API mock, deployed to the cluster for contract testing against a real ingress."
  value       = "https://mock-store.${local.host}"
}

output "MOCK_ADMIN_API_URL" {
  description = "Prism Admin API mock."
  value       = "https://mock-admin.${local.host}"
}

output "DATABASE_URL_MEDUSA_OWNER" {
  description = "Medusa's migration role. Only scripts/db-medusa-migrate.ts uses it; never the runtime connection."
  value       = module.postgres.database_url_medusa_owner
  sensitive   = true
}

output "MEDUSA_DB_SCHEMA" {
  description = "Schema Medusa's own tables live in. Constant across environments."
  value       = "medusa"
}

output "JWT_SECRET" {
  description = "Generated, not typed. apps/core refuses to start in production without it."
  value       = random_password.jwt_secret.result
  sensitive   = true
}

output "COOKIE_SECRET" {
  description = "Generated, not typed."
  value       = random_password.cookie_secret.result
  sensitive   = true
}

output "ADMIN_SESSION_SECRET" {
  description = "Generated, not typed. apps/admin requires at least 32 characters."
  value       = random_password.admin_session_secret.result
  sensitive   = true
}

output "app_secret_arn" {
  description = "Secrets Manager ARN holding the three application secrets above."
  value       = aws_secretsmanager_secret.app.arn
}

output "STORE_API_URL" {
  description = "Store API base URL — the core app's public origin."
  value       = local.core_origin
}

output "ADMIN_API_URL" {
  description = "Admin API base URL — the same core app."
  value       = local.core_origin
}

output "STORE_CORS" {
  description = "Origins allowed on the Store API."
  value       = local.storefront_origin
}

output "ADMIN_CORS" {
  description = "Origins allowed on the Admin API."
  value       = local.admin_origin
}

output "AUTH_CORS" {
  description = "Origins allowed on the auth routes."
  value       = "${local.storefront_origin},${local.admin_origin}"
}

output "S3_MEDIA_BUCKET" {
  description = "Product media bucket."
  value       = module.objects.media_bucket
}

output "S3_BACKUP_BUCKET" {
  description = "Backups bucket."
  value       = module.objects.backups_bucket
}

# ---------- everything else the runbooks and later tasks need ----------

output "cluster_name" {
  description = "EKS cluster name. `aws eks update-kubeconfig --name <this>`."
  value       = module.cluster.cluster_name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = module.cluster.cluster_endpoint
}

output "oidc_provider_arn" {
  description = "IRSA provider ARN — External Secrets and the load balancer controller need it."
  value       = module.cluster.oidc_provider_arn
}

output "oidc_provider_url" {
  description = "IRSA provider URL without the scheme, for trust-policy conditions."
  value       = module.cluster.oidc_provider_url
}

output "vpc_id" {
  description = "VPC id."
  value       = module.network.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnet ids."
  value       = module.network.private_subnet_ids
}

output "ci_role_arn" {
  description = "Set as the AWS_ROLE_ARN repository variable; deploy-staging.yml assumes it with OIDC (task 2.4)."
  value       = module.ci_oidc.role_arn
}

output "ecr_repository_urls" {
  description = "app name -> ECR repository URL. The image tag is the git sha."
  value       = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}

output "database_secret_arns" {
  description = "Secrets Manager ARNs for the database roles; consumed by External Secrets in task 2.6."
  value = {
    owner = module.postgres.owner_secret_arn
    app   = module.postgres.app_secret_arn
  }
}

output "redis_secret_arn" {
  description = "Secrets Manager ARN for the Redis auth token and URL."
  value       = module.redis.secret_arn
}

output "bootstrap_db_env" {
  description = "Values the infra/kubernetes/bootstrap-db Job needs in order to create the platform_app role."
  value = {
    host                    = module.postgres.address
    database                = "platform"
    app_username            = module.postgres.app_username
    medusa_owner_username   = module.postgres.medusa_owner_username
    owner_secret_arn        = module.postgres.owner_secret_arn
    app_secret_arn          = module.postgres.app_secret_arn
    medusa_owner_secret_arn = module.postgres.medusa_owner_secret_arn
  }
}

output "dotenv" {
  description = "The whole environment as a .env file. `terraform output -raw dotenv > .env` — never commit the result."
  sensitive   = true
  value       = <<-ENV
    # Generated by terraform output -raw dotenv (${var.name}). Contains secrets — do not commit.
    DATABASE_URL=${module.postgres.database_url}
    DATABASE_URL_APP=${module.postgres.database_url_app}
    REDIS_URL=${module.redis.redis_url}
    DATABASE_URL_MEDUSA_OWNER=${module.postgres.database_url_medusa_owner}
    MEDUSA_DB_SCHEMA=medusa
    KAFKA_BROKERS=${var.kafka_brokers}
    KEYCLOAK_URL=https://auth.${local.host}
    KEYCLOAK_REALM_STAFF=staff
    KEYCLOAK_REALM_CUSTOMERS=customers
    OPENFGA_API_URL=https://openfga.${local.host}
    OPENFGA_STORE_ID=
    MOCK_API_URL=https://mock-store.${local.host}
    MOCK_ADMIN_API_URL=https://mock-admin.${local.host}
    S3_MEDIA_BUCKET=${module.objects.media_bucket}
    S3_BACKUP_BUCKET=${module.objects.backups_bucket}
    JWT_SECRET=${random_password.jwt_secret.result}
    COOKIE_SECRET=${random_password.cookie_secret.result}
    ADMIN_SESSION_SECRET=${random_password.admin_session_secret.result}
    STORE_API_URL=${local.core_origin}
    ADMIN_API_URL=${local.core_origin}
    STORE_CORS=${local.storefront_origin}
    ADMIN_CORS=${local.admin_origin}
    AUTH_CORS=${local.storefront_origin},${local.admin_origin}
    # Deliberately NOT set here, and they must not be:
    #   CORE_DEV_TOKENS         local-development bypass; setting it in a cloud environment is a security hole
    #   CORE_ORGANIZATION_ID    seeded application data, not infrastructure
    #   STORE_PUBLISHABLE_KEY   per-store key, created by the registry module at runtime
    #   PORT                    set per container image, not per environment
  ENV
}
