AVERIS — CATATAN PEMBANGUNAN
==============================
Diperbarui: 31 Agustus 2026


APA ITU AVERIS
----------------
Averis adalah "accountability layer" (lapisan akuntabilitas) antara data dan
keputusan. Beberapa AI agent spesialis menganalisis data yang sama secara
independen (dari Reppo Datanet). Setiap klaim yang mereka buat wajib
menempel pada bukti (evidence) yang benar-benar diambil sistem — tidak bisa
mengarang sumber — lalu dinilai dengan rubrik yang deterministik (bukan
dinilai oleh model AI lain), dan hasil dari semua agent digabung jadi satu
laporan intelijen yang bisa diperiksa ulang, lengkap dengan bagian yang
mereka SEPAKATI dan bagian yang mereka TIDAK sepakati.

Reppo = infrastruktur data eksternal (datanet, kurasi, prediction market).
Averis dibangun DI ATAS Reppo, bukan menggantikannya.


GARIS WAKTU SINGKAT (dari git log)
-------------------------------------
20 Agu 2026   Mulai project (scaffold Next.js)

25 Agu 2026   Update besar pertama: mulai bangun "Ave Agent"
26 Agu 2026   Lanjut bangun Ave Agent, update Averis
27 Agu 2026   Update Averis, update data

29 Agu 2026   Hari paling padat fitur baru:
              - Validasi job diperketat: sekarang wajib "brief" yang jelas
                dan bermakna untuk memulai job, bukan sekadar teks
                minimal 8 karakter (dulu bisa lolos dengan teks asal-asalan)
              - Harga token $AVRS diambil langsung dari pool on-chain
                (Uniswap v4), bukan dari API pihak ketiga, sekaligus
                menampilkan all-time high
              - Job sekarang dimiliki oleh wallet yang membuatnya,
                bukan oleh API key aplikasi
              - Pengecekan wallet gate dibaca ulang tiap request (bukan
                dihafal sekali saat aplikasi start) — supaya pencabutan
                akses langsung berlaku
              - Setiap laporan sekarang mencatat provider/model LLM di
                balik tiap agent, dan mengukur seberapa "beragam" cohort-nya
                (jumlah model berbeda, indikator monokultur) — supaya
                konsensus yang bulat bukan cuma karena semua agent pakai
                satu model yang sama
              - Tambah provider OpenRouter: satu API key bisa menjalankan
                model dari banyak vendor/lab berbeda, satu model per agent
              - Reward agent sekarang bisa benar-benar dibayar on-chain
                (transfer ERC-20 sungguhan), dan bug pada x402 paywall
                diperbaiki (dulu salah mengutip chain, sekarang valid)
              - Rename field "mint" jadi "token" di seluruh sistem trading
                (mint adalah istilah Solana; Averis settle di EVM/Robinhood
                Chain dengan ERC-20, jadi istilahnya diluruskan)

30-31 Agu 2026  Update lanjutan, termasuk sesi ini:
              - Landing page disederhanakan dari 12 section jadi 7 section
              - Debug masalah ticker harga $AVRS real-time di landing page


YANG SUDAH DIBANGUN (kondisi saat ini)
=========================================

1. INFRASTRUKTUR & STRUKTUR PROJECT
   - Monorepo npm workspaces: apps/ (web, api, operator), packages/ (13
     paket internal), workers/, prisma/, docs/, scripts/, tests/
   - Database PostgreSQL via Prisma — 27 model data (User, Agent, Datanet,
     Job, Claim, Evidence, Evaluation, ConsensusResult, ReputationScore,
     Prediction, Reward, Automation, Position, dan seterusnya)
   - Docker Compose untuk Postgres + Redis lokal
   - Deploy ke Fly.io (2 app terpisah: gateway+worker, dan web), database
     production di Supabase, queue via pgmq (tanpa perlu Redis di production)

2. PROTOKOL INTI (job engine)
   - Job engine & lifecycle lengkap (state machine dari job dibuat sampai
     selesai/resolved)
   - Validasi brief job yang ketat (menolak input yang tidak bermakna)
   - Budget guard: budget dicek & dikunci SEBELUM job dijalankan, atomik
     (bukan ketahuan kehabisan uang di tengah jalan)
   - 4 worker lifecycle (job -> evaluasi -> konsensus -> resolusi) jalan
     dalam satu proses

3. AGENT & EVIDENCE
   - Runtime LLM yang bisa ganti provider: mock (default, deterministik,
     tanpa API key) / Anthropic / OpenAI / Gemini / OpenRouter
   - 5 agent spesialis: Research Agent, Markets Agent, Security Agent,
     Data Quality Agent, Onchain Analyst
   - Tool yang dipakai agent (http_get, compute_evidence_stats, dst) —
     setiap bukti yang dikutip WAJIB benar-benar diambil oleh tool,
     kutipan ke sumber yang tidak pernah diambil otomatis ditolak
   - Bisa jalankan cohort lintas vendor LLM sekaligus (lewat OpenRouter),
     supaya "beragam pendapat" bukan cuma satu model bicara ke dirinya
     sendiri

4. EVALUASI, KONSENSUS & REPUTASI
   - Evaluasi deterministik, 5 dimensi (kualitas bukti, konsistensi,
     spesifisitas, korroborasi, kesesuaian rubrik datanet) — model TIDAK
     menilai model lain
   - Klaim yang sejenis dikelompokkan & digabung berdasar performa terukur;
     perbedaan pendapat antar agent TETAP ditampilkan, tidak dirata-ratakan
   - Confidence dan consensus dilaporkan terpisah (cohort bisa "yakin tapi
     terbelah")
   - Laporan mencatat komposisi cohort: berapa vendor/model berbeda yang
     benar-benar berkontribusi ke satu verdict
   - Sistem reputasi agent: dihitung dari hasil prediksi yang resolved &
     akurasi terukur, BUKAN dari besar stake modal

5. INTEGRASI REPPO
   - Baca Datanet, pod, dan data langsung dari API publik Reppo
   - Normalisasi data Reppo ke format internal yang provider-agnostic
   - Mode "fixture" untuk jalan sepenuhnya offline (tanpa memanggil API
     Reppo asli) — dipakai untuk demo & testing

6. OPERATOR OTONOM
   - Node otonom terpisah yang mencari job, memilih strategi sendiri, dan
     menjalankannya (apps/operator)
   - Budget guard yang sama juga berlaku di sini sebelum eksekusi

7. AUTOMATION / TRADING (halaman /automation)
   - Deploy "automation" yang mengubah hasil job (intelligence report)
     jadi posisi trading
   - Posisi baru dibuka kalau confidence DAN consensus lolos ambang batas
     terpisah, plus syarat jumlah agent minimum yang selesai
   - Mode paper trading (simulasi) sudah bisa jalan; mode LIVE trading
     sengaja belum diaktifkan (return error 501 — belum ada driver
     eksekusi sungguhan)
   - Belum ada penjadwalan otomatis — evaluate & sweep posisi masih
     dipanggil manual (lewat dashboard atau script)

8. PEMBAYARAN & TOKEN
   - Reward untuk agent bisa dibayar on-chain sungguhan (transfer ERC-20)
     lewat perintah "npm run settle" — defaultnya cuma mencetak rencana
     pembayaran, harus pakai flag --execute untuk benar-benar bayar
   - x402 paywall: POST job bisa di-charge per-request (challenge
     pembayaran sudah valid dan bisa di-quote), TAPI belum pernah ada satu
     pun pembayaran yang benar-benar settle penuh ke facilitator sungguhan
   - Harga live token $AVRS di landing page diambil langsung dari pool
     Uniswap v4 di on-chain (bukan API pihak ketiga), lengkap dengan
     all-time high — (catatan: sedang didiagnosis kenapa ticker-nya
     kadang tidak menampilkan angka di browser meski API server-nya
     sendiri sudah benar)
   - Penamaan token diluruskan (bukan lagi memakai istilah "mint" ala
     Solana, karena settlement-nya di EVM)

9. AUTENTIKASI & TENANCY
   - Root API key (lihat semua tenant, dipakai worker/operator/demo) vs
     Account key per user (hanya lihat job miliknya sendiri)
   - Login wallet opsional lewat Privy — job & automation bisa dimiliki
     oleh wallet yang connect, bukan cuma oleh API key aplikasi
   - Job milik akun lain me-return 404 (bukan 403), supaya tidak bisa
     ditebak keberadaannya
   - Rate limit per API key, bukan per IP

10. WEB APP — HALAMAN YANG SUDAH ADA
    - Landing page (/) — baru disederhanakan: hero, ticker harga $AVRS,
      contoh laporan, cara kerja, kenapa berbeda, FAQ, tombol mulai
    - Whitepaper (/whitepaper)
    - Roadmap (/roadmap) — 5 fase rencana protokol
    - Dashboard (/dashboard) — bikin & pantau job
    - Agents (/agents) — daftar agent + skor reputasi
    - Datanets (/datanets) — jelajah dataset dari Reppo
    - Playground (/playground) — coba panggil API langsung dari browser,
      otomatis dapat contoh kode curl & SDK yang sepadan
    - Automation (/automation) — kelola automation trading
    - Privacy (/privacy)

11. API GATEWAY
    - REST API lengkap: jobs (create/list/detail/intelligence/explain),
      datanets, agents, automations, health check
    - Auth Bearer token, rate limit per key
    - Bisa dipasangi x402 paywall per-request

12. SDK
    - Client TypeScript resmi (@averis/sdk) — createClient, runJob, dst,
      tanpa dependency luar
    - Mendukung alur pembayaran x402 lewat fetch yang di-wrap

13. TESTING
    - Unit test (vitest, tanpa perlu infrastruktur)
    - Integration test yang menjalankan job sungguhan lawan Postgres asli
    - Test khusus tenancy (memastikan satu akun tidak bisa lihat/tebak job
      akun lain)

14. DOKUMENTASI
    - README.md — dokumentasi teknis lengkap (cara jalankan, env var, API,
      cara deploy)
    - docs/ — architecture, protocol, agent, operator, automation, integrasi
      Reppo, tracing


YANG BELUM SELESAI / DIKETAHUI BELUM JALAN
=============================================
(ringkasan dari bagian "Status" di README.md)

- Prediction resolution: kodenya sudah ada dan bisa baca data Reppo asli,
  tapi belum ada satu prediksi pun yang sungguhan jatuh tempo — jadi skor
  akurasi & kalibrasi reputasi masih di nilai netral untuk semua agent
- Semua agent masih terpasang ke provider "mock" secara default — belum
  ada bukti nyata apakah cohort model sungguhan hasilnya lebih baik
- x402: challenge pembayaran sudah valid, tapi belum pernah ada satu
  pembayaran pun yang settle sungguhan lewat facilitator
- Driver settlement EVM sudah teruji lewat RPC tiruan (mock), belum pernah
  jalan transfer sungguhan di chain asli
- Automation mode LIVE trading sengaja belum diaktifkan
- Belum ada metrics/tracing observability (biaya, latency, tingkat gagal
  masih tidak terlihat)
- DataItem (item data dari Reppo) belum pernah benar-benar ditulis ke
  database — kalau pod upstream dihapus, jejak evidence job lama jadi
  yatim
- Traffic dari web app masih berbagi satu API key server-side (kecuali
  /automation yang sudah per-wallet)
- Belum ada penjadwalan otomatis untuk automation (evaluate/sweep manual)
- Belum ada adapter harga terverifikasi untuk automation menandai posisi

SENGAJA BELUM DIBANGUN: token protokol sendiri, DAO, governance, custom
chain, custom inference network, infrastruktur ZK, cross-chain.


CATATAN
--------
File ini dibuat oleh Claude berdasarkan git log dan struktur kode per
31 Agustus 2026, untuk memberi gambaran cepat "apa saja yang sudah
dibangun" tanpa perlu baca ulang seluruh kode. Untuk detail teknis lengkap
(cara menjalankan, daftar environment variable, daftar endpoint API, cara
deploy), lihat README.md di folder yang sama.
