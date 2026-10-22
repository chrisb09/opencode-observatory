# Physical clustering experiment — 2026-10-21

## Method

- Created a separate database, `observatory_cluster_benchmark_20261021`, by logical
  dump/restore. It retained all **463,721 entities**, indexes, tenant policies, and
  analytics lookup tables. Raw `events` payloads were omitted because analytics
  does not query them. Production data/layout was not modified.
- The copy occupied about **919 MB**. A logical restore preserves the source scan
  order but repacks rows and rebuilds indexes; it is not a byte-for-byte physical
  clone. Thus the restored baseline is not identical to production's existing layout.
- Used the application role with forced row-level security still active.
- Held the upper time bound fixed at **1792598719673** for both phases and kept the
  dataset unchanged. Each workload had a warmup, then three full-call samples with
  the diagnostic process's application cache cleared before every call.
- After full-call measurements, separately ran three `EXPLAIN (ANALYZE, BUFFERS,
  SETTINGS, FORMAT JSON)` probes of the canonical usage-facts SQL. SQL figures below
  are PostgreSQL execution time, not row transfer/decoding or subsequent calculations.
- The normal analytics call retained its 5-second usage-statement timeout. Diagnostic
  EXPLAIN probes used a 60-second limit so a slow statement could be measured.
- Ran `CLUSTER public.entities USING entities_time`, then `ANALYZE public.entities`,
  and repeated the identical workloads. Clustering took **23.1 seconds** on the copy.
- PostgreSQL/OS caches were not flushed. The copy shared the PostgreSQL instance and
  host with normal services. These are sequential A/B diagnostic samples, not isolated
  disk-cold measurements or a randomized concurrency test.
- The disposable copy was removed after the results were recorded.

## Results

All numbers are three-sample medians. Full-call timings exclude HTTP transfer,
JSON serialization, and browser rendering. Each call recomputed analytics despite
the warm database buffers.

| Workload | Calls returned in summary | Usage SQL before | Usage SQL clustered | Full call before | Full call clustered |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 day | 695 | 50.92 ms | 28.85 ms | 151 ms | 154 ms |
| 7 days | 8,080 | 136.26 ms | 184.52 ms | 842 ms | 977 ms |
| 30 days | 33,407 | 675.16 ms | 398.11 ms | 2,376 ms | 2,770 ms |
| 90 days | 77,312 | 1,877.47 ms | 1,133.95 ms | 5,544 ms | 5,028 ms |
| All history | 101,462 | 1,503.17 ms | 1,713.11 ms | 6,913 ms | 6,909 ms |
| 7 days, model filter | 4,234 | 167.81 ms | 170.13 ms | 687 ms | 698 ms |
| 7 days, machine filter | 5,147 | 108.17 ms | 94.27 ms | 733 ms | 652 ms |

The counts above are matching canonical usage calls, not the number of output
objects in the analytics package. All full responses were compared across layouts,
including charts and breakdowns, allowing tiny floating-point summation differences.
All comparisons passed, and all canonical SQL result counts matched.

## Buffer effects

Root-plan shared buffer read counts (8 KiB blocks), including the query's joins and
TOAST accesses, are medians of the separate EXPLAIN probes:

| Workload | Before | Clustered | Change |
| --- | ---: | ---: | ---: |
| 30 days | 63,612 | 13,214 | **79% fewer shared-buffer reads** |
| 90 days | 128,330 | 52,821 | **59% fewer shared-buffer reads** |
| All history | 185,731 | 203,026 | 9% more shared-buffer reads |

The 1-day, 7-day, and filtered 7-day SQL probes had a median of zero shared-buffer
reads in both phases: those measurements mostly exercise already cached pages.
Clustering reduced their shared-buffer hit counts, but timing did not consistently
improve. Shared-buffer reads are not necessarily physical disk reads: they may be
served by the operating system's file cache, and block counters are not unique-page counts.

The main access-plan shapes remained the same: 90 days used bitmap heap scans;
all-history used parallel sequential scans. Table storage changed only from
849,649,664 to 848,191,488 bytes (about 0.17% smaller), with unchanged total index size.
This was predominantly a locality/layout experiment rather than a large compaction.

The clustered index order is `(user_id, kind, observed_at)`, not global time order.
An administrator check confirmed `entities_time` was marked clustered and column
correlation for `kind` was 1. Time correlation across *all kinds* is not expected to
be 1 because each kind starts its own time sequence.

## Interpretation

- **The locality hypothesis has merit:** 30-day and 90-day usage SQL became about
  41% and 40% faster, respectively, alongside materially fewer buffer reads.
- **It was not an across-the-board dashboard improvement.** The full 90-day call
  improved about 9%, the machine-filtered call about 11%, and all-history was flat.
  Full 7-day and 30-day calls regressed in this run. Other queries, driver transfer,
  application computation, and shared-host variability remain part of those timings;
  this experiment does not attribute those regressions to a single component.
- The original production 90-day timeout did **not** reproduce on the restored copy
  even before clustering. Therefore this experiment does not demonstrate that
  clustering alone fixes that timeout.
- These results support clustering as a possible maintenance optimization for raw
  time-range reads, not a replacement for avoiding unrelated work, narrow facts,
  or aggregate rollups. They do not justify applying an exclusive-locking rewrite
  to production as an automatic performance cure.

## Reproduction

`scripts/benchmark-clustering.ts` checks that its database name starts with
`observatory_cluster_benchmark_` and rejects copies already marked clustered.
Use a fresh disposable copy for each run; it changes physical storage and statistics.
It never needs application HTTP credentials.

With `DATABASE_URL` set to that copy using the table-owning application role:

```sh
node --import tsx scripts/benchmark-clustering.ts --rounds=3
```

The script emits sanitized JSON containing timings, result counts, buffer counters,
and scan types. It verifies full-response equivalence and SQL result counts. Drop
the disposable database after retaining the results; it is not an application dependency.
