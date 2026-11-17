# EPOS – POS + inventory (PWA, offline, encrypted)

Files: `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icon.svg`.
Host over HTTPS (GitHub Pages is free) – required for encryption APIs, Bluetooth and installing.

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

## Camera barcode scanner
Tap the scan icon in the Sell search bar (scan many items in a row), in an item's SKU field, in the Inventory search, in a stock count (each scan adds 1 to the count), or when adding lines to a purchase order / delivery. Uses Chrome's built-in BarcodeDetector (EAN/UPC, Code 128/39, QR…) – no external code. Needs camera permission and HTTPS. Bluetooth/USB scanners also work by typing into the search box. Set each item's SKU to its barcode.

## Security
- Every record is encrypted with AES-256-GCM. The key is wrapped by each user's password/PIN (PBKDF2, 310k rounds). Nothing readable is stored without a login.
- 5 wrong attempts → timed lockout (30 s, doubling). Failed sign-ins are recorded.
- Auto-lock when idle (default 5 min). Activity log of logins, voids, price/stock changes, discounts, user changes.
- Backups stay encrypted (they need the same accounts to open). CSV export is plain text – admin only, password re-check.
- **Forgotten admin password = data cannot be recovered.** Keep an encrypted backup.
- Limits: a PIN is weaker than a password; someone who can copy this device's browser storage could try to guess PINs offline. Use strong admin passwords, keep USB debugging off, and set a screen lock on the tablet.

## Printing
Settings → Printer: Bluetooth LE (direct), RawBT app (classic Bluetooth), or system print. Cashiers can pair the printer from the Account tab.

## Updating
Re-upload changed files; close and reopen the app twice to load the new version.
