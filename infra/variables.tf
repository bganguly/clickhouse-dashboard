variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
  default     = "dash-test"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC created for the test DB"
  type        = string
  default     = "10.42.0.0/16"
}

variable "engine_version" {
  description = "PostgreSQL major version (RDS resolves the latest supported minor)"
  type        = string
  default     = "16"
}

variable "db_name" {
  description = "Initial database name"
  type        = string
  default     = "app"
}

variable "db_username" {
  description = "Master username (avoid reserved words like 'admin')"
  type        = string
  default     = "appuser"
}

variable "instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.m5.xlarge"
}

variable "allocated_storage" {
  description = "RDS allocated storage in GB"
  type        = number
  default     = 100
}

variable "allowed_cidr" {
  description = "CIDR allowed to connect to Postgres on 5432 (set by infra-up.sh to your IP/32)"
  type        = string
  default     = "0.0.0.0/0"
}

variable "ec2_instance_type" {
  description = "EC2 instance type for the app server"
  type        = string
  default     = "t3.small"
}

variable "ec2_root_volume_size" {
  description = "Root EBS volume size (GB) for the app server. The AMI's own default (2GB) is too small once nodejs/postgresql-client/awscli/rsync/nginx are dnf-installed alongside the app's node_modules/build output — that combination fills a 2GB disk with zero headroom for a subsequent npm install or next build."
  type        = number
  default     = 20
}

variable "ssh_public_key_path" {
  description = "Path to local SSH public key used for EC2 access"
  type        = string
  default     = "~/.ssh/id_rsa.pub"
}

variable "demo_snapshot_bucket" {
  description = "S3 bucket the app EC2 instance is allowed to write demo-data snapshots to (bake-demo-snapshot.sh)"
  type        = string
  default     = "bikram-nextjs-subsecond-fetch-with-websockets"
}
