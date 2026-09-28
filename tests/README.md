# Catalogue v2 tests

```bash
npm test
```

That starts a backend of its own, pointed at a **throwaway database**, runs both
suites against it, and shuts it down.

## Why a separate database

Both suites **delete every v2 catalogue row before they run**. Their assertions
depend on an exact starting state — *"3 colours × 2 storages = 6 items"*,
*"the facet shows 3 values"* — and leftover rows make those lie.

That is correct for a test suite and destructive if aimed at real data.

**Using a different port is not enough.** Two servers on different ports share
one database if the connection string is the same:

```
:5051  →  mongodb://localhost:27017/enterprise_platform      ← your app
:5099  →  mongodb://localhost:27017/enterprise_platform      ← same rows!
```

During development this wiped a live catalogue twice. Soft delete made it
recoverable both times, which was luck, not design — the cleanup helpers use
`deleteMany` directly, and anyone using the app at that moment would have seen
an empty screen.

So the runner sets the database, not just the port:

```
:5099  →  mongodb://localhost:27017/enterprise_platform_test
```

## The guard

`run_tests.py` refuses to start if the target database name does not contain
`test`, or if it matches the `MONGODB_URI` already in `.env`. That makes the
mistake above impossible rather than merely discouraged.

## Configuration

| Variable | Default | |
|---|---|---|
| `TEST_DB` | `enterprise_platform_test` | Must contain "test" |
| `TEST_PORT` | `5099` | Any free port |
| `TEST_MONGO_HOST` | `mongodb://localhost:27017` | |
| `TEST_API` | set by the runner | Base URL a suite talks to |

## The suites

**`v2_regression.py`** — the full catalogue: types and field definitions,
category inheritance, the variant matrix, multi-axis filtering and facets,
unpriced products, charge arithmetic including tax-on-a-fee, the six
availability strategies, slots and bookings, referential integrity, soft delete
and restore, partial SKU uniqueness, and open choice fields.

**`v2_crud.py`** — every edit, delete and restore the UI can reach, each check
named after the control it backs.

Run one directly if you need to, but start the server yourself first:

```bash
MONGODB_URI=mongodb://localhost:27017/enterprise_platform_test PORT=5099 npx tsx src/server.ts
TEST_API=http://localhost:5099 python tests/v2_regression.py
```
