# Diseño — CI/CD con imágenes versionadas + rollback (Fase 1: AWS EC2 + Docker)

**Fecha:** 2026-06-17
**Repo:** `mindblisspower-back` (rama `main`)
**Estado:** Aprobado (diseño) — pendiente revisión de spec antes del plan de implementación

---

## 1. Contexto y problema

Hoy el backend se despliega con `.github/workflows/deploy.yml`: compila binarios Go
arm64 y los copia por **SSH + `systemctl restart`**, sobrescribiendo el binario en el
servidor. Esto **no tiene imágenes versionadas, no tiene rollback** (el binario anterior
se pierde) y guarda una llave SSH privada en el CI.

Además existe scaffolding **obsoleto orientado a Hetzner/Cloudflare** (`PLAYBOOK.md`,
`caddy/Caddyfile` con IPs `10.0.1.x`, `ci/deploy.yml` que publica a GHCR). **Toda la
operación está hoy en AWS** (EC2 t4g/Graviton, RDS, Route53); Hetzner quedó atrás.

### Objetivo
Pipeline de despliegue **AWS-nativo** que construye y publica **imágenes Docker
versionadas**, las despliega a los EC2 actuales con **rollback fácil**, sin downtime,
y diseñado para **graduar a ECS Fargate (Fase 2)** reutilizando las mismas imágenes.

### No-objetivos (Fase 1)
- No migrar a ECS/EKS todavía (eso es Fase 2).
- No externalizar Redis/NATS (siguen como systemd nativo; van a managed en Fase 2).
- No cubrir el frontend Next.js (`vicion-growth-hub`): es **otro repo**, tendrá su
  propio pipeline idéntico en un spec aparte.
- No implementar redundancia multi-réplica (HA real) — llega en Fase 2 con estado externalizado.

---

## 2. Servicios en alcance

| Servicio | Tecnología | Repo path | Host(s) actual(es) | Puertos | Imagen ECR |
|---|---|---|---|---|---|
| `api` | bun + Hono | `app/` | server 2 (`i-02fcc4...`) | 3000 (HTTP) | `vp/api` |
| `vp-engine` | Go (scratch) | `vp-engine/cmd/vp-engine` | server 1 y 2 | 50051 gRPC, 9090 métricas | `vp/vp-engine` |
| `vp-payments` | Go | `vp-engine/cmd/vp-payments` | server 1 (`i-060e76...`) | 9095 | `vp/vp-payments` |

**Fuera de alcance (siguen como systemd nativo):** Redis, NATS, Prometheus, Grafana,
node-exporter. Cambian poco y/o tienen estado.

**Servidores (us-east-1, cuenta 522814703714):**
- server 1 `i-060e76a6c26bded35` / EIP 34.195.82.200 — web + engine + payments
- server 2 `i-02fcc4d2329040711` / EIP 44.209.143.146 — api + engine + observabilidad
- Ambos: instance profile `vp-ec2-ssm`, Ubuntu 26.04 arm64, gestionados por SSM.

---

## 3. Arquitectura

```
git push (staging|main)
        │
        ▼
GitHub Actions  ── OIDC ──▶ AWS (rol vp-gha-deploy, sin llaves estáticas)
  job test-build:
    • api:        bun install/typecheck/test
    • go:         go build ./... (gate de compilación)
  job docker-push (por servicio):
    • docker buildx --platform linux/arm64 (Dockerfiles ya existen)
    • push ECR:  <repo>:<git-sha>   (inmutable)  +  <repo>:<env>  (móvil: staging|prod)
  job deploy (por instancia destino, vía SSM Run Command):
    • aws ecr get-login-password | docker login        (auth por instance role)
    • IMAGE_TAG=<git-sha> docker compose pull
    • IMAGE_TAG=<git-sha> docker compose up -d          (swap del contenedor)
    • health check (curl al /health del servicio)
    • si health falla ⇒ exit 1  (el contenedor anterior sigue vivo; no se promueve)
        │
        ▼
ALB (HTTPS, cert ACM, health checks)  ─▶  api.mindblisspower.com  (Route53 → ALB)
   └─ listener 443 → target group "api"  → server 2:3000
   (web/app.mindblisspower.com sigue en server 1 hasta que el repo frontend lo ponga
    detrás de este mismo ALB; ese cutover se coordina en el spec del frontend)
vp-engine / vp-payments: tráfico interno (gRPC / localhost), NO pasan por el ALB
Redis · NATS · Prometheus · Grafana · node-exporter: systemd nativo (sin cambios)
```

### 3.1 Versionado e inmutabilidad
- Tag **inmutable** = `git-sha` completo. Es la unidad de despliegue y rollback.
- Tag **móvil** = `staging` / `prod`, apunta al último sha desplegado (conveniencia).
- ECR con **immutable tags** activado para los sha (no se sobreescriben).
- **Lifecycle policy**: conservar las últimas **10** imágenes por repo; expirar el resto.

### 3.2 Deploy sin downtime
- `docker compose up -d` recrea el contenedor; el ALB health check saca al target
  mientras reinicia y lo reincorpora al pasar `/health`. Con `stop_grace_period` y
  `depends_on: condition: service_healthy` se minimiza el blip.
- Para cero-downtime estricto por servicio HTTP (api): correr 2 contenedores con
  puertos distintos y recargar el target group, o aceptar el blip corto de Fase 1
  (HA real = Fase 2). **Decisión Fase 1:** swap simple con health gate; blip < ~2s
  tolerado.

### 3.3 Rollback
- **Automático:** si el health check post-deploy falla, el job aborta y el contenedor
  anterior sigue corriendo (nunca se promueve el tag `prod`).
- **Manual:** `gh workflow run deploy --field tag=<git-sha-previo>` (o
  `_meta/devops/scripts/rollback.sh <servicio> <git-sha>`), que hace pull+up del sha
  anterior. Las imágenes están en ECR (lifecycle conserva 10).

---

## 4. Componentes a crear

### 4.1 ECR
- Repos: `vp/api`, `vp/vp-engine`, `vp/vp-payments`.
- Tag immutability: ON. Scan on push: ON. Lifecycle: retener 10 imágenes.

### 4.2 IAM
- **Rol OIDC `vp-gha-deploy`** (trust al proveedor OIDC de GitHub, condicionado al repo
  `Alain-Colombia-Arbitrage-Mev/mindblisspower-back` y a las refs `main`/`staging`):
  - `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`,
    `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`,
    `ecr:CompleteLayerUpload` (acotado a los 3 repos).
  - `ssm:SendCommand` acotado a las instancias destino y al documento
    `AWS-RunShellScript`; `ssm:GetCommandInvocation`.
- **Ampliar el rol de instancia `vp-ec2-ssm`** con:
  - `AmazonEC2ContainerRegistryReadOnly` (pull desde ECR).
  - `ssm:GetParametersByPath` sobre `/vicionpower/<env>/*` + `kms:Decrypt` de la KMS key usada.

### 4.3 Docker / Compose en cada host
- `deploy/compose/<host-role>.yml` con servicios parametrizados por `IMAGE_TAG`
  (env var), `--env-file` no usado (los secretos vienen de SSM, ver 4.5).
- Instalar Docker Engine + plugin compose vía SSM (one-time, documentado).

### 4.4 ALB + ACM + DNS
- ALB (internet-facing) en las subnets públicas de la VPC. **Compartido**: este spec crea
  el ALB + el target group `api`; el repo frontend le añadirá su target group `web` después.
- Certificado **ACM** para `api.mindblisspower.com` (y `app.` cuando se sume la web;
  validación DNS en Route53).
- Listener 443 → target group `api` (server 2:3000, health `/health`).
- Route53: se crea `api.mindblisspower.com` **alias → ALB**. `app.mindblisspower.com`
  (web) **no se toca en este spec**; su cutover al ALB se hace en el spec del frontend.
- Security Groups: el ALB acepta 443 público; los EC2 aceptan el puerto de la app
  **solo desde el SG del ALB** (cerrar 3000 público; hoy el SG solo abre 80/443).

### 4.5 Secretos — SSM Parameter Store (SecureString)
- Jerarquía: `/vicionpower/<env>/<servicio>/<CLAVE>` (p.ej. `/vicionpower/prod/api/DATABASE_URL`).
- Cifrado con una KMS key dedicada (`alias/vicionpower-secrets`).
- En arranque del contenedor, un entrypoint hace
  `aws ssm get-parameters-by-path --path /vicionpower/<env>/<servicio>/ --with-decryption`
  con el instance role, exporta como env y ejecuta el proceso. **Sin `.env` en disco,
  sin secretos en el CI.**
- Migración: cargar los `.env` actuales del server a Parameter Store (script one-time).
- Nota: si luego se requiere **rotación** (credenciales RDS), esos secretos puntuales
  pueden ir a Secrets Manager; el patrón de lectura es análogo.

### 4.6 Workflow nuevo
- `.github/workflows/deploy.yml` reescrito: jobs `test-build` → `docker-push` (matrix por
  servicio) → `deploy` (matrix por instancia), con `workflow_dispatch` que acepta
  `tag` para rollback manual.
- `staging` → instancia `mindbliss-staging`; `main` → server 1 + server 2.

---

## 5. Limpieza (parte del trabajo)

Marcar obsoletos / eliminar (con nota de reemplazo), para no dejar dos verdades:
- `_meta/devops/PLAYBOOK.md` (Hetzner) → reemplazar por playbook AWS.
- `_meta/devops/caddy/Caddyfile` (Cloudflare/Hetzner, IPs `10.0.1.x`) → eliminar.
- `_meta/devops/ci/deploy.yml` (publica a GHCR) → reemplazado por el workflow ECR.
- Referencias a GHCR en los Dockerfiles (`app/Dockerfile`, `vp-engine/deployments/Dockerfile`)
  → actualizar comentarios a ECR.

---

## 6. Flujo de cutover (orden de implementación, alto nivel)

1. Crear ECR + lifecycle + IAM (rol OIDC y ampliación de `vp-ec2-ssm`).
2. Cargar secretos actuales a Parameter Store; añadir entrypoint de fetch.
3. Instalar Docker + compose en ambos hosts (vía SSM).
4. Escribir Dockerfiles faltantes / ajustar existentes; build local de prueba arm64.
5. Workflow CI: build + push a ECR (sin desplegar aún) — validar imágenes.
6. Desplegar primero en **staging**, validar health + rollback.
7. ALB + ACM + target group `api`; crear DNS `api.mindblisspower.com` → ALB (TTL bajo).
   (`app.`/web se reapunta al ALB en el spec del frontend, no aquí.)
8. Cutover en prod servicio por servicio (api → engine → payments), con el viejo
   systemd como fallback hasta confirmar.
9. Retirar el deploy binario-SSH y limpiar artefactos Hetzner.

---

## 7. Criterios de éxito

- `git push main` produce imágenes `vp/*:<git-sha>` en ECR y las despliega solo si
  pasan health checks.
- Rollback a un sha anterior en **un comando** (`workflow_dispatch tag=<sha>`), < 2 min.
- `api.mindblisspower.com` resuelve al **ALB** y sirve la API por HTTPS (ACM). (`app.`/web
  migra al ALB en el spec del frontend.)
- Ningún secreto de runtime vive en el repo ni en el CI; los contenedores los leen de
  Parameter Store con el instance role.
- Puerto 3000 **no** accesible desde internet (solo vía ALB).
- Las mismas imágenes corren sin reconstruir en una task definition de prueba de Fargate
  (validación de "Fase 2-ready").

---

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Blip de downtime en swap de contenedor (Fase 1 sin multi-réplica) | health gate + ALB drena el target; aceptado < ~2s. HA real en Fase 2. |
| Romper prod en cutover | staging primero; cutover servicio por servicio con systemd viejo como fallback. |
| OIDC mal acotado (CI con permisos de más) | trust policy condicionada a repo+ref; permisos ECR/SSM mínimos y acotados a recursos. |
| Recursos en t4g.medium (2 vCPU/3.7GB) al sumar Docker | servicios stateless livianos; medir; engine es scratch ~15MB. |
| Secretos: instance role demasiado amplio | `ssm:GetParametersByPath` acotado a `/vicionpower/<env>/*` + KMS key específica. |

---

## 9. Fase 2 (fuera de alcance, para contexto)

Mover las **mismas imágenes** a ECS Fargate: task definitions (versionado + rollback
nativo), servicios con N réplicas detrás del **mismo ALB**, Redis → ElastiCache,
NATS clusterizado o servicio dedicado, secretos vía la integración nativa de ECS con
Secrets Manager/Parameter Store. Monitoreo a managed (AMP/CloudWatch) o box dedicado.
