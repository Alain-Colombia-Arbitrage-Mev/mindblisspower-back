# shared

Código transversal usado por múltiples módulos. **No tiene lógica de negocio.**

```
shared/
├── http/          # middleware (auth, error handler, requestId, idempotency-key)
├── queue/         # BullMQ wrapper, idempotent job helpers
├── crypto/        # pgcrypto helpers, age, password hashing
├── audit/         # writer to audit.activity_log con entity/action/actor
├── observability/ # OTel spans, structured logging (pino)
└── validation/    # zod schemas reusables (e.g. PaginationCursor, MoneyAmount)
```

**Reglas:**
- Si algo se necesita en >= 2 módulos, vive aquí.
- Nada en `shared/*` debe importar de `modules/*`. Si lo necesita, está mal abstraído.
- `shared/audit` es el único que escribe en `audit.*`; los módulos lo invocan.
