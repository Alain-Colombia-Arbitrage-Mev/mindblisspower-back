# Servidores VicionPower / MindBlissPower

> Inventario levantado vía AWS SSM (`AWS-RunShellScript`) el 2026-06-17.
> Cuenta AWS `522814703714`, región `us-east-1`. Ambas instancias gestionadas por SSM
> con el instance profile `vp-ec2-ssm` (rol con `AmazonSSMManagedInstanceCore`).

## Resumen

| Instancia | EIP | IP privada | Rol | Tipo | OS |
|---|---|---|---|---|---|
| `i-060e76a6c26bded35` | **34.195.82.200** | 172.31.40.91 | **Frontend / Web** | t4g.medium | Ubuntu 26.04 LTS |
| `i-02fcc4d2329040711` | **44.209.143.146** | 172.31.36.103 | **API + Motor + Observabilidad** | t4g.medium | Ubuntu 26.04 LTS |

DNS: **`app.mindblisspower.com` → `34.195.82.200`** (Route53 zona `Z04248571P6Q70DSQDSGO`, A, TTL 60).

Notas comunes a ambos: 2 vCPU, 3.7 GiB RAM, disco raíz 48 GB (~16-17% usado), uptime ~19 días.
**No** usan Docker, **no** usan PM2, **no** usan nginx. Servicios corren como units de systemd.

---

## 1. `34.195.82.200` — Frontend / Web (`i-060e76a6c26bded35`)

Es el servidor público al que apunta `app.mindblisspower.com`.

### Puertos en escucha
| Puerto | Bind | Proceso | Notas |
|---|---|---|---|
| 80 / 443 | `0.0.0.0` | **caddy** | Reverse proxy + TLS (entrada pública) |
| 2019 | `127.0.0.1` | caddy | API de administración de Caddy |
| 3000 | `*` | **next-server** | Frontend Next.js |
| 9090 | `127.0.0.1` | vp-engine | Métricas |
| 50051 | `127.0.0.1` | vp-engine | gRPC |
| 9095 | `127.0.0.1` | vp-payments | Servicio de pagos |
| 6379 | `127.0.0.1` | redis-server | Cache |
| 22 | `0.0.0.0` | sshd | |

### Servicios de aplicación (systemd)
- `caddy.service` — reverse proxy / TLS
- `mindbliss-web.service` — Next.js (frontend)
- `vp-engine.service` — motor de simulación (gRPC + métricas)
- `vp-payments.service` — servicio de pagos
- `redis-server.service`

### Runtime
- Node.js **v22.22.1**, Python 3.14.4

---

## 2. `44.209.143.146` — API + Motor + Observabilidad (`i-02fcc4d2329040711`)

Backend de la API y stack de monitoreo. No expone 80/443 (no es web pública).

### Puertos en escucha
| Puerto | Bind | Proceso | Notas |
|---|---|---|---|
| 3000 | `*` | **bun** | API (`mindbliss-vp-api`) |
| 50051 | `127.0.0.1` | vp-engine | gRPC |
| 9090 | `127.0.0.1` | vp-engine | Métricas |
| 4222 | `127.0.0.1` | nats-server | Bus de mensajes |
| 6379 | `127.0.0.1` | redis-server | Cache |
| 9099 | `127.0.0.1` | prometheus | Métricas (server) |
| 9100 | `*` | prometheus-node-exporter | Métricas de host |
| 3001 | `*` | grafana | Dashboards |
| 22 | `0.0.0.0` | sshd | |

### Servicios de aplicación (systemd)
- `mindbliss-vp-api.service` — API (bun)
- `mindbliss-vp-engine.service` — motor de simulación
- `nats-server.service` — bus de eventos
- `redis-server.service`
- `prometheus.service`, `grafana-server.service`, `prometheus-node-exporter.service` — observabilidad

### Runtime
- Python 3.14.4 (bun corre como servicio; no estaba en el PATH de root)

---

## Seguridad de red (verificado)

Ambas instancias usan el mismo Security Group **`sg-00bc3b29df49c4597`**.
Reglas de entrada abiertas a internet (`0.0.0.0/0`): **solo TCP 80 y 443**.

- Aunque Grafana (3001), bun (3000) y node-exporter (9100) escuchan en `0.0.0.0`
  *dentro* del host, **NO son accesibles desde internet** porque el SG no abre esos
  puertos. Quedan alcanzables solo dentro de la VPC. ✅
- SSH (22) **no** está abierto a `0.0.0.0/0`; el acceso administrativo va por SSM.
- Nota menor: `44.209.143.146` tiene 80/443 abiertos en el SG pero no corre ningún
  servicio en esos puertos (no hay Caddy/nginx ahí), así que esas reglas no exponen nada.

## Cómo se obtuvo / reproducir

```bash
# Script de inventario en: _meta/devops/inventory.sh
aws ssm send-command --document-name AWS-RunShellScript \
  --instance-ids i-060e76a6c26bded35 i-02fcc4d2329040711 \
  --parameters file://_meta/devops/ssm-params.json
# y luego:
aws ssm get-command-invocation --command-id <id> --instance-id <id>
```
Acceso interactivo sin SSH: `aws ssm start-session --target <instance-id>`.
