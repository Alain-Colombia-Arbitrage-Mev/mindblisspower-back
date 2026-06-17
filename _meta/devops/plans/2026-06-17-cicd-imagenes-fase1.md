# CI/CD Imágenes Versionadas + Rollback (Fase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el deploy binario-por-SSH por un pipeline AWS-nativo que construye imágenes Docker versionadas (git-SHA), las publica a ECR y las despliega a los EC2 actuales vía SSM con rollback en un comando, detrás de un ALB con TLS.

**Architecture:** GitHub Actions autentica a AWS con OIDC (sin llaves), construye imágenes arm64 multi-stage y las sube a ECR con tag inmutable = git-SHA. El deploy se dispara por SSM Run Command sobre las instancias (que autentican el pull con su instance role), hace `docker compose pull/up` con health gate. Un ALB con cert ACM termina TLS y enruta a la API. Secretos en SSM Parameter Store (SecureString).

**Tech Stack:** AWS (ECR, IAM/OIDC, SSM, ALB/ELBv2, ACM, Route53, KMS, Parameter Store), Docker + compose, GitHub Actions, bun/Hono (api), Go (vp-engine, vp-payments).

## Global Constraints

- Región AWS: `us-east-1`. Cuenta: `522814703714`.
- Arquitectura de imágenes: **linux/arm64** (instancias t4g/Graviton).
- Repo: `Alain-Colombia-Arbitrage-Mev/mindblisspower-back`, rama default `main`; rama `staging` para staging.
- Instancias prod: server1 `i-060e76a6c26bded35` (EIP 34.195.82.200), server2 `i-02fcc4d2329040711` (EIP 44.209.143.146). Staging: `i-0f7f6c73503537d73` (`mindbliss-staging`) — **confirmar al inicio de Task 11**.
- Instance profile existente: `vp-ec2-ssm`. SG actual compartido: `sg-00bc3b29df49c4597` (solo 80/443 público).
- Servicios en alcance: `api` (bun, `app/`, server2), `vp-engine` (Go, ambos), `vp-payments` (Go, server1). Frontend Next.js = repo aparte, fuera de este plan.
- Nombres ECR: `vp/api`, `vp/vp-engine`, `vp/vp-payments`. Tag inmutable = git-SHA completo; tag móvil = `prod`/`staging`.
- Jerarquía de secretos: `/vicionpower/<env>/<servicio>/<CLAVE>`. KMS alias: `alias/vicionpower-secrets`.
- Hostname API: `api.mindblisspower.com` (NO tocar `app.mindblisspower.com` en este plan).
- `aws` CLI ya instalado y autenticado como `user/MINDBLISS` con permisos IAM. Todas las `aws` se corren desde PowerShell/terminal local salvo que se indique SSM.
- Commits: rama de trabajo `feat/cicd-ecr-fase1` (NO commitear directo a `main`). Mensaje de commit termina con la línea Co-Authored-By indicada por el harness.

---

### Task 1: Repositorios ECR + lifecycle policy

**Files:**
- Create: `_meta/devops/ecr/lifecycle-policy.json`
- Create: `_meta/devops/ecr/create-repos.sh`

**Interfaces:**
- Produces: 3 repos ECR (`vp/api`, `vp/vp-engine`, `vp/vp-payments`) con URI `522814703714.dkr.ecr.us-east-1.amazonaws.com/<repo>`; usados por Tasks 8, 9.

- [ ] **Step 1: Escribir la lifecycle policy (conservar 10 imágenes)**

`_meta/devops/ecr/lifecycle-policy.json`:
```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Conservar las ultimas 10 imagenes, expirar el resto",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 10
      },
      "action": { "type": "expire" }
    }
  ]
}
```

- [ ] **Step 2: Escribir el script de creación**

`_meta/devops/ecr/create-repos.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
REGION=us-east-1
POLICY_FILE="$(dirname "$0")/lifecycle-policy.json"
for repo in vp/api vp/vp-engine vp/vp-payments; do
  aws ecr describe-repositories --repository-names "$repo" --region "$REGION" >/dev/null 2>&1 \
    || aws ecr create-repository \
         --repository-name "$repo" \
         --region "$REGION" \
         --image-tag-mutability IMMUTABLE \
         --image-scanning-configuration scanOnPush=true >/dev/null
  aws ecr put-lifecycle-policy \
    --repository-name "$repo" \
    --region "$REGION" \
    --lifecycle-policy-text "file://$POLICY_FILE" >/dev/null
  echo "OK: $repo"
done
```

- [ ] **Step 3: Ejecutar el script**

Run: `bash _meta/devops/ecr/create-repos.sh`
Expected: tres líneas `OK: vp/api`, `OK: vp/vp-engine`, `OK: vp/vp-payments`.

- [ ] **Step 4: Verificar repos y lifecycle**

Run: `aws ecr describe-repositories --region us-east-1 --query "repositories[?starts_with(repositoryName,'vp/')].{Name:repositoryName,Mutable:imageTagMutability,Scan:imageScanningConfiguration.scanOnPush}" --output table`
Expected: 3 filas, `Mutable=IMMUTABLE`, `Scan=True`.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/cicd-ecr-fase1
git add _meta/devops/ecr/
git commit -m "feat(devops): crear repos ECR vp/* con immutability y lifecycle"
```

---

### Task 2: GitHub OIDC provider + rol `vp-gha-deploy`

**Files:**
- Create: `_meta/devops/iam/gha-oidc-trust.json`
- Create: `_meta/devops/iam/gha-deploy-policy.json`

**Interfaces:**
- Consumes: ARNs de repos ECR (Task 1).
- Produces: rol IAM `arn:aws:iam::522814703714:role/vp-gha-deploy` usado por el workflow (Tasks 8, 9) vía `aws-actions/configure-aws-credentials`.

- [ ] **Step 1: Crear el OIDC provider de GitHub (idempotente)**

Run:
```bash
aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?contains(Arn,'token.actions.githubusercontent.com')]" --output text \
| grep -q . || aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 1c58a3a8518e8759bf075b76b750d4f2df264fcd
```
Expected: sin error (crea el provider o no hace nada si ya existe).

- [ ] **Step 2: Escribir la trust policy (acotada al repo y refs)**

`_meta/devops/iam/gha-oidc-trust.json`:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::522814703714:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:Alain-Colombia-Arbitrage-Mev/mindblisspower-back:ref:refs/heads/main",
            "repo:Alain-Colombia-Arbitrage-Mev/mindblisspower-back:ref:refs/heads/staging"
          ]
        }
      }
    }
  ]
}
```

- [ ] **Step 3: Escribir la policy de permisos (ECR push + SSM send)**

`_meta/devops/iam/gha-deploy-policy.json`:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrAuth",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "EcrPush",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:DescribeImages"
      ],
      "Resource": [
        "arn:aws:ecr:us-east-1:522814703714:repository/vp/api",
        "arn:aws:ecr:us-east-1:522814703714:repository/vp/vp-engine",
        "arn:aws:ecr:us-east-1:522814703714:repository/vp/vp-payments"
      ]
    },
    {
      "Sid": "SsmDeploy",
      "Effect": "Allow",
      "Action": ["ssm:SendCommand"],
      "Resource": [
        "arn:aws:ssm:us-east-1::document/AWS-RunShellScript",
        "arn:aws:ec2:us-east-1:522814703714:instance/i-060e76a6c26bded35",
        "arn:aws:ec2:us-east-1:522814703714:instance/i-02fcc4d2329040711",
        "arn:aws:ec2:us-east-1:522814703714:instance/i-0f7f6c73503537d73"
      ]
    },
    {
      "Sid": "SsmPoll",
      "Effect": "Allow",
      "Action": ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"],
      "Resource": "*"
    }
  ]
}
```

- [ ] **Step 4: Crear el rol y adjuntar la policy**

Run:
```bash
aws iam create-role --role-name vp-gha-deploy \
  --assume-role-policy-document file://_meta/devops/iam/gha-oidc-trust.json
aws iam put-role-policy --role-name vp-gha-deploy \
  --policy-name vp-gha-deploy-perms \
  --policy-document file://_meta/devops/iam/gha-deploy-policy.json
```
Expected: JSON del rol creado; segundo comando sin salida (éxito).

- [ ] **Step 5: Verificar**

Run: `aws iam get-role --role-name vp-gha-deploy --query 'Role.Arn' --output text`
Expected: `arn:aws:iam::522814703714:role/vp-gha-deploy`

- [ ] **Step 6: Commit**

```bash
git add _meta/devops/iam/gha-oidc-trust.json _meta/devops/iam/gha-deploy-policy.json
git commit -m "feat(devops): rol OIDC vp-gha-deploy para CI (ECR push + SSM send)"
```

---

### Task 3: KMS key + ampliar instance role `vp-ec2-ssm`

**Files:**
- Create: `_meta/devops/iam/vp-ec2-ssm-extra-policy.json`

**Interfaces:**
- Consumes: rol `vp-ec2-ssm` (existente).
- Produces: KMS key `alias/vicionpower-secrets` (usada en Task 5); el instance role queda con permiso de pull ECR + lectura de `/vicionpower/*` + decrypt KMS.

- [ ] **Step 1: Crear la KMS key y su alias**

Run:
```bash
KEYID=$(aws kms create-key --description "VicionPower runtime secrets" --query 'KeyMetadata.KeyId' --output text)
aws kms create-alias --alias-name alias/vicionpower-secrets --target-key-id "$KEYID"
echo "KMS KeyId=$KEYID"
```
Expected: imprime `KMS KeyId=<uuid>`. Guardar ese KeyId para el Step 2.

- [ ] **Step 2: Escribir la policy extra del instance role**

`_meta/devops/iam/vp-ec2-ssm-extra-policy.json` (reemplazar `<KMS_KEY_ID>` por el KeyId del Step 1):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadAppSecrets",
      "Effect": "Allow",
      "Action": ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"],
      "Resource": "arn:aws:ssm:us-east-1:522814703714:parameter/vicionpower/*"
    },
    {
      "Sid": "DecryptSecrets",
      "Effect": "Allow",
      "Action": ["kms:Decrypt"],
      "Resource": "arn:aws:kms:us-east-1:522814703714:key/<KMS_KEY_ID>"
    }
  ]
}
```

- [ ] **Step 3: Adjuntar ECR ReadOnly (managed) + la policy inline**

Run:
```bash
aws iam attach-role-policy --role-name vp-ec2-ssm \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly
aws iam put-role-policy --role-name vp-ec2-ssm \
  --policy-name vp-ec2-ssm-secrets \
  --policy-document file://_meta/devops/iam/vp-ec2-ssm-extra-policy.json
```
Expected: sin error.

- [ ] **Step 4: Verificar**

Run: `aws iam list-attached-role-policies --role-name vp-ec2-ssm --query 'AttachedPolicies[].PolicyName' --output text`
Expected: incluye `AmazonSSMManagedInstanceCore` y `AmazonEC2ContainerRegistryReadOnly`.
Run: `aws iam list-role-policies --role-name vp-ec2-ssm --query 'PolicyNames' --output text`
Expected: incluye `vp-ec2-ssm-secrets`.

- [ ] **Step 5: Commit**

```bash
git add _meta/devops/iam/vp-ec2-ssm-extra-policy.json
git commit -m "feat(devops): KMS key + ampliar vp-ec2-ssm (ECR pull, SSM params, KMS decrypt)"
```

---

### Task 4: Instalar Docker + compose en los hosts (vía SSM)

**Files:**
- Create: `_meta/devops/scripts/install-docker.sh`
- Create: `_meta/devops/scripts/ssm-run.sh` (helper reusable)

**Interfaces:**
- Produces: Docker Engine + plugin compose en server1/server2; helper `ssm-run.sh <instance-id> <script-file>` usado por Tasks siguientes.

- [ ] **Step 1: Escribir el helper SSM reusable**

`_meta/devops/scripts/ssm-run.sh`:
```bash
#!/usr/bin/env bash
# Uso: ssm-run.sh <instance-id> <script-file>
set -euo pipefail
INST="$1"; SCRIPT="$2"; REGION=us-east-1
B64=$(base64 -w0 "$SCRIPT")
PARAMS=$(printf '{"commands":["echo %s | base64 -d | sudo bash"]}' "$B64")
TMP=$(mktemp); printf '%s' "$PARAMS" > "$TMP"
CID=$(aws ssm send-command --region "$REGION" --document-name AWS-RunShellScript \
  --instance-ids "$INST" --parameters "file://$TMP" --query 'Command.CommandId' --output text)
rm -f "$TMP"
for i in $(seq 1 60); do
  ST=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$INST" --query 'Status' --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|Cancelled|TimedOut) break;; esac; sleep 5
done
echo "### $INST status=$ST"
aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$INST" --query 'StandardOutputContent' --output text
aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$INST" --query 'StandardErrorContent' --output text >&2
[ "$ST" = "Success" ]
```

- [ ] **Step 2: Escribir el script de instalación de Docker**

`_meta/devops/scripts/install-docker.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  echo "docker+compose ya instalados: $(docker --version)"; exit 0
fi
export DEBIAN_FRONTEND=noninteractive
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker ubuntu || true
systemctl enable --now docker
docker --version && docker compose version
```

- [ ] **Step 3: Ejecutar en ambos hosts**

Run:
```bash
chmod +x _meta/devops/scripts/ssm-run.sh
bash _meta/devops/scripts/ssm-run.sh i-060e76a6c26bded35 _meta/devops/scripts/install-docker.sh
bash _meta/devops/scripts/ssm-run.sh i-02fcc4d2329040711 _meta/devops/scripts/install-docker.sh
```
Expected: cada uno termina con `status=Success` y muestra `Docker version ...` y `Docker Compose version ...`.

- [ ] **Step 4: Commit**

```bash
git add _meta/devops/scripts/ssm-run.sh _meta/devops/scripts/install-docker.sh
git commit -m "feat(devops): helper ssm-run + instalar Docker/compose en hosts"
```

---

### Task 5: Secretos → Parameter Store + entrypoint de fetch

**Files:**
- Create: `_meta/devops/secrets/dump-env-to-ssm.sh`
- Create: `deploy/entrypoint-secrets.sh`

**Interfaces:**
- Consumes: KMS `alias/vicionpower-secrets` (Task 3).
- Produces: parámetros `/vicionpower/<env>/<servicio>/*` en SSM; `entrypoint-secrets.sh` que exporta esos params como env y hace `exec "$@"` (usado por los compose de Task 7).

- [ ] **Step 1: Confirmar la ubicación de los `.env` actuales en los hosts**

Run (lee solo rutas, no valores):
```bash
cat > /tmp/findenv.sh <<'EOF'
for f in /etc/vicionpower/*.env /opt/vicion/*.env /etc/vp-engine/*.env; do [ -f "$f" ] && echo "$f"; done
EOF
bash _meta/devops/scripts/ssm-run.sh i-02fcc4d2329040711 /tmp/findenv.sh
```
Expected: lista de rutas `.env` reales (p.ej. `/etc/vicionpower/api.env`). Anotarlas; si la ruta difiere, ajustar Step 2.

- [ ] **Step 2: Escribir el script de carga env→SSM (se corre EN el host vía SSM)**

`_meta/devops/secrets/dump-env-to-ssm.sh`:
```bash
#!/usr/bin/env bash
# Corre en el host. Sube cada KEY=VALUE de un .env a SSM como SecureString.
# Uso (dentro del host): dump-env-to-ssm.sh <env> <servicio> <ruta-.env>
set -euo pipefail
ENVN="$1"; SVC="$2"; FILE="$3"; REGION=us-east-1
while IFS= read -r line; do
  case "$line" in ''|\#*) continue;; esac
  key="${line%%=*}"; val="${line#*=}"
  aws ssm put-parameter --region "$REGION" \
    --name "/vicionpower/$ENVN/$SVC/$key" \
    --value "$val" --type SecureString \
    --key-id alias/vicionpower-secrets --overwrite >/dev/null
  echo "set /vicionpower/$ENVN/$SVC/$key"
done < "$FILE"
```

- [ ] **Step 3: Cargar los secretos de cada servicio (ajustar rutas a las del Step 1)**

Run (ejemplo para `api` en server2; repetir para `vp-engine`/`vp-payments` con sus rutas):
```bash
cat > /tmp/dump-api.sh <<'EOF'
set -e
cat > /usr/local/bin/dump-env-to-ssm.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ENVN="$1"; SVC="$2"; FILE="$3"; REGION=us-east-1
while IFS= read -r line; do
  case "$line" in ''|\#*) continue;; esac
  key="${line%%=*}"; val="${line#*=}"
  aws ssm put-parameter --region "$REGION" --name "/vicionpower/$ENVN/$SVC/$key" --value "$val" --type SecureString --key-id alias/vicionpower-secrets --overwrite >/dev/null
  echo "set /vicionpower/$ENVN/$SVC/$key"
done < "$FILE"
SH
chmod +x /usr/local/bin/dump-env-to-ssm.sh
/usr/local/bin/dump-env-to-ssm.sh prod api /etc/vicionpower/api.env
EOF
bash _meta/devops/scripts/ssm-run.sh i-02fcc4d2329040711 /tmp/dump-api.sh
```
Expected: líneas `set /vicionpower/prod/api/<KEY>` por cada variable.

- [ ] **Step 4: Verificar que los parámetros existen (sin imprimir valores)**

Run: `aws ssm get-parameters-by-path --path /vicionpower/prod/api/ --region us-east-1 --query 'Parameters[].Name' --output text`
Expected: lista de nombres `/vicionpower/prod/api/...` (sin valores).

- [ ] **Step 5: Escribir el entrypoint que inyecta secretos en el contenedor**

`deploy/entrypoint-secrets.sh`:
```bash
#!/usr/bin/env sh
# Lee /vicionpower/$APP_ENV/$APP_SVC/* de SSM, exporta como env y arranca el proceso.
set -e
: "${APP_ENV:?APP_ENV requerido}"; : "${APP_SVC:?APP_SVC requerido}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="/vicionpower/$APP_ENV/$APP_SVC/"
# get-parameters-by-path paginado; exporta NAME(sin prefijo)=VALUE
NEXT=""
while : ; do
  OUT=$(aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX" --with-decryption \
        --query 'Parameters[].[Name,Value]' --output text ${NEXT:+--starting-token "$NEXT"})
  echo "$OUT" | while IFS=$(printf '\t') read -r name value; do
    [ -n "$name" ] || continue
    key="${name#$PREFIX}"
    export "$key=$value"
  done
  NEXT=$(aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX" --query 'NextToken' --output text 2>/dev/null || echo None)
  [ "$NEXT" = "None" ] && break
done
# Re-export real (el while corre en subshell): usar un archivo temporal
ENVF=$(mktemp)
aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX" --with-decryption \
  --query 'Parameters[].[Name,Value]' --output text | while IFS=$(printf '\t') read -r name value; do
    [ -n "$name" ] || continue; printf '%s=%s\n' "${name#$PREFIX}" "$value" >> "$ENVF"
  done
set -a; . "$ENVF"; set +a; rm -f "$ENVF"
exec "$@"
```

Nota: el contenedor necesita el `aws` CLI. Para imágenes distroless/scratch (api, vp-engine) esto NO funciona dentro del contenedor; en su lugar el **fetch lo hace el host** y se pasa por `--env-file` generado en el deploy (ver Task 9, donde el SSM script genera el env-file con `aws ssm` antes del `compose up`). Este `entrypoint-secrets.sh` queda como alternativa solo para imágenes con shell+aws.

- [ ] **Step 6: Commit**

```bash
git add _meta/devops/secrets/dump-env-to-ssm.sh deploy/entrypoint-secrets.sh
git commit -m "feat(devops): cargar .env a SSM Parameter Store + entrypoint de secretos"
```

---

### Task 6: Ajustar Dockerfiles y build arm64 local

**Files:**
- Modify: `app/Dockerfile`
- Modify: `vp-engine/deployments/Dockerfile`
- Create: `vp-engine/deployments/Dockerfile.payments`

**Interfaces:**
- Produces: imágenes construibles `vp/api`, `vp/vp-engine`, `vp/vp-payments` arm64.

- [ ] **Step 1: Arreglar el lockfile en `app/Dockerfile`**

El repo usa `bun.lock` (texto), no `bun.lockb`. En `app/Dockerfile` reemplazar:
```dockerfile
COPY package.json bun.lockb* ./
```
por:
```dockerfile
COPY package.json bun.lock* ./
```
y actualizar los comentarios de cabecera de `ghcr.io/vicionpower/app` a `522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/api`.

- [ ] **Step 2: Verificar build arm64 de api**

Run: `docker buildx build --platform linux/arm64 -t vp/api:test app/`
Expected: build termina `naming to ... vp/api:test` sin error de lockfile.

- [ ] **Step 3: Parametrizar el Dockerfile de vp-engine para el cmd**

En `vp-engine/deployments/Dockerfile`, hacer el `cmd` configurable. Reemplazar la línea de build y el `ENTRYPOINT` para usar un `ARG CMD=vp-engine`:
```dockerfile
ARG CMD=vp-engine
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
    -o /app-bin ./cmd/${CMD}
```
y en el stage final:
```dockerfile
COPY --from=builder /app-bin /app-bin
ENTRYPOINT ["/app-bin"]
```
Actualizar el comentario de imagen a `522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/vp-engine`.

- [ ] **Step 4: Verificar build arm64 de engine y payments (mismo Dockerfile, distinto ARG)**

Run:
```bash
docker buildx build --platform linux/arm64 --build-arg CMD=vp-engine   -f vp-engine/deployments/Dockerfile -t vp/vp-engine:test   vp-engine/
docker buildx build --platform linux/arm64 --build-arg CMD=vp-payments -f vp-engine/deployments/Dockerfile -t vp/vp-payments:test vp-engine/
```
Expected: ambos builds OK; el chequeo de binario estático (`not a dynamic executable`) pasa.

- [ ] **Step 5: Commit**

```bash
git add app/Dockerfile vp-engine/deployments/Dockerfile
git commit -m "fix(docker): lockfile bun.lock, parametrizar cmd Go, apuntar a ECR"
```

---

### Task 7: docker-compose por host

**Files:**
- Create: `deploy/compose/server1.yml` (vp-engine + vp-payments)
- Create: `deploy/compose/server2.yml` (api + vp-engine)

**Interfaces:**
- Consumes: imágenes ECR (Tasks 1/6), env-file generado en deploy (Task 9).
- Produces: stacks compose parametrizados por `IMAGE_TAG`, `REGISTRY`; consumidos por Task 9.

- [ ] **Step 1: Escribir el compose de server2 (api + engine)**

`deploy/compose/server2.yml`:
```yaml
services:
  api:
    image: ${REGISTRY}/vp/api:${IMAGE_TAG}
    restart: unless-stopped
    env_file: [/run/vicionpower/api.env]
    ports: ["127.0.0.1:3000:3000"]
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 2s
      retries: 3
      start_period: 15s
    stop_grace_period: 20s
  vp-engine:
    image: ${REGISTRY}/vp/vp-engine:${IMAGE_TAG}
    restart: unless-stopped
    env_file: [/run/vicionpower/vp-engine.env]
    ports: ["127.0.0.1:50051:50051", "127.0.0.1:9090:9090"]
    stop_grace_period: 20s
```

- [ ] **Step 2: Escribir el compose de server1 (engine + payments)**

`deploy/compose/server1.yml`:
```yaml
services:
  vp-engine:
    image: ${REGISTRY}/vp/vp-engine:${IMAGE_TAG}
    restart: unless-stopped
    env_file: [/run/vicionpower/vp-engine.env]
    ports: ["127.0.0.1:50051:50051", "127.0.0.1:9090:9090"]
    stop_grace_period: 20s
  vp-payments:
    image: ${REGISTRY}/vp/vp-payments:${IMAGE_TAG}
    restart: unless-stopped
    env_file: [/run/vicionpower/vp-payments.env]
    ports: ["127.0.0.1:9095:9095"]
    stop_grace_period: 20s
```

- [ ] **Step 3: Validar sintaxis compose (local)**

Run: `IMAGE_TAG=test REGISTRY=local docker compose -f deploy/compose/server2.yml config -q && echo OK`
Expected: `OK` (sin errores de parseo).
Run: `IMAGE_TAG=test REGISTRY=local docker compose -f deploy/compose/server1.yml config -q && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add deploy/compose/
git commit -m "feat(deploy): compose por host (api/engine/payments) parametrizado por IMAGE_TAG"
```

---

### Task 8: Workflow CI — build + push a ECR (sin deploy)

**Files:**
- Create: `.github/workflows/build.yml`

**Interfaces:**
- Consumes: rol `vp-gha-deploy` (Task 2), repos ECR (Task 1), Dockerfiles (Task 6).
- Produces: imágenes `vp/*:<git-sha>` y `vp/*:<env>` en ECR; output `image_tag` reusable por el deploy (Task 9).

- [ ] **Step 1: Escribir el workflow de build**

`.github/workflows/build.yml`:
```yaml
name: build
on:
  push: { branches: [main, staging] }
permissions: { id-token: write, contents: read }
env:
  AWS_REGION: us-east-1
  REGISTRY: 522814703714.dkr.ecr.us-east-1.amazonaws.com
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: bun install --frozen-lockfile
        working-directory: app
      - run: bun run typecheck
        working-directory: app
      - uses: actions/setup-go@v5
        with: { go-version-file: vp-engine/go.mod }
      - run: go build ./...
        working-directory: vp-engine
  push:
    needs: test
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - { repo: vp/api,         context: app,       dockerfile: app/Dockerfile,                    cmd: "" }
          - { repo: vp/vp-engine,   context: vp-engine, dockerfile: vp-engine/deployments/Dockerfile,  cmd: vp-engine }
          - { repo: vp/vp-payments, context: vp-engine, dockerfile: vp-engine/deployments/Dockerfile,  cmd: vp-payments }
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::522814703714:role/vp-gha-deploy
          aws-region: ${{ env.AWS_REGION }}
      - uses: aws-actions/amazon-ecr-login@v2
      - uses: docker/setup-buildx-action@v3
      - name: env tag
        id: t
        run: echo "env=${{ github.ref_name == 'main' && 'prod' || 'staging' }}" >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@v6
        with:
          context: ${{ matrix.context }}
          file: ${{ matrix.dockerfile }}
          platforms: linux/arm64
          push: true
          build-args: ${{ matrix.cmd != '' && format('CMD={0}', matrix.cmd) || '' }}
          tags: |
            ${{ env.REGISTRY }}/${{ matrix.repo }}:${{ github.sha }}
            ${{ env.REGISTRY }}/${{ matrix.repo }}:${{ steps.t.outputs.env }}
          provenance: false
```

- [ ] **Step 2: Commit y push a una rama de prueba para validar (no main aún)**

```bash
git add .github/workflows/build.yml
git commit -m "feat(ci): workflow build+push imagenes arm64 a ECR via OIDC"
git push -u origin feat/cicd-ecr-fase1
```

- [ ] **Step 3: Disparar el build manualmente desde la rama staging de prueba**

Run (merge o push de la rama a `staging` para gatillar; o temporalmente añadir la rama al `on.push`):
`gh workflow run build.yml --ref staging` (tras alinear la rama) o push a `staging`.
Expected: el run termina verde; jobs `test` y `push (3 matrices)` OK.

- [ ] **Step 4: Verificar imágenes en ECR**

Run: `aws ecr describe-images --repository-name vp/api --region us-east-1 --query 'imageDetails[].imageTags' --output text`
Expected: aparece un tag = git-SHA y `staging`.

- [ ] **Step 5: Verificar que la imagen corre en Fargate-ready (smoke local arm64)**

Run: `docker run --rm --platform linux/arm64 522814703714.dkr.ecr.us-east-1.amazonaws.com/vp/vp-engine:staging --version || true`
Expected: imprime versión o arranca (valida que el binario corre en arm64).

---

### Task 9: Workflow CI — deploy vía SSM + rollback

**Files:**
- Create: `.github/workflows/deploy.yml` (reemplaza el actual)
- Create: `_meta/devops/scripts/remote-deploy.sh` (lo que corre EN el host)
- Delete: contenido viejo de `.github/workflows/deploy.yml` (binario-SSH)

**Interfaces:**
- Consumes: imágenes ECR (Task 8), compose (Task 7), rol OIDC (Task 2), instance role (Task 3).
- Produces: deploy con health gate; `workflow_dispatch` con input `tag` para rollback.

- [ ] **Step 1: Escribir el script remoto (genera env-file desde SSM, pull, up, health)**

`_meta/devops/scripts/remote-deploy.sh`:
```bash
#!/usr/bin/env bash
# Corre EN el host vía SSM. Args por env: ENVN, IMAGE_TAG, COMPOSE (ruta), SERVICES (lista), REGION
set -euo pipefail
REGION="${REGION:-us-east-1}"
REGISTRY="522814703714.dkr.ecr.${REGION}.amazonaws.com"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
install -d -m 700 /run/vicionpower
for svc in $SERVICES; do
  pfx="/vicionpower/$ENVN/$svc/"
  : > "/run/vicionpower/$svc.env"; chmod 600 "/run/vicionpower/$svc.env"
  aws ssm get-parameters-by-path --region "$REGION" --path "$pfx" --with-decryption \
    --query 'Parameters[].[Name,Value]' --output text \
  | while IFS="$(printf '\t')" read -r name value; do
      [ -n "$name" ] && printf '%s=%s\n' "${name#$pfx}" "$value" >> "/run/vicionpower/$svc.env"
    done
done
export REGISTRY IMAGE_TAG="$IMAGE_TAG"
docker compose -f "$COMPOSE" pull
docker compose -f "$COMPOSE" up -d --remove-orphans
# Health gate: esperar que el contenedor api (si existe) responda; engine/payments por estado
sleep 5
docker compose -f "$COMPOSE" ps
FAIL=0
for svc in $SERVICES; do
  state=$(docker inspect -f '{{.State.Health.Status}}{{.State.Status}}' "$(docker compose -f "$COMPOSE" ps -q "$svc")" 2>/dev/null || echo "")
  case "$state" in *healthy*|*running) ;; *) echo "UNHEALTHY: $svc ($state)"; FAIL=1;; esac
done
[ "$FAIL" = 0 ] && echo "DEPLOY OK tag=$IMAGE_TAG" || { echo "DEPLOY FAILED"; exit 1; }
```

- [ ] **Step 2: Escribir el workflow de deploy**

`.github/workflows/deploy.yml` (reemplaza por completo el contenido actual):
```yaml
name: deploy
on:
  workflow_run:
    workflows: [build]
    types: [completed]
    branches: [main, staging]
  workflow_dispatch:
    inputs:
      tag:        { description: "git-SHA a desplegar (rollback)", required: true }
      environment:{ description: "prod|staging", required: true, default: prod }
permissions: { id-token: write, contents: read }
env:
  AWS_REGION: us-east-1
concurrency: { group: deploy-${{ github.ref_name }}, cancel-in-progress: false }
jobs:
  deploy:
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::522814703714:role/vp-gha-deploy
          aws-region: ${{ env.AWS_REGION }}
      - name: resolve target
        id: t
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            ENV="${{ inputs.environment }}"; TAG="${{ inputs.tag }}"
          else
            ENV="${{ github.event.workflow_run.head_branch == 'main' && 'prod' || 'staging' }}"
            TAG="${{ github.event.workflow_run.head_sha }}"
          fi
          echo "env=$ENV" >> "$GITHUB_OUTPUT"; echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          # Formato targets: "inst|compose|svc1 svc2;inst|compose|svc1 svc2" (campos por |, targets por ;)
          if [ "$ENV" = "prod" ]; then
            echo "targets=i-060e76a6c26bded35|deploy/compose/server1.yml|vp-engine vp-payments;i-02fcc4d2329040711|deploy/compose/server2.yml|api vp-engine" >> "$GITHUB_OUTPUT"
          else
            echo "targets=i-0f7f6c73503537d73|deploy/compose/server2.yml|api vp-engine" >> "$GITHUB_OUTPUT"
          fi
      - name: deploy via SSM
        run: bash _meta/devops/scripts/ci-ssm-deploy.sh "${{ steps.t.outputs.env }}" "${{ steps.t.outputs.tag }}" "${{ steps.t.outputs.targets }}"
```

- [ ] **Step 3: Escribir el lanzador SSM del CI**

`_meta/devops/scripts/ci-ssm-deploy.sh`:
```bash
#!/usr/bin/env bash
# Uso: ci-ssm-deploy.sh <env> <tag> "<inst|compose|svcs;inst|compose|svcs>"
# Campos por '|', targets por ';'. svcs puede contener espacios.
set -euo pipefail
ENVN="$1"; TAG="$2"; TARGETS="$3"; REGION=us-east-1
REMOTE=$(base64 -w0 _meta/devops/scripts/remote-deploy.sh)
[ -n "$TARGETS" ] || { echo "sin targets"; exit 1; }
IFS=';' read -ra T <<< "$TARGETS"
for t in "${T[@]}"; do
  inst="${t%%|*}"; rest="${t#*|}"; compose="${rest%%|*}"; svcs="${rest#*|}"
  # El script remoto recibe sus args por env; lo invocamos con base64 para no pelear con comillas.
  CMD="ENVN='$ENVN' IMAGE_TAG='$TAG' COMPOSE='$compose' SERVICES='$svcs' bash -c \"echo $REMOTE | base64 -d | bash\""
  PARAMS=$(printf '{"commands":["%s"]}' "$CMD")
  TMP=$(mktemp); printf '%s' "$PARAMS" > "$TMP"
  CID=$(aws ssm send-command --region "$REGION" --document-name AWS-RunShellScript --instance-ids "$inst" --parameters "file://$TMP" --query 'Command.CommandId' --output text)
  rm -f "$TMP"
  for i in $(seq 1 60); do ST=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$inst" --query Status --output text 2>/dev/null || echo Pending); case "$ST" in Success|Failed|Cancelled|TimedOut) break;; esac; sleep 5; done
  echo "### $inst status=$ST"
  aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$inst" --query StandardOutputContent --output text
  [ "$ST" = Success ] || { aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$inst" --query StandardErrorContent --output text >&2; exit 1; }
done
```

- [ ] **Step 4: Probar deploy en staging por `workflow_dispatch`**

Run: `gh workflow run deploy.yml --ref staging -f tag=<git-sha-de-Task8> -f environment=staging`
Expected: run verde; logs muestran `DEPLOY OK tag=<sha>`.

- [ ] **Step 5: Probar rollback (desplegar un sha anterior)**

Run: `gh workflow run deploy.yml --ref staging -f tag=<sha-anterior> -f environment=staging`
Expected: run verde; `docker compose ps` en el host muestra la imagen con el sha anterior.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/deploy.yml _meta/devops/scripts/remote-deploy.sh _meta/devops/scripts/ci-ssm-deploy.sh
git commit -m "feat(ci): deploy via SSM con health gate + rollback por workflow_dispatch"
```

---

### Task 10: ALB + ACM + target group + DNS api.

**Files:**
- Create: `_meta/devops/alb/create-alb.sh`

**Interfaces:**
- Consumes: server2 (`i-02fcc4...`) corriendo api en `:3000` (Task 9).
- Produces: ALB con listener 443 (ACM) → target group `vp-api-tg`; `api.mindblisspower.com` alias → ALB.

- [ ] **Step 1: Descubrir VPC, subnets públicas y SG del ALB**

Run:
```bash
VPC=$(aws ec2 describe-instances --instance-ids i-02fcc4d2329040711 --query 'Reservations[0].Instances[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=map-public-ip-on-launch,Values=true --query 'Subnets[].SubnetId' --output text)
echo "VPC=$VPC SUBNETS=$SUBNETS"
```
Expected: imprime VPC y ≥2 subnets en AZs distintas (requisito del ALB). Si hay <2, usar subnets públicas existentes de 2 AZs.

- [ ] **Step 2: Solicitar certificado ACM (validación DNS) y crear el registro CNAME de validación**

Run:
```bash
CERT=$(aws acm request-certificate --domain-name api.mindblisspower.com --validation-method DNS --query CertificateArn --output text)
aws acm describe-certificate --certificate-arn "$CERT" --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```
Expected: devuelve `{Name,Type,Value}` del CNAME de validación. Crear ese CNAME en Route53 (zona `Z04248571P6Q70DSQDSGO`) con un change-batch UPSERT, y esperar `aws acm wait certificate-validated --certificate-arn "$CERT"`.

- [ ] **Step 3: Crear SG del ALB y target group**

Run:
```bash
ALBSG=$(aws ec2 create-security-group --group-name vp-alb-sg --description "ALB publico 443" --vpc-id $VPC --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $ALBSG --protocol tcp --port 443 --cidr 0.0.0.0/0
TG=$(aws elbv2 create-target-group --name vp-api-tg --protocol HTTP --port 3000 --vpc-id $VPC \
  --target-type instance --health-check-path /health --health-check-interval-seconds 10 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 register-targets --target-group-arn $TG --targets Id=i-02fcc4d2329040711,Port=3000
echo "ALBSG=$ALBSG TG=$TG"
```
Expected: imprime los IDs. (La api debe escuchar en `:3000` accesible desde el SG del ALB — ver Step 5.)

- [ ] **Step 4: Crear el ALB y el listener 443**

Run:
```bash
ALB=$(aws elbv2 create-load-balancer --name vp-alb --type application --scheme internet-facing \
  --subnets $SUBNETS --security-groups $ALBSG --query 'LoadBalancers[0].LoadBalancerArn' --output text)
aws elbv2 create-listener --load-balancer-arn $ALB --protocol HTTPS --port 443 \
  --certificates CertificateArn=$CERT --default-actions Type=forward,TargetGroupArn=$TG
DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns $ALB --query 'LoadBalancers[0].DNSName' --output text)
ZID=$(aws elbv2 describe-load-balancers --load-balancer-arns $ALB --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)
echo "ALB_DNS=$DNS ALB_ZONE=$ZID"
```
Expected: imprime el DNS del ALB (`vp-alb-...elb.amazonaws.com`) y su hosted zone id.

- [ ] **Step 5: Abrir el puerto 3000 del EC2 solo desde el SG del ALB; exponer api a la red privada**

Run:
```bash
aws ec2 authorize-security-group-ingress --group-id sg-00bc3b29df49c4597 \
  --protocol tcp --port 3000 --source-group $ALBSG
```
Y cambiar el bind de la api en `deploy/compose/server2.yml` de `127.0.0.1:3000:3000` a `3000:3000` (para que el ALB la alcance por la IP privada). Re-desplegar server2 (Task 9 dispatch).
Expected: `aws elbv2 describe-target-health --target-group-arn $TG` muestra `State=healthy` para el target.

- [ ] **Step 6: Crear `api.mindblisspower.com` como alias al ALB en Route53**

Run (UPSERT con AliasTarget usando `ALB_DNS` y `ALB_ZONE` del Step 4):
```bash
cat > /tmp/api-dns.json <<JSON
{ "Changes": [ { "Action": "UPSERT", "ResourceRecordSet": {
  "Name": "api.mindblisspower.com.", "Type": "A",
  "AliasTarget": { "HostedZoneId": "$ZID", "DNSName": "$DNS", "EvaluateTargetHealth": true } } } ] }
JSON
aws route53 change-resource-record-sets --hosted-zone-id Z04248571P6Q70DSQDSGO --change-batch file:///tmp/api-dns.json
```
Expected: `ChangeInfo.Status=PENDING`; esperar INSYNC.

- [ ] **Step 7: Verificar HTTPS end-to-end**

Run: `curl -fsS https://api.mindblisspower.com/health && echo " <- API OK"`
Expected: respuesta del `/health` + `<- API OK`; cert válido (sin `-k`).

- [ ] **Step 8: Commit**

```bash
git add _meta/devops/alb/create-alb.sh deploy/compose/server2.yml
git commit -m "feat(devops): ALB + ACM + target group api + DNS api.mindblisspower.com"
```

---

### Task 11: Cutover staging + validación de rollback

**Files:** (sin archivos nuevos; validación)

**Interfaces:**
- Consumes: todo lo anterior.

- [ ] **Step 1: Confirmar el server de staging**

Run: `aws ec2 describe-instances --instance-ids i-0f7f6c73503537d73 --query 'Reservations[0].Instances[0].{Name:Tags[?Key==`Name`]|[0].Value,State:State.Name}' --output json`
Expected: `mindbliss-staging`, `running`. Si NO es el staging correcto, ajustar el `targets` de staging en `.github/workflows/deploy.yml` y `Global Constraints`.

- [ ] **Step 2: Instalar Docker en staging y cargar sus secretos**

Run:
```bash
bash _meta/devops/scripts/ssm-run.sh i-0f7f6c73503537d73 _meta/devops/scripts/install-docker.sh
```
Y cargar `/vicionpower/staging/api/*` y `/vicionpower/staging/vp-engine/*` (Task 5, env=`staging`).
Expected: `status=Success`; params staging listados por `get-parameters-by-path`.

- [ ] **Step 3: Deploy a staging desde el pipeline (push a rama staging)**

Run: push a `staging` y dejar correr `build` → `deploy`.
Expected: ambos runs verdes; `curl` al health del servicio en staging OK.

- [ ] **Step 4: Validar rollback en staging**

Run: `gh workflow run deploy.yml --ref staging -f tag=<sha-anterior> -f environment=staging`
Expected: run verde; el contenedor vuelve al sha anterior (`docker compose ps` vía SSM).

---

### Task 12: Cutover prod + retirar binario-SSH + limpiar Hetzner

**Files:**
- Delete: `_meta/devops/caddy/Caddyfile`
- Delete: `_meta/devops/ci/deploy.yml`
- Modify: `_meta/devops/PLAYBOOK.md` (marcar OBSOLETO + apuntar a AWS)
- Create: `_meta/devops/PLAYBOOK-AWS.md` (operación real)

**Interfaces:**
- Consumes: pipeline validado en staging (Task 11).

- [ ] **Step 1: Deploy a prod servicio por servicio**

Run: merge de `feat/cicd-ecr-fase1` → `main` (PR), dejar correr `build`→`deploy`.
Expected: runs verdes; `https://api.mindblisspower.com/health` OK; `docker compose ps` en server1/server2 muestra imágenes con el sha de `main`.

- [ ] **Step 2: Confirmar que los systemd viejos quedan como fallback y luego deshabilitarlos**

Run (tras 24-48h estable; vía SSM en cada host):
```bash
cat > /tmp/stopold.sh <<'EOF'
for s in vp-engine vp-payments mindbliss-vp-api mindbliss-vp-engine mindbliss-web; do
  systemctl is-enabled "$s" 2>/dev/null && systemctl disable --now "$s" 2>/dev/null && echo "disabled $s" || true
done
EOF
bash _meta/devops/scripts/ssm-run.sh i-060e76a6c26bded35 /tmp/stopold.sh
bash _meta/devops/scripts/ssm-run.sh i-02fcc4d2329040711 /tmp/stopold.sh
```
Expected: las units viejas de los servicios contenerizados quedan deshabilitadas (Redis/NATS/Prometheus/Grafana NO se tocan).

- [ ] **Step 3: Eliminar artefactos Hetzner y escribir el playbook AWS**

Borrar `_meta/devops/caddy/Caddyfile` y `_meta/devops/ci/deploy.yml`. En `_meta/devops/PLAYBOOK.md` añadir al inicio:
```markdown
> **OBSOLETO (Hetzner).** La operación real está en AWS. Ver PLAYBOOK-AWS.md.
```
Crear `_meta/devops/PLAYBOOK-AWS.md` con: topología AWS (2 EC2 + ALB + RDS + ECR), cómo desplegar (push a main), cómo hacer rollback (`gh workflow run deploy.yml -f tag=<sha>`), y dónde viven los secretos (Parameter Store `/vicionpower/<env>/*`).

- [ ] **Step 4: Verificar que no quedan referencias a GHCR/Hetzner activas**

Run: `grep -rniE 'ghcr.io|hetzner|cloudflare|10\.0\.1\.' _meta/devops .github app/Dockerfile vp-engine/deployments | grep -v PLAYBOOK.md`
Expected: sin resultados (o solo comentarios históricos en PLAYBOOK.md marcado OBSOLETO).

- [ ] **Step 5: Commit final**

```bash
git rm _meta/devops/caddy/Caddyfile _meta/devops/ci/deploy.yml
git add _meta/devops/PLAYBOOK.md _meta/devops/PLAYBOOK-AWS.md
git commit -m "chore(devops): retirar deploy binario-SSH y artefactos Hetzner; playbook AWS"
```

---

## Notas de ejecución

- Las instancias deben tener salida a internet (NAT/IGW) para `docker pull` desde ECR y `aws ssm`. Ya están gestionadas por SSM (lo tienen).
- Si un `docker pull` falla por auth, revisar que el instance role tenga `AmazonEC2ContainerRegistryReadOnly` (Task 3).
- El health gate de engine/payments es por estado del contenedor (no exponen `/health` HTTP por el ALB); api sí tiene healthcheck HTTP.
- `provenance: false` en buildx evita el índice multi-arch que confunde a algunos runtimes; mantener arm64 puro.
