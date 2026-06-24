# Python 3.11 pinned via the base image.
FROM python:3.11-slim

# System dependencies:
#   ffmpeg        — clip extraction / video frame decoding (OpenCV)
#   tesseract-ocr — scoreboard OCR (pytesseract)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so this layer is cached across code changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render injects $PORT. gunicorn serves app:app (the Flask instance in app.py).
# --timeout 600 keeps long OCR scans (scan-clock has a 5-min client timeout)
# from being killed by gunicorn's 30s default.
CMD ["sh", "-c", "gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --timeout 600"]
