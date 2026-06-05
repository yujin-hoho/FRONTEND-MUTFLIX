# telegram_api.py
# Modul untuk melayani katalog Telegram dinamis dari database dan Webhook sinkronisasi

from flask import Blueprint, jsonify, request, Response, stream_with_context, current_app
import time
import requests
import re
import os
import jwt
import socket
import threading
import asyncio

# ==========================================
# Pyrogram import — MUST be at module level (runs on main thread).
# Pyrogram's internals touch asyncio at import time; importing from a
# ThreadPoolExecutor worker (Flask/gunicorn thread) raises
# "There is no current event loop in thread X" on Python 3.10+.
# Importing here at startup avoids that entirely.
# ==========================================
try:
    from pyrogram import Client as _PyrogramClient
    _PYROGRAM_AVAILABLE = True
except Exception as _pyro_import_err:
    _PyrogramClient = None  # type: ignore
    _PYROGRAM_AVAILABLE = False
    print(f"[TELEGRAM-PYRO] pyrogram not available: {_pyro_import_err}", flush=True)

# ==========================================
# 🛑 HACK BYPASS DNS HUGGINGFACE 🛑
# ==========================================
_asli_getaddrinfo = socket.getaddrinfo

def bypass_dns(*args, **kwargs):
    host = args[0] if args else kwargs.get('host')
    port = args[1] if len(args) > 1 else kwargs.get('port')
    
    # Jika HuggingFace nolak nerjemahin domain Telegram, kita kasih IP aslinya langsung!
    if host == 'api.telegram.org':
        # 149.154.167.220 adalah IP asli resmi milik Telegram
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('149.154.167.220', port))]
    
    return _asli_getaddrinfo(*args, **kwargs)

# Timpa sistem DNS bawaan Python
socket.getaddrinfo = bypass_dns
# ==========================================

telegram_bp = Blueprint('telegram_api', __name__, url_prefix='/api/telegram')

# Helper function untuk query DB menghindari circular import
def execute_query(query, args=(), fetchone=False, commit=False):
    from serverUtama import get_db_connection, release_db_connection
    conn, db_type = get_db_connection()
    try:
        if db_type == 'postgres':
            from psycopg2.extras import RealDictCursor
            cur = conn.cursor(cursor_factory=RealDictCursor)
        else:
            import sqlite3
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            
        # SQLite vs Postgres placeholder translation
        if db_type == 'sqlite':
            query = query.replace('%s', '?')
            
        cur.execute(query, args)
        
        if commit:
            conn.commit()
            return True
            
        if fetchone:
            res = cur.fetchone()
            return dict(res) if res else None
        else:
            res = cur.fetchall()
            return [dict(row) for row in res]
    except Exception as e:
        print(f"[Telegram DB Error] {e}", flush=True)
        if commit and conn is not None:
            try:
                conn.rollback()
            except:
                pass
        return None
    finally:
        release_db_connection(conn, db_type)

# ==========================================
# PYROGRAM MTProto SINGLETON (runs in its own asyncio thread)
# ==========================================
# Pyrogram is async-only. Flask is sync. We bridge them via a dedicated event loop
# running in a background daemon thread.
#
# The client is initialized lazily on first large-file request (no startup cost).
# Once initialized it stays alive for the server lifetime — reconnect is automatic.
# ==========================================

_pyro_client = None           # pyrogram.Client instance
_pyro_loop   = None           # asyncio loop running in background thread
_pyro_ready  = threading.Event()  # set when client is authorized
_pyro_lock   = threading.Lock()   # guards initialization

CHUNK_SIZE = 1024 * 512  # 512 KB per streaming chunk

def _pyro_get_file_size_from_file_id(file_id_str: str) -> int:
    """
    Decode size from Bot API file_id using pyrogram's FileId decoder.
    No MTProto call needed — file_id already encodes the file metadata.
    This is the ONLY way to get file_size for bots without peer resolution.
    """
    if _pyro_client is None or _pyro_loop is None:
        return 0
    try:
        from pyrogram.file_id import FileId
        decoded = FileId.decode(file_id_str)
        # file_size is not always embedded in file_id, but worth trying
        size = getattr(decoded, 'file_size', 0) or 0
        return int(size)
    except Exception:
        return 0


def _start_pyro_loop(loop):
    """Entry point for the background asyncio thread."""
    asyncio.set_event_loop(loop)
    loop.run_forever()

def _ensure_pyro_client():
    """
    Lazily initialize the pyrogram client.
    Returns True if ready, False if env vars missing.
    Thread-safe — only first caller does real work.

    IMPORTANT: Client() must be created INSIDE the background asyncio thread because
    Pyrogram's constructor calls asyncio.get_event_loop() internally. In Python 3.10+
    this raises RuntimeError in any thread that doesn't have an event loop set
    (e.g. Flask's ThreadPoolExecutor workers). We work around this by creating and
    starting the client entirely inside an async coroutine on the background loop.
    """
    global _pyro_client, _pyro_loop, _pyro_ready

    api_id    = os.environ.get("TELEGRAM_API_ID", "").strip()
    api_hash  = os.environ.get("TELEGRAM_API_HASH", "").strip()
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()

    if not api_id or not api_hash or not bot_token:
        print("[TELEGRAM-PYRO] Missing env vars: TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_BOT_TOKEN", flush=True)
        return False

    if not _PYROGRAM_AVAILABLE:
        print("[TELEGRAM-PYRO] pyrogram not installed — cannot stream large files", flush=True)
        return False

    with _pyro_lock:
        if _pyro_client is not None:
            return True  # Already initialized

        try:
            loop = asyncio.new_event_loop()
            _pyro_loop = loop

            # Start the asyncio event loop in a background daemon thread.
            # The loop must be running BEFORE we schedule coroutines on it.
            t = threading.Thread(target=_start_pyro_loop, args=(loop,), daemon=True)
            t.start()

            # Create AND start the pyrogram Client inside the background loop thread.
            # _PyrogramClient was imported at module level (main thread) — safe.
            # Instantiation happens here inside an async coroutine on the background
            # loop, so asyncio.get_event_loop() inside pyrogram returns this loop.
            async def _init_client():
                global _pyro_client
                # Use per-PID session name so each gunicorn worker process has its own
                # SQLite session file. Prevents "database is locked" when multiple
                # workers try to initialize pyrogram simultaneously.
                session_name = f"mutflix_bot_{os.getpid()}"
                client = _PyrogramClient(
                    name=session_name,
                    api_id=int(api_id),
                    api_hash=api_hash,
                    bot_token=bot_token,
                    workdir="/tmp",
                )
                await client.start()
                _pyro_client = client
                _pyro_ready.set()
                print("[TELEGRAM-PYRO] Pyrogram client started and authorized ✅", flush=True)

            future = asyncio.run_coroutine_threadsafe(_init_client(), loop)
            future.result(timeout=30)  # wait up to 30s for auth
            return True

        except Exception as e:
            print(f"[TELEGRAM-PYRO] Failed to start pyrogram client: {e}", flush=True)
            _pyro_client = None
            return False


def _pyro_stream_generator(file_id_str: str, offset: int = 0, max_idle_seconds: int = 600):
    """
    Stream file bytes from Telegram via pyrogram MTProto.

    CRITICAL: We pass the Bot API file_id STRING directly to stream_media().
    pyrogram decodes it internally (DC id, access_hash, file_reference) and
    fetches the file without needing to resolve the channel peer at all.
    This is the ONLY approach that works for bots accessing private channels
    they are members of, since bots cannot call GetDialogs or use get_chat()
    without the peer already being cached.

    Uses queue.Queue for the async→sync bridge (gunicorn gevent workers).
    """
    import queue as _queue

    # pyrogram stream_media delivers 1 MiB chunks
    PYRO_CHUNK = 1024 * 1024
    chunk_index = offset // PYRO_CHUNK
    skip_bytes  = offset %  PYRO_CHUNK

    _DONE = object()

    class _ErrWrap:
        def __init__(self, exc): self.exc = exc

    buf = _queue.Queue(maxsize=32)

    async def _collect():
        first = True
        try:
            # Pass file_id string directly — no get_messages(), no peer resolution.
            # pyrogram decodes the file_id to retrieve DC and access_hash for the
            # FILE ITSELF, which is a different MTProto primitive from the peer.
            async for chunk in _pyro_client.stream_media(
                file_id_str,
                offset=chunk_index,
            ):
                if first:
                    if skip_bytes and chunk:
                        chunk = chunk[skip_bytes:]
                    first = False
                if not chunk:
                    continue
                while True:
                    try:
                        buf.put_nowait(chunk)
                        break
                    except _queue.Full:
                        await asyncio.sleep(0.05)
        except Exception as e:
            buf.put(_ErrWrap(e))
        finally:
            buf.put(_DONE)

    asyncio.run_coroutine_threadsafe(_collect(), _pyro_loop)

    last_activity = time.monotonic()
    while True:
        try:
            item = buf.get(timeout=0.2)
        except _queue.Empty:
            if (time.monotonic() - last_activity) > max_idle_seconds:
                raise TimeoutError(
                    f"MTProto stream idle > {max_idle_seconds}s (file_id={file_id_str[:20]}..., offset={offset})"
                )
            continue
        if item is _DONE:
            break
        if isinstance(item, _ErrWrap):
            raise item.exc
        last_activity = time.monotonic()
        yield item




# ==========================================
# KATALOG & WEBHOOK ROUTES
# ==========================================

@telegram_bp.route('/katalog', methods=['GET'])
def get_telegram_catalog():
    """
    Endpoint: GET /api/telegram/katalog
    Mengambil katalog Telegram dari database secara dinamis.
    """
    # Try Redis first
    try:
        from serverUtama import redis_get
        redis_data = redis_get("telegram:catalog")
        if redis_data is not None:
            return jsonify({
                "status": 200,
                "message": "Katalog Telegram Berhasil Diambil (cached)",
                "total": len(redis_data),
                "data": redis_data
            })
    except: pass
    
    rows = execute_query("SELECT * FROM telegram_catalog ORDER BY added_at DESC")
    if rows is None:
        return jsonify({"status": 500, "message": "Database error", "data": []}), 500
        
    # Cache to Redis
    try:
        from serverUtama import redis_set
        redis_set("telegram:catalog", rows, ttl_seconds=600)
    except: pass
        
    return jsonify({
        "status": 200,
        "message": "Katalog Telegram Berhasil Diambil",
        "total": len(rows),
        "data": rows
    })

@telegram_bp.route('/detail/<item_id>', methods=['GET'])
def get_telegram_detail(item_id):
    """
    Endpoint: GET /api/telegram/detail/<item_id>
    """
    row = execute_query("SELECT * FROM telegram_catalog WHERE item_id = %s", (item_id,), fetchone=True)
    if row:
        return jsonify({"status": 200, "data": row})
    return jsonify({"status": 404, "message": "Video Telegram tidak ditemukan"}), 404

# ==========================================
# WEBHOOK LISTENER UNTUK BOT TELEGRAM
# ==========================================
TMDB_API_KEY = os.environ.get('TMDB_API_KEY', '57a840e691238eebf82b88ea9a9f2136') 

def fetch_tmdb_metadata(title):
    """
    Mencari metadata TMDB berdasarkan nama caption/file.
    Misalnya: "Avengers Endgame 2019 1080p.mkv" -> "Avengers Endgame"
    """
    clean_title = re.sub(r'(19|20)\d{2}.*|\[.*\]|\(.*\)|1080p|720p|480p|\.mkv|\.mp4|\.srt', '', title, flags=re.IGNORECASE).strip()
    if not clean_title:
        clean_title = title
        
    try:
        url = f"https://api.themoviedb.org/3/search/multi?api_key={TMDB_API_KEY}&query={clean_title}&language=id-ID"
        resp = requests.get(url, timeout=5).json()
        if resp.get('results'):
            for res in resp['results']:
                if res.get('media_type') in ['movie', 'tv'] or res.get('title') or res.get('name'):
                    return {
                        'title': res.get('title') or res.get('name', title),
                        'poster_path': res.get('poster_path', ''),
                        'media_type': res.get('media_type', 'movie')
                    }
    except Exception as e:
        print(f"[TMDB Telegram Error] {e}", flush=True)
    
    return {'title': title, 'poster_path': '', 'media_type': 'movie'}

@telegram_bp.route('/webhook', methods=['POST'])
def telegram_webhook():
    """
    Endpoint: POST /api/telegram/webhook
    Terima update dari Telegram.
    """
    data = request.json
    if not data:
        return jsonify({"status": "ignored"}), 200
        
    # Telegram mengirim update berupa message atau channel_post
    msg = data.get('channel_post') or data.get('message')
    if not msg:
        return jsonify({"status": "no_message"}), 200
        
    chat_id = msg.get('chat', {}).get('id')
    message_id = msg.get('message_id')
    
    # Hanya memroses file video/document
    video_file = msg.get('video') or msg.get('document')
    if not video_file:
        return jsonify({"status": "no_video"}), 200
        
    caption = msg.get('caption', '')
    file_name = video_file.get('file_name', '')
    mime_type = video_file.get('mime_type', '')
    file_size = video_file.get('file_size')
    telegram_file_id = video_file.get('file_id')
    
    # Gunakan caption, atau file_name
    title_raw = caption.strip() if caption else file_name.strip()
    item_id = f"telg-{message_id}"
    
    # Cek duplikat di database
    exists = execute_query("SELECT id FROM telegram_catalog WHERE item_id = %s", (item_id,), fetchone=True)
    if exists:
        return jsonify({"status": "already_exists"}), 200
        
    # Fetch TMDB (otomatis!)
    tmdb_data = fetch_tmdb_metadata(title_raw)
    
    # Insert ke database
    query = """
        INSERT INTO telegram_catalog 
        (item_id, folder_name, media_type, tmdb_title, tmdb_poster_path, chat_id, video_message_id,
         telegram_file_id, telegram_file_name, telegram_mime_type, telegram_file_size) 
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    args = (
        item_id, 
        title_raw, 
        tmdb_data['media_type'], 
        tmdb_data['title'], 
        tmdb_data['poster_path'], 
        chat_id, 
        message_id,
        telegram_file_id,
        file_name,
        mime_type,
        file_size
    )
    
    success = execute_query(query, args, commit=True)
    if success:
        print(f"[Telegram Webhook] Tersimpan DB: {title_raw} (MsgID: {message_id})", flush=True)
        try:
            from serverUtama import redis_delete
            redis_delete("telegram:catalog")
        except: pass
    
    return jsonify({"status": "ok"}), 200


# ==========================================
# STREAM ENDPOINT — Bot API (≤20MB) + MTProto fallback (>20MB)
# ==========================================

@telegram_bp.route('/stream/<chat_id>/<int:message_id>', methods=['GET', 'HEAD'])
def telegram_stream(chat_id: str, message_id: int):
    """
    Server-side Telegram streaming via MTProto (pyrogram).
    - HEAD  → Returns headers only (availability probe) — instant.
    - GET   → Streams via Bot API for small files (≤20 MB), MTProto for large files.
    Supports HTTP Range for seeking.
    """
    try:
        chat_id_int = int(chat_id)
    except Exception:
        return jsonify({"error": "Invalid chat_id"}), 400

    # --- JWT Auth ---
    token = request.headers.get('x-access-token')
    if not token:
        return jsonify({'message': 'Token missing'}), 401
    try:
        jwt.decode(token, current_app.config['SECRET_KEY'], algorithms=["HS256"])
    except Exception:
        return jsonify({'message': 'Token invalid'}), 401

    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not bot_token:
        return jsonify({"error": "Server missing TELEGRAM_BOT_TOKEN"}), 503

    # Parse Range header
    range_header = request.headers.get("Range")
    byte_start = 0
    byte_end_req = None
    if range_header:
        try:
            rng = range_header.replace("bytes=", "").split("-")
            byte_start = int(rng[0]) if rng[0] else 0
            byte_end_req = int(rng[1]) if len(rng) > 1 and rng[1] else None
        except Exception:
            byte_start = 0

    # Lookup from DB
    row = execute_query(
        "SELECT telegram_file_id, telegram_file_size FROM telegram_catalog WHERE chat_id = %s AND video_message_id = %s LIMIT 1",
        (chat_id_int, message_id),
        fetchone=True,
    )
    file_id    = (row or {}).get("telegram_file_id")
    db_file_size = int((row or {}).get("telegram_file_size") or 0)

    if not file_id:
        return jsonify({"error": "Telegram file_id missing. Re-send the video to the bot/webhook to re-index."}), 404

    # HEAD — availability probe, no streaming
    if request.method == 'HEAD':
        resp = Response(status=200)
        resp.headers['Content-Type'] = 'video/mp4'
        resp.headers['Accept-Ranges'] = 'bytes'
        resp.headers['Cache-Control'] = 'no-store'
        if db_file_size > 0:
            resp.headers['Content-Length'] = str(db_file_size)
        return resp

    # ---- STEP 1: Bot API fast-path (only for small files ≤ 20 MB) ----
    # Try quickly; if file is too large, skip to MTProto immediately
    try:
        meta = requests.get(
            f"https://api.telegram.org/bot{bot_token}/getFile",
            params={"file_id": file_id},
            timeout=8,
        ).json()

        if meta.get("ok") and meta.get("result", {}).get("file_path"):
            file_path    = meta["result"]["file_path"]
            upstream_url = f"https://api.telegram.org/file/bot{bot_token}/{file_path}"
            upstream_headers = {}
            if range_header:
                upstream_headers["Range"] = range_header

            r = requests.get(upstream_url, headers=upstream_headers, stream=True, timeout=30)

            def generate_bot_api():
                try:
                    for chunk in r.iter_content(chunk_size=CHUNK_SIZE):
                        if chunk:
                            yield chunk
                finally:
                    try:
                        r.close()
                    except Exception:
                        pass

            resp = Response(stream_with_context(generate_bot_api()), status=r.status_code)
            for h in ["Content-Type", "Content-Length", "Accept-Ranges", "Content-Range", "Last-Modified", "ETag"]:
                if h in r.headers:
                    resp.headers[h] = r.headers[h]
            resp.headers["Cache-Control"] = "no-store"
            print(f"[TELEGRAM] Serving via Bot API HTTP (chat={chat_id_int}, msg={message_id})", flush=True)
            return resp

        # Bot API returned error — check if size-related or something else
        description = (meta.get("description") or "").lower()
        if "file is too large" in description or "file is too big" in description:
            print(f"[TELEGRAM] File too large for Bot API → MTProto (chat={chat_id_int}, msg={message_id})", flush=True)
        else:
            # Unknown Bot API error — still try MTProto as fallback (don't give up)
            print(f"[TELEGRAM] Bot API error (non-size): {meta.get('description')} → trying MTProto anyway", flush=True)

    except Exception as e:
        # Network error talking to Bot API — skip straight to MTProto
        print(f"[TELEGRAM] Bot API request failed: {e} → trying MTProto", flush=True)

    # ---- STEP 2: MTProto via pyrogram ----
    if not _ensure_pyro_client():
        return jsonify({
            "error": "MTProto unavailable. Set TELEGRAM_API_ID + TELEGRAM_API_HASH env vars.",
        }), 503

    if not _pyro_ready.wait(timeout=30):
        return jsonify({"error": "Pyrogram client not ready — please retry in a moment"}), 503

    # Resolve file size (needed for Content-Length / Content-Range)
    # Use DB value first; fallback to decoding from file_id (no MTProto call needed).
    file_size = db_file_size
    if file_size <= 0:
        file_size = _pyro_get_file_size_from_file_id(file_id) or 0
        if file_size > 0:
            print(f"[TELEGRAM-PYRO] Decoded file_size from file_id: {file_size} bytes", flush=True)

    def generate_pyro():
        try:
            for chunk in _pyro_stream_generator(file_id, offset=byte_start):
                yield chunk
        except Exception as e:
            print(f"[TELEGRAM-PYRO] Stream error: {e}", flush=True)

    status_code = 206 if range_header else 200
    resp = Response(stream_with_context(generate_pyro()), status=status_code)
    resp.headers["Content-Type"] = "video/mp4"
    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Cache-Control"] = "no-store"

    if file_size > 0:
        end_byte       = file_size - 1
        content_length = file_size - byte_start
        resp.headers["Content-Length"] = str(content_length)
        if range_header:
            resp.headers["Content-Range"] = f"bytes {byte_start}-{end_byte}/{file_size}"

    print(f"[TELEGRAM-PYRO] Streaming chat={chat_id_int} msg={message_id} via MTProto (offset={byte_start})", flush=True)
    return resp
