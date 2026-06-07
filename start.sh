#!/bin/bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  JJK Domain Expansion — Unified Launcher
#  Starts both Python backend + Vite frontend
#  Ctrl+C or closing the terminal kills BOTH
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PORT=8765
FRONTEND_PORT=5173
BACKEND_PID=""
FRONTEND_PID=""
PYTHON_BIN="${PROJECT_DIR}/.venv/bin/python"

# Auto-create Python virtualenv and install requirements if missing
if [ ! -x "${PYTHON_BIN}" ]; then
    echo "⚙️  Python virtualenv not found. Creating .venv and installing requirements..."
    if command -v python3 >/dev/null 2>&1; then
        python3 -m venv .venv
    elif command -v python >/dev/null 2>&1; then
        python -m venv .venv
    else
        echo "❌ Python not found. Please install Python 3 and retry."
        exit 1
    fi

    if [ -x "${PROJECT_DIR}/.venv/bin/pip" ]; then
        "${PROJECT_DIR}/.venv/bin/pip" install --upgrade pip setuptools wheel >/dev/null 2>&1 || true
        echo "⚙️  Installing Python requirements..."
        "${PROJECT_DIR}/.venv/bin/pip" install -r requirements.txt || echo "❗ pip install failed — please run '.venv/bin/pip install -r requirements.txt'"
    else
        echo "❌ pip not available in the created venv. Create a venv manually and install requirements.txt"
    fi
fi

kill_process_tree() {
    local pid="$1"
    local children
    children="$(pgrep -P "${pid}" 2>/dev/null || true)"
    for child in ${children}; do
        kill_process_tree "${child}"
    done
    kill "${pid}" 2>/dev/null || true
}

# Cleanup function — kills all child processes
cleanup() {
    echo ""
    echo "🔴 Shutting down all processes..."
    if [ -n "${BACKEND_PID}" ]; then
        kill_process_tree "${BACKEND_PID}"
        wait "${BACKEND_PID}" 2>/dev/null || true
    fi
    if [ -n "${FRONTEND_PID}" ]; then
        kill_process_tree "${FRONTEND_PID}"
        wait "${FRONTEND_PID}" 2>/dev/null || true
    fi
    echo "✅ All processes stopped."
    exit 0
}

# If stale listeners exist on expected ports, clear them before launch.
clear_port_if_busy() {
    local port="$1"
    local pids
    pids="$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "${pids}" ]; then
        echo "⚠️  Port ${port} already in use. Stopping stale process(es): ${pids}"
        kill ${pids} 2>/dev/null || true
        sleep 1
    fi
}

# Trap INT (Ctrl+C) and TERM signals
trap cleanup INT TERM

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🔮 JJK Domain Expansion — Starting Up"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

clear_port_if_busy "${BACKEND_PORT}"
clear_port_if_busy "${FRONTEND_PORT}"

# 1. Start Python backend (WebSocket + CV)
echo ""
echo "⚡ Starting Python backend (ws://localhost:${BACKEND_PORT})..."
cd "$PROJECT_DIR"
if [ ! -x "${PYTHON_BIN}" ]; then
    echo "❌ Python virtualenv not found at ${PYTHON_BIN}"
    echo "   Create it with: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
    exit 1
fi
export MPLCONFIGDIR="${PROJECT_DIR}/.mplconfig"
export XDG_CACHE_HOME="${PROJECT_DIR}/.cache"
export PYTHONPYCACHEPREFIX="${PROJECT_DIR}/.pycache"
mkdir -p "${MPLCONFIGDIR}" "${XDG_CACHE_HOME}" "${PYTHONPYCACHEPREFIX}"
"${PYTHON_BIN}" app.py &
BACKEND_PID=$!
echo "   Backend PID: $BACKEND_PID"

# Give the backend a moment to initialize
sleep 2

# 2. Start Vite frontend dev server
echo ""
echo "🌐 Starting Vite frontend (http://localhost:${FRONTEND_PORT})..."
cd "$PROJECT_DIR/frontend"
# If dependencies aren't installed, do so automatically (if npm is available)
if [ ! -d "node_modules" ]; then
    echo "⚙️  Frontend dependencies not found. Running 'npm install'..."
    if command -v npm >/dev/null 2>&1; then
        npm install || echo "❗ npm install failed — please run 'npm install' inside ./frontend and retry"
    else
        echo "❌ npm not found. Install Node.js/npm or run 'npm install' in ./frontend"
    fi
fi

if [ -x "./node_modules/.bin/vite" ]; then
    ./node_modules/.bin/vite &
    FRONTEND_PID=$!
    echo "   Frontend PID: $FRONTEND_PID"
else
    echo "❗ Vite executable not found. Start the frontend manually with: (cd frontend && npm run dev)"
    FRONTEND_PID=""
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Both servers running!"
echo "  🌐 Open: http://localhost:${FRONTEND_PORT}"
echo "  📡 API:  ws://localhost:${BACKEND_PORT}"
echo "  🛑 Press Ctrl+C to stop everything"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Wait for either process to exit — then kill both
while kill -0 "${BACKEND_PID}" 2>/dev/null && kill -0 "${FRONTEND_PID}" 2>/dev/null; do
    sleep 1
done
cleanup
