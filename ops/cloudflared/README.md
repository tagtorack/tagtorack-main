# Cloudflare Tunnel — production n8n

Exposes the local Docker n8n (`127.0.0.1:5678`) to the internet as
`https://n8n.tagtorack.com`, so Cloudflare Pages Functions can reach the
submit/portal/admin webhooks. TLS terminates at Cloudflare's edge; the origin
hop is plain HTTP over loopback.

## What was set up (2026-06-01)

- **Binary:** `cloudflared` (standalone, no installer) at
  `C:\Users\cmcelvain\.cloudflared\cloudflared.exe`
- **Tunnel:** `tagtorack-n8n`, id `3877d0d7-0818-4387-8005-f034f5d0a8ce`
- **Credentials:** `C:\Users\cmcelvain\.cloudflared\3877d0d7-...a8ce.json` — **SECRET**, never commit
- **Config:** `C:\Users\cmcelvain\.cloudflared\config.yml` (mirrored as `config.sample.yml` here)
- **DNS:** CNAME `n8n.tagtorack.com` -> `3877d0d7-...a8ce.cfargotunnel.com` (auto-created by `tunnel route dns`)
- **Auto-start:** hidden launcher at logon —
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\cloudflared-tagtorack.vbs`
  (runs `cloudflared tunnel run tagtorack-n8n`, window style 0). Matches Docker
  Desktop, which also only runs while the user is logged in.

## Why a Startup launcher and not a Windows service

A SYSTEM service would survive logoff, but n8n (Docker Desktop) does not run
while logged off anyway, so the service would just spin with no origin. The
logon launcher matches the real lifecycle and needs no admin/UAC.

## Operations

```powershell
$cf = "$env:USERPROFILE\.cloudflared\cloudflared.exe"
& $cf tunnel list                       # show tunnel + connections
& $cf tunnel info tagtorack-n8n          # per-edge connection detail
Get-Process cloudflared                  # is it running?

# Restart the tunnel:
Get-Process cloudflared | Stop-Process -Force
wscript "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\cloudflared-tagtorack.vbs"

# Verify end-to-end:
Invoke-WebRequest https://n8n.tagtorack.com/healthz -UseBasicParsing
```

## If you migrate n8n to a cloud VM later

1. Copy `cert.pem` + the tunnel `*.json` credentials to the server's `~/.cloudflared/`.
2. Copy `config.sample.yml` -> `config.yml`, fix the `credentials-file` path, keep the
   ingress origin pointing at wherever n8n listens.
3. Install as a real systemd/Windows service there (`cloudflared service install`).
   DNS needs no change — the CNAME already points at the tunnel id.
