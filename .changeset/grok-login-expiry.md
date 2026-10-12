---
"@obversa/engine-grok-cli": patch
---

`authFile` is read again at each call instead of once at construction, so a Grok login refreshed outside a run reaches the next call. A call now fails before any Grok process starts, as a non-retryable `invalid-config` error naming the expiry, when the file has at least one `expires_at` and none of them is later than now plus the call's time limit, instead of spending the call on 401 rejections. A file with no `expires_at` is not checked.
