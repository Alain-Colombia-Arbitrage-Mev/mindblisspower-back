# VicionPower — AWS DevOps Playbook (estado real)

> Este documento describe la infraestructura y CI/CD **tal como está desplegada actualmente**.
> Cuenta AWS: **522814703714** / región primaria: **us-east-1**

---

## 1. Topología

```
Internet
   │
   ▼
ALB vp-alb  (internet-facing, 3 AZ, HTTPS con cert ACM)
   │  DNS: api.mindblisspower.com → A-alias al ALB
   │
   ▼
Target group vp-api-tg  → server2:3000
   │
   ▼
server2  i-02fcc4d2329040711
  ├── contenedor: api          (puerto 3000, host net)
  └── contenedor: vp-engine   (host net, TLS activado, user:"0")
       └── certs montados ro desde /etc/vp-engine/tls

server1  i-060e76a6c26bded35   (interno, sin ALB)
  ├── contenedor: vp-engine    (host net, sin TLS)
  └── contenedor: vp-payments  (host net)
```

### Compose files
| Host    | Archivo                              |
|---------|--------------------------------------|
| server2 | `deploy/compose/server2.yml`         |
| server1 | `deploy/compose/server1.yml`         |

Todos los servicios usan `network_mode: host`.

### Servicios NO migrados (siguen como systemd nativo)
- Redis, NATS, Prometheus, Grafana, Caddy — siguen en systemd en los hosts.
- **Web (Next.js)** — repo aparte `vicion-growth-hub`; `app.mindblisspower.com` apunta directamente a la EIP de server1, **no al ALB**.

### Base de datos
- **Postgres** = RDS (gestionado).

### Systemd units anteriores (DISABLED)
Las siguientes units están deshabilitadas y no deben reactivarse:

| Host    | Unit                        |
|---------|-----------------------------|
| server2 | `mindbliss-vp-api`          |
| server2 | `mindbliss-vp-engine`       |
| server1 | `vp-engine`                 |
| server1 | `vp-payments`               |

---

## 2. Imágenes ECR

Registro: `522814703714.dkr.ecr.us-east-1.amazonaws.com`

| Repositorio       | Arch  | Tags                         |
|-------------------|-------|------------------------------|
| `vp/api`          | arm64 | `<git-SHA>` + `prod`/`staging` |
| `vp/vp-engine`    | arm64 | `<git-SHA>` + `prod`/`staging` |
| `vp/vp-payments`  | arm64 | `<git-SHA>` + `prod`/`staging` |

**Lifecycle policy:** ECR conserva las últimas 10 imágenes por repositorio.

> **Nota:** los repos ECR están configurados como **MUTABLE** para permitir el tag móvil
> `prod`/`staging`. Ver sección de limitaciones conocidas.

---

## 3. CI/CD

### build.yml — build & push automático

**Trigger:** push a `main` o `staging`.

**Flujo:**
1. OIDC → asume rol IAM `vp-gha-deploy` (sin llaves estáticas).
2. Build imagen arm64 con `docker buildx`.
3. Push a ECR con dos tags:
   - `<git-SHA>` (fijo, único)
   - `prod` o `staging` (tag móvil, sobreescribe el anterior)

### deploy.yml — gate manual de producción

**Trigger:** `workflow_dispatch` únicamente (nunca se activa automáticamente).

**Inputs:**
| Input         | Descripción                              |
|---------------|------------------------------------------|
| `tag`         | git-SHA de la imagen a desplegar         |
| `environment` | `prod` o `staging`                       |

**Flujo:**
1. SSM Run Command ejecuta `ci-ssm-deploy.sh` en el host target.
2. En el host, `remote-deploy.sh`:
   a. ECR login (`aws ecr get-login-password …`).
   b. Lee parámetros desde SSM Parameter Store y genera `/run/vicionpower/<svc>.env`.
   c. `docker compose pull` + `docker compose up -d`.
   d. Health gate: espera a que el contenedor responda en `/health`.

### Comandos operativos

**Deploy a producción:**
```bash
gh workflow run deploy.yml -f tag=<git-sha> -f environment=prod
```

**Rollback** (basta con apuntar a un git-SHA anterior — ECR conserva las imágenes):
```bash
gh workflow run deploy.yml -f tag=<git-sha-anterior> -f environment=prod
```

---

## 4. Secretos — SSM Parameter Store

- Tipo: `SecureString`, cifrado con KMS key `alias/vicionpower-secrets`.
- Jerarquía: `/vicionpower/<env>/<servicio>/`.
- **Lectura:** el instance role de los servidores tiene permisos de solo lectura.
- **Escritura:** se hace con el usuario admin (credenciales fuera del instance role).

> **IMPORTANTE — Windows/Git Bash:**
> Al subir parámetros desde Windows o Git Bash, anteponer:
> ```bash
> MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' aws ssm put-parameter …
> ```
> Sin esto, la shell convierte los valores con `/` inicial (p.ej. rutas) y los
> sube corruptos.

---

## 5. Limitaciones conocidas / TODO

### 5.1 Config per-host del vp-engine (CRÍTICO)

**Problema:** server1/vp-engine requiere la config en `/vicionpower/prod/s1-vp-engine/`
(sin TLS), pero `remote-deploy.sh` lee por defecto de `/vicionpower/prod/vp-engine/`
(= config de server2, con TLS). Un deploy automatizado a server1 inyectaría la config
de server2 y el engine de server1 **crashearía**.

**Mitigación actual:** el deploy es manual; el operador no ejecuta `deploy.yml` contra
server1 con la config de vp-engine sin verificar el path correcto.

**Fix pendiente:** que `remote-deploy.sh` / `ci-ssm-deploy.sh` acepten un override de
path SSM per-host (p.ej. embebido en el target string del SSM Run Command), de modo que
server1/vp-engine lea siempre de `s1-vp-engine/` y no de `vp-engine/`.

---

### 5.2 vp-engine corre como root en server2

El contenedor usa `user: "0"` para poder leer los certs TLS que tienen permisos
`640 root:mindbliss`.

**Fix pendiente:** alinear el UID/GID del contenedor con el grupo `mindbliss`, o ajustar
los permisos de los certs para no requerir root.

---

### 5.3 ECR MUTABLE

Los repositorios ECR se cambiaron de `IMMUTABLE` a `MUTABLE` para poder usar el tag
móvil `prod`/`staging`. Esto permite que un tag apunte a imágenes distintas en el tiempo.

**Alternativa más segura:** usar solo tags git-SHA (inmutables) y nunca sobreescribir.
El tag móvil es conveniente pero introduce el riesgo de ambigüedad en auditorías.

---

### 5.4 Web (Next.js) no migrada al ALB

`app.mindblisspower.com` sigue apuntando directamente a la EIP de server1 (no pasa por
el ALB). La app web vive en el repo aparte `vicion-growth-hub` y no forma parte de este
pipeline CI/CD.

**Fix pendiente (si aplica):** cuando se migre la web, agregar un segundo listener/rule
en el ALB o un ALB separado, y actualizar el DNS.

---

## 6. Referencia rápida

```bash
# Ver estado de los contenedores en server2
aws ssm start-session --target i-02fcc4d2329040711
docker compose -f /deploy/compose/server2.yml ps

# Ver estado en server1
aws ssm start-session --target i-060e76a6c26bded35
docker compose -f /deploy/compose/server1.yml ps

# Logs del api en server2
docker logs -f api --tail 100

# Ver parámetros SSM de prod/api
aws ssm get-parameters-by-path --path /vicionpower/prod/api/ --with-decryption

# Listar imágenes ECR (vp/api)
aws ecr list-images --repository-name vp/api --region us-east-1
```
