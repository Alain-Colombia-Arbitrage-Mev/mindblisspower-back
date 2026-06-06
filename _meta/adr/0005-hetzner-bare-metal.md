# 0005 — Hetzner bare metal en lugar de AWS/GCP/Azure

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

VicionPower necesita infraestructura para:

- 2-3 instancias para `vp-api` (TS, ADR 0002).
- 1 instancia dedicada para `vp-engine` (Go).
- 1 host Postgres primary (alto I/O, NVMe local crítico).
- 1 host Postgres replica.
- 1 host pequeño para Redis + NATS.
- Storage para backups (~100 GB iniciales, crecimiento esperado).
- Load balancer público.

Restricciones:
- **Costo es la restricción principal**: el negocio opera con márgenes definidos (ver `mlm_binario_margen_operativo.md`). Cada €100/mes de infra son €1,200/año que salen del margen operativo.
- **Performance bare metal** importa: Postgres con triggers, ltree, motor de bonos batch — son cargas que se benefician de NVMe directo + CPU sin tenant noisy.
- **Compliance** Habeas Data Colombia: residencia de datos manejable.
- **No hay equipo SRE 24/7** que justifique servicios "managed" caros.

## Decision

**Hetzner como proveedor único** para infra de cómputo y storage:

| Componente | Tipo Hetzner | Costo |
|---|---|---|
| `vp-api` ×2 | Cloud CCX23 (8 vCPU dedicado, 32 GB RAM) | ~€60/mo total |
| `vp-engine` | Cloud CCX33 (16 vCPU dedicado, 64 GB RAM) | ~€60/mo |
| Postgres primary | Dedicated AX52 (Ryzen 7950X3D, 64 GB DDR5, 2× 1 TB NVMe) | ~€80/mo |
| Postgres replica | Dedicated AX42 (Ryzen 7700, 64 GB, 2× 512 GB NVMe) | ~€50/mo |
| Redis + NATS | Cloud CX22 (2 vCPU, 4 GB RAM) | ~€4/mo |
| Storage Box | 1 TB SFTP/S3 | ~€4/mo |
| Load Balancer | LB11 | ~€5/mo |
| Total | | **~€263/mo** |

Cloudflare en frente para TLS termination + DDoS mitigation (tier free).

## Consequences

### Positivas

- **Costo 5-10x menor que AWS/GCP equivalente.** Para igual cómputo (16 vCPU dedicado + NVMe + 64 GB RAM), AWS r7gd.4xlarge ≈ $700/mes vs €60/mes en Hetzner CCX33.
- **Bare metal real**, no shared cores. Postgres en AX52 con NVMe local rinde 3-5x más que Aurora/Cloud SQL con storage networked.
- **Sin egreso facturable.** AWS cobra ~$0.09/GB egreso; Hetzner incluye 20 TB/mes en cada server. Para un servicio que sirva muchos reportes, ahorro significativo.
- **NBG1/HEL1 en EU.** Compliance LATAM/EU manejable; latencia ~120-180ms a Colombia (aceptable para un negocio que no es real-time gaming).
- **Operacionalmente predecible.** API hcloud es estable, sin sorpresas de billing, sin "service quotas" que escalan en silencio.
- **Buenos vecinos.** Hetzner es un proveedor establecido (1997), data centers propios, no startup que pueda quebrar.

### Negativas

- **Sin servicios managed convenientes.** No hay equivalente nativo a RDS/Aurora, Lambda, SQS, S3+CloudFront, KMS, IAM. Cada uno se opera self-hosted (Postgres → ADR 0001, secrets → ADR 0004, queues → ADR 0007).
- **Sin auto-scaling automático.** Hetzner Cloud tiene snapshots y crear-via-API rápido, pero no hay autoscaling group que reacciona a métricas. Mitigación: vertical scaling (cambiar tipo de instancia) + horizontal manual.
- **Single region effective** para producción inicial. Multi-región es posible (FSN1, NBG1, HEL1, ASH, HIL) pero requiere setup manual de replicación. Mitigación: cold standby en HEL1 con pgbackrest pull diario.
- **Soporte enterprise limitado** vs AWS Enterprise Support ($15k+/mes). Para nuestro tamaño irrelevante; para escala enterprise de mañana, evaluar.
- **Compliance certifications:** Hetzner tiene ISO 27001, SOC 2 Type II. Suficiente para Habeas Data Colombia y la mayoría de fintech LATAM. Para PCI DSS Level 1 o HIPAA estricta, AWS/GCP tienen más documentación pre-validada (no es nuestro caso ahora).
- **DDoS protection** está en Cloudflare delante, no Hetzner — funciona pero significa que el TLS y la primera línea de defensa están en otro proveedor.

### Neutras

- Hire de DevOps con experiencia Hetzner es menos común que AWS, pero la curva es plana — Linux server + Postgres operation skills cubren el 95%.
- Documentación Hetzner es buena pero menos extensa que la de AWS — cuando hay un problema raro, googlear ayuda menos. Mitigación: comunidad activa en Reddit/foros y ChatGPT/Claude conocen Hetzner razonablemente bien.

## Alternatives considered

### AWS

**Rechazado para producción.**
- Costo equivalente a nuestro stack: ~$1,500-2,500/mes (RDS Multi-AZ + ECS + ElastiCache + S3 + ALB + Route53 + CloudWatch). 6-10x Hetzner.
- Aurora Postgres: excelente managed, pero pierde NVMe local (storage networked, latencias 1-5ms vs <0.5ms en Hetzner bare metal).
- IAM y compliance superiores, pero excesivos para nuestro caso.
- Lock-in a servicios propietarios (CloudWatch, X-Ray, Lambda) tendrían que reescribirse para mover fuera.

Plan B explícito: si el negocio escala a US$10M+ MRR y requiere SOC 2/PCI estricto, evaluar migración a AWS. Para llegar ahí, antes generamos suficiente ingreso para absorber el costo.

### Google Cloud Platform

**Rechazado.** Mismo perfil de costo que AWS. GKE es excelente pero excede nuestras necesidades (ADR 0008 — modular monolith, no Kubernetes).

### Azure

**Rechazado.** Sin razón específica de elección sobre AWS/GCP; precio similar; ecosistema más sesgado a enterprise Microsoft.

### DigitalOcean

**Considerado seriamente, perdió por:**
- Droplets son competentes pero no hay opción de bare metal real (todo es virtualizado).
- Managed Postgres tier no permite extensiones custom (ltree sí, TimescaleDB no en tiers básicos).
- Block storage tiene IOPS limit que satura rápido en hot path de DB.
- Costo no significativamente menor que AWS para igual capacidad real.

DO es excelente para apps web simples; para fintech con DB pesada, Hetzner gana.

### OVHcloud

**Considerado.** Bare metal francés con precios similares a Hetzner. Perdió por:
- API menos pulida; tooling community menor.
- Latencia desde París a Colombia comparable a Hetzner Alemania.
- Reputación de soporte mixta.

Es alternativa válida si Hetzner cae en disfavor; documentado como Plan B regional.

### Vultr

**Rechazado.** Bueno para small VPS; bare metal con menos cuotación de Vultr no compite con AX52 de Hetzner en relación precio/performance.

### Linode (Akamai)

**Rechazado.** Adquisición por Akamai añadió incertidumbre; pricing tiers cambiaron. Sin ventaja sobre Hetzner.

### On-prem propio en Colombia

**Rechazado.**
- Sin equipo de hardware ni datacenter manageable.
- Costos de uplink y redundancia de energía no compensan vs renta a Hetzner.
- Riesgo único de fallo (incendio, robo, huelga).

## Trade-offs aceptados conscientemente

1. **Latencia desde Hetzner a Colombia: ~120-180ms.** Aceptable para un negocio que no es real-time. Si el frontend está en Cloudflare CDN edge en Colombia/Brasil, el usuario percibe rápido el HTML/JS; las API calls cargan ~150ms — perceptible pero no doloroso.
2. **Single-region por defecto.** Plan de DR (HEL1 cold standby) cubre desastres regionales. RPO 24h cross-region es aceptable para fintech no-real-time.
3. **Sin servicios managed:** se trata operativa explícita en `_meta/devops/PLAYBOOK.md`. La curva de operación se asume como competencia interna que el equipo desarrolla.

## References

- `_meta/devops/PLAYBOOK.md` — provisión + operación detallada.
- `_meta/devops/cloud-init/*` — scripts de bootstrap.
- ADR 0001 — Postgres en AX52 bare metal.
- ADR 0008 — modular monolith (no Kubernetes).
- Hetzner pricing: https://www.hetzner.com/cloud, https://www.hetzner.com/dedicated-rootserver
- Comparativa real-world: https://www.crunchydata.com/blog/postgres-on-bare-metal-vs-cloud
