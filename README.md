# CloudCrafter

Capstone project: four Express microservices (`users`, `events`, `tickets`,
`notifications`) deployed and operated through a full cloud-native pipeline —
Kubernetes, LocalStack-simulated serverless, Helm, CI/CD, Argo CD GitOps, multi-cloud
namespaces, observability, and JWT key rotation.

The full plan is tracked in `docs/CloudCrafter Capstone — End-to-End Implementation
Plan.md`, driven by `docs/CloudCrafter_CURSOR_IMPLEMENTATION.md` as the source of truth.
This README is filled in incrementally as each phase completes; sections below are
placeholders until their phase lands.

## Status

- [x] Phase 1 — Baseline & security fix
- [ ] Phase 2 — Local Kubernetes baseline (Minikube)
- [x] Phase 3 — LocalStack event flow
- [ ] Phase 4 — Helm charts
- [ ] Phase 5 — CI/CD
- [ ] Phase 6 — Argo CD
- [ ] Phase 7 — Multi-cloud namespace proof
- [ ] Phase 8 — Observability
- [ ] Phase 9 — JWT key rotation hardening
- [ ] Phase 10 — Final verification & demo

## Services

| Service | Port | Endpoints |
|---|---|---|
| `users` | 3000 | `GET /health`, `GET /users`, `POST /login`, `GET /protected` |
| `events` | 3000 | `GET /health`, `GET /events`, `GET /events/:id`, `POST /events` |
| `tickets` | 3000 | `GET /health`, `GET /tickets`, `POST /tickets` |
| `notifications` | 3000 | `GET /health`, `GET /notifications`, `POST /notify` |

Each service is a standalone Node/Express app under `services/<name>/`, with an
in-memory data store and its own `Dockerfile`. See `services/users/README.md` for the
users service's JWT key setup.

## Local development

```sh
cd services/<name>
npm install
npm start   # or: npm test
```

## Repository layout

```
services/       application code only
k8s/            original/raw baseline manifests
charts/         Helm packaging (added in Phase 4)
localstack/     LocalStack + Lambda simulation (added in Phase 3)
argocd/         GitOps Application manifests (added in Phase 6)
observability/  Prometheus/Loki/Grafana Helm values (added in Phase 8)
scripts/        reproducible setup/verification helpers
```

## Security

`services/users/private.key` and `public.key` were committed to git history in an
early commit and must be treated as compromised. They have been removed from the
tracked tree and `*.key`/`*.pem` are gitignored. Key paths are now configurable via
`JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH`; see `services/users/README.md`.
Git history itself has not been rewritten (that requires a force-push and separate
explicit authorization).

Remaining sections (Local Kubernetes, Helm, Argo CD, Multi-cloud, Observability, JWT
rotation, Verification) are added as their phases complete.

## LocalStack event flow

`POST /tickets` → receipt uploaded to S3 (LocalStack) → S3 `ObjectCreated` event →
Lambda (`localstack/lambda/receipt-notification`) → `POST /notifications/notify` →
visible in `GET /notifications`. No manual Lambda invocation anywhere in that chain.

```
localstack/
├── docker-compose.yml            # LocalStack (S3 + Lambda), community edition
├── .env.example                  # network name / static IP, copy to .env to override
├── lambda/receipt-notification/  # index.js + package.json (no deps, Node built-ins only)
└── scripts/setup.sh              # idempotent: bucket, function deploy, event wiring
```

**Networking (spec §9.5, Risk 3).** LocalStack runs as a separate Docker Compose stack,
not inside the Minikube cluster, so "localhost" from a Lambda container is the Lambda
container itself — never the in-cluster Notifications service. This environment's
Minikube uses the `docker` driver, which creates a Docker network literally named
`minikube` for the node container; verified empirically that a container attached to
that network *can* reach the Ingress at the Minikube node IP, and that a Pod running
inside Minikube *can* reach a container attached to that same network — see the two
tests below. Both are dead ends on this Windows/Docker Desktop host if attempted from
the bare host or an unrelated Docker network (tested and confirmed to time out).

```
$ docker run --rm --network minikube curlimages/curl:8.10.1 -sv -H "Host: cloudcrafter.local" http://192.168.49.2/api/notifications/health
< HTTP/1.1 200 OK
{"status":"ok","service":"notifications"}

$ kubectl exec deploy/tickets -- wget -qO- http://192.168.49.3:80/   # container on the minikube network
wget: can't connect to remote host (192.168.49.3): Connection refused   # routed, just nothing listening — proves reachability
```

Based on that, the design:

- **LocalStack container** joins the external `minikube` Docker network with a static
  IP (`LOCALSTACK_IP`, default `192.168.49.20`) so Tickets (in-cluster) has a stable S3
  endpoint — `docker compose`-assigned dynamic IPs on that network aren't predictable
  across restarts.
- **`LAMBDA_DOCKER_NETWORK=minikube`** (a real LocalStack setting) — the short-lived
  containers LocalStack spawns to run the Lambda also join that network, so they can
  reach the Ingress at the Minikube node IP.
- **`NOTIFICATIONS_URL`** (spec-required, no hardcoded `localhost`) is set to
  `http://<minikube ip>/api/notifications/notify` — going through the Ingress, since
  that's the practical reachable path the spec explicitly allows for. Because Ingress
  routing is Host-header-based, an additional `NOTIFICATIONS_HOST_HEADER=cloudcrafter.local`
  env var tells the Lambda to send that header explicitly (`localstack/lambda/receipt-notification/index.js`) — this is only needed for this
  Ingress-based path, not a general requirement.

**Tickets → S3.** `services/tickets/server.js` uploads the receipt JSON to
`s3://$S3_BUCKET/receipts/ticket-<id>-user-<userId>.json` via `@aws-sdk/client-s3`
whenever `S3_ENDPOINT`/`S3_BUCKET` are configured; unset (as in tests and plain local
dev), the upload is skipped and `POST /tickets` behaves exactly as before — see spec
§9.7's "keep `POST /tickets` backward compatible."

**Setup.**

```sh
minikube start   # if not already running — the "minikube" Docker network must exist
cd localstack
bash scripts/setup.sh
```

`setup.sh` is idempotent: starts LocalStack, waits for S3/Lambda to report ready,
creates `cloudcrafter-ticket-receipts` if missing, packages and deploys the Lambda
(waiting out LocalStack's async Pending→Active transition on both create and update),
grants S3 permission to invoke it, and wires the `s3:ObjectCreated:*` → Lambda bucket
notification. Re-running it is safe and was verified twice in a row with identical
"already exists / already granted" output the second time.

Until Phase 4 (Helm) formalizes this as chart values, the running `tickets` Deployment
is pointed at LocalStack the same way Phase 2 handled the `users` Secret — an
imperative, uncommitted `kubectl` command, not a change to the tracked `k8s/*.yaml`
baseline:

```sh
kubectl set env deployment/tickets \
  S3_ENDPOINT=http://192.168.49.20:4566 S3_BUCKET=cloudcrafter-ticket-receipts \
  AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
```

**Verified end-to-end** — one `POST /tickets` through the Ingress, no manual Lambda
invocation:

```
$ curl -H "Host: cloudcrafter.local" -X POST -d '{"eventId":1,"userId":42}' \
    -H "Content-Type: application/json" http://192.168.49.2/api/tickets/tickets
{"id":1,"eventId":1,"userId":42,"issuedAt":"2026-08-21T10:06:03.718Z","receiptId":"receipt-1787306763718"}

$ awslocal s3 ls s3://cloudcrafter-ticket-receipts --recursive
2026-08-21 10:06:03        106 receipts/ticket-1-user-42.json

# Real stdout captured from the Lambda's own container — LocalStack spawns one
# short-lived container per invocation (cloudcrafter-localstack-lambda-receipt-notification-<id>):
2026-08-21T10:06:04.872Z  INFO  Processing S3 event for s3://cloudcrafter-ticket-receipts/receipts/ticket-1-user-42.json
2026-08-21T10:06:04.888Z  INFO  Notifications responded 201

$ curl -H "Host: cloudcrafter.local" http://192.168.49.2/api/notifications/notifications
[{"id":1,"message":"Ticket receipt uploaded: receipts/ticket-1-user-42.json","userId":42,"sentAt":"2026-08-21T10:06:04.885Z"}]
```

The notification appears ~1.1s after the ticket was created, driven entirely by the S3
event — the request that created it (`POST /tickets`) never talks to Lambda or
Notifications directly.
