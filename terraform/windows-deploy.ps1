# windows-deploy.ps1
# Run after terraform apply to upload the app and start it on the EC2 instance.
# Uses AWS SSM (no .pem file needed).
#
# The server keeps its own /opt/maximall-web/.env (AWS keys, ADMIN_PASSWORD_HASH, SESSION_SECRET, AI_* settings) and its
# runtime data (data/: saves, AI ledger, dossiers, leads, logs). The local .env is NOT uploaded unless -IncludeEnv is
# passed, and the unpack step replaces only the code paths in the archive; it never wipes the directory.
param(
    [Parameter(Mandatory=$true)]
    [string]$InstanceId,

    [Parameter(Mandatory=$true)]
    [string]$PublicIp,

    # Upload the local .env too (first install on a fresh instance only): it OVERWRITES the server's .env.
    [switch]$IncludeEnv
)

$Region = "eu-central-1"

Write-Host "=== Uploading maximall-web to EC2 instance $InstanceId ($PublicIp) ===" -ForegroundColor Cyan

# Step 1: Create a zip of the project (excluding node_modules, .git, dist)
Write-Host "`n[1/4] Creating deployment archive..." -ForegroundColor Yellow
$ZipPath = "$env:TEMP\maximall-web-deploy.zip"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

# Files to include in the zip. data/catalog + contracts: the Dockerfile COPYs them (AI catalog index, JSON contracts).
$IncludeFiles = @(
    "src", "public", "Dockerfile", "docker-compose.yml",
    "nginx.conf", "package.json", "package-lock.json",
    "tsconfig.json", ".dockerignore", "data/catalog", "contracts"
)
if ($IncludeEnv) {
    Write-Host "  -IncludeEnv: the local .env will REPLACE /opt/maximall-web/.env on the server" -ForegroundColor Red
    $IncludeFiles += ".env"
}
# Local runtime data that must never be uploaded (local test saves, uploaded AR models)
$ExcludeDirs = @("src/data/saves", "public/ar/models")

# Remove old zip if exists
if (Test-Path $ZipPath) { Remove-Item $ZipPath }

Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($ZipPath, 'Create')

function Add-DirToZip {
    param($zip, $dir, $entryPrefix)
    Get-ChildItem -Path $dir -Recurse -File | ForEach-Object {
        $relativePath = $_.FullName.Substring($dir.Length + 1).Replace('\', '/')
        $entryName = if ($entryPrefix) { "$entryPrefix/$relativePath" } else { $relativePath }
        $skip = $false
        foreach ($ex in $ExcludeDirs) { if ($entryName.StartsWith("$ex/")) { $skip = $true } }
        if (-not $skip) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName) | Out-Null
        }
    }
}

foreach ($item in $IncludeFiles) {
    $itemPath = Join-Path $ProjectRoot $item
    if (Test-Path $itemPath -PathType Container) {
        Add-DirToZip $zip $itemPath $item
    } elseif (Test-Path $itemPath -PathType Leaf) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $itemPath, $item) | Out-Null
    }
}
$zip.Dispose()

$zipSize = [math]::Round((Get-Item $ZipPath).Length / 1MB, 2)
Write-Host "  Archive created: $ZipPath ($zipSize MB)" -ForegroundColor Green

# Step 2: Upload to S3 (temp bucket) OR use SSM Run Command to pull from GitHub
# Since we don't have GitHub, we upload to S3 then pull on the instance.
Write-Host "`n[2/4] Uploading to S3 for transfer..." -ForegroundColor Yellow
$BucketName = "maximall-web-deploy-$(Get-Date -Format 'yyyyMMddHHmm')"

aws s3 mb "s3://$BucketName" --region $Region
aws s3 cp $ZipPath "s3://$BucketName/maximall-web.zip" --region $Region
Write-Host "  Uploaded to s3://$BucketName/maximall-web.zip" -ForegroundColor Green

# Step 3: Run commands on the instance via SSM
Write-Host "`n[3/4] Running deployment commands on EC2 via SSM..." -ForegroundColor Yellow

$CommandScript = @"
#!/bin/bash
set -e
exec >> /var/log/maximall-deploy.log 2>&1

echo '--- Deploy started at '`$(date) ---'

# Wait for Docker to be ready
until systemctl is-active docker; do sleep 2; done

# Download app archive from S3
aws s3 cp s3://$BucketName/maximall-web.zip /tmp/maximall-web.zip --region $Region

# Extract to /opt/maximall-web WITHOUT wiping it: .env and data/ (saves, AI spend ledger, dossiers, leads, logs) stay.
# Only the code directories shipped in the archive are replaced as a whole; other files are overwritten in place.
mkdir -p /opt/maximall-web
cd /opt/maximall-web
rm -rf src contracts data/catalog
unzip -o /tmp/maximall-web.zip
mkdir -p data/saves data/runtime data/ai_logs data/ai_clips data/renders data/dossiers

if [ ! -f .env ]; then
  echo 'ERROR: /opt/maximall-web/.env is missing (first install: rerun with -IncludeEnv). Aborting before docker compose.'
  exit 1
fi

# Update BASE_URL in .env with real IP
sed -i 's|BASE_URL=http://REPLACE_WITH_EC2_IP|BASE_URL=http://$PublicIp|g' .env

# One-time migration: UE project saves used to live only inside the container (/app/dist/data/saves); docker-compose now
# mounts ./data/saves there. Copy them out of the running container before it is replaced (no-op when none / already done).
if [ -z "`$(ls -A data/saves 2>/dev/null)" ] && docker ps --format '{{.Names}}' | grep -qx pixel-connector; then
  docker cp pixel-connector:/app/dist/data/saves/. data/saves/ 2>/dev/null && echo "Copied existing saves out of the container: `$(ls data/saves | wc -l) file(s)" || true
fi

echo 'Building and starting Docker Compose...'
docker compose down --remove-orphans 2>/dev/null || true
docker compose up -d --build

echo 'Waiting for app health check...'
for i in `$(seq 1 30); do
  if curl -sf http://localhost/api/settings > /dev/null 2>&1; then
    echo 'App is UP!'
    break
  fi
  sleep 5
done

echo '--- Deploy finished at '`$(date) ---'
"@

$Response = aws ssm send-command `
    --region $Region `
    --instance-ids $InstanceId `
    --document-name "AWS-RunShellScript" `
    --parameters "commands=[$($CommandScript | ConvertTo-Json -Compress)]" `
    --output json | ConvertFrom-Json

$CommandId = $Response.Command.CommandId
Write-Host "  SSM Command ID: $CommandId" -ForegroundColor Green
Write-Host "  Waiting for deployment to complete (this takes 3-5 minutes for Docker build)..." -ForegroundColor Yellow

# Poll for completion
$MaxWait = 600  # 10 minutes
$Elapsed = 0
do {
    Start-Sleep -Seconds 15
    $Elapsed += 15
    $Status = (aws ssm get-command-invocation `
        --region $Region `
        --command-id $CommandId `
        --instance-id $InstanceId `
        --output json 2>$null | ConvertFrom-Json).StatusDetails
    Write-Host "  [$Elapsed s] Status: $Status"
} while ($Status -notin @("Success", "Failed", "TimedOut") -and $Elapsed -lt $MaxWait)

if ($Status -eq "Success") {
    Write-Host "`n[4/4] Cleanup — removing S3 bucket..." -ForegroundColor Yellow
    aws s3 rb "s3://$BucketName" --force --region $Region
    
    Write-Host "`n==================================================" -ForegroundColor Green
    Write-Host "  DEPLOYMENT SUCCESSFUL!" -ForegroundColor Green
    Write-Host "  App URL:   http://$PublicIp" -ForegroundColor Green
    Write-Host "  Admin URL: http://$PublicIp/login.html" -ForegroundColor Green
    Write-Host "==================================================" -ForegroundColor Green
} else {
    Write-Host "`nDeployment status: $Status — check /var/log/maximall-deploy.log on the server" -ForegroundColor Red
    aws s3 rb "s3://$BucketName" --force --region $Region 2>$null
}
