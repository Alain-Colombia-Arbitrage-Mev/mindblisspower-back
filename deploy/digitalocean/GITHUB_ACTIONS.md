# GitHub Actions: revision automatica de Mindbliss

Fecha: 2026-10-24. Eleccion confirmada: GitHub Actions, sin migracion a GitLab.
Gates, publicadores Docker y CD image-only preparados. Para el lanzamiento,
registro y configuracion real seguir [LAUNCH.md](LAUNCH.md). Un workflow
preparado no significa que una imagen se haya publicado o desplegado.

## Que ejecuta cada Pull Request

| Repositorio | Check | Cobertura |
| --- | --- | --- |
| Backend | backend-bun-security | Audit, tipos y toolchain Bun |
| Backend | backend-go-security | Modulos, govulncheck y rechazo de OpenPGP obsoleto |
| Backend | backend-postgres-api | PostgreSQL nativo, persistencia API, unitarias, seguridad HTTP sintetica, politicas de CI |
| Backend | backend-go-race | vet, vulnerabilidades y suite Go con race detector |
| Backend | backend-docker-runtime | Cuatro runtimes, schemas App Platform, staging/production sinteticos y TLS/mTLS |
| Cliente | client-checks | npm audit, lint, tipos, pruebas y build Next.js |
| Admin | admin-checks | npm audit, lint, pruebas y build Next.js |

Los checks propuestos como obligatorios no tienen filtros de rutas: tambien
corren en PRs de documentacion, evitando checks pendientes que nunca arrancan.
El workflow portable-infra mantiene sus filtros y NO se debe exigir globalmente
en proteccion de ramas. Terraform opcional Alibaba tampoco es un requisito del
lanzamiento DigitalOcean.

Auditorias cliente/admin tambien se ejecutan al integrar en sus ramas existentes
(cliente main/staging; admin master). Backend DB/runtime corre en main/staging.
Las revisiones obsoletas se cancelan con concurrencia acotada por workflow/ref;
los jobs tienen timeout. No se cancela un despliegue financiero en curso.

Las validaciones usan `contents: read`, sin secretos cloud, sin
`pull_request_target`, sin persistir la credencial de checkout y con acciones
externas fijadas por SHA. Se ejecutan en runners efimeros de GitHub, no sobre
el host de produccion. Mantener deshabilitada la opcion de enviar secretos a
workflows de forks; un PR no debe obtener permisos para publicar o desplegar.

## Pruebas PostgreSQL que no deben omitirse

La suite API tiene cuatro pruebas que se omiten sin TEST_DATABASE_URL. El gate
las ejecuta adicionalmente contra una base NUEVA tmpfs, sin Internet ni puerto
publicado. TEST_DATABASE_URL se genera dentro del harness, no desde secretos del
repositorio. Se verifica que pasaron las cuatro, ninguna omitida, y que las
fixtures transaccionales hicieron rollback.

```sh
docker build --target test -t mindbliss/rds-api-test app
docker build -f deploy/docker-qa/Dockerfile.postgres -t mindbliss/rds-postgres-test:20261024 .
node deploy/rds/test-postgres.mjs --synthetic-docker --with-api-tests
docker run --rm --network none mindbliss/rds-api-test
```

El ultimo comando ejecuta 31 pruebas API sin DB, toolchain y 12 comprobaciones
HTTP sinteticas. Sus cuatro skips de persistencia no se consideran cobertura:
los cubre el harness anterior. No apuntar TEST_DATABASE_URL a datos reales.

Politica YAML del backend, desde Linux/WSL, adaptando el montaje en PowerShell:

```sh
docker run --rm --network none -v "$PWD:/repo:ro" -w /repo mindbliss/rds-api-test bun test deploy/digitalocean/ci-policy.test.ts
```

## Activacion remota

1. En los TRES repos, antes de publicar cambios, establecer en Settings >
   Secrets and variables > Actions > Variables:
   `DEPLOYMENT_PROVIDER=digitalocean`. No es un secreto. Los workflows AWS viejos
   que siguen en el remoto necesitan esa variable hasta integrar el nuevo
   fail-closed. Los archivos nuevos solo permiten AWS con valor exacto `aws`.
2. Revisar los cambios locales, hacer commits y publicar las ramas feature sin
   archivos ajenos, `.env`, claves, dumps ni artefactos sinteticos. Backend y
   cliente conservan su rama feature DigitalOcean; admin usa
   `feature/github-actions-review-20261024`. Abrir PRs, no push directo a main o
   master. Las validaciones arrancan al abrir la PR, no por elegir Actions en
   esta conversacion.
3. Confirmar que Actions esta permitido en cada repo y que el plan/presupuesto
   ofrece minutos suficientes. Tras la primera ejecucion remota correcta,
   proteger main/staging o master, exigir PR revisada y los checks de la tabla
   segun el repo. Elegir los nombres reales mostrados por esa PR. Bloquear
   force-push/bypass no aprobado y exigir nueva revision tras cambios sensibles.
4. Las protecciones de ramas privadas requieren un plan GitHub que las admita.
   Las aprobaciones de PR no son lo mismo que required reviewers de un entorno:
   estos ultimos no estan disponibles para repos privados en Free/Pro/Team.
   No afirmar que un environment o un workflow manual constituye por si solo
   aprobacion independiente. Revisar el plan antes de activar publicaciones.
5. Mantener App Platform Autodeploy deshabilitado; completar manifiestos,
   registro, DB, cache TLS, secretos reales y validacion staging. No configurar
   tokens de DigitalOcean/Stripe/DB en estos jobs de revision. El CD separado
   usa entornos staging/production, simulacion por defecto y aprobacion explicita.

Fuentes: [proteccion de ramas](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[reglas de despliegue](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

## Publicacion y limites

`container-images.yml` existe en backend, cliente y admin: MANUAL, solo rama
principal, `DEPLOYMENT_PROVIDER=digitalocean`, tras sus gates y con entorno
`container-images`. Usa DOCR con credenciales limitadas de escritura; los jobs
de PR no tienen secretos cloud ni permisos de publicacion. Exporta locks del
candidato probado y comprueba el digest remoto. No afirma SBOM, provenance
firmada ni revision IA. Tener CI verde no autoriza cobros ni despliegues.

`app-platform-deploy.yml`, solo en backend, consume un release JSON ya revisado
en la rama principal. Cambia exclusivamente los seis digests sobre la spec viva,
sin reemplazar secretos ni red. Requiere DO_LAUNCH_APPROVED=true y confirmacion
para aplicar; produccion comprueba el mismo release ACTIVE en staging. No
provisiona recursos ni ejecuta migraciones. Ver limites y rollback en LAUNCH.md.

No se configuro revision IA (Copilot/CodeQL de pago) ni se certifico ausencia
total de vulnerabilidades. Actions ejecuta herramientas/pruebas; no sustituye
revision humana de pagos, autorizaciones, comisiones, arbol o migraciones.

La suite de lint de admin tiene 11 advertencias preexistentes (hooks y codigo
sin uso), sin errores. No se ocultaron ni se modifico codigo de producto para
forzar el gate. Corregirlas en PRs acotadas separadas antes de endurecer la
politica a cero warnings. Mantener revisiones de seguridad y datos de prueba
separadas de cualquier prueba con 1.100 sesiones reales.
