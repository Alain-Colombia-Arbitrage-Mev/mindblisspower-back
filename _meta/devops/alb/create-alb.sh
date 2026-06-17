#!/usr/bin/env bash
# =============================================================================
# Task 10: ALB + ACM + Target Group + DNS api.mindblisspower.com
# Account: 522814703714  Region: us-east-1
# Executed: 2026-06-17
# =============================================================================
# This script documents the exact commands and discovered IDs used to create
# the Application Load Balancer infrastructure for the VisionPower API.
# It is an audit/reproducibility record — resources are already created.
# =============================================================================

set -euo pipefail
export MSYS_NO_PATHCONV=1  # Windows/Git Bash: prevent path mangling

# ---------------------------------------------------------------------------
# DISCOVERED / CREATED RESOURCE IDs
# ---------------------------------------------------------------------------
ACCOUNT="522814703714"
REGION="us-east-1"

# server2 instance
INSTANCE_ID="i-02fcc4d2329040711"
INSTANCE_AZ="us-east-1c"

# VPC (discovered from server2)
VPC="vpc-0717c4c1772924de3"

# Public subnets used by the ALB (must include server2 AZ us-east-1c)
#   subnet-0c6ee992f57703c33  us-east-1a
#   subnet-0c666adeca44de4ae  us-east-1b
#   subnet-06b25135b31195791  us-east-1c  ← server2 lives here
SUBNETS="subnet-0c6ee992f57703c33 subnet-0c666adeca44de4ae subnet-06b25135b31195791"

# Security groups
ALB_SG="sg-0e14573bbad1f4e2d"          # vp-alb-sg (created)
EC2_SG="sg-00bc3b29df49c4597"           # shared EC2 SG (pre-existing; TCP 3000 from ALB SG added)

# ACM certificate
CERT="arn:aws:acm:us-east-1:522814703714:certificate/eda62e5f-1ac7-44fa-acae-f05bbd9f8b66"
# Validation CNAME (created in Route53 zone Z04248571P6Q70DSQDSGO):
#   _663fdf79ced4b058650c49b4f6ebb9a1.api.mindblisspower.com.
#   → _4704c6f1c0888d92bfdb1b7b4938d2e1.jkddzztszm.acm-validations.aws.

# Target group
TG="arn:aws:elasticloadbalancing:us-east-1:522814703714:targetgroup/vp-api-tg/eb12f5908a6dced2"

# ALB
ALB="arn:aws:elasticloadbalancing:us-east-1:522814703714:loadbalancer/app/vp-alb/45f9e041996e4adc"
ALB_DNS="vp-alb-905595310.us-east-1.elb.amazonaws.com"
ALB_ZONE="Z35SXDOTRQ7X7K"  # ALB canonical hosted zone (for Route53 alias)

# Listener
LISTENER="arn:aws:elasticloadbalancing:us-east-1:522814703714:listener/app/vp-alb/45f9e041996e4adc/d6ad1d9eb379729f"

# Route53 hosted zone for mindblisspower.com
R53_ZONE="Z04248571P6Q70DSQDSGO"

# ---------------------------------------------------------------------------
# STEP 1: Discover VPC and public subnets
# ---------------------------------------------------------------------------
# aws ec2 describe-instances --instance-ids $INSTANCE_ID \
#   --query 'Reservations[0].Instances[0].VpcId' --output text
# → vpc-0717c4c1772924de3
#
# aws ec2 describe-subnets \
#   --filters "Name=vpc-id,Values=$VPC" "Name=map-public-ip-on-launch,Values=true" \
#   --query 'Subnets[].[SubnetId,AvailabilityZone]' --output table
# → 6 public subnets across 6 AZs (1a–1f)
#
# aws ec2 describe-instances --instance-ids $INSTANCE_ID \
#   --query 'Reservations[0].Instances[0].[Placement.AvailabilityZone,SubnetId]' --output text
# → us-east-1c  subnet-06b25135b31195791

# ---------------------------------------------------------------------------
# STEP 2: Request ACM certificate + DNS validation
# ---------------------------------------------------------------------------
# CERT=$(aws acm request-certificate \
#   --domain-name api.mindblisspower.com \
#   --validation-method DNS \
#   --query CertificateArn --output text)
#
# Validation record (UPSERT to R53 zone $R53_ZONE):
# aws route53 change-resource-record-sets \
#   --hosted-zone-id $R53_ZONE \
#   --change-batch file://D:/vicionpower/backend/_tmp_acm_validation.json
# (JSON: CNAME _663fdf79ced4b058650c49b4f6ebb9a1.api.mindblisspower.com.
#        → _4704c6f1c0888d92bfdb1b7b4938d2e1.jkddzztszm.acm-validations.aws.)
#
# aws acm wait certificate-validated --certificate-arn "$CERT"
# Status: ISSUED

# ---------------------------------------------------------------------------
# STEP 3: Create ALB SG + target group + register target
# ---------------------------------------------------------------------------
# ALBSG=$(aws ec2 create-security-group \
#   --group-name vp-alb-sg \
#   --description "ALB publico 443" \
#   --vpc-id $VPC \
#   --query GroupId --output text)
# → sg-0e14573bbad1f4e2d
#
# aws ec2 authorize-security-group-ingress \
#   --group-id $ALBSG --protocol tcp --port 443 --cidr 0.0.0.0/0
#
# TG=$(aws elbv2 create-target-group \
#   --name vp-api-tg \
#   --protocol HTTP --port 3000 \
#   --vpc-id $VPC \
#   --target-type instance \
#   --health-check-path /health \
#   --health-check-interval-seconds 10 \
#   --query 'TargetGroups[0].TargetGroupArn' --output text)
# → arn:aws:elasticloadbalancing:us-east-1:522814703714:targetgroup/vp-api-tg/eb12f5908a6dced2
#
# aws elbv2 register-targets \
#   --target-group-arn $TG \
#   --targets Id=i-02fcc4d2329040711,Port=3000

# ---------------------------------------------------------------------------
# STEP 4: Create ALB + HTTPS listener
# ---------------------------------------------------------------------------
# ALB=$(aws elbv2 create-load-balancer \
#   --name vp-alb \
#   --type application \
#   --scheme internet-facing \
#   --subnets subnet-0c6ee992f57703c33 subnet-0c666adeca44de4ae \
#   --security-groups $ALBSG \
#   --query 'LoadBalancers[0].LoadBalancerArn' --output text)
# → arn:aws:elasticloadbalancing:us-east-1:522814703714:loadbalancer/app/vp-alb/45f9e041996e4adc
#
# NOTE: After discovering server2 is in us-east-1c, subnets were expanded:
# aws elbv2 set-subnets \
#   --load-balancer-arn $ALB \
#   --subnets subnet-0c6ee992f57703c33 subnet-0c666adeca44de4ae subnet-06b25135b31195791
#
# aws elbv2 create-listener \
#   --load-balancer-arn $ALB \
#   --protocol HTTPS --port 443 \
#   --certificates CertificateArn=$CERT \
#   --default-actions Type=forward,TargetGroupArn=$TG \
#   --query 'Listeners[0].ListenerArn' --output text
# → arn:aws:elasticloadbalancing:us-east-1:522814703714:listener/app/vp-alb/45f9e041996e4adc/d6ad1d9eb379729f
#
# ALB_DNS=vp-alb-905595310.us-east-1.elb.amazonaws.com
# ALB_ZONE=Z35SXDOTRQ7X7K

# ---------------------------------------------------------------------------
# STEP 5: Open TCP 3000 in EC2 SG from ALB SG
# ---------------------------------------------------------------------------
# aws ec2 authorize-security-group-ingress \
#   --group-id $EC2_SG \
#   --protocol tcp --port 3000 \
#   --source-group $ALBSG

# ---------------------------------------------------------------------------
# STEP 6: api.mindblisspower.com A-alias → ALB
# ---------------------------------------------------------------------------
# aws route53 change-resource-record-sets \
#   --hosted-zone-id $R53_ZONE \
#   --change-batch file://D:/vicionpower/backend/_tmp_api_dns.json
# (JSON: A alias api.mindblisspower.com. → ALB_DNS / ALB_ZONE, EvaluateTargetHealth true)
# ChangeInfo.Status: PENDING → INSYNC (waited)

# ---------------------------------------------------------------------------
# VERIFICATION RESULTS
# ---------------------------------------------------------------------------
# aws elbv2 describe-target-health --target-group-arn $TG
# → State: healthy
#
# curl -fsS https://api.mindblisspower.com/health
# → "ok"  (valid TLS cert, no -k flag)
