# Viewer pan performance, render path redesign

Status draft. Date 2026-07-05. Branch `perf/pan-render-path`.

## Problem

Panning the deck.gl map feels heavy even when every visible row group is
already decoded and resident in the flat cache. A pan that fetches zero bytes
and decodes nothing still tears down and rebuilds the whole map, so the user
sees churn and an empty-map flash that produce the exact same pixels.

This was investigated with four parallel read-only audits (hot path, deck.gl
rendering, cache effectiveness, fetch scheduling). Three of the four
independently ranked the same defect first, there is no check for "the resolved
read plan did not change," so `runFetch` always runs its full path.

## Root cause

`fetchCurrentView` dedupes on a rounded bbox key (`fetch-key.ts`), and at any
real zoom a one pixel pan changes that key. But the resolved read plan (the
column, the row-group indices, and the page sub-ranges) is usually identical
for a small pan because the same groups still intersect. Nothing compares the
plan, so on every pan `runFetch` runs `resetViz`, `clearLayers`,
`pickFlats.clear`, `closeFeaturePopup`, then rebuilds every batch layer and
finally re-merges all visible vertices into a fresh buffer and re-uploads it.

The decode cache (`flat-cache.ts`) hides the network and decode cost for
already-seen data, so what remains is pure CPU allocation and redundant GPU
upload.

## What is already correct (do not touch)

- The page-index decode is memoized per file and row group in
  `file-cache.ts` `pageRangeMemo` and genuinely survives pans. The original
  "page index re-reads on pan" hypothesis is false.
- The byte cache pins coarse bands and excludes pinned bytes from the LRU
  budget, so exact chunks can never evict a warm coarse band.
- Side panels are change-gated and do not re-render on pan.
- The 150 ms moveend debounce is correct, intermediate pan frames do no fetch
  work.

## Hard constraints carried from viewer/CLAUDE.md

Every change below must respect these. They are non negotiable.

- Holed polygon fills keep `positionFormat 'XY'` through the complex-flat
  accessor shape. deck.gl 9.3.6 ignores `vertexValid` for hole cutting.
- Any failure at page granularity falls back to a whole-group read.
  `pageRangesForRowGroup` returns null on any problem, keep that contract.
- The decode path stays zero-copy. No per-feature GeoJSON, no per-row wrappers,
  no coordinate pair allocations on the hot path. `rowIds` stays one Uint32 per
  primitive.
- Flat-cache buckets and byte-cache slices are immutable and shared by
  reference. Never mutate a returned bucket.
- deck.gl shallow-compares layer `data` by reference. Keep stable
  `{length, attributes}` wrappers, a fresh wrapper forces a full GPU re-upload.
- Interleaved rendering stays. The click popup stays a fresh Popup per click.
- Superseded reads must never paint stale. Paint stays token-gated.

## The plan, four phases

### Phase 1, plan-signature short-circuit and file-invariant hoists

Goal, make an in-place pan over unchanged data do no teardown, no rebuild, no
upload.

1. After `refineToPages`, compute a plan signature from the column, the sorted
   row-group indices, and the per-range sub-range signatures (the same
   `rangeSignature` already used for the flat-cache key). Store the committed
   signature on the instance when a fetch settles.
2. At the top of the settle path, if the newly resolved signature equals the
   committed one and the file url is unchanged, return early before
   `clearLayers`, leaving the current layers on screen. The viz panels still
   update their camera-derived readouts through the existing reactive props.
3. Move the file-invariant work out of the per-pan path. The prefix-sum row
   offsets (`app-root.ts:703-708`) and the schema lookup (`app-root.ts:936`)
   depend only on the file, compute them once at load and store on the instance.
   Reuse the `plan` already computed in `fetchCurrentView` instead of
   recomputing it in `runFetch`.
4. Defer `clearLayers` so the map is not blanked until the first new batch is
   ready to paint, removing the flash. A superseded fetch must still clean up.

Risk, low. Mostly guard code and hoisting. The main care is that the early
return still lands the correct viz state and does not strand a spinner.

### Phase 2, merged-layer and GPU reuse

Goal, when the view does change, stop uploading the whole coordinate set twice.

1. The batch layers already upload their buffers once. The end-of-fetch
   `mergeFlatGeometries` allocates a fresh buffer over all visible vertices and
   uploads it a second time just to collapse layer count. Skip the merge when
   the batch count is small (a threshold around eight layers-worth of groups),
   keeping the per-batch layers, since pick provenance already works per batch.
2. When the merge is worth doing for draw-call count, cache the merged buckets
   and the built `Layer[]` keyed by the sorted row-group index set. A settle
   that resolves to the same set reuses the same `Layer` objects by reference,
   so deck.gl diffs them to a no-op.

Risk, medium. Must preserve the atomic swap that avoids an empty frame and the
per-batch pick provenance registration.

### Phase 3, per-page decode cache

Goal, panning inside a large exact-band row group reuses decoded pages instead
of re-decoding the overlap.

Today the flat-cache key embeds the merged sub-range signature, which jitters
as the AOI shifts, so every pan is a miss and the whole kept span is re-decoded
although the bytes are warm. Re-key per page, the stable unit.

1. Key the flat cache per kept `PageRange` as
   `column, rowGroupIndex, pageRowStart-pageRowEnd`. The page boundaries come
   from the memoized `pageRangesForRowGroup` output and never jitter.
2. On a view, probe each kept page. Coalesce only the misses into contiguous
   fetch spans (reuse `mergePageRanges` over the miss set) so hyparquet still
   skips dropped pages. Decode the fetched bytes and split the result back into
   per-page buckets, `set` each page individually.
3. Paint by concatenating the kept pages' buckets, hits and fresh alike,
   through the existing merge.

Only large non-prefetched page-pruned files reach this path. Prefetched files
(32 MB and under) already reuse decode because they read whole groups with a
stable `full` signature.

Risk, medium. The reader in `rowgroups.ts` accumulates a whole group before
decode, this moves the accumulate-then-decode boundary to per page. Per-page
buckets stay immutable and `rowIds` is already keyed to the absolute file row,
so concatenation stays self-consistent.

### Phase 4, network scheduling

Goal, faster first paint and faster fast-pan recovery.

1. Stop serializing whole fetches on `fetchChain`. Paint is already token
   gated, so let a superseded `runFetch` return without awaiting the old
   chain's in-flight reads to drain. If overlap is a concern, gate only the
   internal read pool with a shared semaphore rather than the whole fetch.
2. Resolve the first-view page-index reads concurrently with `Promise.all`
   over the wide groups instead of the current serial loop, preserving the
   whole-group fallback.
3. Raise `MAX_CONCURRENT_READS` from 6 toward 16 for HTTP/2 and decouple
   read-ahead from the paint chain so a worker can prefetch the next group
   while its paint is queued.

Risk, higher. This touches the cancellation contract and the shared byte cache
connection pool. The serialized `paintChain` and the inter-group `setTimeout(0)`
yield stay, they are load-bearing.

## Verification

- `pnpm typecheck` and `pnpm test` after every phase.
- Drive a real pan session against the hosted Finland file and read the
  existing `timeWork` events (`wkb-decode`, `gpu-upload`) plus the phase events.
  Phase 1 should show an in-place pan producing no `gpu-upload` and no
  `wkb-decode`. Phase 3 should show a deep-zoom pan re-decoding only the newly
  visible pages, not the overlap.
- Confirm no stale paint under fast panning and file switching, the token gate
  must still hold.
- Watch the byte and flat cache `stats` to confirm hit rates rise and the
  coarse-band pins stay resident.

## Sequencing

Phases are independent enough to land and verify one at a time. Phase 1 and 2
carry nearly all the felt improvement. Phase 3 matters at deep zoom on large
files. Phase 4 is polish and carries the most risk, so it lands last behind its
own verification.
