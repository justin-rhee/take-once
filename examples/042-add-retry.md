# 042 add-retry

Blocked by: 040
Touches: src/net/, tests/net-retry.test.js
Branch: add-retry (from main)
Done when: `node --test tests/net-retry.test.js` exits 0

## Context
Requests to the sync endpoint fail about once a day on a dropped connection, and nothing retries them.

## Steps
1. Retry idempotent requests up to three times with backoff. Done when: the new test passes.

## Never
Don't change the request timeout. Don't touch files outside Touches.
