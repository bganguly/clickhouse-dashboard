output "ecr_repository_url" {
  description = "ECR repository URL for the app image"
  value       = aws_ecr_repository.app.repository_url
}


output "apprunner_service_arn" {
  description = "App Runner service ARN"
  value       = aws_apprunner_service.app.arn
}

output "apprunner_service_url" {
  description = "App Runner service hostname"
  value       = aws_apprunner_service.app.service_url
}

output "cdn_url" {
  description = "HTTPS URL via CloudFront"
  value       = "https://${aws_cloudfront_distribution.app.domain_name}"
}
