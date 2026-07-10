# 16 — Electron Desktop Client

## 1. Genel karar

Electron açık kaynak olacaktır. Ama ana ürün değildir.

Ana ürün Web/PWA’dır.

Electron sadece desktop konforu sağlar.

## 2. Electron hedefleri

- global push-to-talk
- tray/minimize
- desktop notification
- ses cihazı kısayolları
- mikrofon mute hotkey
- auto-update
- game overlay ileri aşama
- native menu

## 2.1 Official app ve instance hesaplari

Electron client official LobbyForge app'in desktop kabugudur; tek bir merkezi zorunlu hesap sistemi gibi davranmaz.

Desktop'ta uc baglanti tipi desteklenmelidir:

1. **Official LobbyForge hub:** kullanici official LobbyForge account ile girer.
2. **Public registry instance:** kullanici registry'den bir instance secer; instance kendi auth politikasini uygular.
3. **Manual connect:** kullanici domain/IP girer; yine hedef instance kendi auth politikasini uygular.

Desktop app official hesapla su bilgileri senkronlayabilir:

- saved instance list
- recently connected instances
- desktop preferences
- global push-to-talk keybinds
- optional profile/avatar for official hub

Ama self-host instance session cookie'leri, local memberships ve local roles instance'a aittir. Bir self-host instance "Sign in with LobbyForge" acmadiysa desktop kullanicisi o instance icin local login/register/guest flow'u tamamlar.

## 3. İlk yaklaşım

Electron canlı web UI’yi açar:

```ts
win.loadURL("https://app.example.com");
```

Böylece:

- web UI güncellenince desktop da güncel olur
- Next.js’i Electron içine paketleme karmaşası azalır
- ilk sürüm hızlı çıkar

## 4. Güvenlik ayarları

```ts
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true
}
```

Preload script sadece gerekli native köprüleri sağlar.

## 5. Global push-to-talk

Electron globalShortcut ile PTT yakalar.

Akış:

1. Kullanıcı keybind seçer.
2. Electron global key event yakalar.
3. Web UI’ye IPC veya preload bridge ile PTT active/inactive gönderir.
4. Web UI LiveKit audio track mute/unmute yapar.

## 6. Windows 7

Electron Windows 7 hedeflenmez.

Destek:

- Windows 10/11 desktop
- Windows 7/8/8.1 web best-effort legacy

## 7. Auto-update

İleri sürümde:

- GitHub Releases
- electron-updater
- code signing optional
- stable/beta channels

## 8. Repo yapısı

```txt
apps/desktop/
  src/
    main.ts
    preload.ts
  package.json
  electron-builder.yml
```

## 9. Ne zaman yapılmalı?

Electron şu aşamalardan sonra yapılmalı:

1. Web voice çalışıyor
2. Hushle oynanıyor
3. Plugin sistemi var
4. Installer var
5. Core UI oturdu

Erken Electron yapmak zaman kaybettirir.
