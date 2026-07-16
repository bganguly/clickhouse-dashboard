variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
  default     = "ch-dash"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.42.0.0/16"
}

variable "allowed_cidr" {
  description = "CIDR allowed SSH access to the app server"
  type        = string
  default     = "0.0.0.0/0"
}

variable "ec2_instance_type" {
  description = "EC2 instance type for the app server"
  type        = string
  default     = "t3.small"
}

variable "ec2_root_volume_size" {
  description = "Root EBS volume size (GB)"
  type        = number
  default     = 8
}

variable "ssh_public_key_path" {
  description = "Path to local SSH public key used for EC2 access"
  type        = string
  default     = "~/.ssh/id_rsa.pub"
}
