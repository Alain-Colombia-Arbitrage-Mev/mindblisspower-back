# Releases aprobadas

Guardar aqui UN manifiesto JSON completo por release, sin secretos. Se arma con
los image-lock.json de los tres workflows de publicacion, no escribiendo tags
manualmente. El backend debe usar un mismo commit para sus cuatro servicios.

```sh
node deploy/digitalocean/release.mjs assemble backend-image-lock.json client-image-lock.json admin-image-lock.json --output deploy/digitalocean/releases/r20261024-01.json
```

Revisar/committear el manifiesto por PR. El despliegue manual solo admite rutas
en este directorio, no URLs, archivos de secretos o nombres con traversal.
Primero staging; produccion comprueba que staging este ACTIVE con los mismos
seis digests. El artefacto backup se versiona pero NO se ejecuta al desplegar.
