#requires -Version 5
# Crea el rol IAM vp-ec2-ssm para EC2 + SSM y su instance profile.
# Idempotente: si algo ya existe, lo informa y sigue.
$ErrorActionPreference = 'Stop'
$role    = 'vp-ec2-ssm'
$trust   = 'D:/vicionpower/backend/_meta/devops/iam/trust-policy.json'
$ssmArn  = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'

Write-Host "== Identidad ==" -ForegroundColor Cyan
aws sts get-caller-identity

Write-Host "`n== 1/4 Crear rol $role ==" -ForegroundColor Cyan
if (aws iam get-role --role-name $role 2>$null) {
  Write-Host "  ya existe, omitido"
} else {
  aws iam create-role --role-name $role --assume-role-policy-document "file://$trust"
}

Write-Host "`n== 2/4 Adjuntar AmazonSSMManagedInstanceCore ==" -ForegroundColor Cyan
aws iam attach-role-policy --role-name $role --policy-arn $ssmArn
Write-Host "  adjuntada"

Write-Host "`n== 3/4 Crear instance profile $role ==" -ForegroundColor Cyan
if (aws iam get-instance-profile --instance-profile-name $role 2>$null) {
  Write-Host "  ya existe, omitido"
} else {
  aws iam create-instance-profile --instance-profile-name $role
}

Write-Host "`n== 4/4 Agregar rol al instance profile ==" -ForegroundColor Cyan
$prof = aws iam get-instance-profile --instance-profile-name $role | ConvertFrom-Json
if ($prof.InstanceProfile.Roles.RoleName -contains $role) {
  Write-Host "  el rol ya esta en el profile, omitido"
} else {
  aws iam add-role-to-instance-profile --instance-profile-name $role --role-name $role
  Write-Host "  agregado"
}

Write-Host "`n== Listo. Verificacion final ==" -ForegroundColor Green
aws iam get-instance-profile --instance-profile-name $role
