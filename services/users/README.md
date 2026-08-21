# users service

Handles login and RS256 JWT-based authentication.

## Security note

The RSA keypair originally committed to this repo (`private.key` / `public.key`) was
checked into git history and must be treated as permanently compromised. It has been
removed from the tracked tree; `*.key` is now gitignored. **Never commit a real
private key.**

## Local development

Generate your own dev keypair (not committed):

```sh
openssl genrsa -out private.key 2048
openssl rsa -in private.key -pubout -out public.key
```

Key paths are configurable via env vars (see `.env.example`):

- `JWT_PRIVATE_KEY_PATH` — defaults to `./private.key`
- `JWT_PUBLIC_KEY_PATH` — defaults to `./public.key`

In Kubernetes these point at a mounted `users-jwt-keys` Secret instead of files in the
image.

## Demo credentials

`demo` / `demo123` — in-memory only, for local/demo use.
