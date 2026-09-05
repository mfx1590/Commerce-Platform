# RDS Postgres 16.
#
# Two roles, exactly as in the local stack: `platform` owns the schema and runs migrations,
# `platform_app` is what the applications connect as and is subject to row level security.
# Terraform creates only the master role. `platform_app` is created by the bootstrap Job in
# infra/kubernetes/bootstrap-db, because a role created here would need its password in the state
# file and would drift the moment anyone ran a GRANT.
#
# Both passwords are generated in Terraform and stored in Secrets Manager. Neither is ever printed
# to a terminal, written to a tfvars file, or committed.

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

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-postgres"
  subnet_ids = var.subnet_ids
  tags       = merge(var.tags, { Name = "${var.name}-postgres" })
}

resource "aws_security_group" "this" {
  name        = "${var.name}-postgres"
  description = "Postgres access for the ${var.name} EKS cluster"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-postgres" })
}

resource "aws_vpc_security_group_ingress_rule" "postgres" {
  for_each = toset(var.ingress_security_group_ids)

  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from the cluster"
}

resource "aws_db_parameter_group" "this" {
  name        = "${var.name}-postgres16"
  family      = "postgres16"
  description = "Commerce platform ${var.name}"

  # TLS is not optional: the app role carries the tenant context and must not travel in clear text.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  # Anything slower than a second is a bug we want to see, not a mystery in a dashboard.
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  tags = var.tags
}

# RDS rejects a handful of punctuation characters in master passwords; dropping specials entirely
# keeps the generated connection URLs readable and avoids escaping bugs at 3am.
resource "random_password" "owner" {
  length  = 32
  special = false
}

resource "random_password" "app" {
  length  = 32
  special = false
}

# apps/core runs Medusa's migrations as a third role that owns schema `medusa` and has no rights on
# ours. Like platform_app it is created by the bootstrap Job, not here.
resource "random_password" "medusa_owner" {
  length  = 32
  special = false
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name}-postgres"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.instance_class

  db_name  = var.database_name
  username = var.owner_username
  password = random_password.owner.result
  port     = 5432

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false
  multi_az               = var.multi_az

  backup_retention_period    = var.backup_retention_period
  backup_window              = "02:00-03:00"
  maintenance_window         = "sun:03:30-sun:04:30"
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "${var.name}-postgres-final" : null

  performance_insights_enabled    = true
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = merge(var.tags, { Name = "${var.name}-postgres" })
}

locals {
  # sslmode=require is explicit in the URL because the parameter group refuses anything else.
  owner_url        = "postgres://${var.owner_username}:${urlencode(random_password.owner.result)}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${var.database_name}?sslmode=require"
  app_url          = "postgres://${var.app_username}:${urlencode(random_password.app.result)}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${var.database_name}?sslmode=require"
  medusa_owner_url = "postgres://${var.medusa_owner_username}:${urlencode(random_password.medusa_owner.result)}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${var.database_name}?sslmode=require"
}

# ---------- secrets ----------

resource "aws_secretsmanager_secret" "owner" {
  name        = "${var.name}/platform/database/owner"
  description = "Owner/migration role for ${var.name} Postgres"
  tags        = var.tags
}

resource "aws_secretsmanager_secret_version" "owner" {
  secret_id = aws_secretsmanager_secret.owner.id
  secret_string = jsonencode({
    username     = var.owner_username
    password     = random_password.owner.result
    host         = aws_db_instance.this.address
    port         = aws_db_instance.this.port
    database     = var.database_name
    DATABASE_URL = local.owner_url
  })
}

resource "aws_secretsmanager_secret" "medusa_owner" {
  name        = "${var.name}/platform/database/medusa-owner"
  description = "Medusa migration role for ${var.name} Postgres (created by the bootstrap job)"
  tags        = var.tags
}

resource "aws_secretsmanager_secret_version" "medusa_owner" {
  secret_id = aws_secretsmanager_secret.medusa_owner.id
  secret_string = jsonencode({
    username                  = var.medusa_owner_username
    password                  = random_password.medusa_owner.result
    host                      = aws_db_instance.this.address
    port                      = aws_db_instance.this.port
    database                  = var.database_name
    DATABASE_URL_MEDUSA_OWNER = local.medusa_owner_url
  })
}

resource "aws_secretsmanager_secret" "app" {
  name        = "${var.name}/platform/database/app"
  description = "Application role for ${var.name} Postgres (created by the bootstrap job)"
  tags        = var.tags
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    username         = var.app_username
    password         = random_password.app.result
    host             = aws_db_instance.this.address
    port             = aws_db_instance.this.port
    database         = var.database_name
    DATABASE_URL_APP = local.app_url
  })
}
