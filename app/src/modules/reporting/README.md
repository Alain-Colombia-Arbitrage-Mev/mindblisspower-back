# reporting

Dashboards + exports + reportes fiscales.

**Endpoints:**
- `GET /api/me/dashboard` — KPIs personales (saldo, red, ganancias del mes)
- `GET /api/me/reports/earnings.csv?year=2026`
- `GET /api/admin/reports/cohort?from=...&to=...`
- `GET /api/admin/reports/payouts.xlsx?run_id=...`

**Implementación:**
- Vistas materializadas en Postgres refresheadas nocturnamente para dashboards pesados.
- Exports streaming directo desde Postgres (no carga todo en memoria).

**Pendientes:**
- [ ] Definir vistas materializadas (`mv_earnings_monthly`, `mv_network_summary`).
- [ ] CSV streaming con `pg-copy-streams`.
- [ ] XLSX con `exceljs` (streaming write).
- [ ] Reporte fiscal por país (Colombia: certificado de retención).
