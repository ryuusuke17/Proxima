#!/bin/bash
# Proxima entrypoint — manages Xvfb, settings, VNC, and Electron launch

set -e

# Settings path (Electron userData)
SETTINGS_PATH="/root/.config/proxima/settings.json"

# Ensure settings.json has restApiEnabled=true and headlessMode matches VNC flag
ensure_settings() {
    if [ -f "$SETTINGS_PATH" ]; then
        python3 -c "
import json
s = json.load(open('$SETTINGS_PATH'))
s['restApiEnabled'] = True
vnc_enabled = '${PROXIMA_VNC_ENABLED:-false}'
s['headlessMode'] = vnc_enabled.lower() != 'true'
json.dump(s, open('$SETTINGS_PATH', 'w'))
" 2>/dev/null || true
        local hm
        hm=$(echo "${PROXIMA_VNC_ENABLED:-false}" | tr '[:upper:]' '[:lower:]' | grep -q 'true' && echo 'false' || echo 'true')
        echo "[Proxima] Settings enforced — restApiEnabled=true, headlessMode=${hm}"
    else
        echo "[Proxima] Settings file not found at $SETTINGS_PATH"
    fi
}

# Clean stale X lock files from previous runs
rm -f /tmp/.X*-lock /tmp/.X11-unix/X* 2>/dev/null
echo "[Proxima] Cleaned stale X locks"

# Default Electron flags for Docker/container environment
export ELECTRON_FLAGS="--no-sandbox --disable-gpu --ozone-platform=x11"

# Start Xvfb virtual display
export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 &
sleep 2

# Verify Xvfb is actually running
if ! pgrep -x Xvfb > /dev/null 2>&1; then
    echo "[Proxima] ERROR: Xvfb failed to start"
    exit 1
fi
echo "[Proxima] Xvfb running on display :99"

# Ensure settings are correct
ensure_settings

# VNC mode: start fluxbox + x11vnc, run Electron visible
if [ "${PROXIMA_VNC_ENABLED}" = "true" ]; then
    echo "[Proxima] VNC mode enabled"

    # Start fluxbox window manager
    fluxbox &
    sleep 1
    echo "[Proxima] Fluxbox started"

    # Start x11vnc (no password, forever)
    x11vnc -display :99 -forever -nopw -quiet &
    echo "[Proxima] VNC server started on port 5900"

    # Run Electron in VISIBLE mode (no --headless)
    echo "[Proxima] Starting Proxima in VISIBLE mode"
    cd /app && npx electron . $ELECTRON_FLAGS 2>&1
else
    # Headless mode: run Electron hidden
    echo "[Proxima] Starting Proxima in HEADLESS mode"
    cd /app && npx electron . --headless $ELECTRON_FLAGS 2>&1
fi
