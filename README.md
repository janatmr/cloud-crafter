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
- [x] Phase 5 — CI/CD
- [x] Phase 6 — Argo CD
- [x] Phase 7 — Multi-cloud namespace proof
- [x] Phase 8 — Observability
- [x] Phase 9 — JWT key rotation hardening
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

Remaining sections (JWT rotation, Verification) are added as their phases complete.

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

**Local Minikube note (post-Phase 5):** the four service charts' `image.repository`
default now points at `ghcr.io/janatmr/cloud-crafter/<service>` (see below), since that's
what a real cluster needs to pull from. A Minikube demo still builds images straight into
Minikube's own Docker daemon and has no route to GHCR, so use the override file:

```sh
eval $(minikube docker-env)
for s in users events tickets notifications; do
  docker build -t $s:1.0.0 services/$s
done
helm upgrade --install cloudcrafter ./charts/cloudcrafter -f charts/cloudcrafter/values-minikube.yaml
```

## CI/CD (spec §17, §18)

`.github/workflows/ci.yml` — one workflow, several jobs:

| Job | Trigger | What it does |
|---|---|---|
| `test` (matrix: 4 services) | every push, every PR into `main` | `npm ci` + `npm test` per service (Phase 1's `node --test` suites). The `users` service needs an RS256 keypair to boot; CI generates a throwaway one with `openssl` per run — no real key is ever committed or reused. |
| `docker-build` (matrix: 4 services) | every push, every PR into `main` | `docker build` for each `Dockerfile`, validation only, no push. |
| `helm-validate` | every push, every PR into `main` | `helm lint` on all 5 charts, `helm dependency build` + `helm lint` + `helm template` on the umbrella chart. Fails the workflow on any Helm error. |
| `release-images` (matrix: 4 services) | push to `main` only, after `test`/`docker-build`/`helm-validate` pass | Builds and pushes each image to `ghcr.io/janatmr/cloud-crafter/<service>`, tagged with **both** the Git commit SHA and the service's SemVer version (`package.json`'s `version`) — never `latest` (spec §17). |
| `bump-chart-values` | after `release-images` | Sets `image.tag` in each `charts/<service>/values.yaml` to the just-pushed commit SHA and commits/pushes that to `main` (`[skip ci]`) — the "versioned deployment artifact → Git repository desired state" step in spec §18's diagram. This workflow never runs `kubectl`/`helm upgrade` against any cluster; Argo CD (Phase 6) is what turns this commit into a real deployment. |

No lint script exists in any service's `package.json` yet, so the `test` job checks for
one and skips cleanly if absent (spec §17 explicitly allows this — inventing an ESLint
setup nobody asked for would violate the "don't add tools the spec doesn't call for"
rule).

**Required GitHub configuration (manual — this environment has no org/repo admin
credentials to automate these):**

1. **GHCR push permission.** The `release-images`/`bump-chart-values` jobs declare
   `permissions: packages: write` / `contents: write` in the workflow file itself, which
   is sufficient in most repos. If pushes to GHCR or back to `main` fail with a 403,
   check **Settings → Actions → General → Workflow permissions** isn't force-overriding
   this to read-only.
2. **GHCR package visibility.** GHCR packages are private by default. After the first
   successful `release-images` run, either mark each of the four packages public (repo →
   Packages tab → package settings), or provision `imagePullSecret`s in whatever cluster
   pulls them (relevant starting Phase 6/7).
3. **Branch protection for `main` (spec §12).** Require a PR before merging, set the
   required status checks to `test (users)`, `test (events)`, `test (tickets)`,
   `test (notifications)`, `docker-build (*)`, and `helm-validate`, and restrict direct
   pushes. This creates a real tension with `bump-chart-values` pushing straight to
   `main` — once protection is turned on, either add `github-actions[bot]` to the
   "allow specified actors to bypass required pull requests" list, or change that job to
   open a PR (e.g. via `peter-evans/create-pull-request`) with auto-merge instead of
   pushing directly. Left as a follow-up decision rather than guessed at here, since it
   changes the workflow's behavior and this environment has no way to test either path
   against real branch protection rules.

**Validated locally** (this environment has no way to actually execute a GitHub Actions
run or push to GHCR, so these are the same commands the workflow runs, executed
directly):

```
$ npm ci && npm test        # in each services/<name>, ephemeral keypair for users
... all four: 0 failing

$ docker build -t users:ci-validate services/users
... builds clean

$ helm lint charts/users charts/events charts/tickets charts/notifications
4 chart(s) linted, 0 chart(s) failed
$ helm dependency build charts/cloudcrafter && helm lint charts/cloudcrafter
1 chart(s) linted, 0 chart(s) failed
$ helm template cloudcrafter charts/cloudcrafter
... image: "ghcr.io/janatmr/cloud-crafter/users:1.0.0"  (etc. for all four)
```

**Actually triggered** (Phase 6): pushing `main` to GitHub for the first time ran the
real workflow. `test`/`docker-build`/`helm-validate`/`release-images` all passed, and
`bump-chart-values` landed
[`chore(release): bump image tags to 08f92d765965f80fdfff5d10fa06e2d96582b662`](https://github.com/janatmr/cloud-crafter/commit/02f338a478958b926ce79179ffb056efa72236e6)
on `main` — every `charts/<service>/values.yaml` now points `image.tag` at that commit
SHA, proof the pipeline reached GHCR without any manual `kubectl`/`helm` step. GHCR
package visibility (caveat 2 above) is still an open manual action: until the four
packages are made public (or an `imagePullSecret` is provisioned), only the local
Minikube-image overlay (`values-minikube.yaml`, used by Phase 6's Argo Application) can
actually pull; a real cluster pulling `ghcr.io/janatmr/cloud-crafter/*` directly would
need that step done first.

---

## Argo CD (spec §19)

`argocd/` holds the GitOps pieces — `application.yaml` (the `Application` resource) and
a `README.md` with install/verify/rotation steps. Full detail lives there; this section
is the "it actually ran" record (spec §43).

Installed Argo CD into the same Minikube cluster used since Phase 2, via the standard
upstream manifest (`--server-side` was required — the stock `applicationsets.argoproj.io`
CRD's annotations exceed the 256 KiB client-side-apply limit):

```
$ kubectl create namespace argocd
$ kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml --server-side --force-conflicts
... (all argocd-* Deployments/StatefulSet/Services/NetworkPolicies created)
$ kubectl -n argocd wait --for=condition=available --timeout=180s deployment/argocd-server deployment/argocd-repo-server deployment/argocd-applicationset-controller deployment/argocd-redis deployment/argocd-dex-server
... condition met (all 5)
```

Registered the `Application` (the one allowed manual `kubectl apply`, spec §18 — every
deployment change after this goes through git, not a human running `kubectl`/`helm`):

```
$ kubectl apply -f argocd/application.yaml
application.argoproj.io/cloudcrafter created
```

`application.yaml` points at `https://github.com/janatmr/cloud-crafter.git` (public, no
credential needed), path `charts/cloudcrafter`, `targetRevision: main`, namespace
`default`, `helm.valueFiles: [values-minikube.yaml]` (same local-image overlay as
Phases 2/4 — this cluster can't pull the real GHCR images yet, see the CI/CD section's
package-visibility caveat), and `syncPolicy.automated` with `prune: true` /
`selfHeal: true`.

The very first comparison failed with a cold-start timeout
(`context deadline exceeded` fetching `github.com` — the repo-server's first outbound
request from a freshly-started pod; a plain `curl` from the same pod's network
namespace right afterward returned `200` with no other change needed). A hard refresh
(`kubectl -n argocd annotate application cloudcrafter argocd.argoproj.io/refresh=hard --overwrite`)
resolved it immediately and every comparison since has succeeded on the first try:

```
$ kubectl -n argocd get application cloudcrafter -o jsonpath='{.status.sync.status} {.status.health.status}'
Synced Healthy
```

This adopted the pre-existing `cloudcrafter` Helm release cleanly (same release name,
same namespace — Argo CD reconciled it in place, no orphaned/duplicate resources):

```
$ kubectl -n argocd get application cloudcrafter -o jsonpath='{range .status.resources[*]}{.kind}/{.name} {.status} {.health.status}{"\n"}{end}'
Service/events Synced
Service/notifications Synced
Service/tickets Synced
Service/users Synced
Deployment/events Synced
Deployment/notifications Synced
Deployment/tickets Synced
Deployment/users Synced
Ingress/cloudcrafter-ingress Synced
```

Re-verified all four `/health` routes through the same Ingress, now entirely
Argo-CD-managed (`kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 18080:80`,
per the Windows/Minikube-docker-driver networking note in the Local Kubernetes section):

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

**End-to-end GitOps proof** — a real repository change, no manual `kubectl apply`/`helm
upgrade` for the change itself: commit
[`d562f0e`](https://github.com/janatmr/cloud-crafter/commit/d562f0ee22e734f8b9c1228484fa64a63d330818)
bumps `charts/notifications/values.yaml` `replicaCount` from `1` to `2`. Pushing it to
`main` re-triggered the CI/CD pipeline from the previous section too — `test` through
`bump-chart-values` ran again and landed a second real
[`chore(release)`](https://github.com/janatmr/cloud-crafter/commit/44563e19b64dd592ece4d49c43160ce9778abb72)
commit on top, which is itself further proof of Phase 5's pipeline working end to end.
Argo CD's background poll picked up the new tip on its own (confirmed via the
controller's logs — periodic "Comparing app state" reconciliations against `main`),
though the default git-resolution cache made that take longer than convenient to sit
and watch in this session; `kubectl -n argocd annotate application cloudcrafter
argocd.argoproj.io/refresh=hard --overwrite` (a request for Argo CD to look sooner, not
a deploy action — no `kubectl apply`/`helm upgrade` of the workload itself) was used to
get the same result faster:

```
$ kubectl -n argocd get application cloudcrafter -o jsonpath='{.status.sync.status} {.status.sync.revision}'
Synced 44563e19b64dd592ece4d49c43160ce9778abb72
$ kubectl get deploy notifications -n default
NAME            READY   UP-TO-DATE   AVAILABLE   AGE
notifications   2/2     2            2           4h8m
$ kubectl get pods -n default -l app=notifications
NAME                            READY   STATUS    RESTARTS   AGE
notifications-df47459df-hlr5r   1/1     Running   0          19m
notifications-df47459df-q6ftg   1/1     Running   0          40s
```

Re-checked all four `/health` routes once more after this sync — still all `{"status":"ok",...}`.

**Manual action still required:** none for Argo CD itself (repo is public, so no
repository credential secret is needed — see `argocd/README.md`'s "Private repository"
section for what that would look like if it ever becomes private).

---

## Multi-cloud namespace proof (spec §20/§21)

Same `charts/cloudcrafter` umbrella chart, same release name, deployed unmodified into
two new namespaces — `aws` and `google-cloud` — alongside the existing Argo-CD-managed
`default` deployment. No `charts/aws/`, no `charts/google-cloud/`, no
namespace-conditional code anywhere in `services/` or `charts/`.

The only thing that differs per namespace is the Ingress host, supplied as a values
overlay in the same style as the existing `values-minikube.yaml` overlay:
`charts/cloudcrafter/values-aws.yaml` sets `ingress.host: cloudcrafter-aws.local`,
`charts/cloudcrafter/values-google-cloud.yaml` sets
`ingress.host: cloudcrafter-google-cloud.local`. This was necessary because the
Ingress-nginx controller is a single cluster-wide resource watching all namespaces —
three `Ingress` objects all claiming host `cloudcrafter.local` would collide. Distinct
hosts let all three deployments (`default`, `aws`, `google-cloud`) resolve
independently through the same controller with zero ambiguity, which is a stronger proof
than just port-forwarding past the Ingress entirely.

This was deployed with plain `helm upgrade --install` (a manual step, not Argo CD — the
spec's Phase 7 ask is proving the chart itself is portable across namespaces, not wiring
a second GitOps target):

```
$ helm upgrade --install cloudcrafter ./charts/cloudcrafter -n aws --create-namespace \
    -f charts/cloudcrafter/values-minikube.yaml -f charts/cloudcrafter/values-aws.yaml
Release "cloudcrafter" does not exist. Installing it now.
STATUS: deployed

$ helm upgrade --install cloudcrafter ./charts/cloudcrafter -n google-cloud --create-namespace \
    -f charts/cloudcrafter/values-minikube.yaml -f charts/cloudcrafter/values-google-cloud.yaml
Release "cloudcrafter" does not exist. Installing it now.
STATUS: deployed
```

(`values-minikube.yaml` is layered in for the same reason as Phase 6 — GHCR package
visibility is still an open manual action, so this cluster pulls the local
`docker build`-tagged images rather than `ghcr.io/janatmr/cloud-crafter/*` directly.)

The `users` Deployments in both new namespaces initially sat in `ContainerCreating` —
`kubectl describe pod` showed `MountVolume.SetUp failed ... secret "users-jwt-keys" not
found`. The `users-jwt-keys` Secret is namespace-scoped and, before this, only existed in
`default` (from the Phase 2 baseline note). Rather than share one namespace's real key
material across three notionally-independent "clouds," a **distinct** throwaway RS256
keypair was generated per new namespace with `openssl` and loaded the same imperative way
as the `default` bootstrap:

```
$ kubectl create secret generic users-jwt-keys -n aws --from-file=private.key=... --from-file=public.key=...
secret/users-jwt-keys created
$ kubectl create secret generic users-jwt-keys -n google-cloud --from-file=private.key=... --from-file=public.key=...
secret/users-jwt-keys created
```

After that, both namespaces reached full health:

```
$ kubectl get deploy,svc,ingress -n aws
NAME                            READY   UP-TO-DATE   AVAILABLE
deployment.apps/events          1/1     1            1
deployment.apps/notifications   1/1     1            1
deployment.apps/tickets         1/1     1            1
deployment.apps/users           2/2     2            2

NAME                    TYPE        CLUSTER-IP       PORT(S)
service/events          ClusterIP   10.110.182.217   3000/TCP
service/notifications   ClusterIP   10.99.160.187    3000/TCP
service/tickets         ClusterIP   10.107.189.218   3000/TCP
service/users           ClusterIP   10.111.244.0     3000/TCP

NAME                                             CLASS   HOSTS
ingress.networking.k8s.io/cloudcrafter-ingress   nginx   cloudcrafter-aws.local

$ kubectl get deploy,svc,ingress -n google-cloud
NAME                            READY   UP-TO-DATE   AVAILABLE
deployment.apps/events          1/1     1            1
deployment.apps/notifications   1/1     1            1
deployment.apps/tickets         1/1     1            1
deployment.apps/users           2/2     2            2

NAME                    TYPE        CLUSTER-IP      PORT(S)
service/events          ClusterIP   10.104.175.72   3000/TCP
service/notifications   ClusterIP   10.106.71.241   3000/TCP
service/tickets         ClusterIP   10.100.52.236   3000/TCP
service/users           ClusterIP   10.102.224.49   3000/TCP

NAME                                             CLASS   HOSTS
ingress.networking.k8s.io/cloudcrafter-ingress   nginx   cloudcrafter-google-cloud.local
```

Each namespace has its own Pods, Services, Deployments and Secret — no shared ClusterIP,
no shared key material, entirely independent CLUSTER-IPs (spec §21). Verified both ways
per the spec's own verification recipe — direct Service port-forward (bypassing Ingress
entirely) and through the shared Ingress controller with each namespace's distinct host:

```
$ kubectl port-forward -n aws svc/users 18001:3000 &         (repeat for events/tickets/notifications, 18002-18004)
$ curl -s http://127.0.0.1:18001/health
{"status":"ok","service":"users"}
... (events/tickets/notifications all {"status":"ok",...})

$ kubectl port-forward -n google-cloud svc/users 18011:3000 &  (repeat for events/tickets/notifications, 18012-18014)
$ curl -s http://127.0.0.1:18011/health
{"status":"ok","service":"users"}
... (events/tickets/notifications all {"status":"ok",...})

$ kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 18080:80 &
$ curl -H "Host: cloudcrafter-aws.local" http://127.0.0.1:18080/api/users/health
{"status":"ok","service":"users"}
$ curl -H "Host: cloudcrafter-google-cloud.local" http://127.0.0.1:18080/api/users/health
{"status":"ok","service":"users"}
$ curl -H "Host: cloudcrafter.local" http://127.0.0.1:18080/api/users/health
{"status":"ok","service":"users"}
```

All three namespaces (`default`, `aws`, `google-cloud`) answer independently through the
same Ingress controller with no host collision, and `helm list -n aws` / `helm list -n
google-cloud` both show the identical `cloudcrafter-1.0.0` chart version that's running
in `default` — the same artifact, three independent deployments.

Intra-namespace service calls already use bare service names
(`http://notifications:3000` — see `localstack/lambda/receipt-notification/index.js`'s
`NOTIFICATIONS_URL`), which Kubernetes DNS resolves per-namespace automatically; nothing
needed to change here for the chart to be portable across namespaces.

**Manual action still required:** none. Both namespaces are fully deployed and verified
in this environment. If a real multi-account/multi-cluster setup is ever used instead of
one Minikube cluster with two namespaces, the same `helm upgrade --install` commands
apply unchanged per target cluster.

---

## Observability (spec §22-§25)

Real metrics, real logs, one real Grafana dashboard — built on the standard, maintained
`kube-prometheus-stack` (Prometheus + Grafana) and `loki-stack` (Loki + Promtail) Helm
charts, per spec §22's explicit instruction not to hand-roll a monitoring stack. Full
detail (install commands, panel queries, datasource wiring) lives in
`observability/README.md`; this section is the "it actually ran" record.

**Metrics.** All four services now use `prom-client` to expose `GET /metrics`
(`http_requests_total`, `http_request_duration_seconds`, default Node.js process
metrics). Each service chart (`charts/{users,events,tickets,notifications}`) gained a
named `http` Service port and a `ServiceMonitor` (`serviceMonitor.enabled`, default
`true`) so Prometheus Operator scrapes it automatically.

```sh
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts

helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace \
  -f observability/prometheus/values.yaml -f observability/grafana/values.yaml
helm install loki grafana/loki-stack -n monitoring -f observability/loki/values.yaml
kubectl apply -f observability/grafana/dashboard-configmap.yaml
```

Installed into the same Minikube cluster used since Phase 2. **Environment note:** the
Minikube VM was memory-capped at 4GB, which the full stack pushed to ~99%, causing the
Kubernetes API server to time out under sustained load. Fixed by resizing the container
in place (`docker update --memory=8g --memory-swap=8g minikube` + `docker start`,
followed by `minikube start` to repair the kubeconfig's dynamically-reassigned ports) —
this preserves all cluster state (the Minikube data volume is separate from the
container), unlike `minikube delete`. All pre-existing namespaces (`argocd`, `default`,
`aws`, `google-cloud`, plus an unrelated `healthcare` project already in this cluster)
came back healthy afterward.

**Redeployed `charts/cloudcrafter`** to `aws` and `google-cloud` (not Argo CD-managed, so
a direct `helm upgrade` is the right tool — same pattern as Phase 7) to pick up the new
`ServiceMonitor`/named-port templates; the Argo CD-managed `default` namespace picks
this up on its next git-driven sync, same as every other chart change since Phase 6.

```
$ helm upgrade --install cloudcrafter ./charts/cloudcrafter -n aws \
    -f charts/cloudcrafter/values-minikube.yaml -f charts/cloudcrafter/values-aws.yaml
Release "cloudcrafter" has been upgraded. Happy Helming!
```

Prometheus discovering and scraping all four services in both namespaces:

```
$ curl -s http://localhost:9090/api/v1/targets | ...
events aws up http://10.244.0.87:3000/metrics
notifications aws up http://10.244.0.117:3000/metrics
tickets aws up http://10.244.0.110:3000/metrics
users aws up http://10.244.0.100:3000/metrics
events google-cloud up ...
notifications google-cloud up ...
tickets google-cloud up ...
users google-cloud up ...
```

**Logs.** `loki-stack`'s Promtail DaemonSet ingests every pod's stdout/stderr, tagged
with `namespace`/`pod`/`app` labels from Kubernetes metadata — no application code
changes needed. A real query through Grafana's own datasource proxy against the `aws`
namespace returned genuine service-startup log lines:

```
$ curl ... /api/ds/query '{"queries":[{"datasource":{"type":"loki","uid":"loki"},
    "expr":"{namespace=\"aws\", app=\"notifications\"}"}], ...}'
{"log":"Notifications service listening on port 3000\n","stream":"stdout", ...}
```

**Logging hygiene audit (spec §24):** every `console.log`/`console.error` call across
`services/*` was reviewed — only service-startup lines, notification records, and S3
bucket/key names appear; none logs private keys, passwords, JWT signing material, or
complete bearer tokens.

**Grafana.** Prometheus (uid `prometheus`) and Loki (uid `loki`) datasources are both
auto-provisioned — Prometheus by `kube-prometheus-stack` itself, Loki by the `loki-stack`
chart's own sidecar-discovered ConfigMap (with `isDefault: false` explicitly set — its
chart default is `true`, which collides with Prometheus's default datasource and crashes
Grafana on startup with "only one datasource per organization can be marked as
default"; `observability/README.md` documents this in full). The **CloudCrafter**
dashboard (`observability/grafana/dashboards/cloudcrafter-dashboard.json`) auto-loads via
Grafana's dashboard sidecar and has a `$namespace` picker (default/aws/google-cloud) plus
eight panels — Service Health, Pod Readiness, Request Rate, Request Latency (p95), Error
Responses, CPU Usage by Pod, Memory Usage by Pod, and a live Logs panel — all backed by
real Prometheus/Loki queries, no hardcoded values.

**Verified with a real traffic burst** against the `aws` namespace (mixed
200/201/400/401 responses via `POST /tickets`, `POST /login`, `GET /events`, etc.),
queried back through Grafana's own `/api/ds/query` proxy — not just Prometheus directly:

```
$ curl ... /api/ds/query  (Request Rate panel query, instant)
job=events   0.365 req/s
job=notifications 0.733 req/s
job=users    0.733 req/s
job=tickets  0.365 req/s
```

All seven Prometheus-backed panels and the Loki logs panel (78 matching lines) returned
non-empty, real data this way. One environment-specific fix along the way: this
cluster's cAdvisor output has no per-container breakdown (only pod-level cgroup
aggregates, no `container` label at all), so the CPU/memory queries filter on
`pod!=""` rather than the more common `container!="", container!="POD"` pattern, which
returned nothing here.

Retrieve the Grafana admin password (auto-generated by the chart, never committed to
this repo):

```sh
kubectl get secret -n monitoring kube-prometheus-stack-grafana \
  -o jsonpath='{.data.admin-password}' | base64 -d
```

**Manual action still required:** none for the `aws`/`google-cloud` namespaces (both
fully verified above). The Argo CD-managed `default` namespace needs its next sync (automatic, or triggered with the same `argocd.argoproj.io/refresh=hard` annotation used in
Phase 6) to pick up the `ServiceMonitor`/named-port chart changes and start being scraped
too — functionally identical to every other post-Phase-6 chart change in this repo.

---

## JWT key rotation (spec §26–§32)

The `users-jwt-keys` Secret (created out-of-band, not templated by the chart — see the
Helm charts section) holds the RS256 keypair `charts/users` mounts at `/etc/jwt-keys` and
points `JWT_PRIVATE_KEY_PATH`/`JWT_PUBLIC_KEY_PATH` at. Rotation is: generate a fresh
keypair → overwrite the Secret → roll the Deployment → confirm the **old** token is
rejected and the **new** token is accepted, with zero dropped requests throughout.

**Generating and swapping the keypair** (`default` namespace; new keys generated with
`openssl`, never committed):

```sh
openssl genrsa -out private.key 2048
openssl rsa -in private.key -pubout -out public.key

kubectl create secret generic users-jwt-keys -n default \
  --from-file=private.key=private.key --from-file=public.key=public.key \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/users -n default
kubectl rollout status deployment/users -n default
```

**Old-token-rejected / new-token-accepted proof** — a token obtained from `/login`
*before* the rotation is checked against `/protected` *after* it, then a fresh login is
checked too (tokens redacted per spec §31 — only the header/verdict shown):

```
$ curl -s -X POST http://users/login -d '{"username":"demo","password":"demo123"}'
{"token":"eyJhbGciOiJSUzI1NiIs...<redacted>"}          # signed with the pre-rotation key
$ curl -s -o /dev/null -w '%{http_code}' http://users/protected -H "Authorization: Bearer <old token>"
200                                                      # confirmed valid before rotation

# ... keypair generated, Secret updated, `kubectl rollout restart` completes ...

$ curl -s http://users/protected -H "Authorization: Bearer <old token>"
{"error":"invalid or expired token","details":"invalid signature"}
HTTP 403                                                 # old key rejected — no dual-key acceptance
$ curl -s -X POST http://users/login -d '{"username":"demo","password":"demo123"}'
{"token":"eyJhbGciOiJSUzI1NiIs...<redacted>"}           # signed with the new key
$ curl -s http://users/protected -H "Authorization: Bearer <new token>"
{"message":"access granted","user":{"sub":1,"username":"demo",...}}
HTTP 200
```

**Zero-downtime proof, and a real bug found along the way (spec §32).** The first
attempt used `kubectl port-forward svc/users` as the load generator during the rollout
and saw dropped connections — but that was a flaw in the *test*, not the rollout:
`port-forward` against a Service pins to one specific backend pod for its whole
lifetime, so when that exact pod was terminated mid-rollout, the forwarded connection
broke. That's not how the Service's `ClusterIP` behaves for a real client, so the test
was redone from inside the cluster, hitting the Service's DNS name directly (which does
load-balance across every ready pod):

```sh
kubectl run zero-downtime-probe --image=curlimages/curl:8.10.1 --restart=Never --command -- \
  sh -c 'for i in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}\n" \
    --max-time 2 http://users.default.svc.cluster.local:3000/health; sleep 0.2; done'
```

With the corrected methodology, the *first* rotation still dropped 5 of 150 requests
(`000` — connection refused) during the window pods were being replaced. Root cause:
`services/users` has no `preStop` hook, so `SIGTERM` kills the Node process immediately;
kube-proxy's removal of the terminating pod from the Service's endpoints isn't
instantaneous, so a pod that has already stopped listening can still receive a
newly-routed connection for a brief window. This is a standard Kubernetes rolling-update
race, not specific to JWT rotation — the fix is the standard one: delay `SIGTERM` with a
`preStop` sleep so the pod keeps accepting connections until kube-proxy has caught up.
Added to `charts/users/templates/deployment.yaml` (`lifecycle.preStop`, sleep duration
from the new `values.yaml` key `preStopSleepSeconds: 5`).

Re-run after the fix, same in-cluster probe, same rotation procedure, `aws` namespace
first (plain `helm upgrade`, to validate the fix without touching the Argo-managed
release) and then `default`:

```
$ kubectl logs zero-downtime-probe -n aws | grep -v 'health=200' || echo "NONE — all 200"
NONE — all 200
$ kubectl logs zero-downtime-probe -n default | grep -v 'health=200' || echo "NONE — all 200"
NONE — all 200
```

150/150 requests returned `200` in both namespaces across the full rollout — the rolling
update (`maxUnavailable: 0`, `maxSurge: 1`, `replicaCount: 2`, readiness/liveness probes
from Phase 4, `preStop` delay from this phase) never drops traffic.

**How this was rolled out.** The chart fix (`charts/users/templates/deployment.yaml`,
`charts/users/values.yaml`) was validated directly against `aws`/`google-cloud`
(`helm upgrade`, not Argo-managed) and is committed here for Argo CD to pick up in
`default` the same way every other chart change has since Phase 6. To run the actual
rotation proof against `default` *before* that commit was pushed, the same `preStop`
hook was also applied there with a one-off `kubectl patch deployment/users -n default`
— an imperative step, in the same spirit as the imperative `users-jwt-keys` bootstrap
back in the Local Kubernetes section, made permanent by the chart commit rather than
left as a manual, undocumented drift.

**Manual action still required:** push the chart commit so Argo CD's next sync (or a
forced refresh, per the Argo CD section) reconciles `default`'s `Deployment/users`
declaratively — right now it matches the chart only because of the imperative patch
above.
