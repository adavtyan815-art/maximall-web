# Infrastructure & AMI Configuration

This document specifies the AWS credentials, environment variables, AMI configurations, and startup script expectations required to deploy and run the Maximall pixel streaming backend.

---

## 1. Environment Variables (`.env`)

Configure the following variables in the `.env` file at the root of the project:

```ini
PORT=3000                           # Port for the Express server (default: 3000)
NODE_ENV=development                # Environment mode (development / production)

# AWS Credentials and Region
AWS_ACCESS_KEY_ID=your_access_key       # AWS Access Key ID with EC2 access
AWS_SECRET_ACCESS_KEY=your_secret_key   # AWS Secret Access Key
AWS_REGION=eu-central-1                 # Target AWS region

# Default Network Settings (cloned dynamically from active instances, or falls back to these)
AWS_SECURITY_GROUP_ID=sg-01a080...      # Target Security Group ID for EC2 instances
AWS_SUBNET_ID=subnet-0f882b...          # Target Subnet ID (must assign public IPs)
DEFAULT_INSTANCE_TYPE=g4dn.2xlarge      # Default instance size (needs NVIDIA T4 GPU)

# Admin panel credentials
ADMIN_USERNAME=admin                    # Admin login username
ADMIN_PASSWORD_HASH=your_password       # Plain text (or hashed) password string
SESSION_SECRET=your_random_secret_here  # Secret used for signing cookie sessions

# Base URL (for redirect references and API endpoints)
BASE_URL=https://your-domain.ngrok-free.dev

# Timers settings
HEARTBEAT_TIMEOUT_MS=30000              # WebSocket heartbeat interval (30s)
GRACE_PERIOD_MS=60000                   # Session disconnect grace period (60s)
SESSION_CLEANUP_INTERVAL_MS=10000       # Session database cleanup interval (10s)
```

---

## 2. AWS IAM Permissions

The AWS credentials supplied must have an IAM policy granting the following permissions:

- **`ec2:RunInstances`**: Used to launch pre-warm and dynamic on-demand instances.
- **`ec2:StartInstances`**: Used to wake up claimed stopped buffer instances.
- **`ec2:StopInstances`**: Used to stop verified pre-warm instances.
- **`ec2:TerminateInstances`**: Used to terminate active user instances after checkout.
- **`ec2:DescribeInstances`**: Used for state monitoring, boot detection, and synchronization audits.
- **`ec2:DescribeImages`**: Used to dynamically query and search self-owned AMIs by name or tags.
- **`ec2:CreateTags`**: Used to apply metadata tags (`Name` and `Purpose`) during instance creation.
- **`ec2:AuthorizeSecurityGroupIngress`** *(Optional)*: Grants the orchestrator permission to automatically authorize required WebRTC UDP ports on the instance Security Group if enabled.

---

## 3. AMI & Instance Naming Conventions

The application discovers and manages EC2 instances dynamically based on Tags. Ensure the following tag schemas:

- **Instance Name Tag**: `Name=LinuxClient` (controlled by env `EC2_DISCOVERY_TAG`). All instances managed by the scaling service must carry this Name tag.
- **Purpose Tag**: `Purpose=Prewarm` (injected automatically when the backend creates an instance). Used to distinguish pre-warm/buffer pool instances from active on-demand instances.

---

## 4. AMI Boot & Setup Requirements

When the backend launches a pre-warm or dynamic instance from the AMI, it expects the system image to perform the following operations automatically on boot:

### A. Automatic Startup Routine
1. **Unreal Engine 5 (UE5) App**: The application must be configured to launch automatically on system startup (typically using a systemd service or `rc.local` script).
2. **Wilbur / Signaling Server**: Epic Games' signaling web server must boot automatically alongside the UE5 application.
3. **HTTP REST API Disabled**: The signaling server REST endpoints are disabled by default (the backend queries streamer list endpoints via WebSocket instead).

### B. Network exposing (Direct IP Reverse Proxy)
The legacy Pinggy/ngrok tunnel configurations have been **deprecated** in favor of direct connection routing via the orchestrator's Node.js reverse-proxy:

1. **Port Bindings**: The signaling server and player web server must listen directly on local **TCP Port 80** of the dynamic EC2 instance.
2. **Port Openings (AWS Security Group)**: You must ensure that the instance's Security Group allows:
   - Inbound **TCP Port 80**: (Proxied WebSockets signaling and HTTP player assets).
   - Inbound **UDP Port Range `49152-65535`**: (Direct WebRTC media/video stream).
3. **Automatic IP Discovery**: The orchestrator discovers the instance's public IP dynamically via the AWS EC2 API, completely eliminating the need for any dynamic tunnel reporting scripts.
