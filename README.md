# agent-comms

The shared communication layer for the agent platform. One interface agents
call; providers are interchangeable adapters behind it.

Nickel, Buck and Penny all say "send this for tenant X". None of them learns it
was Gmail. Adding Microsoft 365 or Twilio later is one new adapter in
`lib/adapters/` and **zero agent changes** — that indirection is the whole point
of this package. Without it, every agent gets rewritten for every provider.

The dependency runs one way only. This package knows nothing about any agent
that uses it: no invoices, no findings, no collections tiers.

## Sending is off

Nothing is transmitted unless **every** gate opens:

| Gate | Default | Where |
|---|---|---|
| Global send switch (`COMMS_SEND_ENABLED === 'true'`, or `sendEnabled` passed in) | **off** | `lib/interface.js` |
| The tenant's `comms.sendEnabled` | **off** | caller's config |
| An approval record naming a human | absent | `lib/interface.js` |
| Recipient has not opted out | enforced | `lib/store.js` |
| Inside the tenant's send window | enforced, in the tenant's timezone | `lib/interface.js` |

`send()` reports **every** closed gate, not just the first, so "why didn't this
send" is never a guess. With the defaults it is a drafting function: it writes a
queued row and returns.

A host can pin the switch off regardless of the environment:

```js
createComms({ db, sendEnabled: false })
```

## Adapters

| Adapter | Direction | Notes |
|---|---|---|
| `gmail` | outbound | Per-tenant OAuth; sends from the client's own address. `transmit()` exists and is unreachable until the gates open. |
| `quo` | inbound, read-only | Quo (formerly OpenPhone). Exports **no** `transmit()` — it cannot send by construction, not by configuration. Safe to run live. |

### Quo

Verified 2026-09-18 against Quo's published OpenAPI 3.1 spec and the docs at
`quo.com/docs`:

| | |
|---|---|
| Base | `https://api.quo.com` (paths carry their own `/v1`) |
| Auth | `Authorization: <API_KEY>` — the **bare key**, *not* `Bearer <key>` |
| Rate limit | 10 requests/second per key (the adapter throttles to ~8/s) |
| Key | Quo → Settings → API. Owner or Admin only. |

Three things the spec makes non-obvious, each of which will silently ingest
nothing if you get it wrong:

1. `direction` is `"incoming"` / `"outgoing"` — **not** `"inbound"` /
   `"outbound"`. Filtering on the wrong word matches every row and stores none.
2. `GET /v1/messages` and `GET /v1/calls` both **require** `phoneNumberId`
   *and* `participants`. There is no "everything on this number" call, so
   `poll()` walks `/v1/conversations` first to learn who the participants are.
3. `maxResults` is required (1–100); lists come back as
   `{ data, totalItems, nextPageToken }` with a nullable token.

Two more the spec does *not* state, found only by running against the live API
(2026-09-18, elite-pools):

4. **`participants` accepts at most one number.** The spec types it as an
   unbounded array; the server answers `400 "Expected array length to be less
   or equal to 1"`. A group conversation must be split into one request per
   counterparty, so `poll()` flattens conversations to a distinct set of
   counterparties and walks those.
5. **A missing call summary is a `404`, not a plan limit.** On an account where
   summaries demonstrably work, `404` is the ordinary answer for a call Quo
   never summarized (no-answer, very short, or outside its summarization
   window) — in the elite-pools run, 46 of 101 incoming calls. Only `402`/`403`
   mean the plan or the key. Treating `404` as a plan limit reports a billing
   problem that does not exist.

A call with no summary is still ingested, with `body` left null.

**Read-only by construction.** The adapter exports no `transmit()`, and every
request funnels through `assertReadOnlyPath()`, which rejects any non-`GET` and
any write-capable Quo path (`/v1/webhooks`, `/v1/tasks`, `/v1/contacts`,
`mark-as-*`) before a socket is opened. `test/comms.test.js` drives a full
`poll()` and `probe()` through a recording fetch and asserts the set of HTTP
verbs used is exactly `['GET']`.

```
cp .env.example .env     # then put the key in QUO_API_KEY
npm run verify:quo       # probes, polls, prints a sample. Reads only.
```

`QUO_API_KEY` resolves per-tenant storage first, then
`createComms({ quo: { apiKey } })`, then the environment — so the same build
runs multi-tenant locally and single-tenant on Railway with the key in
Variables. `.env` is gitignored (as is any `*.env`); never commit a key.

## Use

```js
const { createComms } = require('agent-comms');

// Sharing the host's database and its existing credential storage.
const comms = createComms({ db, connections });

// Or fully self-contained.
const comms = createComms({ dbPath: '/data/comms.db' });

await comms.draft({ tenant: 'elite-pools', to: 'customer@example.com',
                    subject: 'Past due', body: '...' });

await comms.pollAll({ tenant: 'elite-pools', config });
```

### Options

| Option | Meaning |
|---|---|
| `db` | An open `node:sqlite` handle. Comms adds `comms_*` tables beside yours and touches nothing else. |
| `dbPath` | Where to open one, if you have no database of your own. |
| `connections` | Credential storage port — `save` / `get` / `remove`. See `lib/connections.js`. Omit it and comms keeps its own `comms_connections` table. |
| `sendEnabled` | Global kill switch. Omit and the environment decides; pass `false` to pin it off. |
| `gmail` | `{ clientId, clientSecret, redirectUri }`, falling back to `GMAIL_*` env vars. |
| `quo` | `{ apiKey }`, falling back to `QUO_API_KEY`. Per-tenant stored keys win over both. |
| `fetchImpl` | Injectable `fetch`, for tests. |

## Storage

Every table this package creates is prefixed `comms_`, so it can share a
database file with its host without either side knowing the other's schema. A
test asserts this. If your host keeps a proof-of-silence counter in its own
tables, a queued draft is not a send and must never be written there.

## Tests

```
npm test
```

34 tests, one per guardrail. They are the specification — each fails loudly if
someone loosens the thing it guards.
