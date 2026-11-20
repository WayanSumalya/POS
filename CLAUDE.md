# CLAUDE.md

Panduan untuk Claude Code saat bekerja di repositori EPOS. Fitur dan cara pakai untuk pengguna ada di `README.md`; file ini fokus pada cara bekerja di kodenya.

## Proyek

EPOS adalah aplikasi POS dan inventaris berbentuk PWA (bisa dipasang dan jalan offline), tanpa framework dan tanpa build step. Data dibagikan antar perangkat lewat Supabase. Remote GitHub: `WayanSumalya/POS`, branch `main`.

## File

| File | Isi |
|---|---|
| `index.html` | Kerangka halaman |
| `app.js` | Seluruh logika: penjualan, stok, pembelian, opname, pelanggan, sinkronisasi, cetak struk, scan barcode |
| `style.css` | Tampilan |
| `sw.js` | Service worker (cache offline) |
| `manifest.webmanifest`, `icon.svg` | Metadata PWA |
| `supabase.js` | Klien Supabase |
| `supabase/schema.sql` | Skema database (aman dijalankan ulang) |
| `supabase/rls_roles.sql` | Row-level security berbasis peran. Baca header-nya sebelum menjalankan |
| `.mcp.json` | Konfigurasi MCP Supabase untuk Claude Code |

## Menjalankan

Tidak ada build. Layani folder lewat HTTPS (atau `localhost`), karena API kripto, kamera, dan Bluetooth mensyaratkannya:

```powershell
npx serve D:/EPOS
```

Deploy: unggah ulang file yang berubah ke host (GitHub Pages). Aplikasi perlu ditutup dan dibuka dua kali agar versi baru termuat.

## Aturan penting

- `SB_URL` dan `SB_KEY` di bagian sinkronisasi `app.js` adalah URL proyek dan kunci **publishable** (memang publik). Jangan pernah menaruh kunci `service_role` di repo ini.
- Peran admin/kasir ditegakkan di dalam aplikasi; penegakan di sisi server hanya aktif jika `rls_roles.sql` sudah dijalankan. Menurut README, belum diuji di proyek live.
- Stok disimpan sebagai pergerakan +/- (bukan angka tunggal), supaya dua perangkat yang bertransaksi bersamaan tidak saling menimpa. Pertahankan pola ini.
- Catatan sinkronisasi ada di bagian "SHOP SYNC" `app.js`: tabel punya dua kolom kunci dan satu kolom JSON. Pindah backend berarti menulis ulang fungsi kirim/ambil/live di bagian itu.
- Setelah mengubah `app.js`, `style.css`, atau `index.html`, naikkan nama cache di `sw.js` (konstanta `C`, saat ini `'epos-v22'`) agar perangkat yang sudah memasang aplikasi mengambil versi baru. `sw.js` tidak men-cache permintaan lintas-origin (API Supabase/Google).
- Jangan menyimpan password atau PIN apa pun di kode. Hash PBKDF2 disimpan di baris `creds` di database.

## Git

`.gitignore` sudah ada dan mengecualikan folder `.claude/`, jadi `launch.json` dan `settings.local.json` tidak ikut ke GitHub. `.mcp.json` ikut ter-commit; pastikan isinya tidak memuat token.
