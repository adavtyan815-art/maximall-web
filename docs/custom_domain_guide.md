# Custom Domain & SSL Integration Guide

This document outlines the step-by-step procedure and technical requirements for binding a custom domain or subdomain (e.g., `live.yourdomain.com`) to the MaxiMall PixelStreaming backend. 

---

## 1. Domain & DNS Requirements
Before altering any configuration files on the server, configure your domain's DNS records.

* **DNS Record Type:** `A` Record
* **Host/Name:** The subdomain name (e.g., `live` or `@` for root domain).
* **Value/Target:** The server's public IP address: **`18.185.5.251`**
* **TTL:** `300 seconds` (recommended for fast propagation during test switches).

> [!NOTE]
> Ensure the DNS record is fully propagated globally before running Certbot. You can verify propagation using:
> `nslookup live.yourdomain.com`

---

## 2. Server Firewall & Port Requirements (AWS Security Group)
The custom domain connection relies on Nginx reverse proxying traffic. Ensure the following ports remain open on the host server's security group:

* **Port 80 (HTTP):** Used for initial user redirection and the Let's Encrypt validation challenge.
* **Port 443 (HTTPS):** Used for secure user connections (dashboard, landing page, and WebSocket control channels).

---

## 3. Step-by-Step Transition Protocol

Follow this exact sequence to bind the domain without breaking the pre-warm or streaming lifecycles:

### Step A: Update Environment Variables (`.env`)
1. Open `/opt/maximall-web/.env` on the server.
2. Update the `BASE_URL` value from the temporary `nip.io` domain to your new secure custom domain:
   ```ini
   BASE_URL=https://live.yourdomain.com
   ```

### Step B: Temporarily Stop the Stack
To free up port 80 for the Certbot standalone challenge:
```bash
cd /opt/maximall-web
sudo docker compose down
```

### Step C: Generate Let's Encrypt SSL Certificate
Run Certbot on the host server to issue a certificate for your custom domain:
```bash
sudo certbot certonly --standalone \
  -d live.yourdomain.com \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email
```

> [!IMPORTANT]
> The generated certificate files will be stored in:
> * Certificate: `/etc/letsencrypt/live/live.yourdomain.com/fullchain.pem`
> * Private Key: `/etc/letsencrypt/live/live.yourdomain.com/privkey.pem`
> Do not move or rename these directories; they are mounted dynamically by Docker.

### Step D: Update Nginx Configuration (`nginx.conf`)
Open `/opt/maximall-web/nginx.conf` and update the `server_name` and certificate paths to match your custom domain:

```nginx
server {
    listen 80 default_server;
    server_name _;

    # CRITICAL: Preserve HTTP bypass for EC2 instance report-tunnel callbacks
    location ~ ^/api/instances/ {
        proxy_pass http://app:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Redirect all other HTTP traffic to the secure custom domain
    location / {
        return 301 https://live.yourdomain.com$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name live.yourdomain.com;

    # Point to the custom domain certificates
    ssl_certificate /etc/letsencrypt/live/live.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/live.yourdomain.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://app:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
```

### Step E: Restart the Stack
Restart the Docker containers to apply the Nginx and `.env` updates:
```bash
sudo docker compose up -d --build
```

---

## 4. Why We Must Maintain the HTTP Bypass
> [!WARNING]
> Do not remove the `location ~ ^/api/instances/` block from the port 80 server block.
> 
> **Reason:** The EC2 instances launched from your AMI are pre-programmed to report their active Pinggy tunnel URLs to the backend via raw HTTP on the server's public IP (`http://18.185.5.251/api/instances/...`). 
> If you force a 301 HTTPS redirect on this path, the curl client inside the EC2 boot script will abort the handshake due to hostname verification mismatch (since the certificate is issued for `live.yourdomain.com` and not the raw IP `18.185.5.251`). Leaving this location block intact ensures the tunnel url is reported reliably every time.
