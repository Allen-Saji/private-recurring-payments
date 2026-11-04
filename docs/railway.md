# Railway deployment

The root Dockerfile builds the Rust wallet and web application from source, then packages them with Node 22. Deploy one service with one persistent volume mounted at `/state`. The application runs as the unprivileged `node` user after the entrypoint prepares the volume root. A filesystem lock prevents two application processes from sharing that state.

Public testnet instance: [tandem-production-5e00.up.railway.app](https://tandem-production-5e00.up.railway.app).

## Configuration

Set these service variables before deployment:

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | Exact public HTTPS origin, without a trailing slash |
| `PORT` | `8080`; configure the Railway domain to target this port |
| `APP_HOST` | `0.0.0.0` |
| `APP_STATE_DIR` | `/state` |
| `PRP_BINARY` | `/usr/local/bin/prp` |
| `MAX_ACCOUNTS` | Initial account limit appropriate to measured capacity |
| `JUDGE_EVIDENCE_FILE` | Optional `/state/review-evidence.json` |

Railway supplies `RAILWAY_VOLUME_MOUNT_PATH`. The entrypoint refuses to start if it does not match `APP_STATE_DIR`. Do not set that platform variable manually to bypass this check. The image contains no wallet state, credentials or review evidence.

Use the root Dockerfile, one replica, `/healthz` as the deployment health path, a 120-second health timeout and an on-failure restart policy. Keep server sleeping disabled: recurring payments need the worker to run without browser traffic. The checked-in `railway.json` specifies build and health settings. Railway CLI currently warns that this configuration format is supported only until December 1, 2026; migrate it to Railway's infrastructure-as-code format before that date.

`/healthz` reveals process availability only. Railway's healthcheck hostname is allowed exclusively on that endpoint for GET/HEAD requests. Account and wallet routes retain their canonical Host and Origin checks. Chain connectivity and settlement require separate verification.

## Persistent data and review access

All accounts, wallet seeds, SQLite databases, signed authorizations and payment outboxes live on the volume. Redeploying the image must preserve them. Never use ephemeral container storage for this directory. Back up the entire state consistently while the application is stopped; restoring stale spending reservations remains unsafe. See [workspace operations](workspaces.md#public-testnet-operation).

To enable review access, export selected real testnet records using the instructions in [recorded review access](workspaces.md#recorded-review-access), upload that JSON file to the private volume, and configure its path. The public review account can read every record in that export, so select the evidence deliberately. Do not upload source wallet directories or private keys to enable judge access.

## Release verification

Before opening registration to testers:

1. Confirm HTTPS pages, agent discovery and public metadata use the deployed origin.
2. Confirm the review account reads genuine evidence and receives 403 for mutations.
3. Create a fresh owner account and confirm wallet initialization reaches NU7 testnet.
4. Fund it through Noir, authorize a bounded agreement, and verify the supplier's decrypted receipt.
5. Restart the service and verify account, session, invoice and outbox persistence.
6. Measure proof-generation peak memory and wallet storage growth before increasing account limits.

Limited Trial networking and memory can prevent wallet operations even when the landing page passes health checks. No deployment is payment-verified solely because its HTTP health check passes. Railway is part of the trusted hosting boundary because this release uses service-managed keys. Mainnet remains disabled.

Platform references: [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [volumes](https://docs.railway.com/volumes/reference), [health checks](https://docs.railway.com/deployments/healthchecks), [trial restrictions](https://docs.railway.com/pricing/free-trial).
