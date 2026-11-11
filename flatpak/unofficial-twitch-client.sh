#!/bin/sh
# zypak provides Chromium's sandbox inside Flatpak. Use Wayland natively when a
# Wayland socket is present; otherwise fall back to X11 (--socket=fallback-x11).
if [ -n "$WAYLAND_DISPLAY" ] && [ -S "${XDG_RUNTIME_DIR}/${WAYLAND_DISPLAY}" ]; then
  set -- --ozone-platform=wayland --enable-features=WaylandWindowDecorations "$@"
fi
exec zypak-wrapper /app/electron/electron /app/main "$@"
