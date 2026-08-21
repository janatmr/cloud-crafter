#!/usr/bin/env bash
# Idempotent LocalStack setup for the ticket-receipt event flow (spec §9).
# Safe to re-run: bucket creation, function deploy, and notification wiring all
# tolerate "already exists" / "already configured" outcomes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCALSTACK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAMBDA_DIR="$LOCALSTACK_DIR/lambda/receipt-notification"

[ -f "$LOCALSTACK_DIR/.env" ] && set -a && source "$LOCALSTACK_DIR/.env" && set +a
MINIKUBE_DOCKER_NETWORK="${MINIKUBE_DOCKER_NETWORK:-minikube}"
LOCALSTACK_IP="${LOCALSTACK_IP:-192.168.49.20}"

BUCKET="cloudcrafter-ticket-receipts"
FUNCTION="receipt-notification"
COMPOSE="docker compose -f $LOCALSTACK_DIR/docker-compose.yml"

if ! docker network inspect "$MINIKUBE_DOCKER_NETWORK" >/dev/null 2>&1; then
  echo "Docker network '$MINIKUBE_DOCKER_NETWORK' not found — start Minikube first (minikube start)." >&2
  exit 1
fi

if ! MINIKUBE_IP="$(minikube ip 2>/dev/null)"; then
  echo "Could not read the Minikube node IP via 'minikube ip' — is Minikube running?" >&2
  exit 1
fi
echo "Minikube node IP: $MINIKUBE_IP"
echo "Ingress must be reachable there with Host: cloudcrafter.local (verified in Phase 2)."

echo "Starting LocalStack..."
$COMPOSE up -d

echo "Waiting for LocalStack S3 and Lambda to be ready..."
for i in $(seq 1 30); do
  HEALTH="$(curl -s http://localhost:4566/_localstack/health || true)"
  if echo "$HEALTH" | grep -Eq '"s3": "(running|available)"' && echo "$HEALTH" | grep -Eq '"lambda": "(running|available)"'; then
    echo "LocalStack is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "LocalStack did not become ready in time. Last health response:" >&2
    echo "$HEALTH" >&2
    exit 1
  fi
  sleep 2
done

awslocal() { $COMPOSE exec -T localstack awslocal "$@"; }

echo "Ensuring bucket s3://$BUCKET exists..."
if ! awslocal s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  awslocal s3 mb "s3://$BUCKET"
else
  echo "Bucket already exists — skipping creation."
fi

echo "Packaging Lambda function..."
rm -f "$LAMBDA_DIR/function.zip"
# Git Bash rewrites a bare leading-slash argument like "-w /src" into a Windows path
# before it reaches docker.exe; MSYS_NO_PATHCONV disables that for this one command
# (the $LAMBDA_DIR:/src volume spec itself is left alone — Docker's own CLI already
# splits and converts the host side of "-v host:container" correctly).
MSYS_NO_PATHCONV=1 docker run --rm -v "$LAMBDA_DIR:/src" -w /src alpine sh -c \
  "apk add --no-cache zip >/dev/null && zip -q -r function.zip index.js package.json"

NOTIFICATIONS_URL="http://$MINIKUBE_IP/api/notifications/notify"
NOTIFICATIONS_HOST_HEADER="cloudcrafter.local"
LAMBDA_ENV="Variables={NOTIFICATIONS_URL=$NOTIFICATIONS_URL,NOTIFICATIONS_HOST_HEADER=$NOTIFICATIONS_HOST_HEADER}"
# docker-compose.yml mounts ./lambda read-only into the LocalStack container at /lambda,
# so awslocal (running inside that container) reads the zip from there — not from a path
# on the host, which the LocalStack container has no access to.
ZIP_REF="fileb:///lambda/receipt-notification/function.zip"

wait_for_state() {
  local query="$1" want="$2"
  for i in $(seq 1 30); do
    local got
    got="$(awslocal lambda get-function --function-name "$FUNCTION" --query "$query" --output text 2>/dev/null || true)"
    [ "$got" = "$want" ] && return 0
    sleep 1
  done
  return 1
}

echo "Deploying Lambda function '$FUNCTION'..."
if awslocal lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1; then
  # A function left over from a prior run may still be Pending — code/config
  # updates are rejected until the current version finishes initializing.
  wait_for_state "Configuration.State" "Active"
  awslocal lambda update-function-code --function-name "$FUNCTION" --zip-file "$ZIP_REF" \
    >/dev/null
  wait_for_state "Configuration.LastUpdateStatus" "Successful"
  awslocal lambda update-function-configuration --function-name "$FUNCTION" \
    --environment "$LAMBDA_ENV" >/dev/null
else
  awslocal lambda create-function \
    --function-name "$FUNCTION" \
    --runtime nodejs18.x \
    --handler index.handler \
    --zip-file "$ZIP_REF" \
    --role arn:aws:iam::000000000000:role/lambda-role \
    --environment "$LAMBDA_ENV" \
    >/dev/null
fi

echo "Granting S3 permission to invoke the Lambda (idempotent)..."
awslocal lambda add-permission \
  --function-name "$FUNCTION" \
  --statement-id s3invoke \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn "arn:aws:s3:::$BUCKET" >/dev/null 2>&1 || echo "Permission already granted — skipping."

echo "Waiting for the Lambda function to become Active..."
wait_for_state "Configuration.State" "Active"

echo "Wiring the S3 -> Lambda object-created notification..."
FUNCTION_ARN="arn:aws:lambda:us-east-1:000000000000:function:$FUNCTION"
awslocal s3api put-bucket-notification-configuration \
  --bucket "$BUCKET" \
  --notification-configuration "{\"LambdaFunctionConfigurations\":[{\"LambdaFunctionArn\":\"$FUNCTION_ARN\",\"Events\":[\"s3:ObjectCreated:*\"]}]}"

echo
echo "Done. LocalStack S3 endpoint for in-cluster services: http://$LOCALSTACK_IP:4566"
echo "Lambda -> Notifications target: $NOTIFICATIONS_URL (Host: $NOTIFICATIONS_HOST_HEADER)"
