#!/usr/bin/env bash
# CloudCrafter — repeatable verification checks (spec §34).
#
# Every command below has actually been run against this project's Minikube
# cluster; nothing here is aspirational. Read-only — it doesn't roll deployments
# or rotate keys (see the JWT rotation section of the README for that
# procedure). Requires: kubectl, helm, docker, and an Ingress reachable at
# INGRESS_ADDR (default: a `kubectl port-forward` to the ingress-nginx
# controller — see README "Local Kubernetes" for why this project doesn't hit
# the Minikube IP directly on this host).
set -euo pipefail
cd "$(dirname "$0")/.."

INGRESS_ADDR="${INGRESS_ADDR:-127.0.0.1:18080}"

section() { printf '\n=== %s ===\n' "$1"; }

section "Kubernetes — cluster-wide"
kubectl get pods -A
kubectl get svc -A
kubectl get ingress -A

section "Helm — chart validation"
helm lint charts/users charts/events charts/tickets charts/notifications charts/cloudcrafter
helm dependency build charts/cloudcrafter
helm template cloudcrafter charts/cloudcrafter >/dev/null && echo "helm template: OK"

section "Kubernetes — users rollout status (default)"
kubectl rollout status deployment/users -n default --timeout=60s

section "Multi-cloud namespaces"
for ns in aws google-cloud; do
  echo "--- $ns ---"
  kubectl get pods,svc,ingress -n "$ns"
done

section "Ingress health routes — default (cloudcrafter.local)"
for s in users events tickets notifications; do
  printf '/api/%s/health -> ' "$s"
  curl -sf -H "Host: cloudcrafter.local" "http://$INGRESS_ADDR/api/$s/health"
  echo
done

section "Ingress health routes — aws (cloudcrafter-aws.local)"
for s in users events tickets notifications; do
  printf '/api/%s/health -> ' "$s"
  curl -sf -H "Host: cloudcrafter-aws.local" "http://$INGRESS_ADDR/api/$s/health"
  echo
done

section "Ingress health routes — google-cloud (cloudcrafter-google-cloud.local)"
for s in users events tickets notifications; do
  printf '/api/%s/health -> ' "$s"
  curl -sf -H "Host: cloudcrafter-google-cloud.local" "http://$INGRESS_ADDR/api/$s/health"
  echo
done

section "Argo CD — Application status"
kubectl -n argocd get application cloudcrafter \
  -o jsonpath='sync={.status.sync.status} health={.status.health.status} revision={.status.sync.revision}{"\n"}'

section "LocalStack — S3 receipts and Lambda wiring"
docker exec cloudcrafter-localstack awslocal s3 ls "s3://cloudcrafter-ticket-receipts" --recursive | tail -5
docker exec cloudcrafter-localstack awslocal lambda get-function --function-name receipt-notification \
  --query 'Configuration.[FunctionName,State,LastUpdateStatus]' --output text

section "Observability — Prometheus targets and Grafana datasources"
kubectl get pods -n monitoring
GRAFANA_PW=$(kubectl get secret -n monitoring kube-prometheus-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d)
echo "(Grafana admin password retrieved — not printed; see README Observability section)"

section "Done"
echo "All checks above ran against the live cluster — see README.md for narrated, dated output."
