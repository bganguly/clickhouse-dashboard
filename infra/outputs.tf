output "ec2_public_ip" {
  description = "Stable (Elastic) public IP of the EC2 app server"
  value       = aws_eip.app.public_ip
}

output "cdn_url" {
  description = "HTTPS URL via CloudFront"
  value       = "https://${aws_cloudfront_distribution.app.domain_name}"
}

output "ec2_ssh_key_name" {
  description = "EC2 key pair name"
  value       = aws_key_pair.app.key_name
}
