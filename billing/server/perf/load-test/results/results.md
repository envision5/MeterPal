# Load test summary

- Results file: `C:\Users\craig\MeterPal\billing\server\perf\load-test\results\results.json`
- Window: 242s

| Endpoint | p50 / p95 / p99 |
|---|---|
| /v1/billing.attach | 699ms / 1864ms / 2231ms |
| /v1/check | 15ms / 118ms / 202ms |
| /v1/customers/:id | 14ms / 95ms / 150ms |
| /v1/track | 19ms / 125ms / 194ms |

## Aggregate

| Metric | Value |
|---|---|
| Requests | 14,823 |
| Rate | 80.0 req/s |
| p50 / p95 / p99 | 17ms / 159ms / 872ms |
| Status codes | 200: 14,758  409: 65 |
| Scenarios created / failed | 5,115 / 0 |
