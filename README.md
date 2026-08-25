# claude-dash

Claude Code oturumu devam ederken **son yazdığınız promptu, o anda çalışan tool'u,
subagent'ları / arka plan işlerini ve görev (todo) listesini** canlı gösteren küçük
bir pano. Tek dosya, sıfır bağımlılık, sadece Node.js gerekiyor.

**Token tüketmez:** hook'lar stdout'a hiçbir şey yazmaz (Claude bağlamına hiçbir şey
enjekte edilmez), model/API çağrısı yoktur; her şey yerel çalışır. Maliyet yalnızca
tool çağrısı başına birkaç ms'lik kısa yerel node süreci.

VS Code'da **Simple Browser** sekmesinde açarsanız editörden hiç çıkmadan izleyebilirsiniz.

---

## Başka bilgisayara kurulum (GitHub)

```bash
gh repo clone hakncglyn-sudo/claude-dash ~/.claude/tools/claude-dash
node ~/.claude/tools/claude-dash/claude-dash.js install
```

Windows PowerShell:

```powershell
gh repo clone hakncglyn-sudo/claude-dash "$env:USERPROFILE.claude	oolsclaude-dash"
node "$env:USERPROFILE.claude	oolsclaude-dashclaude-dash.js" install
```

Güncellemek için klasörde `git pull` yeterlidir; hook komutu dosya yolunu gösterdiği için
yeniden `install` gerekmez (yalnızca yol değişirse gerekir).

---

## Kurulum (dosyayı elle kopyalayarak)

### Windows (cmd)

```bat
mkdir "%USERPROFILE%\.claude\tools" 2>nul
copy "%USERPROFILE%\Downloads\claude-dash.js" "%USERPROFILE%\.claude\tools\"
node "%USERPROFILE%\.claude\tools\claude-dash.js" install
```

Çalıştırmak:

```bat
node "%USERPROFILE%\.claude\tools\claude-dash.js" serve --open
```

### Windows (PowerShell)

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\tools" | Out-Null
Copy-Item "$env:USERPROFILE\Downloads\claude-dash.js" "$env:USERPROFILE\.claude\tools\"
node "$env:USERPROFILE\.claude\tools\claude-dash.js" install
node "$env:USERPROFILE\.claude\tools\claude-dash.js" serve --open
```

### macOS / Linux / Git Bash / WSL

```bash
mkdir -p ~/.claude/tools && cp claude-dash.js ~/.claude/tools/
node ~/.claude/tools/claude-dash.js install
node ~/.claude/tools/claude-dash.js serve --open
```

---

`install` komutu `settings.json`'i **yedekler** (`.claude-dash.bak`) ve yalnızca kendi
hook'larini ekler; mevcut hook'lariniza dokunmaz. Tekrar calistirmak guvenlidir.

> Kurulumdan sonra acik Claude Code oturumlarini yeniden baslatin - hook'lar oturum
> baslangicinda okunur.

Sunucu `http://127.0.0.1:4317` adresinde ve sadece localhost'ta çalışır.

Kurulumdan sonra sunucuyu elle başlatmak gerekmez: bir Claude Code oturumu açılırken
(`SessionStart` hook'u) sunucu ayakta değilse arka planda kendiliğinden başlar; son
oturum kapanınca da sunucu kendini kapatır. `serve` komutu yine de elle çalıştırılabilir.

### VS Code icinde gostermek

`Ctrl + Shift + P` -> **Simple Browser: Show** -> `http://127.0.0.1:4317`

Sekmeyi saga surukleyip terminalin yaninda sabit tutabilirsiniz.

## Panoda ne var

| Bölüm | İçerik |
|---|---|
| **Son prompt** | O oturumda en son yazdığınız prompt (1000 karaktere kadar saklanır). Tek satır görünür; **tıklayınca tam metin açılır/kapanır**. Slash komutları `/komut argüman` olarak görünür. |
| **Şu an** | O anda çalışan tool: `⚙ Bash — npm install · 12s` gibi canlı satır. Tool çalışmıyorsa "yanıt hazırlanıyor…", onay/girdi bekleniyorsa `⏸ bekliyor: …` (kart noktası da sarıya döner). |
| **Subagent & arka plan** | Her `Task`/`Agent`/`Workflow` çağrısı ve arka plan Bash işleri: durum (`●` çalışıyor / `◔` arka planda / `✓` bitti / `✗` hata), canlı süre. Üzerine gelince agent'a verilen prompt tooltip olarak görünür. |
| **Görevler** | O anki todo listesi; `in_progress` olan kalın ve "…yapılıyor" halinde, biten üstü çizili. |
| **Üst bar** | Toplam aktif subagent + açık görev sayısı, bağlantı durumu, "yalnızca aktif oturumlar" filtresi. |

Aynı anda birden fazla Claude Code oturumu çalışıyorsa her biri ayrı bir kart olur;
aktif subagent'ı olan oturum en üste çıkar. Sunucu tek başına çalışır — oturumları
kapatıp açsanız bile pano açık kalabilir.

## Komutlar

```
node claude-dash.js install              hook'ları kur
node claude-dash.js serve [--port 4317] [--open]
node claude-dash.js uninstall            hook'ları kaldır
node claude-dash.js reset                olay geçmişini temizle
```

(Windows'ta dosya yolunu tırnak içinde tam yazın:
`node "%USERPROFILE%\.claude\tools\claude-dash.js" serve`)

## Nasıl çalışıyor

Claude Code hook'ları → her oturum için ayrı dosya: `~/.claude/dash/sessions/<session_id>.jsonl`
(append-only) → sunucu klasörü tarar → tarayıcıya SSE ile canlı basar.

Oturum kapanınca (`SessionEnd`) o oturumun dosyası silinir ve oturum panodan düşer;
son dosya da silinince sunucu kendini kapatır. `CLAUDE_DASH_KEEP=1` ortam değişkeni
varken dosyalar silinmez (hata ayıklama için).

Kullanılan hook'lar:

| Hook | Ne için |
|---|---|
| `PreToolUse` (tüm tool'lar) | "şu an" satırı; `Task`/`Agent`/`Workflow` → subagent başladı; arka plan Bash → arka plan işi başladı |
| `PostToolUse` (tüm tool'lar) | "şu an" temizliği; subagent bitti (başarı/hata/arka planda sürüyor); `TodoWrite` → görev listesi |
| `UserPromptSubmit` | oturum etiketi + task bildirimlerinden arka plan iş bitişi |
| `SubagentStop` | subagent'ın gerçek bitişi |
| `Notification` | "onay/girdi bekliyor" durumu |
| `Stop`, `SessionStart`, `SessionEnd` | oturum durumu |

Hook betiği hiçbir şey yazdırmaz, her koşulda `0` ile çıkar ve `timeout: 5` ile
sınırlıdır — oturumunuzu yavaşlatmaz veya bozmaz.

## Notlar / sınırlar

- **Alt-alt agent'lar**: bir subagent'ın kendi içinde açtığı Task'lar ayrı satır olarak
  görünmez (hook aynı oturum kimliği altında raporlanır).
- **Tur ortasında gönderilen mesajlar** (Claude çalışırken yazılanlar) `UserPromptSubmit`
  üretmediği için panoda görünmez; etiket bir sonraki normal prompt'ta güncellenir.
- **Arka plan sezgiseldir**: arka planda başlatılan subagent'ların bitişi `SubagentStop`
  + task bildirimi metni üzerinden eşleştirilir. Nadiren bir iş `◔ arka planda` takılı
  kalabilir; oturum kapanınca `?` olarak işaretlenir.
- Her oturum dosyası 8 MB'ı geçince otomatik sıfırlanır. `SessionEnd` alamadan ölen
  oturumların dosyaları 24 saat sonra sunucu tarafından temizlenir.
- Ortam değişkenleri: `CLAUDE_DASH_PORT` (varsayılan 4317), `CLAUDE_DASH_DIR`
  (varsayılan `~/.claude/dash`), `CLAUDE_DASH_KEEP=1` (oturum bitince dosyayı silme).
- Windows'ta tek gereken `node`'un PATH'te olması (`node --version` ile kontrol edin).
  Betik yolu hook komutuna tırnak içinde yazılır, boşluklu klasörler sorun çıkarmaz.
