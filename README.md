# JJK — Run locally

This project contains a Python WebSocket backend that performs gesture classification and a Vite/Three.js frontend.

Quick start (all-in-one):

```bash
# From project root
./start.sh
```

What `start.sh` does:
- Creates a Python virtualenv `.venv` and installs `requirements.txt` if missing
- Starts the Python backend (`app.py`) on port `8765`
- Installs frontend deps (`npm install`) if `node_modules` is missing
- Starts the Vite dev server on port `5173`

Run backend only:

```bash
# Create venv then run
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Run frontend only:

```bash
cd frontend
npm install
npm run dev
# open http://localhost:5173
```

Notes:
- The frontend will attempt to connect to `ws://localhost:8765` when served from `localhost`.
- On macOS you may need to allow camera access for the browser to use the webcam.
- If you're missing Python, Node, or npm, install them first.

If you want, I can also add a `Makefile` or a lightweight Docker Compose setup — tell me which you prefer.