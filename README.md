# Unofficial Twitch Client for Linux

A desktop Twitch app for Linux with live notifications, lower delay, stream saving and ad blocking, all in one AppImage.

## Features

- Followed channels and subscriptions in the sidebar
- Notifications when channels you follow go live
- Full chat with emotes, polls and predictions
- Behind-live counter with jump to live
- Save live streams and download past broadcasts
- Channel search, quality picker, picture-in-picture
- Light and dark themes
- Built-in ad blocking (best effort)

## Download

1. Get `Twitch-1.0.0.AppImage` from [Releases](../../releases).
2. Right-click it → Properties → allow executing as a program.
3. Double-click to run, then log in. Use **Log in with Firefox** for Google, Apple or Amazon accounts.

On Ubuntu, install `libfuse2` first. To save streams, open Settings → **Install yt-dlp**.

## Build from source

```bash
npm install
npm run dist
```

The AppImage is created in `dist/`.

## Flatpak

Build and install locally with [flatpak-builder](https://docs.flatpak.org/en/latest/flatpak-builder.html):

```bash
flatpak install flathub org.flatpak.Builder org.freedesktop.Sdk//26.08 org.electronjs.Electron2.BaseApp//26.08
flatpak run org.flatpak.Builder --user --install --force-clean build-dir flatpak/io.github.ryth9419_jpg.Unoffical-twitch-client.yml
flatpak run io.github.ryth9419_jpg.Unoffical-twitch-client
```

The build is offline: Electron and the npm runtime dependencies are pinned by checksum. After changing `package-lock.json`, regenerate the npm sources:

```bash
python3 flatpak/gen-npm-sources.py package-lock.json > flatpak/npm-sources.json
```

## Disclaimer

Not affiliated with or endorsed by Twitch Interactive, Inc. MIT licensed.
