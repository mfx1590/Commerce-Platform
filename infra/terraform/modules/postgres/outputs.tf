output "endpoint" {
  description = "host:port of the instance."
  value       = aws_db_instance.this.endpoint
}

output "address" {
  description = "Hostname of the instance."
  value       = aws_db_instance.this.address
}

output "security_group_id" {
  description = "Security group in front of the instance."
  value       = aws_security_group.this.id
}

output "database_url" {
  description = "DATABASE_URL — owner role. Migrations only; applications must use database_url_app."
  value       = local.owner_url
  sensitive   = true
}

output "database_url_app" {
  description = "DATABASE_URL_APP — application role, subject to RLS. Valid once the bootstrap job has run."
  value       = local.app_url
  sensitive   = true
}

output "owner_secret_arn" {
  description = "Secrets Manager ARN of the owner credentials; what External Secrets reads (task 2.6)."
  value       = aws_secretsmanager_secret.owner.arn
}

output "app_secret_arn" {
  description = "Secrets Manager ARN of the application credentials."
  value       = aws_secretsmanager_secret.app.arn
}

output "app_username" {
  description = "Application role name, for the bootstrap job."
  value       = var.app_username
}
