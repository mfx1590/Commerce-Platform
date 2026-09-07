# dev environment.
#
#   terraform init -backend-config=backend.hcl
#   terraform plan  -var-file=terraform.tfvars
#   terraform apply -var-file=terraform.tfvars
#
# CI only ever runs `terraform fmt -check` and `terraform init -backend=false && terraform validate`,
# which need no AWS account. See the runbook in infra/README.md.
#
# dev is optimised for cost, not resilience: one NAT gateway, single-AZ database, no Redis replica,
# nothing deletion-protected, so the whole environment can be destroyed and recreated at will.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # Partial configuration: the bucket and lock table are account-specific and are passed with
  # `-backend-config=backend.hcl` (see backend.hcl.example) so no account id lands in git.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "commerce-platform"
      Environment = "dev"
      ManagedBy   = "terraform"
    }
  }
}

module "environment" {
  source = "../../modules/environment"

  name        = "dev"
  base_domain = var.base_domain
  azs         = var.azs

  vpc_cidr           = "10.10.0.0/16"
  single_nat_gateway = true

  node_instance_types = ["t3.medium"]
  node_desired_size   = 2
  node_min_size       = 2
  node_max_size       = 4

  postgres_instance_class          = "db.t4g.micro"
  postgres_multi_az                = false
  postgres_backup_retention_period = 7

  redis_node_type     = "cache.t4g.micro"
  redis_replica_count = 0

  bucket_prefix = var.bucket_prefix
  protect       = false

  github_repository           = var.github_repository
  create_github_oidc_provider = var.create_github_oidc_provider

  kafka_brokers       = var.kafka_brokers
  schema_registry_url = var.schema_registry_url
}
