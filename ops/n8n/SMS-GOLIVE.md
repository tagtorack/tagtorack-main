# SMS drop-off notifications — go-live runbook

Phase 2 adds an **opt-in SMS** alongside the existing approval email: when a merchant
approves an item, the seller can be texted the Cal.com drop-off link. Everything is
built and **dark-launched behind `TT_SMS_ENABLED=false`** — no texts send until you
finish the steps below.

## What's already done (code + local stack)

- **DB:** `sellers.sms_consent` + `sellers.sms_opted_out_at` added
  (`ops/initdb/06-sms-consent.sql`). Applied to the live local `tagtorack_app`.
- **Consent capture:** separate, unchecked SMS-consent checkbox on the submit form
  (`submit/portal.html`), wired through `submit/assets/submit.js` → WF-2 → `sellers`.
- **Send:** WF-M4 `Notify` sends a Twilio SMS in addition to the email, gated on
  `TT_SMS_ENABLED && sms_consent && !sms_opted_out_at && a valid phone` (E.164, US default).
- **Opt-out:** WF-S2 `sms/inbound` handles STOP/START → stamps/clears `sms_opted_out_at`.
  Deployed + active.
- **Deployed to local n8n:** WF-2 (`tBbadOonmAB2mbWo`), WF-M4 (`DfPmR0J6A76d4ff5`),
  WF-S2 (`BEuLcNcueoKAWMjP`) — all active. Verified: intake e2e passes, consent
  persists, approval flips to `merchant_approved`, SMS skipped while the flag is off.

## Remaining steps to go live (operator)

1. **Apply the migration to production DB** (only needed if prod is a separate DB from
   the local stack — the local `tagtorack_app` is already migrated):
   ```
   docker exec -i tt_pg sh -c 'psql -U "$POSTGRES_USER" -d tagtorack_app -v ON_ERROR_STOP=1' < ops/initdb/06-sms-consent.sql
   ```

2. **Twilio account + A2P 10DLC registration** (external; carrier approval takes days):
   - Create/Use a Twilio account; buy an SMS-capable number.
   - Register an A2P 10DLC **Brand** + **Campaign** (use case: account
     notifications / transactional). US traffic is filtered until this is approved.
   - Create a **Messaging Service** and attach the number; enable **Advanced Opt-Out**
     (carrier-compliant STOP/START/HELP auto-replies). WF-S2 mirrors opt-out to our DB.

3. **Point Twilio inbound at WF-S2** — in the Messaging Service (or the number's
   Messaging config), set "A message comes in" webhook to:
   ```
   https://n8n.tagtorack.com/webhook/sms/inbound   (HTTP POST)
   ```

4. **Set credentials** in `ops/.env` (placeholders already present):
   ```
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_MESSAGING_SERVICE_SID=MG...   # preferred for 10DLC
   # or TWILIO_FROM_NUMBER=+1...        # if not using a Messaging Service
   ```
   Then recreate the n8n container so it loads them (still off — flag is false):
   ```
   cd ops && docker compose up -d
   ```

5. **Prove delivery** to your own phone before enabling for sellers:
   ```
   node ops/n8n/sms-probe.mjs +1XXXXXXXXXX
   ```
   Confirm the text arrives and Twilio Console → Monitor → Messaging logs shows
   `delivered`. Reply **STOP**, then POST a test to `sms/inbound` (or just text STOP)
   and confirm `sellers.sms_opted_out_at` gets set; **START** clears it.

6. **Flip the flag** and recreate the container:
   ```
   # in ops/.env
   TT_SMS_ENABLED=true
   cd ops && docker compose up -d
   ```

7. **Update the copy from "email" to "email or text"** (the truthfulness gate — only
   after step 5 passes). Edit the seller confirmation/how-it-works lines in
   `submit/portal.html` and the marketing drop-off lines (hero/how-it-works/features
   in the root HTML + `docs/content.md`, which carry a "Phase 2" note at each spot).

8. **End-to-end with a real seller submission:** submit with a phone + SMS box checked,
   approve in `/portal`, confirm **both** email and SMS arrive with a working booking
   link. Submit again without consent → no SMS. STOP → no further SMS.

## Rollback

- Set `TT_SMS_ENABLED=false` and `docker compose up -d` — texts stop immediately;
  email is unaffected. The migration is additive and can stay.

## Redeploying the workflows (if you change the build scripts)

```
cd ops/n8n
node build-wf2.mjs           # regenerates wf2.json (then sync workflows/WF-2-submit-start.json)
node build-m-decide.mjs      # writes workflows/WF-M4-merchant-decide.json
node build-sms-inbound.mjs   # writes workflows/WF-S2-sms-inbound.json
# deploy (PowerShell — Git Bash mangles leading-slash paths):
node n8n-api.mjs PUT  /workflows/tBbadOonmAB2mbWo workflows/WF-2-submit-start.json
node n8n-api.mjs PUT  /workflows/DfPmR0J6A76d4ff5 workflows/WF-M4-merchant-decide.json
node n8n-api.mjs PUT  /workflows/BEuLcNcueoKAWMjP workflows/WF-S2-sms-inbound.json
# activate if needed:
node n8n-api.mjs POST /workflows/<id>/activate
```
