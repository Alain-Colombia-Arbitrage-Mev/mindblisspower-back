# KYC pro: S3 organizado + OCR de pasaporte (auto-aprobación)

Fecha: 2026-07-16 · Sub-proyecto A de la tanda KYC/admin/perfil.

## Objetivo
Activar y mejorar el KYC de miembros: almacenamiento S3 privado y **organizado**
(carpeta por cliente y por tipo de documento) + un **filtro OCR** que, para
pasaportes, valida que sea un pasaporte, esté **vigente** y que los datos
**coincidan** con la persona; si pasa, **auto-aprueba** el KYC. Fallo/ilegible →
revisión manual de admin (nunca auto-rechazo por fallo técnico).

## Estado actual (verificado en prod)
- Código KYC completo y cableado (presign PUT → upload → confirm/HeadObject → in_review).
- `mlm.kyc_document` **no existe en prod** (migración 41 sin aplicar) → KYC apagado.
- vp-payments sin `KYC_S3_BUCKET` → endpoints 503.
- Existe cliente OpenRouter (texto) en `internal/networkintel/openrouter.go`; para OCR se necesita uno multimodal (image_url).
- `mlm.person.kyc_status` existe. `first_name`/`last_name` existen.

## Decisiones
- **Modelo OCR:** `google/gemini-3.1-flash-lite` (barato, imagen+PDF, JSON mode). Configurable por env.
- **Aprobación:** auto-aprobar al pasar OCR; fallo → rechazado con motivo; ilegible/error → in_review manual.
- **Bucket:** nuevo `vp-kyc-mindblisspower` privado, SSE, block public access; instance role con S3 solo a ese bucket.

## Diseño

### Almacenamiento
- Key: `kyc/{personID}/{docType}/{nonce}-{filename}` (hoy `kyc/{personID}/{nonce}-{filename}`).
- Bucket dedicado privado; `s3:PutObject/GetObject/HeadObject` al instance role.

### Esquema (nueva migración 46)
`ALTER TABLE mlm.kyc_document` add:
- `ocr_status text` CHECK (skipped|pending|passed|failed|error) default 'skipped'
- `ocr_result jsonb`, `ocr_reason text`, `doc_expiry date`, `ocr_checked_at timestamptz`
Índice parcial para el sweep: `WHERE ocr_status='pending'`.

### Flujo OCR (async, best-effort + sweep de respaldo)
1. `handleKYCConfirm`: si `doc_type='passport'`, marca `ocr_status='pending'` y dispara goroutine (context propio con timeout). Si no es pasaporte, `ocr_status='skipped'`, queda in_review (manual).
2. Goroutine / sweep: lee objeto de S3 (bytes→base64 data URL; soporta image/pdf) → OpenRouter vision (JSON mode) extrae `{is_passport, surname, given_names, passport_number, nationality, date_of_birth, expiry_date, mrz_present}`.
3. Validación:
   - `is_passport == true`
   - `expiry_date > hoy` (vigente)
   - nombre coincide: `given_names` contiene `first_name` y `surname` contiene `last_name` (case/acentos-insensible)
4. Resultado (transaccional):
   - OK → doc `approved`, `person.kyc_status='approved'`, `ocr_status='passed'`, guarda `doc_expiry`+`ocr_result`.
   - Falla regla → doc `rejected` + `ocr_reason`, `ocr_status='failed'`, `person.kyc_status='rejected'`.
   - Error del modelo / ilegible → deja `in_review`, `ocr_status='error'` (admin revisa).
5. Sweep periódico reprocesa `ocr_status='pending'` viejos (resiliencia a reinicios).

### Backend
- `kycocr.go`: cliente OpenRouter multimodal + prompt de extracción + parse JSON estricto.
- `kyc.go`: key con docType; en confirm, ramifica OCR; helpers de transición de estado.
- `store.go`/`kyc.go`: `MarkOCRPending`, `SetOCRResult(approve/reject/error)`, `PendingOCRDocs` (sweep).
- `config.go`: `PAYMENTS_KYC_OCR_MODEL` (default gemini-3.1-flash-lite), `PAYMENTS_OPENROUTER_API_KEY` (o reusar `OPENROUTER_API_RAG`), `PAYMENTS_KYC_OCR_ENABLED`.
- `main.go`: wiring + goroutine de sweep (como el de carritos).
- helper `nameMatches` (normaliza acentos/caso).

### Frontend (growth-hub `dashboard/kyc/page.jsx`)
- Tras subir un pasaporte, poll a `/api/member/kyc/documents` mostrando "Verificando documento…" → "Aprobado" / "Rechazado: {motivo}".

## Deploy / infra
1. Crear bucket `vp-kyc-mindblisspower` (privado, SSE, block public) + política al instance role.
2. Aplicar a RDS prod: **41** (kyc_document), **46** (campos OCR), y de paso **42** (support.ticket → arregla "generar ticket", sub-proyecto C).
3. Backend CI+deploy; env vp-payments: `KYC_S3_BUCKET=vp-kyc-mindblisspower`, `PAYMENTS_KYC_OCR_MODEL`, key OpenRouter.
4. growth-hub deploy (UI de estado).

## Fuera de alcance (follow-up)
- UI de revisión KYC de admin (aprobar/rechazar manual) — el OCR cubre el happy path del pasaporte; el resto queda in_review visible en admin más adelante.
- Sub-proyectos B (gestión admins), D (guardar perfil) — quedan en cola.
