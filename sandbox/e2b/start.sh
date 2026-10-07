#!/usr/bin/env bash
# Starts the sandbox browser stack. Safe to run again: each part starts only if it is not up.
export DISPLAY=:99
PROFILE=/home/user/chrome-profile
mkdir -p "$PROFILE"

up() { pgrep -x "$1" >/dev/null 2>&1; }

up Xvfb || (Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &)
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done

# A crashed Chromium leaves a lock behind that blocks the next start on the same profile.
if ! up chromium; then
  rm -f "$PROFILE"/Singleton*
  (chromium \
    --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check \
    --user-data-dir="$PROFILE" --remote-debugging-port=9222 \
    --window-position=0,0 --window-size=1280,800 --force-device-scale-factor=1 \
    --disable-features=Translate,InfiniteSessionRestore --password-store=basic \
    about:blank >/tmp/chromium.log 2>&1 &)
fi

# Chromium only listens on loopback; E2B reaches the sandbox from outside.
up socat || (socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 >/tmp/socat.log 2>&1 &)

# Live view for hand-over (sign-in, 3DS). Reachable only through the server's proxy.
up x11vnc || (x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &)
pgrep -f "websockify.*6080" >/dev/null 2>&1 || (websockify --web /usr/share/novnc 6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &)
