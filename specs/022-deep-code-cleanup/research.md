# Research: Deep Code Cleanup

No external research needed — this is a deletion-only task. All dead code was identified through 3 rounds of codebase auditing with 6 specialized agents.

## Audit Methodology

- **Round 1**: Surface-level audit of all services, controllers, routes, and frontend components
- **Round 2**: Deep line-by-line audit of ai.service.ts, schema.prisma, app.ts, package.json
- **Round 3**: Cross-reference audit (all endpoints → all frontend callers), internal audit of every active component and service file

## Key Decisions

| Decision | Rationale | Alternatives Rejected |
|----------|-----------|----------------------|
| Keep shadcn/ui components | May use for future UI work; trivially re-addable | Delete all — rejected by user |
| Keep backend endpoints (except automated messages + dead features) | Mobile app may call them directly | Aggressive cleanup — too risky |
| Drop OpusReport + ClassifierWeights tables | Zero code references, data valueless without deleted code | Keep tables — unnecessary bloat |
| Remove automated messages entirely | Never used by any client | Keep for future — no plans to use |
| Remove ai-pipeline route + snapshot service | Only served deleted frontend tab | Keep — no value without UI |
