# staging environment.
#
#   terraform init -backend-config=backend.hcl
#   terraform plan  -var-file=terraform.tfvars
#   terraform apply -var-file=terraform.tfvars
#
# Same shape as dev — both are thin wrappers around modules/environment — but sized and protected
# like production: a NAT gateway per AZ, Multi-AZ Postgres with 14 days of backups, a Redis replica
# for automatic failover, deletion protection on, and no force-destroy of non-empty buckets.
#
# If this environment is created in the same AWS account as dev, leave create_github_oidc_provider
# false: an account may hold only one GitHub OIDC provider and dev already created it.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "commerce-platform"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

module "environment" {
  source = "../../modules/environment"

  name        = "staging"
  base_domain = var.base_domain
  azs         = var.azs

  vpc_cidr           = "10.20.0.0/16"
  single_nat_gateway = false

  node_instance_types         = ["t3.large"]
  node_desired_size           = 3
  node_min_size               = 3
  node_max_size               = 8
  cluster_public_access_cidrs = var.cluster_public_access_cidrs

  postgres_instance_class          = "db.t4g.small"
  postgres_multi_az                = true
  postgres_backup_retention_period = 14

  redis_node_type     = "cache.t4g.small"
  redis_replica_count = 1

  bucket_prefix = var.bucket_prefix
  protect       = true

  github_repository           = var.github_repository
  create_github_oidc_provider = var.create_github_oidc_provider

  kafka_brokers       = var.kafka_brokers
  schema_registry_url = var.schema_registry_url
}
