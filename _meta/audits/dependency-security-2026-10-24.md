# Actualizacion De Dependencias - 2026-10-24

Rama: `feature/security-dependencies-20261024` en backend, cliente y administrador.

## Auditoria Y Cambios

| Componente | Antes | Despues | Motivo |
| --- | --- | --- | --- |
| Next.js, cliente/admin | 16.4.1 | 16.4.3 | Parche estable de la misma linea |
| aws-jwt-verify, cliente/admin | 4.0.1 | 5.2.1 | Actualizacion del verificador, compatible con Node >=18 |
| PostCSS directo, cliente/admin | 8.5.23 | 8.5.31 | Parche de herramienta de estilos; Next conserva su dependencia interna auditada |
| ESLint y @eslint/js | 9.39.2 | 9.39.5 | Ultimo parche compatible con el plugin React actual |
| Bun, imagenes API y CI | 1.3.8 | 1.4.4 | Runtime y gestor fijados a la misma version |
| @types/bun | 1.3.14 | 1.4.4 | Tipos alineados con runtime |
| esbuild transitivo API | 0.18.20 / 0.25.12 / 0.28.2 | 0.28.2 | Override elimina la rama vulnerable del CLI Drizzle |
| google.golang.org/grpc | 1.83.1 | 1.83.2 | GO-2026-6443 |
| github.com/klauspost/compress | 1.18.5 | 1.18.7 | GO-2026-5841 |

Auditoria inicial: npm no informaba vulnerabilidades en los dos frontends. Bun informaba GHSA-67mh-4wv8-2f99 en esbuild, transitivo de desarrollo desde Drizzle. La imagen productiva ya excluia Drizzle/esbuild; se mantiene y comprueba esa exclusion. Go no detectaba simbolos vulnerables alcanzables, pero informaba gRPC a nivel de paquete y compress a nivel de modulo: ambos se parchearon igualmente.

Los lockfiles se regeneraron con los gestores correspondientes. No se uso `--force`, `--legacy-peer-deps`, ni se ocultaron avisos de auditoria.

## Compatibilidad Y Autenticacion

- Ocho pruebas nuevas por frontend firman JWT RSA localmente y usan JWKS en memoria. Prueban firma valida, identidad manipulada, audiencia, emisor, tipo de token, vencimiento y ausencia de vencimiento, sin llamadas a Cognito ni OTP.
- El administrador ahora rechaza sesiones cuando falta `COGNITO_CLIENT_ID`; ya no intenta omitir audiencia. Tambien exige `exp` numerico, igual que el cliente. No se relajan controles de firma ni permisos.
- La generacion SQL de Drizzle con el esquema real fallo por dos defaults JS `0n`. Se reprodujo el mismo fallo en la imagen anterior, por lo que no era una regresion del upgrade. Se representan como expresiones SQL `0`: mismo tipo bigint y mismo valor por defecto, sin alterar la DB.
- `test:toolchain` genera el esquema real en un directorio temporal, comprueba los dos defaults `bigint DEFAULT 0 NOT NULL` y elimina solo su directorio verificado. No carga configuracion de aplicacion ni credenciales, y nunca aplica el SQL generado.

## Controles Permanentes

Workflows `dependency-security.yml` en los tres repositorios: PR, rama de esta correccion y ejecucion manual, sin permisos de despliegue ni secretos AWS. npm/Bun audit son bloqueantes; Go ejecuta govulncheck v1.9.0 incluyendo tests. Los pipelines existentes tambien ejecutan npm/Bun y el gate Go antes de desplegar/publicar. El test Docker Bun incluye la prueba de toolchain.

El gate Go usa `-scan=package`: bloquea paquetes importados vulnerables aunque no se haya demostrado una llamada alcanzable. Se validaron localmente tanto ese modo como el analisis de simbolos.

Los workflows se validaron sintacticamente y sus comandos se ejecutaron localmente. No se han disparado en GitHub ni se modificaron las reglas de proteccion de ramas.

## Resultados

- npm audit completo y produccion: 0 vulnerabilidades conocidas en cliente y admin.
- Bun audit: 0 vulnerabilidades conocidas, incluyendo desarrollo.
- govulncheck para Linux/amd64 con tests: 0 vulnerabilidades en simbolos alcanzables y 0 en paquetes importados. Queda un aviso a nivel de modulo descrito debajo.
- `go mod verify`: todos los modulos verificados.
- Docker: 165 pruebas cliente, 98 admin y 28 API Bun aprobadas. Typecheck y builds optimizados correctos; lint admin y revision enfocada de frontend sin errores.
- API Bun: prueba de toolchain aprobada y pentest HTTP sintetico con 12 probes, 3 mutaciones autorizadas de fixture y 0 llamadas externas.
- Imagen API runtime: Bun 1.4.4; ausencia de drizzle-kit, esbuild y TypeScript comprobada.
- Login cliente/admin Docker inspeccionado a 1280px: estilos e imagenes cargados, sin desbordamiento horizontal. No se enviaron codigos.
- Suite Go completa en Docker con `go test -race -p 2 -count=1 -timeout=20m ./...`: aprobada, incluidos bonos, pagos, simulador y retiros. Sin carreras ni fallos.
- 23 pruebas de politicas de infraestructura portable aprobadas. Smoke HTTP general: 24 comprobaciones aprobadas.
- Tras actualizar tambien los servicios Go QA: 15 lecturas API HTTP 200 y prueba SQL del arbol bajo rol de lectura aprobadas; se conservan los nodos bloqueados y sus descendientes. PostgreSQL y Redis no se recrearon.
- Incidencia local de Docker: snapshot padre ausente al exportar cache. La imagen API se reconstruyo sin cache y los frontends de forma separada; no se hizo prune ni se tocaron volumenes.

## Riesgos Y Limites

GO-2026-5932 afecta a `golang.org/x/crypto/openpgp` en todas las versiones, sin parche publicado. El proyecto necesita x/crypto por NATS/nkeys/curve25519, NO por OpenPGP. Se verifico `go list -deps -test ./...`: ningun paquete OpenPGP importado. CI bloquea cualquier incorporacion futura de ese paquete. No se suprime el aviso del scanner ni se afirma que el modulo completo este libre de alertas.

React 18 sigue deprecado por Next 16 y ESLint 9 sigue fuera de soporte. No se detectaron CVE npm en estas versiones. `eslint-plugin-react@7.37.5` declara compatibilidad hasta ESLint 9, no 10; se requiere una migracion especifica del tooling, no forzar peers. React 19 tambien requiere revisar DnD, mapas y otros peers. No se hicieron migraciones mayores de UI/Tailwind que pudieran romper estilos o componentes.

Esto es SCA de dependencias y regresion local, no una garantia de seguridad total, auditoria completa del SO de imagenes ni pentest productivo. La copia historica permanece intacta. No se aplicaron migraciones a bases reales, ni hubo cobros, OTP, emails, push o despliegue de produccion.

## Fuentes Primarias

- [esbuild GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)
- [gRPC GO-2026-6443](https://pkg.go.dev/vuln/GO-2026-6443)
- [compress GO-2026-5841](https://pkg.go.dev/vuln/GO-2026-5841)
- [OpenPGP GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932)
- [Next.js 16.4.3](https://github.com/vercel/next.js/releases/tag/v16.4.3)
- [Bun 1.4.4](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4)
