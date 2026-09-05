variable "name" {
  description = "Environment name (dev, staging)."
  type        = string
}

variable "vpc_id" {
  description = "VPC the instance lives in."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet ids for the DB subnet group."
  type        = list(string)
}

variable "ingress_security_group_ids" {
  description = "Security groups allowed to reach port 5432 — the EKS cluster security group, nothing else."
  type        = list(string)
}

variable "instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage" {
  description = "Initial storage in GB."
  type        = number
  default     = 20
}

variable "max_allocated_storage" {
  description = "Upper bound for storage autoscaling."
  type        = number
  default     = 100
}

variable "multi_az" {
  description = "false in dev, true in staging."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "false in dev so the environment can be torn down, true in staging."
  type        = bool
  default     = false
}

variable "backup_retention_period" {
  description = "Days of automated backups."
  type        = number
  default     = 7
}

variable "database_name" {
  description = "Initial database. Matches the local stack, so DATABASE_URL differs only in host."
  type        = string
  default     = "platform"
}

variable "owner_username" {
  description = "Master/owner role. Migrations run as this role; applications never do."
  type        = string
  default     = "platform"
}

variable "app_username" {
  description = "Application role, subject to RLS. Created by the bootstrap job, not by Terraform."
  type        = string
  default     = "platform_app"
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
