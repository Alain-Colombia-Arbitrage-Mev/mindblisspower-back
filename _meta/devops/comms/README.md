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

Ver la lista completa con defaults en `vp-engine/deploy/vp-payments.env.example`.
