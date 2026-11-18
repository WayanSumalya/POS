# EPOS – POS + inventory (PWA, offline-capable, live multi-device)

Files: `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icon.svg`.
Host over HTTPS (GitHub Pages is free) – required for the crypto API (password hashing), Bluetooth and installing.

## Roles
| | Administrator | Cashier |
|---|---|---|
| Sell, print/reprint receipts | ✔ | ✔ |
| See sales | all, profit | own, today only |
| Items & stock, prices, costs | ✔ | – |
| Void sales, settings, users, backups, CSV | ✔ | – |
| Discount | unlimited | up to the % set by admin |

Admin signs in with a password (8+ chars); cashiers with a 6-digit PIN on a keypad.
First launch → create the admin account. Settings → Team → Add user.

## Inventory tools (admin)
- **Purchasing:** suppliers, purchase orders (draft → ordered → received/partial), receive goods to add stock and update cost, print or share a PO.
- **Stock count (opname):** blind or open count, per category or all items, variance report, apply adjustments (sales during the count are respected).
- **Branding:** shop logo (shown in the app and optionally printed on receipts) and user photos (default is a person icon).

## Customers & loyalty
Customers tab (cashiers can add/look up; only admins edit, adjust points, delete, export). Attach a customer to an order, earn points on the amount paid, redeem points as a discount at checkout. Rates are in Settings → Loyalty program. Voiding a sale reverses points. Receipts show points earned and balance.

## Receiving
Inventory → Receiving: record deliveries as goods-received notes (GRN-0001…) against a purchase order (partial deliveries supported) or without a PO. Supplier invoice number, cost updates, printable.

## Shop sync — many devices, live (Supabase, free)
All devices share one database. Sell on the cashier tablet and see it on your phone within a second; edit stock, prices, users from any device. Works offline too: changes wait and are sent when the connection returns.

**One-time setup (owner, ~5 minutes)**
1. Create a free project at supabase.com (region Singapore).
2. SQL Editor → paste `supabase/schema.sql` → Run. (Safe to run again.)
3. Authentication → Users → Add user (the *shop account*: an email + password, tick Auto Confirm). Authentication → Sign In / Providers → turn **off** “Allow new users to sign up”.
4. The project URL and the public (publishable) key are set at the top of the sync section in `app.js` (`SB_URL`, `SB_KEY`).

**Add a device:** open the app → sign in with the shop account → sign in with your EPOS user (admin password / cashier PIN). That is all.

How it works: every record is a row (newest change wins); stock is stored as +/- movements, so two devices selling and receiving at the same time add up instead of overwriting each other. Settings → Shop sync shows the status (Live / Offline / pending).

**Server-side roles (recommended):** run `supabase/rls_roles.sql` (read its header first; give your admin account the `admin` role BEFORE running it). Use one shop account for owner devices (`admin`) and a separate one for cashier tablets (`cashier`). The database then refuses cashier writes to products, prices, users, settings, voids and stock additions, even if someone bypasses the app. Tested on PostgreSQL 16 with a mocked Supabase auth; not yet run on your live project. Password/PIN verifiers are stored in separate `creds` rows: administrator rows are invisible to cashier accounts. After updating all devices, sign in once with the admin shop account (it migrates the old shared user row), then change the admin password.

Good to know: the shop account can read all shop data, so keep it private; EPOS roles (admin/cashier) are enforced inside the app. Keep device clocks on automatic time. Supabase's free plan pauses a project after a week with no activity at all.
Moving to another host later (e.g. your own server) only means re-implementing the “send / fetch / live” functions in the SHOP SYNC section of `app.js`; the table has two key columns and one JSON column.

## Camera barcode scanner
Tap the scan icon in the Sell search bar (scan many items in a row), in an item's SKU field, in the Inventory search, in a stock count (each scan adds 1 to the count), or when adding lines to a purchase order / delivery. Uses Chrome's built-in BarcodeDetector (EAN/UPC, Code 128/39, QR…) – no external code. Needs camera permission and HTTPS. Bluetooth/USB scanners also work by typing into the search box. Set each item's SKU to its barcode.

## Security
- Sign-in: admin password (PBKDF2, 310k rounds) / cashier PIN; 5 wrong attempts → timed lockout. Data is shared through your private Supabase project (shop-account login + row-level security); shop data is stored as plain JSON on the device and in Supabase (not encrypted). Backup and CSV files are not encrypted either. Roles are enforced in the app, not by the server: anyone holding the shop account can reach all data through the Supabase API.
- 5 wrong attempts → timed lockout (30 s, doubling). Failed sign-ins are recorded.
- Auto-lock when idle (default 5 min). Activity log of logins, voids, price/stock changes, discounts, user changes.
- Backup files exported from Settings still work; CSV export is plain text – admin only, password re-check.
- A forgotten admin password cannot be reset from inside the app; keep it safe (the shop data itself stays in Supabase).
- Limits: a PIN is weaker than a password; someone who can copy this device's browser storage could try to guess PINs offline. Use strong admin passwords, keep USB debugging off, and set a screen lock on the tablet.

## Printing
Settings → Printer: Bluetooth LE (direct), RawBT app (classic Bluetooth), or system print. Cashiers can pair the printer from the Account tab.

## Updating
Re-upload changed files; close and reopen the app twice to load the new version.
