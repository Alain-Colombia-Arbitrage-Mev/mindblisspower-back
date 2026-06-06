# 0004 — sops + age para secrets management

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** equipo VicionPower (devfidubit)

## Context

VicionPower necesita gestionar secrets (DB passwords, API keys, JWT secrets, encryption keys, OAuth client secrets, age keys per host) para:

- 1 entorno de producción inicialmente, staging y dev secundarios.
- ~4-6 hosts (vp-api ×2, vp-engine, redis, db primary, db replica).
- ~3-5 ingenieros con acceso variable según rol.

Restricciones:
- **No queremos plaintext en el repo** (obvio).
- **Tampoco queremos plaintext en filesystem** del host sin cifrar.
- **Costo $0 preferido** mientras el equipo es chico.
- **Rotación viable** sin requerir downtime.
- **Threat model:** repo leak (atacante read-only) y host compromise individual deben fallar limpio.

## Decision

**sops (Secrets OPerationS) + age (asymmetric encryption).**

Implementación:
- Archivos `secrets/<env>.enc.yaml` cifrados con sops, **commiteados al repo**.
- `.sops.yaml` declara qué age recipients pueden descifrar qué archivo (por path regex).
- Cada host tiene su age private key en `/etc/vicionpower/age.key` (mode 400 root).
- Cada ingeniero ops tiene su age key en `~/.config/sops/age/keys.txt` (con passphrase opcional).
- `decrypt-env.sh` corre como `ExecStartPre=` del systemd unit; descifra a `/etc/vicionpower/app.env` (mode 600 deploy) antes de cada start del servicio.
- Rotación: `sops updatekeys *.enc.yaml` re-encripta con el set actual de recipients.

Detalles operativos en `_meta/devops/secrets/README.md`.

## Consequences

### Positivas

- **Costo $0.** sops es open source (Mozilla, ahora getsops). age es Apache 2.0.
- **Git-friendly.** Diffs son legibles (sops produce YAML estructurado), conflicts pueden resolverse manualmente.
- **Sin componentes runtime adicionales.** No hay servicio Vault que mantener vivo, monitorear, hacer backup, escalar.
- **Acceso por host bien aislado.** Si un host se compromete, atacante solo descifra los secrets de ese entorno (no pueden saltar a producción si están en staging).
- **Rotación es git-trackeable.** El commit que rota una key es auditable.
- **Funciona offline.** Deploy desde máquina sin red al exterior puede descifrar localmente.

### Negativas

- **Manual rotation.** No hay rotación automática de credenciales (a diferencia de Vault dynamic secrets). Humanos tienen que rotar passwords periódicamente. Mitigación: calendar quarterly + runbook documentado.
- **No audit log centralizado** de "quién accedió a qué secret cuándo". Solo `git log` muestra "quién editó". Mitigación: en producción, auditd alerta sobre lecturas de `/etc/vicionpower/age.key`.
- **Comprometer la age private key de un ingeniero compromete TODOS los entornos a los que tenía acceso.** Mitigación: pass-phrase wrap de age keys (`age -p`), MFA en git host, laptop encryption (FileVault/LUKS).
- **No hay credenciales dinámicas** (e.g. DB password efímera por sesión). Para fintech sofisticada eso es deseable pero no bloqueante a este tamaño.
- **No es estándar enterprise.** Auditores SOC 2/PCI esperan Vault o KMS. Si entramos a regulación pesada, migración a Vault está documentada como Plan B.

### Neutras

- Curva de aprendizaje del equipo: ~30 min para usar `sops <file>`. Los 5-10 ingenieros del equipo aprenden una vez y ya.
- TIstop es trade-off: `git pull` antes de deploy garantiza secrets actualizados, pero también significa que un git push es la única "transacción" para introducir un secret nuevo.

## Alternatives considered

### HashiCorp Vault (self-hosted)

**Rechazado para este tamaño.**
- Excelente para 20+ servicios, dynamic secrets, leases, audit log centralizado.
- Operacionalmente: 3 nodos para HA (Raft o Consul), auto-unseal con KMS o cloud HSM, backup, monitoring.
- Footprint ~512 MB RAM por nodo + storage = ~€30-50/mes adicional + horas de ops.
- Para 4-6 hosts y 1 entorno productivo, es 10x el overhead vs sops.

**Plan B documentado:** si el equipo crece a 15+ ingenieros o entramos a regulación PCI/SOX, migrar a Vault. La forma de los secrets en sops YAML mapea directamente a Vault KV v2.

### HashiCorp Vault Cloud (HCP)

**Rechazado.**
- $0.50/hora cluster mínimo = $360/mes. Insostenible al tamaño del proyecto.
- Lock-in con HashiCorp Cloud — la razón por la que escogimos Hetzner self-hosted (ADR 0005) es no depender de proveedores cloud caros.

### AWS Secrets Manager / Parameter Store

**Rechazado.**
- $0.40/secret/mes + $0.05 por 10k API calls. Para ~30 secrets = ~$12/mes — barato, pero exige tener AWS account + IAM setup para hosts no-AWS.
- Latencia desde Hetzner a AWS: 50-150ms cada lookup. Cache local sería necesaria, lo que reintroduce el problema de "secret en filesystem".

### Doppler / Infisical / 1Password CLI

**Considerado.**
- Doppler: $7/user/mes. Bueno, pero costo escala con team size; no aporta valor extra vs sops para nuestro tamaño.
- Infisical: open source, self-hostable. Más sofisticado que sops (UI web, RBAC fino) pero requiere correr su servicio + Postgres aparte.
- 1Password CLI: $7.99/user/mes. Bien para developer secrets locales, pero no para inyección a servicios en producción (no diseñado para eso).

Ninguno gana lo suficiente sobre sops para justificar costo o complejidad.

### Plain `.env` files SCP'd manualmente

**Rechazado.** Sin trail de cambios, sin rotación trazable, sin protección si la máquina del operador se compromete con el archivo abierto.

### Encrypted env vars en CI variables (GitHub Secrets)

**Considerado parcialmente.** Útil para secrets que solo el pipeline CI necesita (e.g. `DEPLOY_SSH_KEY`, `GHCR_TOKEN`). NO usado para secrets de aplicación porque eso obliga a que CI tenga acceso a producción cada deploy — superficie de ataque innecesaria. CI solo descifra el bundle ya cifrado con sops y lo deja en el host; nunca ve los secrets en plaintext.

## References

- `_meta/devops/secrets/README.md` — guía operativa.
- `_meta/devops/secrets/.sops.yaml` — creation rules.
- `_meta/devops/secrets/secrets.example.yaml` — template plaintext.
- `_meta/devops/scripts/decrypt-env.sh` — wrapper systemd ExecStartPre.
- sops: https://github.com/getsops/sops
- age: https://github.com/FiloSottile/age
- Mozilla post-mortem que dio origen a sops: https://blog.mozilla.org/security/2018/07/12/sops-secrets-os/
