---
'@routedock/routedock': patch
---

Trustline preflight now throws `RouteDockAccountNotFoundError` (`code: 'ACCOUNT_NOT_FOUND'`) only when Horizon returns 404 for the payer account. Transient Horizon failures continue with a logged warning, and the original error is kept as `cause`.
