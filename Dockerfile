FROM python:3.13.4-slim-bookworm

WORKDIR /app

# 1. Install dependencies sistem
RUN apt-get update && apt-get install -y \
    build-essential \
    ffmpeg \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# 2. Buat user dulu
RUN useradd -m -u 1000 user

# 3. Instal library python (biar cache-nya awet)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Ambil kode aplikasi
COPY . .

# 5. FIX PERMISSION: Buat folder DAN pastikan SEMUA file di /app milik si 'user'
# Lakukan ini sebagai root sebelum pindah user
USER root
RUN mkdir -p /app/cache && chown -R user:user /app 

# 6. Baru pindah ke user 1000
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

EXPOSE 7860
ENV FLASK_APP=wsgi.py
ENV PORT=7860

# HuggingFace MAXED OUT: 16GB RAM
# Workers: 5 (each ~200MB = 1GB total)
# Threads: 48 per worker (I/O bound waiting for Neon/GDrive) -> 5 * 48 = 240 concurrent requests
# Keep-Alive: 75s (aggressive connection reuse)
# Max Requests: 10000 (recycle workers very slowly, keep cache hot)
CMD ["gunicorn", "-b", "0.0.0.0:7860", "wsgi:app", "--timeout", "300", "--workers", "5", "--threads", "48", "--worker-class", "gthread", "--max-requests", "10000", "--max-requests-jitter", "1000", "--graceful-timeout", "30", "--keep-alive", "75"]
