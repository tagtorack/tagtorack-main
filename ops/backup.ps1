# C:\AI\Business Owners\TagtoRack\ops\backup.ps1
# Nightly pg_dump of both databases (tagtorack_app + n8n) with 30-day rotation.
# Override defaults with env vars: PG_CONTAINER, BACKUP_DEST.
$ErrorActionPreference = "Stop"

$pgContainer = if ($env:PG_CONTAINER) { $env:PG_CONTAINER } else { "tt_pg" }
$dest        = if ($env:BACKUP_DEST)  { $env:BACKUP_DEST }  else { "$env:OneDrive\TagtoRack-backups" }

# Fail loudly if the container isn't running, instead of producing empty dumps.
$running = docker ps --filter "name=$pgContainer" --format "{{.Names}}"
if (-not $running) { Write-Error "Postgres container '$pgContainer' is not running."; exit 1 }

New-Item -ItemType Directory -Force -Path $dest | Out-Null
$stamp = Get-Date -Format yyyyMMdd-HHmm

foreach ($db in @("tagtorack_app", "n8n")) {
  docker exec $pgContainer pg_dump -U tagtorack -d $db -F c -f "/tmp/$db.dump"
  docker cp "${pgContainer}:/tmp/$db.dump" "$dest\$db-$stamp.dump"
  Write-Host "Backed up $db -> $dest\$db-$stamp.dump"
}

# Rotate: prune dumps older than 30 days (logged, so a silent purge can't hide a bad run).
Get-ChildItem $dest -Filter "*.dump" |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
  ForEach-Object { Write-Host "Pruning old backup: $($_.Name)"; Remove-Item $_.FullName -Force }
