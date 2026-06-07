FROM python:3.11-slim

# Install core Ubuntu system libraries required by OpenCV & MediaPipe
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libxcb1 \
    libx11-6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies directly, forcing headless versions
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir opencv-python-headless

COPY ..

# Run your app using your port configuration
CMD ["python", "app.py"]
