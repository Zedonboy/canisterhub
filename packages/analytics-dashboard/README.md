# analytics-dashboard

A standalone React app holding the usage-analytics dashboard (overview KPIs,
events, funnels, retention, logs) that used to live at
`frontend/src/pages/Analytics.tsx`. That page is now a canister-listing
page instead, mirroring `Database.tsx`/`Storage.tsx`/`Auth.tsx` - listing
this project's `analytics`-kind canisters (see `packages/analytics`, the
`ic-analytics` prebuilt release) rather than rendering a dashboard itself.

Every chart/table here is still the same illustrative sample data
(`src/lib/mock-data.ts`) it always was - there's no real usage-analytics or
log-aggregation building block in this codebase, and this app has no real
canister interface wired up (unlike `packages/table-browser`, which really
does talk to a specific `ic-sql` canister and gets embedded directly into
its wasm). This one is just a relocated page with nowhere in particular to
be served from yet.

## Local development

```sh
npm install
npm run dev
```
