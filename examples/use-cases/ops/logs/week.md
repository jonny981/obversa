# Service log, one week

- INC-301 started Monday 09:12, lasted 18 minutes. Sign-in slow for a
  fifth of customers. Cause: a cache node restarted. Fixed by failover.
- INC-302 started Wednesday 22:40, lasted 2 hours 5 minutes. Exports
  queued and did not run. Cause: a worker pool at its limit. Fixed by
  raising the limit and draining the queue.
- INC-303 started Friday 14:03, lasted 6 minutes. One region's status
  page showed stale data. Cause: a publishing job skipped. Fixed by
  re-running the job.
