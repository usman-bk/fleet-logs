# fleet-logs

_Built with AI assistance._

A REST API that stores vehicle maintenance records for many fleet companies on
one MongoDB database. Each company gets an API key and sees only its own
vehicles and records. Records carry a date, a type, odometer reading and a cost
in whole pence. There is a monthly cost report per vehicle.

Express 5, official MongoDB driver, Zod 4, TypeScript strict. 68 tests (M),
1.5 s for the full run (M), against a real `mongod` 8.2.6 started by
`mongodb-memory-server`.

    npm ci
    npm test
    npm run build

    MONGO_URI=mongodb://127.0.0.1:27017 npm run tenant -- "Acme Haulage"   # prints a key once
    MONGO_URI=mongodb://127.0.0.1:27017 npm start

Every call carries `Authorization: Bearer <key>`.

| Method and path | What it does |
|---|---|
| `POST /api/vehicles`, `GET /api/vehicles` | add a vehicle, page through them by plate |
| `GET`, `PATCH`, `DELETE /api/vehicles/:id` | one vehicle (delete also removes its records) |
| `POST /api/vehicles/:id/records` | add a record |
| `GET /api/records` | list newest first; filters `vehicleId`, `type`, `from`, `to`; `limit`, `cursor` |
| `GET`, `PATCH`, `DELETE /api/records/:id` | one record |
| `GET /api/reports/cost-by-vehicle-month?from=&to=` | pence per vehicle per calendar month |

## How one fleet is kept out of another

The tenant is read from the API key and from nothing else. A middleware looks
up the SHA-256 of the key and sets `req.tenantId`. Every handler puts that id in
the filter of every query it runs, including the `$lookup` inside the report.
Request schemas are strict, so a body that carries `tenantId` is refused rather
than ignored.

Looking at another fleet's record gives 404, not 403, so the API does not
confirm that the id exists. `test/isolation.test.ts` takes a second tenant and
tries all seven id-based routes against the first tenant's vehicle and record,
checks each answers 404, then reads the first tenant's data back to see nothing
changed. It also checks that lists and the report show none of the other
fleet's rows, and that only a hash of each key is stored.

## Validation answers

Bad input returns 400 with `{ "errors": { "<field>": "<message>" } }`, every
wrong field at once. Money must be an integer, so `"costPence": "150.00"` is
refused, and `2026-02-30` is refused as a date. Unknown fields and unknown query
parameters are reported by name.

## Indexes and what the tests ask of them

All indexes start with `tenantId`:

- `records (tenantId, date -1, _id -1)` for the tenant-wide list
- `records (tenantId, vehicleId, date -1, _id -1)` for one vehicle's history
- `vehicles (tenantId, plate)`, unique, for the vehicle list and the plate rule

`test/indexes.test.ts` calls `explain("executionStats")` on each query against a
tenant with 400 records beside another with 1,600. It asserts an `IXSCAN`, no
`COLLSCAN`, no in-memory `SORT` stage, and that a first page examines 25 keys or
fewer (M). With the tenant-wide index removed, two of the eight tests failed, so
the assertions do bite.

## Paging that survives inserts

Pages are cut by cursor, not by offset. The cursor is the `(date, _id)` of the
last row, and the next page asks for rows strictly after that pair in the
newest-first order. A new row can only land ahead of the cursor, where nobody is
reading, or behind it, where it will be read in turn. The tests seed 60 records
over six dates so ten share each date, then insert 20 rows between pages (newer,
same date as the cursor, and older). Every original row appears exactly once and
none repeats. Breaking the `_id` tiebreak made three of the ten paging tests
fail.

## The monthly report

An aggregation: `$match` on tenant and date range, `$group` by vehicle and
`$dateToString` month in UTC, `$lookup` for the plate, sorted by plate then
month. `test/report.test.ts` loads ten records with known amounts and compares
the output to a table worked out by hand, including a record on the last day of
the range, one the day after it, and 31 January against 1 February.

## Found while building

- A body with an extra field came back as a 400 with no field named, because
  Zod reports unknown keys as one issue with an empty path. The error mapper now
  lists each unknown name (commit "Name each unknown field in a 400 instead of
  reporting the whole body").
- MongoDB 8 plans a lookup on a unique key as `EXPRESS_IXSCAN`, so a test that
  looked for the exact stage name `IXSCAN` failed on a healthy plan. It now
  accepts any index scan stage and still rejects `COLLSCAN`.
- `npm run build` failed on TypeScript 6 until `rootDir` was set (commit "Fix
  build rootDir, drop unused test variables").

## Not covered

- Keys cannot be rotated or revoked, and there is no rate limit.
- The report groups months in UTC. A fleet that cares where midnight falls would
  need a timezone per tenant.
- Dates are plain days. There is no time of day on a record.
- Tested on a single node. Nothing here has run against a replica set, a sharded
  cluster or a hosted MongoDB.
- Cursors are not signed, so a caller can forge one. It only changes where their
  own page starts, because the tenant filter is applied regardless.
