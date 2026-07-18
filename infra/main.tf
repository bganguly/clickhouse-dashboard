data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ── ECR ────────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "app" {
  name                 = "${var.name_prefix}-app"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  tags                 = { Name = "${var.name_prefix}-app" }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 3 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 3 }
      action       = { type = "expire" }
    }]
  })
}

# ── CodeBuild: build Docker image and push to ECR ─────────────────────────────

resource "aws_s3_bucket" "codebuild_src" {
  bucket        = "${var.name_prefix}-codebuild-src"
  force_destroy = true
  tags          = { Name = "${var.name_prefix}-codebuild-src" }
}

resource "aws_iam_role" "codebuild" {
  name = "${var.name_prefix}-codebuild"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "codebuild" {
  name = "${var.name_prefix}-codebuild"
  role = aws_iam_role.codebuild.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = aws_ecr_repository.app.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${aws_s3_bucket.codebuild_src.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_codebuild_project" "app" {
  name         = "${var.name_prefix}-app"
  service_role = aws_iam_role.codebuild.arn

  artifacts { type = "NO_ARTIFACTS" }

  environment {
    type            = "LINUX_CONTAINER"
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    privileged_mode = true

    environment_variable { name = "ECR_REPO_URI",      value = aws_ecr_repository.app.repository_url }
    environment_variable { name = "AWS_DEFAULT_REGION", value = var.aws_region }
  }

  source {
    type      = "S3"
    location  = "${aws_s3_bucket.codebuild_src.bucket}/source.zip"
    buildspec = "buildspec.yml"
  }

  tags = { Name = "${var.name_prefix}-app" }
}

# ── App Runner: scale-to-zero, wake on first ping ─────────────────────────────

resource "aws_apprunner_auto_scaling_configuration_version" "app" {
  auto_scaling_configuration_name = "${var.name_prefix}-app"
  min_size                         = 0
  max_size                         = 2
  max_concurrency                  = 100
  tags                             = { Name = "${var.name_prefix}-app" }
}

resource "aws_iam_role" "apprunner_ecr" {
  name = "${var.name_prefix}-apprunner-ecr"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "build.apprunner.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr" {
  role       = aws_iam_role.apprunner_ecr.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

resource "aws_apprunner_service" "app" {
  service_name                   = "${var.name_prefix}-app"
  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.app.arn

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_ecr.arn
    }
    image_repository {
      image_identifier      = "${aws_ecr_repository.app.repository_url}:latest"
      image_repository_type = "ECR"
      image_configuration {
        port = "3000"
        runtime_environment_variables = {
          NODE_ENV            = "production"
          CLICKHOUSE_URL      = var.clickhouse_url
          CLICKHOUSE_USER     = "default"
          CLICKHOUSE_PASSWORD = var.clickhouse_password
        }
      }
    }
    auto_deployments_enabled = false
  }

  instance_configuration {
    cpu    = "1024"
    memory = "2048"
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  tags = { Name = "${var.name_prefix}-app" }

  depends_on = [aws_iam_role_policy_attachment.apprunner_ecr]
}

# ── S3 maintenance page (failover for true errors, not cold starts) ────────────

resource "aws_s3_bucket" "maintenance" {
  bucket = "${var.name_prefix}-maintenance"
  tags   = { Name = "${var.name_prefix}-maintenance" }
}

resource "aws_s3_bucket_public_access_block" "maintenance" {
  bucket                  = aws_s3_bucket.maintenance.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_website_configuration" "maintenance" {
  bucket = aws_s3_bucket.maintenance.id
  index_document { suffix = "index.html" }
  error_document { key    = "index.html" }
}

resource "aws_s3_bucket_policy" "maintenance" {
  bucket = aws_s3_bucket.maintenance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicRead"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject"]
      Resource  = "${aws_s3_bucket.maintenance.arn}/*"
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.maintenance]
}

resource "aws_s3_object" "maintenance_html" {
  bucket       = aws_s3_bucket.maintenance.id
  key          = "index.html"
  source       = "${path.module}/maintenance.html"
  content_type = "text/html"
  etag         = filemd5("${path.module}/maintenance.html")
}

# ── CloudFront: App Runner primary + S3 maintenance failover ──────────────────

resource "aws_cloudfront_distribution" "app" {
  enabled = true
  comment = "${var.name_prefix} dashboard"

  origin {
    domain_name = aws_apprunner_service.app.service_url
    origin_id   = "app-origin"
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
  }

  origin {
    domain_name = aws_s3_bucket_website_configuration.maintenance.website_endpoint
    origin_id   = "maintenance-origin"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin_group {
    origin_id = "app-with-maintenance"
    failover_criteria { status_codes = [502, 503, 504] }
    member { origin_id = "app-origin" }
    member { origin_id = "maintenance-origin" }
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "app-origin"
    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
    forwarded_values {
      query_string = true
      headers      = ["*"]
      cookies { forward = "all" }
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "app-with-maintenance"
    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
    forwarded_values {
      query_string = true
      headers      = ["*"]
      cookies { forward = "all" }
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "${var.name_prefix}-cdn" }
}
