variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for all resource names"
  type        = string
  default     = "ch-dash"
}

variable "clickhouse_url" {
  description = "ClickHouse HTTPS endpoint, e.g. https://host:8443"
  type        = string
  sensitive   = true
}

variable "clickhouse_password" {
  description = "ClickHouse default user password"
  type        = string
  sensitive   = true
}
