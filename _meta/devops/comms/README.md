# Comunicados masivos — infraestructura (SQS + SNS + IAM + SSM)

Runbook para el operador. Estos comandos se ejecutan UNA vez, a mano, contra
la cuenta de AWS — no forman parte de CI/CD ni de ningún deploy automatizado.

Requiere: AWS CLI configurado con credenciales de la cuenta `522814703714`
(región `us-east-1`) y permisos para SQS, SNS, IAM y SSM. Ejecutar desde la
raíz de `backend/` (el paso 4 referencia `_meta/devops/iam/vp-comms-sqs.json`
con ruta relativa).

## Qué monta esto

- Una cola SQS `comms-ses-events` (+ DLQ `comms-ses-events-dlq`) suscrita al
  topic SNS `ses-entregas-eventos`, que recibe los eventos de entrega/bounce/
  complaint que SES publica para los correos de campañas.
- Una policy IAM (`vp-comms-sqs.json`) que permite al rol de instancia
  consumir esa cola (`sqs:ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes`).
- Los parámetros SSM que el box APP renderiza como
  `/run/vicionpower/vp-payments.env` al arrancar el servicio.

`vp-payments` (`cmd/vp-payments/main.go`) solo activa el sender de campañas
cuando `COMMS_ENABLED=true` (debe ser así SOLO en el box APP — un único
proceso envía) y solo levanta el consumer de eventos SES cuando
`COMMS_SQS_QUEUE_URL` no está vacío. Ver
`vp-engine/internal/payments/config.go` y `vp-engine/deploy/vp-payments.env.example`.

## Comandos

```bash
export MSYS_NO_PATHCONV=1 PYTHONUTF8=1
ACCOUNT=522814703714; REGION=us-east-1
TOPIC=arn:aws:sns:$REGION:$ACCOUNT:ses-entregas-eventos

# 0) VERIFICAR ANTES DE CREAR LA COLA: el configuration set `entregas` debe tener
#    un event destination que publique SEND, DELIVERY, BOUNCE y COMPLAINT al topic
#    `ses-entregas-eventos`. Sin esto la cola se crea y queda vacía para siempre:
#    el consumer no ve entregas ni rebotes, el freno por tasa de rebote nunca arma
#    y las direcciones que rebotan no se suprimen.
aws sesv2 get-configuration-set-event-destinations --configuration-set-name entregas --region $REGION
#    Debe listar un destination con Enabled=true, MatchingEventTypes que incluya
#    SEND, DELIVERY, BOUNCE y COMPLAINT, y SnsDestination.TopicArn = $TOPIC.
#    Si NO existe (o le faltan tipos de evento), crearlo:
aws sesv2 create-configuration-set-event-destination \
  --configuration-set-name entregas \
  --event-destination-name comms-sns \
  --event-destination "{\"Enabled\":true,\"MatchingEventTypes\":[\"SEND\",\"DELIVERY\",\"BOUNCE\",\"COMPLAINT\"],\"SnsDestination\":{\"TopicArn\":\"$TOPIC\"}}" \
  --region $REGION
#    (si ya existe con otro nombre y le faltan tipos, usar
#     aws sesv2 update-configuration-set-event-destination con los mismos campos)

# 1) DLQ + cola principal
DLQ_URL=$(aws sqs create-queue --queue-name comms-ses-events-dlq --region $REGION --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url $DLQ_URL --attribute-names QueueArn --query Attributes.QueueArn --output text)
Q_URL=$(aws sqs create-queue --queue-name comms-ses-events --region $REGION --attributes "{\"MessageRetentionPeriod\":\"345600\",\"VisibilityTimeout\":\"60\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" --query QueueUrl --output text)
Q_ARN=$(aws sqs get-queue-attributes --queue-url $Q_URL --attribute-names QueueArn --query Attributes.QueueArn --output text)

# 2) Policy de la cola: solo el topic SNS puede publicar
aws sqs set-queue-attributes --queue-url $Q_URL --attributes "{\"Policy\":\"{\\\"Version\\\":\\\"2012-10-17\\\",\\\"Statement\\\":[{\\\"Effect\\\":\\\"Allow\\\",\\\"Principal\\\":{\\\"Service\\\":\\\"sns.amazonaws.com\\\"},\\\"Action\\\":\\\"sqs:SendMessage\\\",\\\"Resource\\\":\\\"$Q_ARN\\\",\\\"Condition\\\":{\\\"ArnEquals\\\":{\\\"aws:SourceArn\\\":\\\"$TOPIC\\\"}}}]}\"}"

# 3) Suscripción SNS → SQS con raw delivery (el body es el JSON del evento SES)
aws sns subscribe --topic-arn $TOPIC --protocol sqs --notification-endpoint $Q_ARN --attributes RawMessageDelivery=true --region $REGION

# 4) IAM: el rol de instancia consume la cola
aws iam put-role-policy --role-name vp-ec2-ssm --policy-name vp-comms-sqs --policy-document file://_meta/devops/iam/vp-comms-sqs.json

# 5) Parámetros SSM que renderizan /run/vicionpower/vp-payments.env (APP)
P=/vicionpower/prod/vp-payments
aws ssm put-parameter --name $P/COMMS_ENABLED --value true --type String --overwrite
aws ssm put-parameter --name $P/COMMS_UNSUBSCRIBE_SECRET --value "$(openssl rand -base64 48)" --type SecureString --overwrite
aws ssm put-parameter --name $P/COMMS_SQS_QUEUE_URL --value "$Q_URL" --type String --overwrite
aws ssm put-parameter --name $P/COMMS_SES_CONFIG_SET --value entregas --type String --overwrite
# En WORKER/staging: COMMS_ENABLED=false (no crear el parámetro o ponerlo en false).
```

Verificar antes de ejecutar que el script de deploy renderiza TODOS los
parámetros bajo `$P/*` (hoy sí: `COGNITO_ISSUER`, `KYC_S3_BUCKET`, etc.
llegan al contenedor). Si el secreto SecureString necesita `kms:Decrypt`, el
rol ya lo tiene vía `vp-ssm-read`.

## Parámetros SSM relevantes (`$P = /vicionpower/prod/vp-payments`)

Obligatorios en el box APP cuando `COMMS_ENABLED=true`:

- `$P/COMMS_ENABLED` — `true` solo en APP; `false` (o ausente) en WORKER/staging.
- `$P/COMMS_UNSUBSCRIBE_SECRET` — SecureString, 32+ bytes aleatorios, NO
  reutilizar `PAYMENTS_SERVICE_TOKEN`.

Opcionales:

- `$P/COMMS_SQS_QUEUE_URL` — vacío ⇒ el proceso no levanta el consumer de
  eventos SES (sin seguimiento de entregas/bounces).
- `$P/COMMS_SES_CONFIG_SET` — default `entregas`.
- `$P/COMMS_SEND_RATE_PER_SEC`, `$P/COMMS_BATCH_SIZE` — throttling del sender.
- `$P/COMMS_UNSUBSCRIBE_BASE_URL` — default `https://app.mindblisspower.com/baja`.
- `$P/COMMS_UNSUBSCRIBE_ONECLICK_URL` — opcional; por defecto se deriva
  reemplazando `/baja` por `/api/comms/unsubscribe` en `COMMS_UNSUBSCRIBE_BASE_URL`.
- `$P/COMMS_REPLY_TO` — default `soporte@mindblisspower.com`.
- `$P/COMMS_MAX_AUDIENCE`, `$P/COMMS_MAX_CAMPAIGNS_PER_DAY`, `$P/COMMS_MAX_TEST_SENDS`.
- `$P/COMMS_LEGAL_NAME` — razón social que va en el pie de cada comunicado
  (default `Mindbliss Power`). El render FALLA si queda vacío.
- `$P/COMMS_POSTAL_ADDRESS` — dirección postal en el pie (default vacío).
  **Configurarla en producción**: CAN-SPAM §7704(a)(5) exige dirección física
  válida en todo correo comercial.

Ver la lista completa con defaults en `vp-engine/deploy/vp-payments.env.example`.

## Rollout (orden obligatorio)

1. **Migración 67** en RDS:
   `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f _meta/migration/67_comms_campaigns.sql`.
   NUNCA con `--single-transaction`: el `ALTER TYPE mlm.approval_operation_type
   ADD VALUE 'comms_campaign'` del final tiene que correr fuera de la transacción.
2. **Configuration set**: verificar/crear el event destination (paso 0 de arriba).
   Si esto falta, todo lo demás "funciona" pero sin seguimiento de entregas.
3. **SQS + DLQ + suscripción SNS + IAM + SSM** (pasos 1–5 de arriba).
4. **Deploy del backend** (`vp-payments`):
   - `COMMS_ENABLED=true` SOLO en el box **APP** — un único proceso envía; con dos
     el ritmo de envío se duplica y el límite de campañas/día se puede burlar.
   - `COMMS_UNSUBSCRIBE_SECRET` en **TODAS** las instancias que puedan servir
     `POST /api/comms/unsubscribe` (APP, WORKER y staging), no solo en APP: el
     endpoint de baja verifica el token con ese secreto y sin él responde 503.
     Debe ser el MISMO valor en todas, o los tokens firmados en APP no se
     validarán donde caiga la petición.
   - `COMMS_LEGAL_NAME` y `COMMS_POSTAL_ADDRESS` en el box APP (pie legal).
   - Con `COMMS_ENABLED=true`, si no se puede derivar la URL One-Click el proceso
     **no arranca** (falla el deploy a propósito): setear
     `COMMS_UNSUBSCRIBE_ONECLICK_URL` o que `COMMS_UNSUBSCRIBE_BASE_URL`
     contenga `/baja`.
5. **Deploy del front (growth-hub) y del panel admin**, en ese orden (la página
   pública `/baja` y su BFF antes de que salga el primer comunicado).
6. **Smoke test** en producción:
   - crear una campaña con segmento de lista de emails (solo internos), enviar
     prueba, someter a aprobación, aprobar con otro super_admin;
   - verificar que llega el correo y que el pie muestra razón social + dirección;
   - **baja One-Click real desde Gmail** (botón "Cancelar suscripción" de la
     cabecera): debe responder 200 y crear la fila en `comms.unsubscribe`;
   - verificar que el consumer marca `delivered` en `comms.campaign_recipient`
     (si no, el paso 2 quedó mal).

### `VP_PAYMENTS_URL` de los BFFs

El panel admin (`mindblisspower-admin`) y growth-hub (`mindblisspowerfront`)
deben apuntar `VP_PAYMENTS_URL` al box **APP**: es la única instancia que llama
`handler.SetComms(sender, …)`, y por lo tanto la única donde
`/api/admin/comms/*` responde algo distinto de `503 comms_disabled`. En
WORKER/staging el proceso solo registra el secreto de baja
(`SetComms(nil, …)`), suficiente para servir `/api/comms/unsubscribe` y nada más.
