# CSS Quick Style

`users.tsx / .ts / .js / .html` dosyasından ayrılmadan CSS Modules tarzı sınıf önerileri; stil, dosya veya klasör yoksa sorup oluşturma ve satır içi (peek) CSS düzenleme. Tailwind uyumlu.

Yazar: Zülkarneyn Karaüce

## Kullanım

| Yazdığın | Ne olur |
|---|---|
| `buton.` | `buton.css` / `buton.module.css` (veya import edilen dosya) içindeki sınıflar listelenir |
| `klasör/buton.` | `klasör/buton.css` içindeki sınıflar listelenir. Seçince kod `buton.dark` olur ve import eklenir |
| `styles.` | Mevcut dosyanın kendi CSS'i (`users.tsx` → `users.module.css`) |
| `<div style=` / `class="` / `className={` | Mevcut dosyanın CSS'indeki sınıflar. `style` seçilirse otomatik `className` / `class` olur |
| Aranan sınıf yoksa | Listenin en altında **➕ Oluştur: .isim** çıkar |
| Oluştur'a basınca | CSS dosyası veya klasörü yoksa küçük bir kutuda **sorar**. Onaylarsan klasör + dosya oluşturulur, kural eklenir, import / `<link>` yazılır ve kaynak dosyanın içinde bir peek kutusu açılır |
| Peek kutusunda yazarken | VS Code'un CSS önerileri normal gelir |
| `Ctrl+S` (peek açıkken) | CSS kaydedilir, Live Preview varsa yenilenir. `Esc` kutuyu kapatır |
| `Ctrl+Alt+E` | İmleçteki mevcut sınıfı aynı peek kutusunda düzenler |

Yol başlangıçları: `klasör/`, `./`, `../`, `@/` (= `<proje>/src/`), `~/` (= proje kökü).

## Tailwind
Proje Tailwind kullanıyorsa (`tailwind.config.*`, `package.json` içinde `tailwindcss` veya CSS'te `@import "tailwindcss"`) otomatik açılır:
- `class` / `className` içinde yazdığın yardımcı sınıflar (`flex`, `p-4` …) için "Oluştur" **gösterilmez**. Özel sınıf için `buton.dark` biçimini veya `style=` kullan.
- Yeni kuralın içine `@apply ;` yazılır ve imleç oraya konur (Tailwind CSS IntelliSense yüklüyse yardımcı sınıflar önerilir).
- Tailwind v4'te yeni CSS dosyasının başına `@reference "…"` eklenir (CSS Modules içinde `@apply` için gerekli).
- Tailwind'in kaçışlı sınıfları (`.md\:flex`) öneri listesine karışmaz.

## Ayarlar
- `cssQuick.aliases` (varsayılan `styles`): bu isimlerle yazınca mevcut dosyanın kendi CSS'i kullanılır. Diğer tüm isimler dosya adı sayılır.
- `cssQuick.stylesFolder`: Yeni CSS dosyaları için klasör (ör. `styles`).
- `cssQuick.createForUnknownIdentifiers`: Bilinmeyen isimlerde "Oluştur" gösterilsin mi.
- `cssQuick.tailwind`: `auto` / `on` / `off`.
- `cssQuick.tailwindApply`: Tailwind açıkken yeni kurala `@apply ;` yazılsın mı.

## Kurulum
- Denemek için klasörü VS Code'da aç, `F5`.
- Kalıcı: `npx @vscode/vsce package` → `Extensions > ... > Install from VSIX`.
