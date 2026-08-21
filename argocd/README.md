# Argo CD (Phase 6 — spec §19)

GitOps sync for the `cloudcrafter` umbrella chart. Argo CD — not GitHub Actions — owns
deployment to the cluster (spec §18 boundary): CI only tests/builds/pushes images and
updates chart values in git; Argo CD reconciles that desired state into Kubernetes.

## What's here

```
argocd/
├── application.yaml   # the Argo CD Application resource
└── README.md          # this file
```

## Installing Argo CD (one-time, per cluster)

Standard upstream manifest install — no custom build, per spec:

```sh
kubectl create namespace argocd
kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml \
  --server-side --force-conflicts
```

`--server-side` is required here: the stock manifest's `applicationsets.argoproj.io` CRD
carries an annotation payload larger than the 256 KiB client-side
`last-applied-configuration` limit, so a plain `kubectl apply` fails on that one CRD.
Server-side apply doesn't store that annotation and applies cleanly.

Wait for the control plane to come up:

```sh
kubectl -n argocd wait --for=condition=available --timeout=180s \
  deployment/argocd-server deployment/argocd-repo-server \
  deployment/argocd-applicationset-controller deployment/argocd-redis \
  deployment/argocd-dex-server
```

## Registering the Application

```sh
kubectl apply -f argocd/application.yaml
```

This is the one allowed manual `kubectl apply` (spec §18: acceptable for local
setup/debugging) — it registers the Application *once*; every subsequent deployment
change flows through git + Argo CD's own sync loop, not manual `kubectl`/`helm`.

`application.yaml` points at:

- **repo**: `https://github.com/janatmr/cloud-crafter.git` (public — no credential
  needed; see "Private repository" below if that ever changes)
- **path**: `charts/cloudcrafter` (the umbrella chart, never `k8s/`)
- **targetRevision**: `main`
- **destination**: the `default` namespace in the same cluster Argo CD runs in
- **helm valueFiles**: `values-minikube.yaml`, the same local-Minikube image overlay
  used in Phases 2/4, since this cluster has no route to pull the real
  `ghcr.io/janatmr/cloud-crafter/*` images the Phase 5 CI release job publishes
- **syncPolicy**: `automated` with `prune: true` and `selfHeal: true` — Argo CD both
  applies new commits automatically and reverts any manual drift in the live cluster
  back to what's in git

## Verifying sync

Via the CLI (`argocd` CLI is not installed in this environment, so verification uses
`kubectl` against the `Application` custom resource instead):

```sh
kubectl -n argocd get application cloudcrafter
kubectl -n argocd get application cloudcrafter -o jsonpath='{.status.sync.status} {.status.health.status}{"\n"}'
```

Expect `Synced Healthy`. `kubectl get pods,deploy -n default` should show the four
services running with the images/replica counts declared in
`charts/cloudcrafter/values-minikube.yaml`.

Via the UI: port-forward and open `https://localhost:8080` (initial admin password is
in the auto-generated `argocd-initial-admin-secret`, which should be deleted after
first login per upstream's own guidance):

```sh
kubectl -n argocd port-forward svc/argocd-server 8080:443
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

## Proving GitOps end-to-end (no manual kubectl/helm deploy)

1. Change something in `charts/cloudcrafter/**` (e.g. bump a `replicaCount`) and commit
   + push to `main`.
2. Within the sync loop's polling interval (default 3 min) — or immediately with
   `kubectl -n argocd patch application cloudcrafter --type merge -p '{"operation":{"sync":{"revision":"HEAD"}}}'`
   to force it — Argo CD detects the new commit and reconciles the cluster to match.
3. Confirm with `kubectl get pods,deploy -n default` and the `Application` status above
   — no `kubectl apply`/`helm upgrade` was run by hand for the change itself.

## Private repository

This repo is public, so no repository credential is configured. If it were private,
the credential would be added declaratively as a `Secret` labeled for Argo CD
(`argocd.argoproj.io/secret-type: repository`) with `repoURL`/`username`/`password` (or
an SSH `sshPrivateKey`) — never embedded in `application.yaml` itself:

```sh
kubectl apply -n argocd -f - <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: cloudcrafter-repo-creds
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  type: git
  url: https://github.com/janatmr/cloud-crafter.git
  username: <redacted>
  password: <a GitHub PAT, redacted>
EOF
```
