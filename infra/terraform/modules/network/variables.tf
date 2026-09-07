variable "name" {
  description = "Environment name, used as the prefix of every resource name (dev, staging)."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR. /16 gives room for 3 public + 3 private /20 subnets."
  type        = string
}

variable "azs" {
  description = "Availability zones to spread the subnets over. Three is the minimum for a highly available EKS control plane."
  type        = list(string)

  validation {
    condition     = length(var.azs) == 3
    error_message = "Exactly three availability zones are required."
  }
}

variable "single_nat_gateway" {
  description = "true in dev (one NAT gateway, ~35 USD/month), false in staging (one per AZ, no cross-AZ SPOF)."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
