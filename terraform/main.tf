terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region     = var.aws_region
  access_key = var.aws_access_key
  secret_key = var.aws_secret_key
}

# ─── Reuse the existing "PixelStreaming" security group ─────────────────────────
# (already has ports 80, 443, 22, 3000, and all pixel streaming ports open)
data "aws_security_group" "pixel_streaming_sg" {
  id = var.security_group_id
}

# ─── EC2 Instance ──────────────────────────────────────────────────────────────
resource "aws_instance" "maximall_web" {
  ami                         = var.ami_id
  instance_type               = "t3.micro"
  key_name                    = var.key_pair_name
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [data.aws_security_group.pixel_streaming_sg.id]
  associate_public_ip_address = true

  root_block_device {
    volume_size           = 20   # GB — enough for Docker images + logs
    volume_type           = "gp3"
    delete_on_termination = true
  }

  # ── Bootstrap script: installs Docker + Docker Compose on first boot ──────────
  user_data = <<-EOF
    #!/bin/bash
    set -e
    exec > /var/log/maximall-bootstrap.log 2>&1

    echo "=== [1/5] Updating system packages ==="
    dnf update -y

    echo "=== [2/5] Installing Docker and dependencies ==="
    dnf install -y docker git unzip
    systemctl enable docker
    systemctl start docker

    echo "=== [3/5] Installing Docker Compose v2 plugin ==="
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -SL "https://github.com/docker/compose/releases/download/v2.27.1/docker-compose-linux-x86_64" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

    echo "=== [4/5] Creating app directory ==="
    mkdir -p /opt/maximall-web

    echo "=== [5/5] Creating systemd service for auto-restart on reboot ==="
    cat > /etc/systemd/system/maximall-web.service << 'UNIT'
[Unit]
Description=Maximall Web Orchestrator (Docker Compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/maximall-web
ExecStart=/usr/bin/docker compose up -d --build
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
UNIT

    systemctl daemon-reload
    systemctl enable maximall-web.service

    echo "=== Bootstrap complete at $(date) ==="
  EOF

  tags = {
    Name    = "maximall-web"
    Project = "maximall-web"
    Role    = "orchestrator"
  }
}

# ─── Elastic IP (static public IP — survives stop/start) ──────────────────────
resource "aws_eip" "maximall_web_eip" {
  instance = aws_instance.maximall_web.id
  domain   = "vpc"

  tags = {
    Name    = "maximall-web-eip"
    Project = "maximall-web"
  }
}
