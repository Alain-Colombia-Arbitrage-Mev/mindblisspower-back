# Auditoría SQL-Server-isms

**Target:** `.`  
**Generado:** 2026-04-28T15:31:12.512Z  
**Archivos escaneados:** see logs

## Resumen

| Severidad | Hallazgos |
|---|---:|
| high | 0 |
| medium | 3 |
| low | 0 |
| info | 0 |

## Hallazgos por patrón

### `sql.bracket-identifiers` (medium) — 3 ocurrencias
**Qué es:** Identificadores con [brackets] (estilo SQL Server)  
**Cómo arreglar:** remover brackets o usar "double quotes" si necesita case-sensitive

- `_meta/generate_diagrams.py:75:12` — `columns[t].append({`
- `_meta/generate_diagrams.py:147:32` — `for c in sorted(columns[t], key=lambda x: x["ord"]):`
- `_meta/generate_diagrams.py:189:32` — `for c in sorted(columns[t], key=lambda x: x["ord"]):`

