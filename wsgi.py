import os
import threading
import time
import requests as py_requests
from flask import request, Response

# Import server app and background workers
from serverUtama import app, background_cache_worker, warmup_cache


# ==========================================
# GDRIVE STREAMING PROXY (Production)
# Proxies video from Google Drive → This Server → Client
# Needed because browsers block direct GDrive access (CORS).
# In dev, the Vite plugin handles this. In prod, this Flask route handles it.
#
# Security: The GDrive access_token is obtained by the frontend via the
# authenticated /api/gdrive-stream-details/ endpoint (which requires JWT).
# This proxy just forwards that token to Google — it doesn't expose any
# additional access beyond what the authenticated user already has.
# ==========================================
@app.route("/gdrive-proxy/<file_id>")
def gdrive_stream_proxy(file_id):
    """Stream a GDrive file through this server to bypass CORS."""
    access_token = request.args.get('access_token')
    if not access_token:
        return Response("Missing access_token", status=400)

    # Build GDrive request
    gdrive_url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "Mutflix/1.0"
    }

    # Forward Range header for seeking
    if request.headers.get("Range"):
        headers["Range"] = request.headers["Range"]

    try:
        upstream = py_requests.get(gdrive_url, headers=headers, stream=True, timeout=30)
    except Exception as e:
        return Response(f"Upstream error: {e}", status=502)

    # Build response headers
    resp_headers = {"Accept-Ranges": "bytes"}
    for h in ["Content-Type", "Content-Length", "Content-Range"]:
        if h in upstream.headers:
            resp_headers[h] = upstream.headers[h]
            
    # Add CORS headers so the cross-origin frontend can play the video stream
    resp_headers["Access-Control-Allow-Origin"] = "*"
    resp_headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"

    # Chunk lebih besar = lebih sedikit iterasi Python↔socket (membantu latency di proxy gratis / HF).
    return Response(
        upstream.iter_content(chunk_size=1024 * 1024),  # 1 MiB
        status=upstream.status_code,
        headers=resp_headers
    )


warmup_cache()

_BG_LOCK_FILE = "/tmp/mutflix_bg_worker.lock"

def start_bg_worker():
    try:
        fd = os.open(_BG_LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        
        # Thread Cache GDrive
        thread_cache = threading.Thread(target=background_cache_worker, daemon=True)
        thread_cache.start()
        
        print(f"[WSGI] Background worker (Cache) started (pid={os.getpid()})", flush=True)
    except FileExistsError:
        # ... (logika lock file sama seperti sebelumnya) ...
        try:
            with open(_BG_LOCK_FILE, 'r') as f:
                old_pid = int(f.read().strip())
            os.kill(old_pid, 0)
            print(f"[WSGI] Workers already running in pid={old_pid}, skipping.", flush=True)
        except (ProcessLookupError, ValueError, OSError):
            os.remove(_BG_LOCK_FILE)
            start_bg_worker()
    except Exception as e:
        print(f"[WSGI] Worker error: {e}", flush=True)

time.sleep(0.1 * (os.getpid() % 5))
start_bg_worker()

if __name__ == "__main__":
    app.run()
