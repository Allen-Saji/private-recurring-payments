# Recurring agreement operator guide

The signer permits one fixed payment in the current eligible period of an installed agreement. The execution agent cannot install agreements, revoke them, choose an unapproved destination, override time, submit a PCZT, or export a key.

This implementation is for testnet. The demo uses separate company approval keys, not two human approvers or threshold custody. The signer host remains trusted.

## Authorization format

An envelope contains `payload` and `signatures`. Each signature has a lowercase public `key` and hexadecimal `signature`. The signed message is:

```text
UTF8(domain) || 0x00 || RFC8785_CANONICAL_JSON(payload)
```

Domains are `private-recurring/agreement/v1`, `private-recurring/invoice/v1`, and `private-recurring/revoke/v1`. Every payload binds company, signer instance, and `zcash-testnet`. Unknown fields, duplicate JSON properties, malformed Unicode, unsafe amounts and oversized envelopes are rejected. Amounts are canonical integer zatoshi strings. Ed25519 strict verification uses `ed25519-dalek`; canonicalization uses `serde_jcs`.

The local trust file pins exactly two distinct company approval keys and one revocation key. The ledger pins that complete trust configuration; changing the file does not silently replace authority. Both company keys must sign identical agreement bytes. Supplier invoices require the separate supplier key retained in the approved agreement.

Supported agreement terms include exact recipient/amount, lifetime budget, absolute fee cap, action cap, validity interval and schedule. Destinations must be testnet Unified Addresses containing only an Orchard receiver; the payment pool is Ironwood. Version 1 is immutable. Amendments and schedule migration are rejected.

Calendar-month schedules use UTC month boundaries and a signed payment window of up to 28 days. Testnet-only fixed intervals support 60-86,400 seconds. The signer derives the current period from its own system clock. It does not catch up missed periods. The clock and host are trust dependencies.

## Local approval example

Initialize and fund the operating/supplier wallets as described in the README. Use a fresh demo directory; keys and messages are created exclusively and existing files are never overwritten by these commands.

```sh
cargo build --locked --bins --examples
export WALLET_STATE_DIR="$HOME/.local/share/private-recurring-testnet"
export COMPANY_DEMO_DIR="$HOME/.local/share/private-recurring-company-demo"

target/debug/examples/policy_demo init "$WALLET_STATE_DIR" "$COMPANY_DEMO_DIR"

target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" policy sign \
  --kind agreement --input "$COMPANY_DEMO_DIR/agreement.unsigned.json" \
  --key "$COMPANY_DEMO_DIR/keys/owner-a" \
  --out "$COMPANY_DEMO_DIR/agreement.one-approval.json" --approve

target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" policy sign \
  --kind agreement --input "$COMPANY_DEMO_DIR/agreement.one-approval.json" \
  --key "$COMPANY_DEMO_DIR/keys/owner-b" \
  --out "$COMPANY_DEMO_DIR/agreement.approved.json" --approve

node agent/verify-envelope.mjs "$COMPANY_DEMO_DIR/agreement.approved.json" private-recurring/agreement/v1

target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" policy init \
  --trust "$COMPANY_DEMO_DIR/trust.json"
target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" policy install \
  --agreement "$COMPANY_DEMO_DIR/agreement.approved.json"
```

The example creates disposable approval keys outside signer state and an agreement for 0.01 TAZ per two-minute interval. The lifetime budget is 0.033 TAZ, including maximum fee reservations. The trusted CLI displays exact canonical terms before writing each approval. The Node verifier independently checks Rust signature/canonicalization interoperability; it is not the authority that decides which public keys are trusted.

## Durable occurrence ledger

The uniqueness key is `(company, agreement_id, period_id)`. Agreement version and invoice ID cannot reset it. A replacement invoice for a consumed period is rejected. An identical retry returns the existing payment ID/state, including after invoice expiry or revocation; it grants no new signature.

SQLite uses write transactions, uniqueness constraints, WAL, and FULL synchronization. Charge plus maximum fee is reserved before wallet work. Pending and confirmed reservations both count against the lifetime limit; unused fee allowance is conservatively retained. The first implementation does not release failed reservations automatically.

The lifecycle is:

```text
reserved -> signing -> signed_durable -> broadcast_unknown -> confirmed
```

The `signing` transition is the durable authorization cutoff. The signer rechecks validity and revocation after proving, immediately before that transition. Revocation and this transition share the same SQLite write serialization. Revocation wins if committed first; an earlier authorized payment may still settle. The acknowledgement reports previously authorized occurrences.

Signed PCZT bytes are synchronized to disk before wallet extraction. Raw transaction bytes, identity and checksum are then saved; the ledger records the artifact hash before release. Broadcast is marked uncertain before the network call. A restarted worker recovers the same artifact. It never builds a replacement because submission timed out.

New signing stops when another occurrence has unresolved signing state. Orphan artifact directories and ledger/artifact mismatches also stop execution. A crash with no durable signature may require operator review. These checks do not defeat a coordinated host-level rollback of every state store; backup restoration requires review, not automatic resumption.

## Transaction inspection

Before signing, the adapter verifies the exact value-bearing external output, internally derived change, value/note commitments, spend ownership, fee, action count, consensus branch, V6 format, locktime and bounded expiry. It decrypts every value-bearing output using sender recovery or the internal incoming viewing key, checking ciphertext contents against the metadata and the expected memo.

Earlier diagnostic agreement payments used a salted hash prefixed `prp:v1:`. New reservations use `prp:v2:` and a deterministic hash of the signed invoice, whose supplier-generated ID contains 256 random bits. The supplier can independently derive this binding. Retained v1 artifacts remain unchanged. Company names, invoice IDs and URLs are not placed in memo plaintext. The final transaction is checked again before release. Unsupported transparent, Sapling or mixed transaction shapes fail closed.

The supplier test scanner separately decrypts the mined output and verifies amount/memo. `confirmed` is a recorded chain observation, not irreversible finality. Status checks attempt reconciliation; unavailable or failed observations return `verification_pending`. Reservations survive reorgs and uncertainty. The supplier service makes its own entitlement decision using a separate wallet and fresh decryption. See backend-api.md. Signer status uses the operating wallet and retained bytes; it never grants supplier access.

## Isolated execution service

Generate an execution capability without printing it:

```sh
export PRP_RPC="$HOME/.local/share/private-recurring-rpc"
mkdir -p "$PRP_RPC"
chmod 700 "$PRP_RPC"
python3 - <<'PY'
import os, secrets
p = os.path.join(os.environ['PRP_RPC'], 'execution.token')
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(secrets.token_hex(32))
    f.flush()
    os.fsync(f.fileno())
PY

export PRP_STATE="$WALLET_STATE_DIR"
export PRP_BINARY="$PWD/target/debug/private-recurring-wallet"
export PRP_INVOICES="$COMPANY_DEMO_DIR/messages"
docker compose -p prp-backend -f deploy/compose.yaml up -d signer
```

The pinned Ubuntu runtime was tested with the Linux x86-64 binary built on Ubuntu-compatible glibc. Build for a compatible runtime when using another host. The signer runs as an unprivileged UID, with a read-only root, all Linux capabilities dropped, and no privilege escalation. Its state mount is writable. The agent runs separately with no network, wallet-state mount, approval-key mount or Docker socket. It sees only signed invoices and the execution socket/capability.

The RPC is length-prefixed JSON: four-byte big-endian length followed by at most 32 KiB. Authentication uses a constant-time comparison of token hashes. Only `submit`, `status`, and the bounded read-only `overview` are accepted. Request reads and response writes have deadlines; concurrency is bounded. There is no network administration endpoint. Stale Unix sockets are archived on restart under an exclusive endpoint lock, preserving the same client endpoint.

Create an invoice for the current period and run the agent:

```sh
target/debug/examples/policy_demo invoice "$WALLET_STATE_DIR" "$COMPANY_DEMO_DIR" renewal-1
docker compose -p prp-backend -f deploy/compose.yaml run --rm --entrypoint node agent \
  /app/run.mjs /rpc/signer.sock /rpc/execution.token /invoices/renewal-1-valid.json
```

The execution loop submits the signed invoice and polls for a verified receipt. It never creates a replacement invoice to bypass refusal. For durable invoice collection and recurring execution, use agent/renew.mjs through the separate backend Compose file documented in backend-api.md. Neither runner is an LLM integration.

## Recovery and revocation

An operator can exercise the save-before-broadcast boundary with `policy prepare --invoice FILE`, exit, and submit the same invoice through a new service process. This was exercised on testnet. Exact retries of an uncertain submission return its recorded state; they do not silently resubmit. An operator may explicitly run `policy rebroadcast PAYMENT_ID`, which checks and submits only the retained bytes. Expiry requires manual reconciliation; automatic replacement is absent.

```sh
target/debug/examples/policy_demo revoke "$WALLET_STATE_DIR" "$COMPANY_DEMO_DIR"
target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" policy revoke \
  --revocation "$COMPANY_DEMO_DIR/revocation.json"
```

The revocation is terminal. Reinstalling the same agreement does not reactivate it. Already authorized or settled payments remain in the ledger.

## Verification limits

Rust tests cover signature/domain and JSON boundaries, calendar periods, invoice mismatches, duplicate and concurrent reservations, lifetime limits, restart persistence, changed trust/schedules, expiry at signing, simulated SQL-write failure, revocation ordering, supplier entitlement expiry, persistent supplier invoice identity, receipt reuse and missing or altered artifact detection. Container probes exercised invalid execution credentials, oversized requests and forbidden administration/key operations. Two real payments in distinct testnet periods were received under one approved agreement; restart recovery, changed invoices, duplicate IDs and terminal revocation were exercised.

Production encrypted custody, hardware-backed approvals, independent security review, exhaustive crash/disk fault injection, amendment handling and automatic expiry recovery are not claimed.
