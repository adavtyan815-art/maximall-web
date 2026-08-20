#!/bin/bash
set -e
exec > /var/log/maximall-bootstrap.log 2>&1

echo "=== [0.5] Inject temporary SSH public key ==="
mkdir -p /home/ec2-user/.ssh
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOESF8hRzJxMQJuRWkwJu/kTsfLnQesvIMiZDLUlfnXQ admin@DESKTOP-V24EV6F" >> /home/ec2-user/.ssh/authorized_keys
chmod 700 /home/ec2-user/.ssh
chmod 600 /home/ec2-user/.ssh/authorized_keys
chown -R ec2-user:ec2-user /home/ec2-user/.ssh

echo "=== [1] dnf update ==="
dnf update -y


echo "=== [1.5] Setup 2GB Swap space ==="
dd if=/dev/zero of=/swapfile bs=1M count=2048
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo "/swapfile none swap sw 0 0" >> /etc/fstab
free -h


echo "=== [2] Install Docker + unzip ==="
dnf install -y docker unzip
systemctl enable docker
systemctl start docker

echo "=== [3] Docker Compose v2 ==="
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL "https://github.com/docker/compose/releases/download/v2.27.1/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

echo "=== [4] Download app from S3 ==="
curl -L -o /tmp/maximall-deploy.zip "https://maximall-web-deploy-tmp.s3.us-east-2.amazonaws.com/maximall-deploy.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA3262B7WJSPXE2EMY%2F20260626%2Fus-east-2%2Fs3%2Faws4_request&X-Amz-Date=20260626T082153Z&X-Amz-Expires=43200&X-Amz-SignedHeaders=host&X-Amz-Signature=cee6bc5c2e7bead7668fd8e78fc1ae9927d99f16be42d0f7556d6e621ca8fa13"
echo "Download complete"


echo "=== [5] Extract ==="
mkdir -p /opt/maximall-web
cd /opt/maximall-web
unzip -o /tmp/maximall-deploy.zip
rm -f /tmp/maximall-deploy.zip

echo "=== [6] Auto-inject public IP into .env ==="
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/public-ipv4")
echo "Detected public IP: $PUBLIC_IP"
sed -i "s|BASE_URL=http://REPLACE_WITH_EC2_IP|BASE_URL=http://$PUBLIC_IP|g" /opt/maximall-web/.env
grep BASE_URL /opt/maximall-web/.env

echo "=== [7] docker compose up ==="
cd /opt/maximall-web
docker compose up -d --build

echo "=== [8] Wait for healthy ==="
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -sf http://localhost/api/settings > /dev/null 2>&1; then
    echo "APP IS UP AND HEALTHY!"
    break
  fi
  echo "Attempt $i of 20 - sleeping 15s..."
  sleep 15
done

echo "=== [9] Systemd auto-restart service ==="
cat > /etc/systemd/system/maximall-web.service << 'UNIT'
[Unit]
Description=Maximall Web Orchestrator
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/maximall-web
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable maximall-web.service

echo "=== Bootstrap complete at $(date) ==="