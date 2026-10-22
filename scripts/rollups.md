# Canonical usage facts and hourly aggregates

## Data path

```
entities → dirty canonical identities → normalized usage_facts
                                             ↓ statement-level database triggers
                                         usage_hourly
```

Ingestion locks a tenant's usage generation, applies the batch's entity updates,
and refreshes affected canonical facts before committing. The existing canonical
rules are shared with the retained raw analytics implementation: steps replace
message usage, and auxiliary attempts are excluded when matching assistant-message
usage exists. Entity triggers track both old/new identities and deduplication
dependants, including fallback messages and affected auxiliary attempts.

INSERT/UPDATE/DELETE statement triggers on `usage_facts` use transition tables to
combine signed contributions by UTC hour and dimensions. They apply the combined
updates in a consistent key order. A fact update subtracts the old contribution and
adds the new one; empty hourly rows are removed. All changes commit or roll back
together. No extension or scheduled refresh is required.

The app eagerly drains dirty identities during ingestion. Direct SQL entity changes
also mark identities dirty and are reconciled by the next uncached analytics read.
The existing 10-second result caches still apply to external changes that bypass the
application's cache-invalidation hooks.

## Representation and query semantics

- Facts retain entity identity, session, timestamp, normalized dimensions, a versioned
  34-number contribution vector, duration, and visible output tokens. Raw telemetry
  payloads are not duplicated into facts.
- Hourly dimensions retain installation, project, provider/model, machine, agent,
  status, historical flag, account/credential attribution and labels. Sessions stay
  on facts rather than fragmenting all hourly aggregates by session.
- The vector stores sums **and known-value counts**, so missing measurements remain
  distinguishable from measured zero. Ratios are derived from numerator/denominator
  sums, not averaged from ratios. Account/key distinctness is reconstructed from
  dimension identities.
- Exact duration/output frequency maps preserve the existing percentile and output
  histogram semantics. They are not approximate sketches or averaged percentiles.
- Complete hours are read from `usage_hourly`; partial first/last hours use exact
  timestamp-filtered facts. Overlapping boundaries are queried once. Session-scoped
  requests use canonical facts directly. All existing filters remain supported.
- Hourly contributions combine into existing hourly, six-hour, daily, epoch-anchored
  weekly, and calendar-monthly chart intervals.
- Tenant RLS is enabled and forced on facts, buckets, dirty identities, and readiness
  state. The catalog version is global metadata, with no tenant payloads.

Usage totals, breakdowns, charts, and output distributions use this path. Transport
attempt correlation/context statistics remain a separate operation on attempts.
`analyticsLegacy()` is retained as a diagnostic/parity oracle. Profiling and physical
clustering scripts explicitly use that raw implementation; the main analytics
benchmark exercises the current rollup path.

## Rules and reconciliation

Alias, price, and account-assignment triggers invalidate the tenant's fact generation.
Market-catalog changes increment a global generation. An out-of-date generation is
rebuilt on the next usage refresh. Format version 1 is also checked; normalization
changes require a version bump or an explicit rebuild.

With `DATABASE_URL` configured for the application role:

```sh
# Initial backfill or refresh outstanding source changes; also applies migrations.
node --import tsx scripts/reconcile-usage.ts

# Recreate facts and buckets from source entities, repairing aggregate drift.
node --import tsx scripts/reconcile-usage.ts --rebuild

# Additionally compare seven-day/all-history responses to the raw implementation.
node --import tsx scripts/reconcile-usage.ts --verify
```

Rebuilds are atomic per tenant and share the ingest/read lock. Both old-fact deletion
and new-fact insertion are bounded to 2,000-row batches; one enormous transition table
proved prohibitively expensive in the copy experiment. Rebuilds explicitly clear
hourly state after deleting facts, so pre-existing drift is repaired, not preserved.
The maintenance command refreshes statistics afterward. A full rebuild can temporarily
delay that tenant's ingestion and uncached analytics; ordinary incremental refreshes
touch only affected identities. On the production-sized copy, a full replacement
rebuild took about 29 seconds; production's initial backfill took about 18 seconds.

## Verification and benchmark — 2026-10-21

All 45 tests passed, including parity across time boundaries/filters, corrections,
deletions restoring canonical fallbacks, pricing/catalog changes, rebuilding corrupted
bucket counts, transaction rollback, Unicode/escaped dimensions, and tenant isolation.

A disposable copy contained 463,721 source entities. Backfilling produced **101,462
canonical usage facts and 6,000 hourly rows**. The following are three-sample uncached
function medians; implementation order alternated, and both implementations' process
caches were cleared before each sample. PostgreSQL buffers were not flushed.

| Range | Matching calls | Raw implementation | Hourly implementation |
| --- | ---: | ---: | ---: |
| 1 day | 640 | 71 ms | 56 ms |
| 7 days | 8,030 | 529 ms | 319 ms |
| 30 days | 33,407 | 1,750 ms | 780 ms |
| 90 days | 77,145 | 3,199 ms | 962 ms |
| All history | 101,462 | 4,055 ms | 1,402 ms |

All response comparisons passed with a small floating-point summation tolerance.
Copy-only ingest benchmarks (including automatic maintenance) measured **25 ms** for
one event, **78 ms** for 25 events, and **282 ms** for 100 events. Synthetic data was
removed afterward. Reproduce only on a disposable `observatory_rollup_benchmark_*`
database using `node --import tsx scripts/benchmark-rollups.ts` after applying migrations,
backfilling, and analyzing the copied source tables.

After deployment, authenticated public HTTPS requests returned complete HTTP 200
responses in 697 ms (7 days), 939 ms (30 days), 1,451 ms (90 days), and 1,159 ms (all).
These are individual observations, not load-test percentiles. Production seven-day
and all-history results also matched the raw implementation before deployment.

A separate production all-history wire measurement read **6,000 hourly rows in
5,334,415 bytes**, versus 79,845,960 bytes for canonical raw usage in the earlier
loading profile: about **93% less usage-result traffic**. Attempt/correlation traffic
remains separate; total measured database traffic was about 27.5 MiB instead of the
earlier 97.9 MiB. Database storage was approximately 113 MB of fact data + 34 MB of
fact indexes, and 9.5 MB of hourly data + 0.8 MB of hourly indexes.
