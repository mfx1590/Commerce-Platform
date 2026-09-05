# S3 buckets: product media and database/system backups.
#
# Both are private. Media is served through a CDN with an origin access identity later (Phase 2,
# window 9 owns the media pipeline); nothing here is ever made public, because a public bucket is
# the single most common way a commerce platform leaks customer uploads.

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

variable "bucket_prefix" {
  description = "Globally unique prefix, usually the organisation slug. Bucket names are <prefix>-<name>-<purpose>."
  type        = string
}

variable "backup_retention_days" {
  description = "Days before a backup object is deleted. Keep well above the RDS retention period."
  type        = number
  default     = 90
}

variable "force_destroy" {
  description = "true in dev so `terraform destroy` can remove a non-empty bucket. Never true in staging."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}

locals {
  buckets = {
    media   = "${var.bucket_prefix}-${var.name}-media"
    backups = "${var.bucket_prefix}-${var.name}-backups"
  }
}

resource "aws_s3_bucket" "this" {
  for_each = local.buckets

  bucket        = each.value
  force_destroy = var.force_destroy
  tags          = merge(var.tags, { Name = each.value, Purpose = each.key })
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = aws_s3_bucket.this

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced" # ACLs off entirely
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Media: keep old versions for a month (an accidental overwrite is recoverable), and never let
# failed multipart uploads accumulate into a silent bill.
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.this["media"].id

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

# Backups: cheap storage after a week, gone after the retention period.
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.this["backups"].id

  rule {
    id     = "tier-and-expire"
    status = "Enabled"

    filter {}

    transition {
      days          = 7
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 30
      storage_class = "GLACIER_IR"
    }

    expiration {
      days = var.backup_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

output "media_bucket" {
  description = "Media bucket name (S3_MEDIA_BUCKET)."
  value       = aws_s3_bucket.this["media"].bucket
}

output "media_bucket_arn" {
  description = "Media bucket ARN, for the IRSA policy of whatever uploads to it."
  value       = aws_s3_bucket.this["media"].arn
}

output "backups_bucket" {
  description = "Backups bucket name (S3_BACKUP_BUCKET)."
  value       = aws_s3_bucket.this["backups"].bucket
}

output "backups_bucket_arn" {
  description = "Backups bucket ARN."
  value       = aws_s3_bucket.this["backups"].arn
}
