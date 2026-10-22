# Analytics performance baseline — 2026-10-21

Measured against the production database through a separate, read-only diagnostic
process running on the host. The application was not redeployed or modified by this
benchmark. The database was not isolated from normal activity, and PostgreSQL buffers
were not flushed. These are diagnostic timings, not latency guarantees.

Three samples per completed operation; process-local caches cleared before each
uncached sample. Each sample was immediately repeated without invalidation. SQL/driver
time includes row transfer and decoding. Function time excludes JSON serialization,
HTTP, proxy transfer, and browser rendering. Payload sizes are uncompressed JSON.

The table below is from the subsequent component-profiled run on the same date.
Moving windows contain slightly different records from the initial run.
For analytics, the result column lists representative outputs; the component table
below details the remaining outputs. Matching calls are inputs, not returned rows.

| Operation | Uncached median | SQL/driver median | Repeat median | Returned results | Payload |
| --- | ---: | ---: | ---: | --- | ---: |
| Analytics, 1 day | 142 ms | 112 ms | 0.2 ms | 1 total; 2 model groups; 25 total-time points | 69 kB |
| Analytics, 7 days | 1,162 ms | 907 ms | 0.5 ms | 1 total; 16 model groups; 29 total-time points | 440 kB |
| Analytics, 30 days | 3,590 ms | 2,585 ms | 0.2 ms | 1 total; 37 model groups; 31 total-time points | 1,025 kB |
| Analytics, 90 days | SQL statement timeout | — | — | No successful response | — |
| Analytics, all history | 7,048 ms | 4,454 ms | 0.3 ms | 1 total; 95 model groups; 20 total-time points | 1,689 kB |
| Analytics, 7 days, model filter | 657 ms | 499 ms | 0.2 ms | 1 total; 2 model groups; 29 total-time points | 89 kB |
| Analytics, 7 days, machine filter | 753 ms | 593 ms | 0.2 ms | 1 total; 11 model groups; 29 total-time points | 312 kB |
| Analytics, 7 days, account filter | 1,109 ms | 918 ms | 0.2 ms | 1 total; 1 model group; 29 total-time points | 60 kB |
| Analytics, 7 days, provider grouping | 1,198 ms | 802 ms | 0.2 ms | Same base outputs; 7 selected provider groups and 203 provider-time points | 338 kB |
| Filter dimensions | 6,803 ms | 5,152 ms | <0.1 ms | 465 attribute combinations | 173 kB |
| Machine inventory | 9,849 ms | 9,849 ms | <0.1 ms | 5 machine/installation rows | 5 kB |
| Sessions, 7 days, first 50 | 362 ms | 331 ms | 33 ms | 50 of 149 sessions | 120 kB |
| Attempts, 7 days, first 50 | 548 ms | 427 ms | 95 ms | 50 of 7,514 attempts; 1 summary | 125 kB |
| Tools, 7 days, first 50 | 57 ms | 56 ms | 60 ms | 50 of 14,529 tool records | 103 kB |
| Attachments, 7 days, first 50 | 26 ms | 25 ms | 17 ms | 50 of 792 attachment records | 86 kB |
| Errors, 7 days | 97 ms | 95 ms | 0.2 ms | 31 error groups; 1 summary | 8 kB |

The 90-day workload stopped on its first failing sample, so there is no three-sample
median for it. All-history success does not establish that every bounded query has
an equally efficient execution plan.

## Components inside analytics

Component timings are observed within the same uncached call; these are not separate
HTTP requests. Loading includes SQL/driver work, normalization, pricing/account
resolution, and (for attempts) correlation. Downstream times operate on loaded facts.
The reported component medians need not sum to the full-call median.

| Component | 7-day median | All-history median | Output count, 7 days / all history |
| --- | ---: | ---: | --- |
| Shared usage facts: load + normalize | 371.0 ms | 3,750.6 ms | 8,157 / 101,462 internal records |
| Totals | 24.5 ms | 264.8 ms | 1 / 1 summary |
| Total + model time series | 29.3 ms | 314.9 ms | 493 / 1,920 points |
| Attempt facts: load + correlate + normalize | 570.8 ms | 1,168.9 ms | 7,514 / 17,513 internal matching records |
| Transport + context statistics | 44.3 ms | 109.6 ms | 1 transport summary + 1 percentile object + 4 / 5 context buckets |
| Model breakdown | 30.6 ms | 251.0 ms | 16 / 95 groups |
| Provider breakdown | 17.2 ms | 219.7 ms | 7 / 12 groups |
| Account breakdown | 22.2 ms | 244.5 ms | 7 / 16 groups |
| Credential breakdown | 30.5 ms | 233.0 ms | 13 / 34 groups |
| Machine breakdown | 21.4 ms | 195.9 ms | 2 / 5 groups |
| Agent breakdown | 14.1 ms | 187.9 ms | 6 / 8 groups |
| Output distribution | 7.5 ms | 55.4 ms | 33 / 33 buckets |

For seven days, 493 chart points means 29 total points plus 16 model series with 29
points each (464). The response also repeats the selected grouping under `groups`
and `groupSeries`: with model grouping, those repeat 16 model groups and 464 points
already present in the model-specific fields. Result counts report these separately
rather than treating them as additional unique analytical results.

Selecting provider grouping still builds all model charts and all six breakdowns.
It then spends a further median **23.1 ms** producing 7 provider series containing
203 points. The full provider-grouped response is therefore not provider-only work.

These measurements support separating totals, requested breakdowns, charts, and
transport/distributions into independently requested components over shared facts.
Merely adding a totals endpoint that calls the existing full `analytics()` function
and selects `.summary` would not save the work. A totals-only path could skip charts,
the six group passes, and attempt loading, but must still pay its usage-fact loading
cost unless that layer is cached or pre-aggregated.

## Findings

- A seven-day window shifted by only 1 ms took **1,082 ms and 20 SQL statements**,
  despite the original window having just been cached. Cache keys include exact bounds.
- Immediate analytics, dimension, inventory, and error repeats issued **zero SQL**.
  Session listing repeats still issued 4 statements; attempt/tool/attachment listing
  repeats issued 10. Their warm figures are not full response-cache hits.
- The seven-day account-filtered query still fetched **8,157 usage facts** and
  **7,514 attempts**, then produced totals for **3,723 calls**. Account assignment is
  resolved in application code, so that filter does not reduce the initial SQL read.
- Dimensions read **227,897 facts** to produce the small set of filter choices.
- Inventory aggregated the entity table to return only **5 machine rows**. Its
  `array_agg(runtime ORDER BY revision DESC)` constructs an ordered array merely to
  retrieve the first runtime; this is a strong query-plan investigation candidate.
- All-history analytics processed **101,462 canonical calls**. About 2.6 seconds of
  its median function latency lay outside the measured query calls. This includes
  application-side normalization/aggregation and other overhead, not just SQL.
- JSON serialization was at most **12 ms** for these median analytics measurements.
  Serialization is not the main server-side bottleneck in this workload.

## Existing cache structure

- Browser: exact-URL promise cache for analytics and dimensions, 10-second TTL,
  approximately 64 entries. Explicit refresh clears it.
- Server: per-process, tenant/generation-scoped promise cache, 10-second TTL,
  128 entries shared across tenants and cache layers. Includes facts, attempts,
  full analytics, grouped time series, dimensions, inventory, and errors.
- Promises coalesce simultaneous identical requests. Server ingestion invalidates
  all cached analytics for that tenant; pricing/identity writes also invalidate it.
- No persistent incremental rollups, prefix sums, or cross-process cache exist.

## Suggested next work

1. Inspect and optimize inventory and dimension queries; small outputs currently
   require the most disproportionate work.
2. Capture the bounded 90-day query plan and address its remaining timeout.
3. Prototype hourly/daily additive rollups for canonical usage, retaining exact raw
   boundary handling and reconciliation for revisions, deduplication, account
   reassignment, and pricing changes.
4. Compare the same benchmark before/after, then measure concurrent HTTP requests
   and browser rendering separately.

Rollups can serve both totals and chart buckets. Arbitrary filter combinations still
require enough retained dimensions; distinct counts and exact percentiles require
separate treatment. Prefix totals over every possible filter combination are not
equivalent to a single O(log n) lookup structure.
