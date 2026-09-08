# IRSA for External Secrets Operator, and nothing else.
#
# The operator itself is a Helm release installed by the bootstrap runbook, not by Terraform: it is
# a cluster add-on with CRDs, and Terraform holding Kubernetes objects means every `plan` needs
# cluster credentials. What Terraform does own is the part only AWS can grant — the IAM role the
# operator assumes, scoped to this environment's secrets and no further.
#
# The blast radius is the point. This role can read `<env>/platform/*` and `<env>/stores/*`; it
# cannot read another environment's secrets, cannot write, and cannot delete. An operator that can
# write is an operator that can silently replace a credential nobody chose.

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

variable "name" {
  description = "Environment name (dev, staging)."
  type        = string
}

variable "oidc_provider_arn" {
  description = "IRSA provider ARN from the cluster module."
  type        = string
}

variable "oidc_provider_url" {
  description = "IRSA provider URL without the scheme."
  type        = string
}

variable "namespace" {
  description = "Namespace the operator runs in."
  type        = string
  default     = "external-secrets"
}

variable "service_account" {
  description = "Service account the operator runs as."
  type        = string
  default     = "external-secrets"
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  secret_prefixes = [
    # Platform-wide credentials: the database roles, Redis, the application secrets.
    "arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:${var.name}/platform/*",
    # Per-store credentials: PSP and carrier keys, one path per store. See the naming scheme in
    # infra/README.md — the wildcard is what lets a new store be onboarded without a Terraform run.
    "arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:${var.name}/stores/*",
  ]
}

resource "aws_iam_role" "this" {
  name        = "${var.name}-external-secrets"
  description = "External Secrets Operator in ${var.name}: read-only on this environment's secrets"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = var.oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          # Bound to one service account in one namespace. Without the `sub` condition any pod in
          # the cluster could assume this role.
          "${var.oidc_provider_url}:sub" = "system:serviceaccount:${var.namespace}:${var.service_account}"
          "${var.oidc_provider_url}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })

  tags = var.tags
}

data "aws_iam_policy_document" "this" {
  statement {
    sid    = "ReadThisEnvironmentsSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = local.secret_prefixes
  }

  # ListSecretVersionIds is account-wide in the API but harmless: it returns version ids, not values.
  statement {
    sid       = "ListVersions"
    effect    = "Allow"
    actions   = ["secretsmanager:ListSecrets"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "${var.name}-external-secrets"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.this.json
}

output "role_arn" {
  description = "Annotate the operator's service account with this: eks.amazonaws.com/role-arn."
  value       = aws_iam_role.this.arn
}

output "secret_prefixes" {
  description = "The only Secrets Manager paths this role can read."
  value       = local.secret_prefixes
}
