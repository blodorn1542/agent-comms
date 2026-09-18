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

Quo's response envelope has not yet been seen against a live workspace.
`adapters.quo.probe(tenantId)` calls each endpoint and reports the keys that
actually came back, so `FIELDS` is corrected from evidence. One gotcha already
caught from the docs: Quo authenticates with the **bare API key**, not
`Bearer <key>`.

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

26 tests, one per guardrail. They are the specification — each fails loudly if
someone loosens the thing it guards.
