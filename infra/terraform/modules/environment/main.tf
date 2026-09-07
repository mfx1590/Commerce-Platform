# One complete environment: network, cluster, database, cache, buckets, image registry and the
# GitHub Actions deploy role.
#
# `envs/dev` and `envs/staging` are thin wrappers around this module with different sizes and
# safety flags. Keeping the wiring here — rather than copying it into each env — is what makes the
# two environments provably the same shape, and what makes "reproducible from an empty account"
# a single `terraform apply` rather than a checklist.
#
# Redpanda is NOT created here: the fixed decision is managed-first (Redpanda Cloud), so the
# cluster is provisioned in their console and only its connection details are passed in.

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

# ---------- inputs ----------

variable "name" {
  description = "Environment name. Prefixes every resource name (dev, staging)."
  type        = string
}

variable "base_domain" {
  description = "Public DNS zone, e.g. example.com. Service URLs are <service>.<name>.<base_domain>."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR."
  type        = string
  default     = "10.0.0.0/16"
}

variable "azs" {
  description = "Three availability zones."
  type        = list(string)
}

variable "single_nat_gateway" {
  description = "One NAT gateway (cheap, dev) or one per AZ (resilient, staging)."
  type        = bool
  default     = true
}

variable "kubernetes_version" {
  description = "EKS control plane version."
  type        = string
  default     = "1.31"
}

variable "node_instance_types" {
  description = "Managed node group instance types."
  type        = list(string)
  default     = ["t3.medium"]
}

variable "node_desired_size" {
  description = "Desired node count."
  type        = number
  default     = 2
}

variable "node_min_size" {
  description = "Minimum node count."
  type        = number
  default     = 2
}

variable "node_max_size" {
  description = "Maximum node count."
  type        = number
  default     = 4
}

variable "cluster_public_access_cidrs" {
  description = "CIDRs allowed to reach the Kubernetes API. Narrow this in staging."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "postgres_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "postgres_multi_az" {
  description = "Multi-AZ RDS."
  type        = bool
  default     = false
}

variable "postgres_backup_retention_period" {
  description = "Days of automated RDS backups."
  type        = number
  default     = 7
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_replica_count" {
  description = "Redis replicas. 0 in dev, 1+ in staging for automatic failover."
  type        = number
  default     = 0
}

variable "bucket_prefix" {
  description = "Globally unique S3 name prefix, usually the organisation slug."
  type        = string
}

variable "protect" {
  description = "true in staging: deletion protection on, no force-destroy of non-empty buckets."
  type        = bool
  default     = false
}

variable "github_repository" {
  description = "owner/repo allowed to assume the CI deploy role."
  type        = string
}

variable "create_github_oidc_provider" {
  description = "false for the second and later environments in the same AWS account — an account may only have one GitHub OIDC provider."
  type        = bool
  default     = true
}

variable "kafka_brokers" {
  description = "KAFKA_BROKERS — Redpanda Cloud bootstrap servers. Empty until the cluster exists."
  type        = string
  default     = ""
}

variable "schema_registry_url" {
  description = "Redpanda Cloud schema registry URL."
  type        = string
  default     = ""
}

variable "apps" {
  description = "Applications that get an ECR repository. Must match the images built by infra/docker/docker-compose.build.yml."
  type        = list(string)
  default = [
    "core",
    "admin",
    "storefront-starter",
    "accounting",
    "analytics-ingest",
    "notifications",
  ]
}

variable "tags" {
  description = "Extra tags merged into the defaults."
  type        = map(string)
  default     = {}
}

locals {
  tags = merge({
    Project     = "commerce-platform"
    Environment = var.name
    ManagedBy   = "terraform"
    Repository  = var.github_repository
  }, var.tags)

  host = "${var.name}.${var.base_domain}"

  # Public origins, per app. The storefront and admin are what a browser talks to; core is the API.
  storefront_origin = "https://shop.${var.name}.${var.base_domain}"
  admin_origin      = "https://admin.${var.name}.${var.base_domain}"
  core_origin       = "https://api.${var.name}.${var.base_domain}"
}

# ---------- composition ----------

module "network" {
  source = "../network"

  name               = var.name
  cidr_block         = var.vpc_cidr
  azs                = var.azs
  single_nat_gateway = var.single_nat_gateway
  tags               = local.tags
}

module "cluster" {
  source = "../cluster"

  name                = var.name
  kubernetes_version  = var.kubernetes_version
  subnet_ids          = module.network.private_subnet_ids
  node_instance_types = var.node_instance_types
  node_desired_size   = var.node_desired_size
  node_min_size       = var.node_min_size
  node_max_size       = var.node_max_size
  public_access_cidrs = var.cluster_public_access_cidrs
  tags                = local.tags
}

module "postgres" {
  source = "../postgres"

  name                       = var.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  ingress_security_group_ids = [module.cluster.cluster_security_group_id]
  instance_class             = var.postgres_instance_class
  multi_az                   = var.postgres_multi_az
  backup_retention_period    = var.postgres_backup_retention_period
  deletion_protection        = var.protect
  tags                       = local.tags
}

module "redis" {
  source = "../redis"

  name                       = var.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  ingress_security_group_ids = [module.cluster.cluster_security_group_id]
  node_type                  = var.redis_node_type
  replica_count              = var.redis_replica_count
  tags                       = local.tags
}

module "objects" {
  source = "../objects"

  name          = var.name
  bucket_prefix = var.bucket_prefix
  force_destroy = !var.protect
  tags          = local.tags
}

resource "aws_ecr_repository" "app" {
  for_each = toset(var.apps)

  name                 = "${var.name}/commerce-platform/${each.value}"
  image_tag_mutability = "IMMUTABLE" # a git sha tag must always mean the same image

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  force_delete = !var.protect
  tags         = local.tags
}

# Untagged layers pile up fast with a tag-per-commit scheme.
resource "aws_ecr_lifecycle_policy" "app" {
  for_each = aws_ecr_repository.app

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 50 most recent images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 50
        }
        action = { type = "expire" }
      },
    ]
  })
}

# Application secrets. .env.example carries obvious dev placeholders for these; in a real environment
# they must be generated and never typed by a human. apps/core's medusa-config.ts refuses to start in
# production without JWT_SECRET and COOKIE_SECRET, and apps/admin without ADMIN_SESSION_SECRET
# (which it requires to be at least 32 characters).
resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "random_password" "cookie_secret" {
  length  = 64
  special = false
}

resource "random_password" "admin_session_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name        = "${var.name}/platform/app"
  description = "Application secrets for ${var.name}"
  tags        = local.tags
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    JWT_SECRET           = random_password.jwt_secret.result
    COOKIE_SECRET        = random_password.cookie_secret.result
    ADMIN_SESSION_SECRET = random_password.admin_session_secret.result
  })
}

module "ci_oidc" {
  source = "../ci-oidc"

  name                 = var.name
  github_repository    = var.github_repository
  create_oidc_provider = var.create_github_oidc_provider
  ecr_repository_arns  = [for r in aws_ecr_repository.app : r.arn]
  eks_cluster_arn      = module.cluster.cluster_arn
  tags                 = local.tags
}
