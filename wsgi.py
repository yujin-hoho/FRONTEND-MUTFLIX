import os
import threading
import time
# Import server app and background workers
from serverUtama import app, background_cache_worker, warmup_cache

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
