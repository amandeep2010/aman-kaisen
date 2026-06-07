import cv2
import numpy as np
import joblib
from collections import deque
import asyncio
import websockets
import json
from main import init_tracker, extract_landmarks
import os
import signal
import http
from pathlib import Path
import warnings
import base64

PROJECT_DIR = Path(__file__).resolve().parent
os.environ.setdefault("MPLCONFIGDIR", str(PROJECT_DIR / ".mplconfig"))
os.environ.setdefault("XDG_CACHE_HOME", str(PROJECT_DIR / ".cache"))
os.environ.setdefault("PYTHONPYCACHEPREFIX", str(PROJECT_DIR / ".pycache"))
warnings.filterwarnings(
    "ignore",
    message="X does not have valid feature names.*",
    category=UserWarning,
)

# Track connected clients + shutdown logic
connected_clients = set()
shutdown_task = None
model = None

def load_model():
    global model
    if model is not None:
        return model
    try:
        model = joblib.load(PROJECT_DIR / "jjk_model.pkl")
        return model
    except Exception as e:
        print("Error loading model:", e)
        raise

def decode_frame(image_data):
    if not image_data:
        return None

    if "," in image_data:
        image_data = image_data.split(",", 1)[1]

    try:
        image_bytes = base64.b64decode(image_data)
    except Exception:
        return None

    image_array = np.frombuffer(image_bytes, dtype=np.uint8)
    frame = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
    if frame is None:
        return None

    # Match the mirrored local capture path the model was trained against.
    return cv2.flip(frame, 1)

def predict_gesture(frame, hands, classifier):
    if frame is None:
        return "neutral"

    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    rgb_frame.flags.writeable = False
    results = hands.process(rgb_frame)

    if not results.multi_hand_landmarks:
        return "neutral"

    landmarks_array = extract_landmarks(results)
    return classifier.predict([landmarks_array])[0]

async def schedule_shutdown():
    """Wait 5 seconds, then exit if no client has reconnected."""
    print("⏳ No clients connected. Shutting down in 5 seconds (refresh to cancel)...")
    await asyncio.sleep(5)
    if len(connected_clients) == 0:
        print("🔴 No clients reconnected. Shutting down.")
        os.kill(os.getpid(), signal.SIGTERM)

async def handler(websocket):
    global shutdown_task
    
    # Register client
    connected_clients.add(websocket)
    print(f"✅ Client connected: {websocket.remote_address} ({len(connected_clients)} active)")
    
    # Cancel any pending shutdown (e.g., page was refreshed)
    if shutdown_task and not shutdown_task.done():
        shutdown_task.cancel()
        print("   ↳ Shutdown cancelled — client reconnected.")
    
    classifier = load_model()
    hands, _, _ = init_tracker(include_drawing=False)
    prediction_buffer = deque(maxlen=5)
    last_sent_label = "neutral"

    try:
        await websocket.send(json.dumps({"gesture": last_sent_label}))

        async for raw_message in websocket:
            try:
                payload = json.loads(raw_message)
            except json.JSONDecodeError:
                continue

            frame = decode_frame(payload.get("image"))
            current_prediction = predict_gesture(frame, hands, classifier)
            prediction_buffer.append(current_prediction)

            current_label = "neutral"
            if len(prediction_buffer) == prediction_buffer.maxlen and len(set(prediction_buffer)) == 1:
                current_label = prediction_buffer[0]

            if current_label != last_sent_label:
                message = json.dumps({"gesture": current_label})
                await websocket.send(message)
                last_sent_label = current_label
                print(f"Broadcasted -> {message}")
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        hands.close()

        # Unregister client
        connected_clients.discard(websocket)
        print(f"❌ Client disconnected: {websocket.remote_address} ({len(connected_clients)} active)")
        
        # Local dev can shut down on tab close; hosted backends should stay warm.
        if len(connected_clients) == 0 and "PORT" not in os.environ:
            shutdown_task = asyncio.ensure_future(schedule_shutdown())

async def process_request(path, request_headers):
    # Reply to non-WebSocket HTTP probes (for example Render health checks).
    upgrade_header = request_headers.get("Upgrade", "")
    if upgrade_header.lower() != "websocket":
        return (http.HTTPStatus.OK, [], b"OK\n")

    return None

async def main_server():
    port = int(os.environ.get("PORT", 8765))
    host = os.environ.get("HOST") or ("0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
    print(f"WebSocket API Server listening on {host}:{port}")
    async with websockets.serve(handler, host, port):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    try:
        asyncio.run(main_server())
    except (KeyboardInterrupt, SystemExit):
        print("API Server Stopped.")
