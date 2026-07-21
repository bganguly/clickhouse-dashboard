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

variable "redis_url" {
  description = "Redis connection URL (rediss://default:TOKEN@host:6380). Leave empty to use in-process cache."
  type        = string
  sensitive   = true
  default     = ""
}
