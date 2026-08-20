variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "eu-central-1"
}

variable "aws_access_key" {
  description = "AWS Access Key ID"
  type        = string
  sensitive   = true
}

variable "aws_secret_key" {
  description = "AWS Secret Access Key"
  type        = string
  sensitive   = true
}

variable "vpc_id" {
  description = "VPC ID — same VPC as pixel-connector"
  type        = string
  default     = "vpc-0f621ae5f57c2a743"
}

variable "subnet_id" {
  description = "Subnet ID — same subnet as pixel-connector (eu-central-1b)"
  type        = string
  default     = "subnet-0f882b9a8b9de5a9d"
}

variable "security_group_id" {
  description = "Existing PixelStreaming security group ID (ports 80, 22, 443 already open)"
  type        = string
  default     = "sg-0b4473181de272289"
}

variable "ami_id" {
  description = "Amazon Linux 2023 AMI for eu-central-1 (same as pixel-connector)"
  type        = string
  default     = "ami-0de6934e87badb694"
}

variable "key_pair_name" {
  description = "Name of the EC2 Key Pair for SSH access"
  type        = string
  default     = "Frankfurt"
}

variable "iam_instance_profile" {
  description = "IAM instance profile — same as pixel-connector (gives SSM + S3 access for deployment)"
  type        = string
  default     = "PixelStreamingEC2Role"
}
