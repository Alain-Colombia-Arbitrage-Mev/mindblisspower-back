<#
  Túnel SSH local -> RDS (a través del worker EC2).
  RDS es Public:false, sólo accesible dentro del VPC, por eso se tunela
  por el worker (100.30.223.84) que sí tiene acceso al SG de RDS.

  Uso:
    pwsh ./scripts/tunnel-rds.ps1            # abre el túnel en 15432 (Ctrl+C para cerrar)
    pwsh ./scripts/tunnel-rds.ps1 -LocalPort 25432

  Mientras el túnel está abierto, conéctate a:
    host=localhost  port=<LocalPort>  dbname=vicionpower  sslmode=require
    ej: psql "host=localhost port=15432 dbname=vicionpower user=vp_web sslmode=require"
#>
param(
  [int]$LocalPort = 15432
)

$Pem        = "C:/Users/alain/Desktop/ancestro web/images/alaindevsenior.pem"
$BastionUser = "ubuntu"
$BastionIp   = "100.30.223.84"
$RdsHost     = "database-mindlisspower.ck7m8m0k2p6b.us-east-1.rds.amazonaws.com"
$RdsPort     = 5432

if (-not (Test-Path $Pem)) {
  Write-Error "No se encuentra la llave .pem en: $Pem"
  exit 1
}

Write-Host "Abriendo túnel: localhost:$LocalPort -> $RdsHost`:$RdsPort  (vía $BastionUser@$BastionIp)" -ForegroundColor Cyan
Write-Host "Conéctate con: psql `"host=localhost port=$LocalPort dbname=vicionpower user=vp_web sslmode=require`"" -ForegroundColor Yellow
Write-Host "Ctrl+C para cerrar el túnel." -ForegroundColor DarkGray

# -N: no ejecutar comando remoto · -L: forward de puerto
ssh -i $Pem `
    -o StrictHostKeyChecking=no `
    -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=30 `
    -N `
    -L "${LocalPort}:${RdsHost}:${RdsPort}" `
    "$BastionUser@$BastionIp"
