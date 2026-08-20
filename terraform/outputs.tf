output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.maximall_web.id
}

output "public_ip" {
  description = "Static public IP (Elastic IP) of the maximall-web server"
  value       = aws_eip.maximall_web_eip.public_ip
}

output "app_url" {
  description = "The live URL for the deployed application"
  value       = "http://${aws_eip.maximall_web_eip.public_ip}"
}

output "admin_url" {
  description = "Admin login URL"
  value       = "http://${aws_eip.maximall_web_eip.public_ip}/login.html"
}
