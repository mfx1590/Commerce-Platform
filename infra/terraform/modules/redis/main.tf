# ElastiCache Redis 7 — sessions, carts and the job queue.
#
# Encryption in transit is on, which means REDIS_URL uses the `rediss://` scheme. An auth token is
# generated here and stored in Secrets Manager alongside the ready-made URL, so an application only
# ever needs the one variable it already knows from the local stack.

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
  }
}

variable "name" {
  description = "Environment name (dev, staging)."
  type        = string
}

variable "vpc_id" {
  description = "VPC the replication group lives in."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet ids for the cache subnet group."
  type        = list(string)
}

variable "ingress_security_group_ids" {
  description = "Security groups allowed to reach port 6379 — the EKS cluster security group."
  type        = list(string)
}

variable "node_type" {
  description = "Cache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "replica_count" {
  description = "Replicas per shard. 0 in dev, 1 in staging (automatic failover needs at least one)."
  type        = number
  default     = 0
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-redis"
  subnet_ids = var.subnet_ids
  tags       = var.tags
}

resource "aws_security_group" "this" {
  name        = "${var.name}-redis"
  description = "Redis access for the ${var.name} EKS cluster"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-redis" })
}

resource "aws_vpc_security_group_ingress_rule" "redis" {
  for_each = toset(var.ingress_security_group_ids)

  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = each.value
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "Redis from the cluster"
}

# ElastiCache auth tokens must be 16-128 printable characters and exclude '@', '"' and '/'.
resource "random_password" "auth" {
  length           = 48
  special          = true
  override_special = "!&#$^<>-"
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${var.name}-redis"
  description          = "Commerce platform ${var.name}"

  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.node_type
  parameter_group_name       = "default.redis7"
  port                       = 6379
  num_cache_clusters         = var.replica_count + 1
  automatic_failover_enabled = var.replica_count > 0
  multi_az_enabled           = var.replica_count > 0

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.this.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.auth.result

  maintenance_window       = "sun:05:00-sun:06:00"
  snapshot_retention_limit = 3
  snapshot_window          = "04:00-05:00"
  apply_immediately        = false

  tags = merge(var.tags, { Name = "${var.name}-redis" })
}

locals {
  redis_url = "rediss://:${urlencode(random_password.auth.result)}@${aws_elasticache_replication_group.this.primary_endpoint_address}:${aws_elasticache_replication_group.this.port}"
}

resource "aws_secretsmanager_secret" "this" {
  name        = "${var.name}/platform/redis"
  description = "Redis auth token and URL for ${var.name}"
  tags        = var.tags
}

resource "aws_secretsmanager_secret_version" "this" {
  secret_id = aws_secretsmanager_secret.this.id
  secret_string = jsonencode({
    host       = aws_elasticache_replication_group.this.primary_endpoint_address
    port       = aws_elasticache_replication_group.this.port
    auth_token = random_password.auth.result
    REDIS_URL  = local.redis_url
  })
}

output "primary_endpoint" {
  description = "Primary endpoint hostname."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "security_group_id" {
  description = "Security group in front of the replication group."
  value       = aws_security_group.this.id
}

output "redis_url" {
  description = "REDIS_URL — rediss:// because transit encryption is enabled."
  value       = local.redis_url
  sensitive   = true
}

output "secret_arn" {
  description = "Secrets Manager ARN holding the auth token and the URL."
  value       = aws_secretsmanager_secret.this.arn
}
