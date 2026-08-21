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
- [ ] Phase 3 — LocalStack event flow
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

Remaining sections (Local Kubernetes, LocalStack, Helm, Argo CD, Multi-cloud,
Observability, JWT rotation, Verification) are added as their phases complete.
