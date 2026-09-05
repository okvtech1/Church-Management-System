# OKV CMS Online — Phase 2 Setup Guide

## What this is
The full marketing-to-paid-account funnel plus the account/org/access layer:
a sales landing page, a read-only live demo, a pricing page (Monthly /
Bi-Annual / Yearly × Starter / Professional), sign-up with a 7-day free
trial, an install-only page, login, Admin-managed Users with roles,
activate/suspend, password reset, a trial/subscription countdown with an
upgrade guide, offline-capable data with sync + notifications, member
communications (announcements, birthday/anniversary/custom messages by
Email/SMS/WhatsApp), internal Admin↔User team messaging, a role/plan-aware
downloadable User Manual, single/multi-branch support (branches sync and
feed the Members "Branch" dropdown automatically), and a bank-transfer
payment form for renewals — plus a Super Admin dashboard to manage every
organization, payment, and system-wide setting (branding, contact details,
payment gateways, pricing) without touching the Sheet.

**Page flow:** `index.html` (first page visitors land on) → `demo.html`
(read-only) or `pricing.html` → `signup.html` (plan pre-filled) →
`install.html` → `app.html` (login → dashboard).

## Architecture: one spreadsheet per organization
Every organization ("tenant") gets its **own** dedicated Google Spreadsheet,
created automatically the moment they sign up — you never create these by
hand. A single small **Master** spreadsheet holds only the tenant registry
(org name, admin contact, which spreadsheet belongs to them, plan,
subscription/trial dates) plus the platform-wide bits that were never
per-tenant anyway (Settings, PaymentRequests). The Master spreadsheet never
holds member/attendance/finance data — that all lives in each org's own
spreadsheet, which is what keeps one org's growth from ever affecting
another's, and is what makes the per-tenant cell-capacity monitoring in
step 7 possible.

## 1. Create the Master Google Sheet
Create a new blank Google Sheet — this is your **Master** sheet, not a
tenant's. Copy its ID from the URL:
`https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

### Exact tab headers (auto-created for you — see step 2)
**On the Master spreadsheet:**
- **Tenants** — one row per organization: `orgId | orgName | adminName |
  adminEmail | adminPhone | spreadsheetId | status | subscriptionStatus |
  subscriptionPlan | billingCycle | subscriptionExpiry | trialEndsAt |
  lastReminderSentAt | userCount | cellsUsed | cellsPercent |
  cellGrowthPerDay | estDaysTo90 | capacityStatus | lastCapacityCheckAt |
  termsAcceptedAt | createdAt | updatedAt`. `cellsUsed` through
  `lastCapacityCheckAt` are the cell-capacity monitoring fields — see step
  7. `termsAcceptedAt` is the consent audit timestamp from signup — see
  "Legal pages" under step 4.
- **EmailIndex** — `email | orgId`. Just a login router (which tenant does
  this email belong to?) — no passwords or personal data here.
- **ResetIndex** — `token | orgId | expiresAt`. Same idea, for password
  reset links.
- **PlatformUsers** — your own Super Admin account(s) only; same shape as
  a tenant's Users tab (see below), just for the platform, not any one org.
- **PaymentRequests** — `id | orgId | orgName | userId | fullName | email |
  phone | plan | billingCycle | note | status | processed | createdAt |
  processedAt` (bank-transfer renewal claims — small volume, stays
  platform-wide rather than per-tenant).
- **Settings** — single row, system-wide config: `key | value`, with
  `"config"` holding a JSON blob (branding, contact, manualPayment,
  gateways, sms, whatsapp, plans), editable from the Super Admin dashboard.

**On each tenant's own spreadsheet (created automatically at signup):**
- **Users** — `id | orgId | orgName | username | email | phone |
  passwordHash | isAdmin | isSuperAdmin | roles | status | sessionToken |
  sessionExpiry | resetToken | resetTokenExpiry | createdAt | updatedAt`.
  Subscription/plan fields are *not* here — they live once, on that org's
  Tenants row, since a subscription belongs to the whole org, not one user.
- **Data** — generic store, holds every module's records as JSON, including
  Members, Announcements and Team Messages: `id | orgId | userId | module |
  recordId | dataJson | updatedAt | updatedBy | deleted`.

## 2. Set up Apps Script
1. In the **Master** Sheet: **Extensions → Apps Script**.
2. Delete the default code, paste in all of `Code.gs`.
3. Near the top, set:
   - `MASTER_SHEET_ID` — the ID you copied above.
   - `RESET_PASSWORD_BASE_URL` — the public URL where you'll host
     `reset-password.html` (e.g. `https://yourdomain.com/reset-password.html`).
   Contact details, bank details, and everything else now live in the
   Settings tab (editable from the Super Admin dashboard after first login)
   rather than as constants here.
4. In the function dropdown (top toolbar), select **initializeMasterSheets**,
   then click **Run**. Approve the permissions prompt. This creates
   `Tenants`, `EmailIndex`, `ResetIndex`, `PlatformUsers`, `PaymentRequests`
   and `Settings` on the Master spreadsheet (including a starter `Settings`
   row with sensible defaults), and removes the default "Sheet1". You do
   **not** run anything to create tenant spreadsheets — `handleSignup`
   creates one automatically the moment someone signs up.
5. Select **createSuperAdmin** in the function dropdown, then click **Run**.
   This creates your own Super Admin login (in `PlatformUsers`, with no
   tenant spreadsheet of its own):
   - Email: `technologyokv@gmail.com`
   - Password: `OKVCMS557`
   Log in with it at `app.html` exactly like any customer would, and
   you'll land on your own platform-wide dashboard instead of a single
   church's. **Change this password from My Account right after your first
   login** — it's a shared default meant to be temporary, not a permanent
   credential.
6. (Recommended) Set up time-driven triggers so things happen automatically
   instead of needing you to run functions by hand: in the Apps Script
   editor, click the clock icon (Triggers) → **Add Trigger**:
   - Function **processPaymentRequests** → time-driven → every 15 minutes.
     This is what makes the "email within the hour" promise real for
     payments confirmed via the Sheet (payments confirmed from your Super
     Admin dashboard apply instantly and don't need this).
   - Function **sendRenewalReminders** → time-driven → once a day. Trial
     reminders still go out close to the deadline (trials are only 7 days),
     but paid-subscription reminders are deliberately spaced to roughly
     twice a month rather than nagging daily — see "Design notes" below.
   - Function **checkAllTenantsCapacity** → time-driven → daily (or weekly
     if you have very few tenants) — see step 7 below. Don't set this to
     run on every page load; the whole point of the trigger is that the
     Super Admin dashboard only ever reads numbers this already computed.

## 3. Deploy the Web App
1. **Deploy → New deployment**.
2. Type: **Web app**.
3. Execute as: **Me**.
4. Who has access: **Anyone**.
5. Click **Deploy**, approve permissions again, then copy the **Web app URL**.
6. Paste that URL into `API_BASE_URL` at the top of **`common.js`** —
   that's the only place it needs to go. Every page that talks to the
   backend (`app.html`, `signup.html`, `reset-password.html`,
   `pricing.html`, `demo.html`, and the three legal pages) loads
   `common.js` for this constant and its shared login/session/sync
   helpers, so there's nothing to keep in sync across files.
   (`index.html` and `install.html` are fully static and don't call the
   backend, so they don't load it.)

Whenever you edit `Code.gs` later, use **Deploy → Manage deployments → Edit
→ New version** so the same URL picks up your changes.

## 4. Host the front-end files
Upload every `.html` file, `manifest.json`, `sw.js`, and the `icons/` folder
together, in the same folder, on any static host (your own domain, GitHub
Pages, Netlify, etc.) — it must be **HTTPS** for install/offline features to
work. Nothing here needs a server language; it's all static files calling
your Apps Script URL.

### Legal pages
Three pages ship with the system for compliance: `privacy-policy.html`,
`terms-of-service.html`, and `refund-policy.html`. They're linked from the
footer of every page, from the login screen, from the My Account tab on
both dashboards, and — as a required checkbox — on `signup.html` itself:
an Admin cannot create an account without agreeing to the Terms of Service
and Privacy Policy. That checkbox is enforced on the **server side** too
(`handleSignup` in `Code.gs` rejects a signup that doesn't include
`agreedToTerms: true`), and the moment of consent is timestamped into the
`termsAcceptedAt` column on that org's `Tenants` row as an audit record —
so it's not just a UI nicety that could be bypassed by editing the page.

**Read and personalize these three pages before going live.** They're
written to accurately describe how *this specific system* works (per-tenant
Google Sheets, manual/gateway payments, the 7-day trial, etc.) and reference
real Nigerian data-protection law (the Nigeria Data Protection Act 2023 and
NDPR 2019), but they are **not a substitute for a lawyer** — have one review
and adapt them for your business before you rely on them, especially the
Refund Policy's specific eligibility rules and the liability terms in
Section 12 of the Terms of Service.

## 5. No special login for you
You manage everything either directly in the Sheets (edit any cell — the
Master's `PaymentRequests` tab, or a specific tenant's `Users`/`Data` if you
ever need to) and the Apps Script editor, or from your Super Admin
dashboard once logged in — there's no separate back-door admin account
baked into the app. To confirm a payment: open **PaymentRequests** on the
Master spreadsheet, find the row, set its **status** cell to `Confirmed` or
`Rejected`. The trigger (or a manual run of `processPaymentRequests()`)
does the rest — or just use the Payments tab on the dashboard, which
applies instantly.

## 6. Google Sheets' 10,000,000-cell limit — per-tenant capacity monitoring
Every Google Sheets **file** — including each tenant's dedicated
spreadsheet — has a hard cap of 10,000,000 cells, summed across all its
tabs. Because each org has its own file, that cap is per-organization, and
`checkAllTenantsCapacity()` (step 2.6) tracks it for you:

- **What it computes, per tenant, once a day/week:** current cell usage
  (actual used range per tab, not the full default grid), what percent of
  10,000,000 that is, a growth rate in cells/day derived from the change
  since the last check, and an estimated number of days until that org
  hits 90% of the limit at its current pace.
- **Where it's stored:** back on that org's row in the Master `Tenants`
  sheet — never computed live when someone opens a dashboard.
- **Status flags:** `Healthy` (under 70%), `Monitor` (70–84%), `Action
  Needed` (85%+). Thresholds are the `85`/`70` numbers inside
  `checkAllTenantsCapacity()` in `Code.gs` if you want to change them.
- **Who sees it:** only the Super Admin dashboard's Organizations tab (a
  "Sheet Capacity" column, with the status, percent used, estimated time
  to 90%, and guidance text next to it) — Organization Admins and Users
  never see any of this, by design.
- **Email alert:** the moment a tenant newly crosses into `Action Needed`,
  you (the address in Settings → Contact) get an email with the
  recommended next step (archive older records into a separate archive
  spreadsheet, or split the tenant further) and a direct link to that
  org's spreadsheet.
- **On-demand refresh:** the "Refresh capacity numbers" button on the
  Organizations tab calls `handleSuperAdminRunCapacityCheck`, which just
  runs the same check immediately — handy for testing, but for a large
  number of tenants prefer letting the scheduled trigger do it, to stay
  well inside Apps Script's execution time limit.

## 7. Migrating an existing single-sheet install
If you have an earlier install where every org shared one spreadsheet
(isolated only by an `orgId` column), run this **once**, manually, from the
Apps Script editor, after completing steps 1–4 above on a fresh Master
sheet:
```
migrateLegacySingleSheetToPerTenant('PASTE_YOUR_OLD_SHEET_ID_HERE')
```
It copies Settings and PaymentRequests across, then creates one new tenant
spreadsheet per organization (copying that org's Users and Data rows into
it) and registers each in the Master `Tenants` sheet — see the big comment
above that function in `Code.gs` for the exact steps. It does **not** touch
or delete the old spreadsheet; verify the new Master and tenant
spreadsheets look right, redeploy the web app pointed at the new
`MASTER_SHEET_ID`, then run `checkAllTenantsCapacity()` once to populate
capacity numbers for the newly created tenant spreadsheets, and archive the
old sheet yourself once you're satisfied.

---

## Testing walkthrough

### 0. The sales funnel
1. Open `index.html`. Confirm the nav links scroll smoothly to each
   section, and both "Start 7-Day Free Trial" buttons work.
2. Click **View Live Demo** → confirm you can click through Dashboard,
   Members, Finance, Attendance, Ministries — all Add/Record buttons are
   visibly disabled. Wait ~8 seconds for the "Get Started Now" popup, and
   confirm both it and the top "Start Free Trial" button lead to
   `pricing.html`.
3. On `pricing.html`, switch between Monthly / Bi-Annual / Yearly and
   confirm prices and the "Save %" badges update. Click **Start for Free**
   on any tier.
4. Confirm you land on `signup.html` with the chosen plan and billing cycle
   shown at the top, and that **Change** sends you back to Pricing.

### A. Two isolated orgs
1. Open `signup.html`, create **Org A** with an Admin account.
2. In an incognito window, create **Org B** with a different Admin account.
3. Log in as each Admin (`app.html`) → **Users** tab. Confirm each only
   ever sees their own org's users — never each other's.

### B. Users scoped inside each org
1. As Org A's Admin → **Users → Add User**. Give them a username, email,
   password, and tick a couple of roles (e.g. *Finance Officer/Treasurer* +
   *Data Entry/Front Desk Officer*). You can also type a custom role into
   the "Add a custom role…" box.
2. Log out, log in as that new User. Confirm they land in the app with no
   **Users** or **Install Link** tabs (Admin-only) and their roles show
   correctly under **My Account**.
3. Back in as Admin, open **Edit** on that user, untick one role and add
   another — confirm it updates immediately.

### C. Admin forgot-password (email flow)
1. On the login screen, click **Forgot password?**, enter the Admin's email.
2. Check that inbox for a "Reset your OKV Church Management System
   password" email with a link to `reset-password.html?token=...`.
3. Open the link, set a new password, confirm you're told to log in, and
   log in with the new password.
4. Try reusing the same link — it should say the link is invalid (tokens
   are single-use).

### D. Admin resets a User's password directly
1. As Admin → **Users** → click the key icon next to a User → enter a new
   password → **Set Password**.
2. Log in as that User with the new password (no email involved at all).

### E. Activate / Suspend
1. As Admin → **Users** → click the suspend icon on a User.
2. Try logging in as that User — should be blocked with "Your account has
   been suspended."
3. Reactivate — they can log in again.

### F. Install link
1. As Admin → **Install Link** tab → copy the link (or tap Share on
   mobile) → send it to a User.
2. Opening that link shows **only** the install screen (device-specific
   instructions + Install button) — no login form, no app content.
3. After installing and opening the app from the home screen icon, the
   User sees the login screen.

### G. Offline + sync
1. While online, add an Announcement.
2. Turn off Wi-Fi/data. Add another Announcement — it still saves locally
   (you'll see "pending sync" on it) and the red offline banner appears.
3. Reconnect — within ~60 seconds (or tap **Sync** manually) the pending
   item syncs automatically and you get a toast notification. Log in as
   another User/Admin in the same org and confirm they see it too (subject
   to the "Users see only their own data" rule — Admins see everything).

### H. Change password (self-service)
1. Both Admin and User can go to **My Account → Change Password** and
   update it themselves at any time while online.

### I. Trial countdown & subscription tab
1. Sign up fresh via `pricing.html` → `signup.html`. On first login, the
   Admin dashboard shows a gold trial banner ("7 days left in your free
   trial").
2. Open the **Subscription** tab (Admin-only, sidebar) — confirm it shows
   the chosen plan, billing cycle, and days remaining, with a "View Plans
   & Upgrade" button that jumps straight to this tab.
3. To see the "near/due" state without waiting 7 days: open the Sheet,
   find that Admin's row, and edit `trialEndsAt` to a timestamp 1–2 days
   from now. Reload the app — the bell icon in the top bar should now show
   a red badge, and the Subscription tab copy should shift to "ending
   soon."
4. Edit `trialEndsAt` to a date in the past and try logging in again —
   you should be blocked with "Your free trial has ended," with a link to
   Pricing.

### J. Branches & member directory
1. As an Admin (or a User with the Membership Officer / Data Entry / Church
   Administrator role) → **Branches** tab. It starts in Single-Branch Mode
   (a notice explains this and the Branch field stays hidden on Members).
2. Turn on **Multi-Branch Mode**, add two branches with a name/location/
   pastor/phone each.
3. Go to **Members** → **Add Member** — confirm the **Branch** dropdown
   already lists both branches with no extra step, and the Members table
   now shows a Branch column.
4. Add a third branch while the Add Member modal is closed, then reopen
   it — confirm the new branch appears immediately.
5. Turn Multi-Branch Mode back off — confirm the Branch field/column hide
   again (existing members keep their saved branch value, it's just not
   shown while in single mode).
6. Turn off Wi-Fi, add a branch and a member with that branch selected —
   confirm both save locally, then reconnect and confirm they sync and
   the Branch dropdown stays correct after sync.

### K. Member directory & communications
1. As an Admin (or a User with the Membership Officer / Data Entry / Church
   Administrator role) → **Members** tab → add 2–3 members with email,
   phone, and a birthday.
2. Go to **Send Message** → pick **Birthday**, confirm the template fills
   in, choose **All Members**, tick **Email**, and send. Check the
   recipients' inboxes.
3. Try **Choose Individually** and confirm only the ticked members receive
   it.
4. Tick **WhatsApp** and send — confirm you get a click-to-chat button per
   recipient (SMS/WhatsApp gateways aren't connected yet, so these are
   queued/manual until you wire one in — see the note in `Code.gs` under
   `sendSms()`/`sendWhatsApp()`).

### L. Team messages
1. As Admin, open **Team Messages**, pick a User (or "Everyone"), send a
   message.
2. Log in as that User — confirm the message appears (may take up to
   ~60 seconds, or tap Sync).
3. Reply as the User and confirm the Admin sees it too.

### M. User manual
1. Open the **User Manual** tab as different roles — confirm the sections
   shown differ (e.g. a plain User without Membership/Comms roles doesn't
   see the Members/Send Message sections; only an Admin sees Managing
   Users and Subscription & Billing).
2. Click **Download PDF** and confirm a PDF downloads with the same
   sections.

### N. Subscription payment (bank transfer)
1. As Admin → **Subscription** tab → confirm the bank details show exactly
   as configured, and the form is pre-filled with the Admin's name/email
   (editable).
2. Pick a plan/cycle, "upload" any image as the payment screenshot, add a
   note, and **Submit Payment Details**.
3. Check **technologyokv@gmail.com** (or whatever `OWNER_EMAIL` you set)
   for the claim email with the screenshot attached, and check the
   submitter's inbox for the "we'll review within the hour" acknowledgment.
4. In the Sheet, open **PaymentRequests**, set that row's **status** to
   `Confirmed`.
5. Run `processPaymentRequests()` from the Apps Script editor (or wait for
   the trigger). Confirm the submitter receives an "You're upgraded!"
   email, and that reopening the app (or waiting up to 5 minutes for the
   automatic background refresh) shows **Active** status on the dashboard
   with the correct plan and renewal date.
6. Repeat with **Rejected** and confirm the customer gets a polite
   rejection email instead, with your contact details.

### O. Automated renewal reminder emails
1. In the Sheet, pick an org Admin's row and set `trialEndsAt` (or
   `subscriptionExpiry` if they're on a paid plan) to 2 days from now.
2. Run `sendRenewalReminders()` from the Apps Script editor. Confirm that
   Admin receives a reminder email with your bank details, and that
   `lastReminderSentAt` on their row updates.
3. Run it again immediately — confirm no second email goes out (the
   `lastReminderSentAt` guard only allows one reminder per day).
4. Separately, just log in as that Admin — confirm the bell icon and
   dashboard trial/renewal banner already reflect "ending soon" purely
   from opening the app, with no email trigger needed for that part.

### P. Super Admin dashboard
1. Complete step 5 under **Set up Apps Script** above to create your Super
   Admin account, then log in with it at `app.html` — confirm you land
   on a completely different, platform-wide dashboard (not any single
   church's).
2. **Organizations** tab: confirm every org you've created in earlier
   tests shows up with its Admin's name, email and phone, plan, status,
   and trial/renewal countdown — pulled live, no Sheet-digging required.
3. Click the pencil icon on an org, change its plan/cycle/renewal date,
   save — confirm it updates immediately (and that org's own dashboard
   picks it up within 5 minutes via the background refresh).
4. Click the suspend/activate icon on an org — confirm that org's Admin
   is locked out/restored accordingly.
5. **Payments** tab: confirm it lists every claim across every org. Submit
   a fresh payment claim as a customer, then Confirm or Reject it directly
   from this tab (the ✓/✗ buttons) — confirm it applies instantly (no
   need to wait for the trigger) and the customer is emailed right away.
6. **Send Message** tab: send a test message to "All Organizations" or a
   hand-picked subset, by Email — confirm each org's Admin receives it,
   personalized with their name/org name.
7. **My Account**: confirm you can change your own Super Admin password
   here, and that Logout works and returns you to the same shared login
   screen everyone else uses.

### Q. System Settings (branding, contact, payments, pricing)
1. **Branding**: change the Primary/Accent colors and App Name, save, then
   open `app.html`/`pricing.html`/`demo.html` in a new tab — confirm
   the new colors and name show up (may take a moment on cached pages).
   Try uploading a logo image too. (`index.html`, the marketing landing
   page, and `install.html` use static branding by design — see "Design
   notes" below — so they won't reflect this change.)
2. **Contact Details**: change the email/phone/website, save, and confirm
   it updates on the login screen's footer, the Subscription tab's "Need
   Help?" block, and `pricing.html`'s footer.
3. **Manual Payment**: change the bank details, save, then open an org's
   Subscription tab and confirm the new account number/bank/name show up
   immediately (next page load or background refresh).
4. **Gateways**: enter a Paystack **test** public/secret key pair, enable
   it, save. Open an org's Subscription tab — a "Pay Instantly with
   Paystack" button should appear. Complete a test transaction and confirm
   it verifies automatically and upgrades the account without needing you
   to touch the Payments tab. Repeat for Flutterwave if you use it. Leave
   Remita's fields filled in but know that confirming those still happens
   manually from the Payments tab for now.
5. **SMS & WhatsApp**: if you have a Termii account, enter `termii` as the
   provider with your API key, save, then send a test member message with
   SMS ticked — confirm it delivers instead of just queuing.
6. **Pricing & Plans**: change a price or the "Suited For" text, save, then
   reload `pricing.html` — confirm the card, the per-month equivalent, and
   the savings percentage all update to match.

---

## Design notes worth knowing
- **Roles vs. Admin access**: the 10 role labels (Church Super Admin,
  Senior Pastor, etc.) are descriptive tags an Admin assigns for
  record-keeping — they do **not** themselves grant Admin-panel access.
  Only the original sign-up account is a true Admin (can manage Users).
  Members/Send Message visibility for Users is gated by a small allow-list
  of roles (Membership Officer, Data Entry/Front Desk Officer, Church
  Administrator/Secretary for Members; those plus Pastoral/Program Officer
  and Ministry Coordinator for Send Message) — edit the `canManageMembers()`
  / `canSendMessages()` functions in `app.html` if you want different
  roles to qualify.
- **Static branding on `index.html` and `install.html`**: unlike
  `app.html`, `pricing.html`, and `demo.html` — which fetch `publicSettings`
  and apply your branding/colors/contact live — the marketing landing page
  (`index.html`) and the installer page (`install.html`) use the branding
  baked into their own HTML/CSS. That's a deliberate choice: `index.html`
  has its own hand-designed hero copy and layout, not a generic template,
  so re-branding it well means editing the page directly rather than just
  changing Settings. If you want it to pull live branding too, follow the
  same `loadLiveBranding()` pattern used in `demo.html`.
- **SMS/WhatsApp delivery**: Email sends for real right now. SMS and
  WhatsApp both work automatically once you enter a Termii key from the
  Settings tab — other providers (Africa's Talking, Twilio, WhatsApp
  Business API) aren't pre-wired but the code is structured so adding one
  is a small, contained change to `sendSms()`/`sendWhatsApp()` in
  `Code.gs`. Until a gateway is configured, WhatsApp messages still
  generate a one-tap `wa.me` link per recipient so sending manually always
  works, with zero setup.
- **Payment gateways**: Paystack and Flutterwave verify for real once you
  enter live keys and enable them — Remita's fields save but aren't wired
  to auto-verify (its integration varies too much by merchant setup);
  confirm those from the Payments tab instead.
- **Renewal reminder cadence**: trial reminders fire close to the 7-day
  deadline since there's little runway either way, but paid-subscription
  reminders are capped to roughly twice a month (a 13-day minimum gap per
  org) regardless of how often the trigger itself runs — this is what
  keeps them from feeling like nagging. Adjust `REMINDER_MIN_GAP_DAYS` in
  `Code.gs` if you want a different cadence.
- **Login requires connectivity**; once logged in at least once, the app
  keeps working offline using the last-synced data, and queues your
  changes to sync automatically.
- **Subscription check**: every login/action checks `subscriptionStatus`
  (`trial` → `active`, or `trial_expired`/`inactive`), with the 7-day trial
  granted automatically on signup and upgrades applied via the bank-transfer
  flow above — ready for Paystack to replace/automate this in Phase 3.
- **Subscription and org-status now live on the Tenants row, not a user
  row**: since a subscription belongs to the whole organization, it's
  stored once in the Master `Tenants` sheet and merged onto every user's
  session at login/whoAmI time. One side effect worth knowing: suspending
  an org from the Super Admin dashboard now force-logs-out *every* user in
  that org (not just the Admin), and blocks *any* of that org's users from
  logging back in — closing a gap in the old single-sheet design where
  only the Admin account was actually suspended.
