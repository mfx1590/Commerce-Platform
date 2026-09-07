variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-central-1"
}

variable "azs" {
  description = "Three availability zones in var.region."
  type        = list(string)
  default     = ["eu-central-1a", "eu-central-1b", "eu-central-1c"]
}

variable "base_domain" {
  description = "Public DNS zone. Service hostnames are <service>.staging.<base_domain>."
  type        = string
}

variable "bucket_prefix" {
  description = "Globally unique S3 name prefix (organisation slug). Buckets are <prefix>-staging-media / -backups."
  type        = string
}

variable "github_repository" {
  description = "owner/repo allowed to assume the CI deploy role."
  type        = string
  default     = "mfx1590/Commerce-Platform"
}

variable "create_github_oidc_provider" {
  description = "true for the first environment in an AWS account, false for every later one (one provider per account)."
  type        = bool
  default     = false
}

variable "kafka_brokers" {
  description = "Redpanda Cloud bootstrap servers. Empty until the cluster is created in their console."
  type        = string
  default     = ""
}

variable "schema_registry_url" {
  description = "Redpanda Cloud schema registry URL."
  type        = string
  default     = ""
}

variable "cluster_public_access_cidrs" {
  description = "CIDRs allowed to reach the staging Kubernetes API. Narrow this to the office/VPN ranges."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
