# --- НАСТРОЙКИ ---
$ContainerName = "plittex-erp-db-1" 
$DbName = "plittex_erp"
$DbUser = "postgres"
$BackupDir = Join-Path $PSScriptRoot "backups_data"
$DaysToKeep = 7
$Date = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"

if (!(Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir }
Write-Host " Запуск бэкапа базы $DbName из Docker..." -ForegroundColor Cyan

$BackupFile = "$BackupDir\plittex_$Date.sql"
$ZipFile = "$BackupFile.zip"

docker exec -t $ContainerName pg_dump -U $DbUser $DbName | Out-File -FilePath $BackupFile -Encoding utf8
Compress-Archive -Path $BackupFile -DestinationPath $ZipFile
Remove-Item $BackupFile

$LimitDate = (Get-Date).AddDays(-$DaysToKeep)
Get-ChildItem $BackupDir -Filter "*.zip" | Where-Object { $_.LastWriteTime -lt $LimitDate } | Remove-Item
Write-Host " Бэкап готов и сжат: $ZipFile" -ForegroundColor Green


