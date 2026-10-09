# Lanternfish API rate limit — design note and deployment log (fictional)

## Part A — Design note, 2026-04-10

Author: Mara (owner). Status: approved design.

Each partner token is limited to **100 requests per minute** on the public routing API. Exceeding the limit returns HTTP 429 with a `Retry-After` header. The limit is enforced at the gateway, not in the service, so that a service restart never resets a partner's budget.

## Part B — Staging deployment log excerpt, 2026-06-02 14:07 UTC

```
gateway: starting lanternfish-gateway sha-7c1e2f
gateway: rate limit policy loaded: partner_token 1000 req/min, burst 200
gateway: 429 handler: Retry-After header disabled (flag RL_RETRY_AFTER=false)
service: routing v2.3.1 ready
```

## Part C — Operator note, 2026-06-02 14:20 UTC

Observed on staging: a partner token made 640 requests in one minute without a 429. The gateway policy says 1000 per minute. The design note says 100. Nobody has recorded a decision to change the limit. Which is right is unknown until the owner says so.
