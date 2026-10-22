# Analytics loading profile — 2026-10-21

## Scope and method

Profiled the existing analytics implementation against the live database from a
separate Node.js process on the host. No application deployment or data/schema
changes were required. Application caches were cleared only in the diagnostic
process; database and OS caches were not flushed. The host also runs other services.

Each ordinary workload used a warmup followed by three application-cache-miss calls.
Time bounds were fixed within a run. The initial run covered 7 days, 30 days, and all
history; all-history was repeated to enable PostgreSQL's explicit output-serialization
timer. The all-history numbers below use that final run (upper bound 1792600913801).

Measurements include:

- Wall time and Node process user+system CPU time for full calls and nested components.
- PostgreSQL socket bytes received, query round-trip time, and instrumented JSON parsers.
- GC performance entries, attributed by time-window overlap after draining callbacks.
- Separate read-only, repeatable-read query probes: EXPLAIN without serialization,
  EXPLAIN with text serialization, ordinary parsed results, and JSON-as-text results
  followed by offline parsing. Modes rotate order between rounds.
- One additional, separate V8 CPU sampling run for all history.

Full-call timing excludes response JSON serialization, HTTP/proxy transfer, and browser
rendering. The JSON-parser timer adds small per-field overhead. CPU sampling adds
overhead and is not used as the baseline wall-time measurement.

## Full calls

| Workload | Canonical usage calls | Wall median | Node CPU median | Reported GC duration median |
| --- | ---: | ---: | ---: | ---: |
| 7 days | 8,056 | 1,034 ms | 510 ms | 75 ms |
| 30 days | 33,407 | 3,542 ms | 1,682 ms | 236 ms |
| All history | 101,462 | 6,741 ms | 3,789 ms | 528 ms |

Node CPU excludes PostgreSQL CPU. GC duration overlaps the component timings and
may include concurrent collection work; it is not an additional, disjoint stop-the-world
pause total. Node CPU can likewise include background threads. Do not add these columns.

## Inside all-history loading

| Component | Wall median | Node CPU median | Input → output |
| --- | ---: | ---: | --- |
| Usage SQL + driver | 3,187 ms | 1,280 ms | Query → 101,462 rows |
| Usage lookup tables | 4 ms | 2 ms | Four small queries → lookup maps/rules |
| Usage normalization + identity filtering | 314 ms | 270 ms | 101,462 → 101,462 records |
| **Usage loading parent span** | **3,516 ms** | **1,556 ms** | Includes the rows above plus transaction overhead |
| Attempt SQL + driver | 472 ms | 251 ms | Query → 17,513 rows |
| Prepare correlation candidates | 11 ms | 12 ms | 17,513 → 17,240 candidates |
| Serialize correlation input | 17 ms | 14 ms | 17,240 candidates → parameter JSON |
| Correlation SQL + driver | 453 ms | 56 ms | Query → 3,740 candidate matches |
| Apply correlation | 12 ms | 12 ms | Enrich matching attempt rows |
| Attempt normalization + identity filtering | 48 ms | 46 ms | 17,513 → 17,513 records |
| **Attempt loading parent span** | **1,023 ms** | **422 ms** | Includes children, lookups, and transaction overhead |

Parent/child spans overlap. Component medians do not necessarily sum to a parent's median.
In particular, normalization is only a few hundred milliseconds: the previous coarse
"load + normalize" figure was not several seconds of normalization code alone.

## Data transferred from PostgreSQL

These are socket-byte deltas during the actual full-call query round trips, not
estimates from table sizes. They include PostgreSQL protocol overhead.

| Query group | Rows | Bytes received | Approximate MiB |
| --- | ---: | ---: | ---: |
| Canonical usage | 101,462 | 79,845,960 | 76.15 |
| Attempts | 17,513 | 19,780,703 | 18.86 |
| Correlation matches | 3,740 | 2,984,476 | 2.85 |
| Transactions/lookups | Small metadata | 11,117 | 0.01 |
| **Total** | | **102,622,256** | **97.87** |

Thus this is neither an events-table scan nor a 2 GB sequential transfer: it is a
pipeline materializing about 98 MiB of detailed PostgreSQL results in Node.js.

## Isolated SQL/serialization/driver probes: all history

All values below are separate three-sample medians in read-only snapshots. PostgreSQL
EXPLAIN's SERIALIZE TEXT formats output but does not transmit that output to the client.

| Query | Executor, output formatting disabled | Server execution including text formatting | Explicit text-formatting timer | Parsed driver round trip | Node CPU during parsed round trip |
| --- | ---: | ---: | ---: | ---: | ---: |
| Canonical usage | 2,064 ms | 2,754 ms | 1,200 ms | 3,702 ms | 1,556 ms |
| Attempts | 40 ms | 223 ms | 174 ms | 415 ms | 288 ms |
| Correlation | 230 ms | 257 ms | 24 ms | 483 ms | 63 ms |

These medians cannot be subtracted as an exact additive decomposition: timings,
buffer state, and overlap differ between probes. The serialization probe uses
TIMING ON (PostgreSQL 17 otherwise omits Serialization.Time), whereas the executor-only
probe uses TIMING OFF to reduce per-node instrumentation overhead. The script also
reports execution-minus-serialization within each serialization sample.

The ordinary canonical query round trip in the full-call run was 3,187 ms, compared
with 3,702 ms in the independent probes. This variability is one reason to avoid a
precise "network-only time = round trip minus EXPLAIN" claim. Result production,
transmission, and client consumption overlap in the streaming protocol.

### Client JSON decoding

- In the full all-history call, timed JSON.parse work was **373 ms** for usage,
  **109 ms** for attempts, and **17 ms** for correlation data.
- In isolated usage probes, default parsing consumed **500 ms** of timed JSON.parse
  work and **1,556 ms** of total Node CPU during the query round trip.
- Returning usage JSON as text reduced query-side Node CPU to **795 ms**, but the
  elapsed round trip was **4,123 ms**, not faster in this run. Parsing those strings
  afterward took **573 ms wall / 397 ms CPU**.

Deferring JSON parsing is therefore a diagnostic, not an optimization: the application
still needs the parsed values. CPU profiles also show UTF-8 decoding, PostgreSQL row
assembly, and integer parsing, not just JSON.parse.

## CPU and allocation findings

The separate sampled all-history run took **6,491 ms wall / 4,016 ms process CPU**.
Its prominent non-idle sampled frames included:

| Frame | Approximate sampled wall time |
| --- | ---: |
| Aggregate.add | 685 ms |
| Garbage collector | 585 ms |
| Grouping loop | 576 ms |
| Instrumented JSON.parse | 517 ms |
| Aggregate.finish | 209 ms |
| Time-series construction | 169 ms |
| UTF-8 slice | 125 ms |
| PostgreSQL row assembly | 96 ms |

These are sampling observations, not additional additive CPU timers. Idle samples
were also substantial. Inspector's own `post` work appeared in the profile and must
not be mistaken for application work. Transpilation limits source-line precision.

The median net heap-used increase during an all-history call was **187 MiB**. This
is neither peak memory nor total allocated bytes; collections can make other spans'
heap deltas negative. Together with 27–30 observed GC events per full call, it confirms
meaningful object churn but does not establish GC as the sole or dominant bottleneck.

## Conclusions

1. Normalization alone is **not** the unexplained multi-second cost. Most usage-loading
   wall time lies in the query/driver pipeline.
2. PostgreSQL output conversion is material (about 1.2 seconds in the explicit usage
   probe), in addition to executing the access plan. EXPLAIN without serialization
   understates the cost of producing a large real result.
3. About 98 MiB crosses the PostgreSQL protocol for a response whose useful outputs
   are summaries and charts. Protocol decoding, JSON parsing, object allocation, and
   GC make this considerably more expensive than a native sequential numeric scan.
4. Node uses around **3.8 CPU-seconds** in the normal all-history call. The repeated
   aggregation passes remain substantial even after data has arrived.
5. The most evidence-backed next changes are reducing full JSON/fact transfer,
   calculating only requested components, and moving appropriate aggregates to SQL
   or compact rollups. Turning off parsing without changing the data contract or
   merely improving SSD throughput does not address the whole pipeline.

## Reproduction

With DATABASE_URL already configured for the application role:

```sh
node --import tsx scripts/profile-analytics-loading.ts --rounds=3
node --import tsx scripts/profile-analytics-loading.ts --rounds=3 --only=all
```

The script prints sanitized measurements, not SQL parameters, raw rows, or full CPU
profiles. It issues SELECT/EXPLAIN queries and transaction/session settings only.
The additional detailed component observer is optional and does not change API payloads.
