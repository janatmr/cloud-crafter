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
- [x] Phase 2 — Local Kubernetes baseline (Minikube)
- [x] Phase 3 — LocalStack event flow
- [x] Phase 4 — Helm charts
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
charts/         Helm packaging: charts/{users,events,tickets,notifications,cloudcrafter}
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

Remaining sections (Argo CD, Multi-cloud, Observability, JWT rotation, Verification)
are added as their phases complete.

## Local Kubernetes (Minikube)

The raw `k8s/*.yaml` baseline (one Deployment + ClusterIP Service per service, plus
`k8s/ingress.yaml`) runs unmodified on Minikube:

```sh
minikube start
minikube addons enable ingress   # already enabled by `minikube start` above

# Build the four images straight into Minikube's Docker daemon (no registry needed)
eval $(minikube docker-env)
for s in users events tickets notifications; do
  docker build -t $s:1.0 services/$s
done

kubectl apply -f k8s/
kubectl get pods
kubectl get svc
kubectl get ingress
```

**Note on the `users` service:** the raw manifest has no key material — by design,
`.dockerignore` excludes `*.key` from the image (Phase 1's security fix), so
`services/users/server.js` fails at startup without a mounted key pair. Kubernetes
Secret-backed key provisioning is formal Phase 9 scope. To prove the raw baseline
itself works end-to-end here, a local-dev-only keypair was generated with `openssl`
and injected via an imperative `kubectl create secret generic users-jwt-keys` +
`kubectl patch deployment/users` (volume mount, not committed to `k8s/*.yaml` — the
tracked baseline manifests stay byte-for-byte untouched). Phase 4's `charts/users`
formalizes that same mount as a first-class template (see below); Phase 9 replaces
the secret's contents with a fresh keypair as part of the rotation procedure.

Since this environment's Minikube uses the `docker` driver on Windows, the Ingress
isn't reachable at the Minikube IP directly from the host; verification used
`kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 18080:80` (an
alternative to `minikube tunnel`, which needs admin rights to bind port 80).

Verified — all four routes return their service's real `/health` body through the
Ingress:

```
$ curl -H "Host: cloudcrafter.local" http://127.0.0.1:18080/api/users/health
{"status":"ok","service":"users"}
$ curl -H "Host: cloudcrafter.local" http://127.0.0.1:18080/api/events/health
{"status":"ok","service":"events"}
$ curl -H "Host: cloudcrafter.local" http://127.0.0.1:18080/api/tickets/health
{"status":"ok","service":"tickets"}
$ curl -H "Host: cloudcrafter.local" http://127.0.0.1:18080/api/notifications/health
{"status":"ok","service":"notifications"}
```

```
$ kubectl get pods
NAME                             READY   STATUS    RESTARTS   AGE
events-59bdddfb67-zff9v          1/1     Running   0          2m21s
notifications-67947cb646-skpxp   1/1     Running   0          2m21s
tickets-564788cf59-s4dpf         1/1     Running   0          2m21s
users-96d999f7c-bp5kk            1/1     Running   0          66s

$ kubectl get svc
NAME            TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)    AGE
events          ClusterIP   10.108.221.122   <none>        3000/TCP   2m22s
notifications   ClusterIP   10.100.87.217    <none>        3000/TCP   2m22s
tickets         ClusterIP   10.98.164.105    <none>        3000/TCP   2m22s
users           ClusterIP   10.106.48.204    <none>        3000/TCP   2m22s

$ kubectl get ingress
NAME                   CLASS   HOSTS                ADDRESS        PORTS   AGE
cloudcrafter-ingress   nginx   cloudcrafter.local   192.168.49.2   80      2m22s
```

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

## Helm charts

`k8s/*.yaml` stays as the untouched raw baseline (spec §10); the deployable artifact
going forward is Helm — one chart per service plus an umbrella chart:

```
charts/
├── users/           # Chart.yaml, values.yaml, templates/{deployment,service,_helpers}
├── events/
├── tickets/
├── notifications/
└── cloudcrafter/    # umbrella chart — local `dependencies` on the four service charts
    └── templates/ingress.yaml   # same routes/regex as k8s/ingress.yaml, host/class configurable
```

Each service chart exposes exactly: `replicaCount`, `image.{repository,tag,pullPolicy}`,
`service.{type,port}`, `resources.{requests,limits}`, `env` — plus a
`readinessProbe`/`livenessProbe` on `GET /health`:3000 for all four. Resource
requests/limits are sized per service rather than copy-pasted (`users` highest, since it
does RS256 signing/verification per request):

| Chart | requests (cpu/mem) | limits (cpu/mem) |
|---|---|---|
| `users` | 100m / 128Mi | 300m / 256Mi |
| `tickets` | 75m / 96Mi | 200m / 192Mi |
| `events` | 50m / 64Mi | 150m / 128Mi |
| `notifications` | 50m / 64Mi | 150m / 128Mi |

`charts/users` additionally sets `replicaCount: 2` and a `RollingUpdate` strategy
(`maxUnavailable: 0`, `maxSurge: 1`) so Phase 9's key-rotation rollout always has at
least one ready replica — and mounts the `users-jwt-keys` Secret at `/etc/jwt-keys`,
wiring `JWT_PRIVATE_KEY_PATH`/`JWT_PUBLIC_KEY_PATH` to point there (the same Secret
Phase 2 created imperatively; the chart just makes that mount declarative). `charts/tickets`
templates the LocalStack S3 env vars (`S3_ENDPOINT`, `S3_BUCKET`, `AWS_REGION`, and local
test credentials) from `values.yaml`, defaulting to the same `192.168.49.20:4566`
endpoint Phase 3 wired up.

**Validated:**

```sh
helm dependency build charts/cloudcrafter   # vendors the four local file:// deps
helm lint charts/users charts/events charts/tickets charts/notifications charts/cloudcrafter
helm template cloudcrafter charts/cloudcrafter   # inspected: 4 Deployments, 4 Services, 1 Ingress
```

All five charts lint clean; the rendered Ingress matches `k8s/ingress.yaml` exactly.

**Redeployed to Minikube via the umbrella chart** (replacing the Phase 2 raw-manifest
resources, which were `kubectl delete -f k8s/`'d first so Helm could own the object
names — reversible any time with `kubectl apply -f k8s/`):

```sh
helm upgrade --install cloudcrafter ./charts/cloudcrafter -n default --create-namespace
```

```
$ kubectl get pods
NAME                             READY   STATUS    RESTARTS   AGE
events-7d5bbd7556-mq5hc          1/1     Running   0          2m39s
notifications-697f9b6cbc-gpqmd   1/1     Running   0          2m39s
tickets-5c8764bb95-2rrvm         1/1     Running   0          2m39s
users-548ffb5586-vfkdz           1/1     Running   0          2m39s
users-548ffb5586-z79tv           1/1     Running   0          2m39s

$ kubectl get svc
NAME            TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE
events          ClusterIP   10.111.177.6    <none>        3000/TCP   2m39s
notifications   ClusterIP   10.97.116.90    <none>        3000/TCP   2m39s
tickets         ClusterIP   10.111.32.251   <none>        3000/TCP   2m39s
users           ClusterIP   10.96.179.100   <none>        3000/TCP   2m39s

$ kubectl get ingress
NAME                   CLASS   HOSTS                ADDRESS        PORTS   AGE
cloudcrafter-ingress   nginx   cloudcrafter.local   192.168.49.2   80      2m40s

$ helm list -n default
NAME          NAMESPACE  REVISION  STATUS    CHART                APP VERSION
cloudcrafter  default    1         deployed  cloudcrafter-1.0.0   1.0.0
```

`users` came up at 2/2 as configured. Re-ran the same `/health` verification as Phase 2
(via `kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 18080:80`) —
all four routes still return their service's real body, now served by the
Helm-managed Deployments:

```
$ curl -H "Host: cloudcrafter.local" http://127.0.0.1:18080/api/users/health
{"status":"ok","service":"users"}
$ curl -H "Host: cloudcrafter.local" http://127.0.0.1:18080/api/events/health
{"status":"ok","service":"events"}
$ curl -H "Host: cloudcrafter.local" http://127.0.0.1:18080/api/tickets/health
{"status":"ok","service":"tickets"}
$ curl -H "Host: cloudcrafter.local" http://127.0.0.1:18080/api/notifications/health
{"status":"ok","service":"notifications"}
```

Also confirmed the Phase 3 S3 wiring and Phase 1 JWT login both still work against the
Helm-managed `tickets`/`users` Deployments — `tickets`' pod has
`S3_ENDPOINT=http://192.168.49.20:4566`, `S3_BUCKET=cloudcrafter-ticket-receipts` from
chart values, and `POST /login` against the chart-mounted `users-jwt-keys` Secret
returns a valid RS256 token.

**Environment note:** Helm was installed as a portable binary (no admin rights available
for the system package manager in this environment) rather than a system-wide install —
functionally identical, just not on a machine-wide PATH by default.
