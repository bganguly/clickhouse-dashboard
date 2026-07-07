output "db_endpoint" {
  description = "RDS Postgres endpoint host"
  value       = aws_db_instance.pg.address
}

output "db_port" {
  description = "RDS Postgres port"
  value       = aws_db_instance.pg.port
}

output "db_name" {
  description = "Initial database name"
  value       = var.db_name
}

output "db_username" {
  description = "Master username"
  value       = var.db_username
}

output "db_password" {
  description = "Master password"
  value       = random_password.db_password.result
  sensitive   = true
}

output "ec2_public_ip" {
  description = "Stable (Elastic) public IP of the EC2 app server — does not change across instance stop/restart"
  value       = aws_eip.app.public_ip
}

output "cdn_url" {
  description = "HTTPS URL (CloudFront's own cert — no domain needed) for the dashboard"
  value       = "https://${aws_cloudfront_distribution.app.domain_name}"
}

output "ec2_ssh_key_name" {
  description = "EC2 key pair name"
  value       = aws_key_pair.app.key_name
}

output "database_url" {
  description = "Ready-to-use connection string for Prisma + raw pg"
  value       = "postgresql://${var.db_username}:${random_password.db_password.result}@${aws_db_instance.pg.address}:${aws_db_instance.pg.port}/${var.db_name}?sslmode=require"
  sensitive   = true
}
