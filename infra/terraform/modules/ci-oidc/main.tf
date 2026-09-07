# GitHub Actions → AWS with OIDC federation. No long-lived access keys anywhere.
#
# GitHub mints a short-lived OIDC token for a workflow run; the trust policy below only accepts
# tokens from this repository and only for the branches listed in `allowed_refs`. A leaked token is
# useless minutes later and cannot be replayed from another repo.
#
# The role deliberately cannot touch RDS, S3 data or secrets. CI's job is: push an image to ECR and
# bump a tag. Everything else in the cluster is ArgoCD's business.

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

variable "github_repository" {
  description = "owner/repo that may assume the role."
  type        = string
}

variable "allowed_refs" {
  description = "Git refs allowed to assume the role. Keep this to main; PR builds do not deploy."
  type        = list(string)
  default     = ["refs/heads/main"]
}

variable "create_oidc_provider" {
  description = "false if the account already has the GitHub OIDC provider (only one per account is allowed)."
  type        = bool
  default     = true
}

variable "ecr_repository_arns" {
  description = "ECR repositories the role may push to."
  type        = list(string)
  default     = []
}

variable "eks_cluster_arn" {
  description = "EKS cluster the role may describe, so the workflow can build a kubeconfig."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}

data "aws_partition" "current" {}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS verifies GitHub's certificate chain itself for this provider; the thumbprint is kept for
  # older API compatibility and is not the security boundary.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = var.tags
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
  subjects     = [for ref in var.allowed_refs : "repo:${var.github_repository}:ref:${ref}"]
}

resource "aws_iam_role" "ci" {
  name        = "${var.name}-github-actions"
  description = "GitHub Actions deploy role for ${var.github_repository} (${var.name})"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = local.subjects
        }
      }
    }]
  })

  max_session_duration = 3600
  tags                 = var.tags
}

data "aws_iam_policy_document" "ci" {
  # Authenticating to ECR is account-wide by design; the push itself is scoped below.
  statement {
    sid       = "EcrLogin"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = length(var.ecr_repository_arns) > 0 ? [1] : []

    content {
      sid    = "EcrPush"
      effect = "Allow"
      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:CompleteLayerUpload",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ]
      resources = var.ecr_repository_arns
    }
  }

  dynamic "statement" {
    for_each = var.eks_cluster_arn != "" ? [1] : []

    content {
      sid       = "EksDescribe"
      effect    = "Allow"
      actions   = ["eks:DescribeCluster"]
      resources = [var.eks_cluster_arn]
    }
  }
}

resource "aws_iam_role_policy" "ci" {
  name   = "${var.name}-github-actions"
  role   = aws_iam_role.ci.id
  policy = data.aws_iam_policy_document.ci.json
}

output "role_arn" {
  description = "Set this as the AWS_ROLE_ARN repository variable; the workflow assumes it with OIDC."
  value       = aws_iam_role.ci.arn
}

output "oidc_provider_arn" {
  description = "GitHub OIDC provider ARN in this account."
  value       = local.provider_arn
}

output "partition" {
  description = "AWS partition, exposed so callers can build ARNs without a second data source."
  value       = data.aws_partition.current.partition
}
