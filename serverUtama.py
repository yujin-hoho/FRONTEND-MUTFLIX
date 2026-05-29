# -*- coding: utf-8 -*-
import os
import re
import json
import pickle
import base64
import time
import hashlib
import hmac
import threading
import requests
import datetime
import traceback
import signal
import uuid
import copy
from functools import wraps, lru_cache
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
from urllib.parse import quote
import unicodedata
from time import monotonic as _monotonic

# --- HIGH-PERFORMANCE LIBRARIES (HuggingFace Optimized) ---
import orjson
import diskcache
from flask_compress import Compress

# --- LIBRARY FLASK & GOOGLE ---
from flask import Flask, jsonify, send_from_directory, request, Response, stream_with_context
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
try:
    from werkzeug.middleware.proxy_fix import ProxyFix
    HAS_PROXY_FIX = True
except ImportError:
    HAS_PROXY_FIX = False
import jwt
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# --- LIBRARY DISCORD (Untuk Fitur Generate Token) ---
try:
    from discord_interactions import verify_key_decorator, InteractionType, InteractionResponseType
except ImportError:
    # Dummy decorator jika library tidak ada, agar app tidak crash
    print("WARNING: 'discord-interactions' library missing. Discord features disabled.")
    def verify_key_decorator(key):
        def decorator(f):
            @wraps(f)
            def decorated(*args, **kwargs): return f(*args, **kwargs)
            return decorated
        return decorator
    class InteractionType: APPLICATION_COMMAND = 2
    class InteractionResponseType: CHANNEL_MESSAGE_WITH_SOURCE = 4; PONG = 1

# --- LIBRARY SUPABASE ---
try:
    from supabase import create_client, Client
except ImportError as e:
    print(f"[INIT] WARNING: Supabase library NOT installed: {e}", flush=True)
    create_client = None
    Client = None

# --- LIBRARY DATABASE ---
try:
    import psycopg2 
    from psycopg2 import OperationalError
    from psycopg2.extras import RealDictCursor
    from psycopg2.pool import ThreadedConnectionPool
except ImportError as e:
    print(f"WARNING: psycopg2 import failed: {e}", flush=True)
    psycopg2 = None
    OperationalError = None
    RealDictCursor = None
    ThreadedConnectionPool = None

# ==========================================
# KONFIGURASI UTAMA
# ==========================================
app = Flask(__name__, static_folder="dist")

# --- CORS: Hanya izinkan origin yang legitimate ---
# Env var ALLOWED_ORIGINS = comma-separated list of allowed origins
# Default: HuggingFace Space origin + localhost untuk development
_allowed_origins_str = os.environ.get('ALLOWED_ORIGINS', '')
if _allowed_origins_str:
    _allowed_origins = [o.strip() for o in _allowed_origins_str.split(',') if o.strip()]
else:
    # Default: izinkan dari HF Space sendiri (self-hosted frontend) + localhost dev
    _allowed_origins = ['https://melancholia112-mutflix.hf.space', 'http://localhost:*', 'http://127.0.0.1:*']
CORS(app, resources={r"/api/*": {"origins": _allowed_origins}}, supports_credentials=True)

# --- KOMPRESI RESPONSE (Brotli/Gzip otomatis) ---
app.config['COMPRESS_ALGORITHM'] = ['br', 'gzip']
app.config['COMPRESS_MIN_SIZE'] = 500
Compress(app)

if HAS_PROXY_FIX:
    try:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)
    except Exception as e: print(f"ProxyFix Warning: {e}")

# Environment Variables
SECRET_KEY = os.environ.get('SECRET_KEY', 'default_dev_key')
DATABASE_URL = os.environ.get('DATABASE_URL') 
GDRIVE_TOKEN_B64 = os.environ.get('GDRIVE_TOKEN_B64')
GDRIVE_SUBTITLE_TOKEN_B64 = os.environ.get('GDRIVE_SUBTITLE_TOKEN_B64')
GDRIVE_SUBTITLE_FOLDER_ID = os.environ.get('GDRIVE_SUBTITLE_FOLDER_ID')
SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY')
TMDB_API_KEY = os.environ.get('TMDB_API_KEY')

# Discord Config
DISCORD_PUBLIC_KEY = os.environ.get('DISCORD_PUBLIC_KEY') 
DISCORD_ADMIN_ID = os.environ.get('DISCORD_ADMIN_ID')     

# ==========================================
# RATE LIMITER (IP-based, in-memory)
# ==========================================
# Sliding window rate limiter — prevents abuse of public endpoints
# Configurable via env vars for easy tuning on HuggingFace
_RATE_LIMIT_RPM = int(os.environ.get('RATE_LIMIT_RPM', '60'))       # requests per minute per IP
_RATE_LIMIT_BURST = int(os.environ.get('RATE_LIMIT_BURST', '120'))   # burst limit (short window)
_rate_limit_store = {}  # {ip: [timestamp, timestamp, ...]}
_rate_limit_lock = threading.Lock()

def _rate_limit_check(limit=None):
    """Check rate limit for current request IP. Returns (allowed, retry_after_seconds)."""
    if limit is None:
        limit = _RATE_LIMIT_RPM
    ip = request.headers.get('X-Forwarded-For', request.remote_addr)
    if ip and ',' in ip:
        ip = ip.split(',')[0].strip()  # Take first IP from proxy chain
    now = _monotonic()
    window = 60.0  # 1 minute window
    
    with _rate_limit_lock:
        if ip not in _rate_limit_store:
            _rate_limit_store[ip] = []
        
        # Clean old entries outside window
        _rate_limit_store[ip] = [t for t in _rate_limit_store[ip] if now - t < window]
        
        if len(_rate_limit_store[ip]) >= limit:
            oldest = _rate_limit_store[ip][0]
            retry_after = int(window - (now - oldest)) + 1
            return False, max(retry_after, 1)
        
        _rate_limit_store[ip].append(now)
        
        # Periodic cleanup: remove IPs with no recent activity (every ~100 requests)
        if len(_rate_limit_store) > 1000:
            stale_ips = [k for k, v in _rate_limit_store.items() if not v or now - v[-1] > window * 2]
            for k in stale_ips:
                del _rate_limit_store[k]
    
    return True, 0

def rate_limited(limit=None):
    """Decorator: rate limit an endpoint by IP address."""
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            allowed, retry_after = _rate_limit_check(limit)
            if not allowed:
                resp = orjson_jsonify({"error": "Rate limit exceeded", "retry_after": retry_after}, 429)
                resp.headers['Retry-After'] = str(retry_after)
                return resp
            return f(*args, **kwargs)
        return decorated
    return decorator

app.config['SECRET_KEY'] = SECRET_KEY
app.config['JSON_SORT_KEYS'] = False

# Init Clients
supabase = None
if SUPABASE_URL and SUPABASE_KEY and create_client:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as e:
        print(f"[INIT] ERROR creating Supabase client: {e}", flush=True)

# GDrive Folders — HARUS disimpan di Environment Variable / HuggingFace Secrets
# Format env var: comma-separated IDs, e.g. "id1,id2,id3"
_gdrive_folders_env = os.environ.get('GDRIVE_FOLDER_IDS', '')
if _gdrive_folders_env:
    GDRIVE_FOLDER_IDS = [fid.strip() for fid in _gdrive_folders_env.split(',') if fid.strip()]
else:
    # Fallback kosong — JANGAN hardcode IDs di repo publik!
    GDRIVE_FOLDER_IDS = []
    print("WARNING: GDRIVE_FOLDER_IDS env var not set! GDrive features will not work.", flush=True)

# Cache Config — HuggingFace MAXED OUT (5GB disk cache limit)
CACHE_DIR = "cache"
if not os.path.exists(CACHE_DIR): os.makedirs(CACHE_DIR)
CACHE_REFRESH_INTERVAL = 300    # 5 min - BG worker refreshes every content cycle
CACHE_DURATION_FOLDERS = 86400   # 24 hours - folder response cache
CACHE_DURATION_VIDEOS  = 86400   # 24 hours - video response cache
CACHE_DURATION_EMPTY   = 1800     # 30 min - empty results retry lebih cepat
TMDB_CACHE_TTL_SECONDS = int(os.environ.get('TMDB_CACHE_TTL_SECONDS', '86400'))  # 24 jam default
WATCH_HISTORY_ACTIVE_CUTOFF = 0.90  # >=90% watched is treated as completed server-side

# diskcache: thread-safe, process-safe, persistent backup — 5GB for 16GB RAM machine
disk_cache = diskcache.Cache(CACHE_DIR, size_limit=5 * 1024 * 1024 * 1024)

# === AGGRESSIVE IN-MEMORY CACHE (16GB RAM) ===
# Data NEVER expires from RAM — BG worker proactively refreshes
# dict lookup = ~0.01ms vs diskcache = ~1-5ms vs GDrive API = ~500-2000ms
_mem_cache = {}       # {key: data}
_mem_cache_ts = {}    # {key: timestamp}
_mem_lock = threading.Lock()

# === GLOBAL THREAD POOL (persistent, shared across all requests) ===
# 24 workers — handles parallel GDrive calls, subtitle fetches, DB queries
# Cost: ~24MB RAM (1MB stack per thread) — negligible
_global_executor = ThreadPoolExecutor(max_workers=24)
_tmdb_meta_executor = ThreadPoolExecutor(
    max_workers=int(os.environ.get('TMDB_META_WORKERS', '64'))
)

# === JWT DECODE CACHE ===
# Cache decoded JWT payloads keyed by token string — avoids ~0.5ms decode per auth request
# TTL: 5 minutes — balances freshness vs speed
_jwt_cache = {}       # {token_string: decoded_payload}
_jwt_cache_ts = {}    # {token_string: timestamp}
_jwt_cache_ttl = 300  # 5 minutes
_jwt_lock = threading.Lock()

# === SUBTITLE RAM CACHE ===
# Pre-loads ALL subtitle files (GDrive + Supabase) into RAM at startup
# Average subtitle = 50-100KB, 500 files = ~50MB — minimal RAM cost
# Eliminates 200-500ms latency per subtitle request
_subtitle_cache = {}       # {file_path: bytes_content}
_subtitle_cache_ts = {}    # {file_path: timestamp}
_subtitle_lock = threading.Lock()

# === SUPABASE SUBTITLE MAP CACHE ===
# Cache fetch_supabase_subtitles_map() results to avoid hitting Supabase every time
_supa_sub_cache = {}       # {folder_name: subs_map}
_supa_sub_cache_ts = {}    # {folder_name: timestamp}
_supa_sub_ttl = 43200      # 12 hours — subtitles very rarely change, reduce Supabase API calls
_subtitle_empty_map_ttl = 300  # empty subtitle scans must retry soon; new subs are added often
_supa_sub_lock = threading.Lock()

# === GDRIVE SUBTITLE MAP CACHE ===
# Cache fetch_gdrive_subtitle_map() results — dedicated GDrive subtitle account
_gdrive_sub_cache = {}       # {folder_name: subs_map}
_gdrive_sub_cache_ts = {}    # {folder_name: timestamp}
_gdrive_sub_ttl = 43200      # 12 hours — same as Supabase
_gdrive_sub_lock = threading.Lock()

# === CATEGORY FOLDER IDS CACHE ===
# Cache GDrive category folder IDs (Series/Movies) to avoid re-querying every fetch_gdrive_videos call
_category_folder_ids_cache = None   # set of folder IDs
_category_folder_ids_ts = 0
_category_folder_ids_ttl = 300      # 5 minutes

# === SEARCH INDEX (in-memory inverted index) ===
# Maps normalized words → list of {name, type, source}
# Enables server-side instant search without client downloading all data
_search_index = defaultdict(list)   # {word: [item_dict, ...]}
_search_index_built = False
_search_lock = threading.Lock()

# === MARKERS RAM CACHE (intro + outro) ===
# Cache ALL markers in RAM — avoids DB roundtrip on every player load
# Invalidated on admin POST/DELETE mutations
_intro_markers_cache = None    # {folder_name: intro_end_seconds} or None = not loaded
_outro_markers_cache = None    # {folder_name: outro_start_seconds} or None = not loaded
_markers_lock = threading.Lock()

# === PRE-SERIALIZED RESPONSE CACHE ===
# Cache orjson-serialized bytes directly — skip serialization on every request
# ~0.1-0.5ms saved per response for large JSON payloads
_response_cache = {}       # {cache_key: orjson_bytes}
_response_cache_ts = {}    # {cache_key: timestamp}
_response_lock = threading.Lock()

# === TMDB OVERRIDE RAM CACHE ===
# Avoids DB reads + deepcopy/merge work on every /api/folders request.
_tmdb_overrides_cache = None      # {folder_name: override_dict}
_tmdb_overrides_ts = 0
_tmdb_overrides_lock = threading.Lock()

# === TMDB PROXY CACHE ===
# Cache response TMDB server-side so repeated app requests avoid TMDB.
_tmdb_proxy_cache = {}       # {cache_key: {status, content_type, body, ts}}
_tmdb_proxy_cache_ts = {}    # {cache_key: timestamp}
_tmdb_proxy_lock = threading.Lock()
_tmdb_meta_cache = {}        # {cache_key: {status, payload, ts}}
_tmdb_meta_cache_ts = {}     # {cache_key: timestamp}
_tmdb_meta_cache_lock = threading.Lock()
_tmdb_meta_key_locks = {}    # {cache_key: threading.Lock}
_tmdb_meta_key_locks_lock = threading.Lock()

# === GDRIVE BEARER TOKEN CACHE ===
# Token valid ~1 jam, cache 45 menit — eliminates credential check per request
# ~50-100ms saved per /api/gdrive-stream-details/ call
_gdrive_token = None       # bearer token string
_gdrive_token_ts = 0       # last refresh timestamp
_gdrive_token_ttl = 2700   # 45 minutes
_gdrive_token_lock = threading.Lock()
_stream_token_ttl = 24 * 60 * 60  # 24 hours; keeps binge sessions stable across GDrive token refreshes

# === USER DATA RAM CACHE (profiles, mylist) ===
# Per-user caching — eliminates DB roundtrip (~100-200ms saved per request)
# Invalidated on mutations (save/add/edit/delete)
# [FIX] Tambah timestamp per-entry untuk cross-worker invalidation via diskcache
_user_profiles_cache = {}      # {user_id: [profile_dicts]}
_user_mylist_cache = {}        # {user_id_profile_id: [mylist_dicts]}
_user_profiles_cache_ts = {}   # {user_id: timestamp}
_user_mylist_cache_ts = {}     # {user_id_profile_id: timestamp}
_user_data_lock = threading.Lock()

def _invalidate_response_cache(*keys):
    with _response_lock:
        for key in keys:
            _response_cache.pop(key, None)
            _response_cache_ts.pop(key, None)

def _response_keys_for_data_cache(key):
    """Map shared data-cache keys to per-worker serialized response keys."""
    if key == 'folders_list':
        return ('resp_folders', 'resp_folders_merged')
    if key == 'content_releases':
        return ('resp_releases', 'resp_folders_merged')
    if isinstance(key, str) and key.startswith('videos_'):
        return (f'resp_{key}',)
    return ()

def _should_sync_data_cache(key):
    return key in ('folders_list', 'content_releases') or (
        isinstance(key, str) and key.startswith('videos_')
    )

def _invalidate_subtitle_maps(folder_name):
    """Invalidate subtitle map caches in this worker and signal other workers."""
    if not folder_name:
        return
    now = time.time()
    try:
        disk_cache.set(f"_inv_subtitles_{folder_name}", now, expire=3600)
    except Exception:
        pass
    with _gdrive_sub_lock:
        _gdrive_sub_cache.pop(f"gdrive_sub_{folder_name}", None)
        _gdrive_sub_cache_ts.pop(f"gdrive_sub_{folder_name}", None)
    with _supa_sub_lock:
        _supa_sub_cache.pop(f"supa_sub_{folder_name}", None)
        _supa_sub_cache_ts.pop(f"supa_sub_{folder_name}", None)

def _subtitle_map_cache_valid(cache_ts, folder_name, cache_value):
    inv_ts = None
    try:
        inv_ts = disk_cache.get(f"_inv_subtitles_{folder_name}")
    except Exception:
        inv_ts = None
    if inv_ts and cache_ts < inv_ts:
        return False
    ttl = _subtitle_empty_map_ttl if not cache_value else _supa_sub_ttl
    return (time.time() - cache_ts) < ttl

def _invalidate_user_cache(cache_type, cache_key):
    """Cross-worker invalidation: write timestamp ke diskcache (shared),
    dan hapus dari RAM cache worker ini."""
    now = time.time()
    inv_key = f"_inv_{cache_type}_{cache_key}"
    try:
        disk_cache.set(inv_key, now, expire=3600)  # TTL 1 jam
    except: pass
    with _user_data_lock:
        if cache_type == 'profiles':
            _user_profiles_cache.pop(cache_key, None)
            _user_profiles_cache_ts.pop(cache_key, None)
        elif cache_type == 'mylist':
            _user_mylist_cache.pop(cache_key, None)
            _user_mylist_cache_ts.pop(cache_key, None)

def _is_user_cache_valid(cache_type, cache_key):
    """Cek apakah RAM cache masih valid vs cross-worker invalidation.
    Return True jika cache valid, False jika perlu reload dari DB."""
    if cache_type == 'profiles':
        ram_ts = _user_profiles_cache_ts.get(cache_key)
    elif cache_type == 'mylist':
        ram_ts = _user_mylist_cache_ts.get(cache_key)
    else:
        return False
    if ram_ts is None:
        return False
    inv_keys = [f"_inv_{cache_type}_{cache_key}"]
    try:
        for inv_key in inv_keys:
            inv_ts = disk_cache.get(inv_key)
            if inv_ts is not None and inv_ts > ram_ts:
                return False  # Ada invalidasi dari worker lain yang lebih baru
    except: pass
    return True

# === GDRIVE CLIENT CACHE (Thread-Local) ===
# google-api-python-client is NOT thread-safe! Sharing `Service` across threads causes `double free or corruption` segfaults.
_gdrive_local = threading.local()
# [FIX] Keepalives DISABLED — biar Neon.tech bisa auto-suspend saat idle
# Sebelumnya keepalives_idle=30 bikin TCP heartbeat tiap 30 detik → Neon gak pernah tidur
DB_KWARGS = {"keepalives": 0, "connect_timeout": 10, "sslmode": "require"}

# ==========================================
# DATABASE HELPER & INIT (ON-DEMAND, NO POOL)
# ==========================================

def get_db_connection():
    if not DATABASE_URL:
        import sqlite3
        conn = sqlite3.connect('users.db', check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn, 'sqlite'
    
    # On-demand: buat koneksi baru tiap request, langsung tutup setelah selesai
    # 0 idle connections saat tidak ada request
    for attempt in range(3):
        try:
            conn = psycopg2.connect(DATABASE_URL, **DB_KWARGS)
            return conn, 'postgres'
        except Exception as e:
            print(f"[DB] Connection attempt {attempt+1} failed: {e}", flush=True)
            time.sleep(0.5)
    
    raise Exception("DB Connection Failed after retries")

def release_db_connection(conn, db_type):
    if conn is None: return
    try: conn.close()
    except: pass

_RELEASES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'content_releases.json')

def _migrate_releases_json_to_db(conn, cur):
    """One-time migration: import content_releases.json into DB table, then rename the file."""
    try:
        if not os.path.exists(_RELEASES_FILE):
            return
        with open(_RELEASES_FILE, 'r') as f:
            releases = json.loads(f.read())
        if not releases:
            return
        for r in releases:
            try:
                cur.execute(
                    "INSERT INTO content_releases (folder_name, status, release_date, media_type, tmdb_title, tmdb_poster_path, tmdb_overview, tmdb_rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (r.get('folder_name'), r.get('status', 'published'), r.get('release_date'), r.get('media_type', 'tv'),
                     r.get('tmdb_title'), r.get('tmdb_poster_path'), r.get('tmdb_overview'), r.get('tmdb_rating'),
                     r.get('created_at', time.time()), r.get('updated_at', time.time()))
                )
            except Exception:
                pass  # Duplicate, skip
        conn.commit()
        # Rename the old file so migration doesn't run again
        os.rename(_RELEASES_FILE, _RELEASES_FILE + '.migrated')
        print(f"Migrated {len(releases)} content releases from JSON to DB.")
    except Exception as e:
        print(f"Error migrating releases JSON: {e}")

def init_db():
    """
    Fungsi ini membuat semua tabel yang diperlukan jika belum ada.
    Termasuk tabel: users, registration_tokens, vouchers, profiles, watch_history, my_list.
    [FIX] Skip jika tabel sudah ada — hemat Neon CU saat worker restart.
    """
    conn, db_type = None, None
    try:
        conn, db_type = get_db_connection()
        cur = conn.cursor()
        # Quick check: if core tables exist, we still run lightweight CREATE TABLE IF NOT EXISTS
        # to allow new tables/migrations on existing installs, without breaking older DBs.
        tables_already_exist = False
        try:
            cur.execute("SELECT 1 FROM users LIMIT 1")
            cur.fetchone()
            tables_already_exist = True
            print("[INIT-DB] Core tables exist — running lightweight migrations.", flush=True)
        except Exception:
            # Table doesn't exist yet, proceed with full init
            if db_type == 'postgres':
                conn.rollback()  # Reset failed transaction for postgres
            tables_already_exist = False
        
        # Tentukan sintaks SQL berdasarkan jenis database (Postgres vs SQLite)
        pk_type = "SERIAL PRIMARY KEY" if db_type == 'postgres' else "INTEGER PRIMARY KEY AUTOINCREMENT"
        bool_type = "BOOLEAN" if db_type == 'postgres' else "INTEGER"
        now_func = "CURRENT_TIMESTAMP"
        
        # 1. Tabel Users
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS users (
                id {pk_type},
                username VARCHAR(255) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role VARCHAR(20) DEFAULT 'user',
                subscription_expires_at TIMESTAMP
            );
        """)

        # 2. Tabel Registration Tokens (Token Pendaftaran)
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS registration_tokens (
                id {pk_type},
                code VARCHAR(50) UNIQUE NOT NULL,
                duration_days INTEGER NOT NULL,
                is_used {bool_type} DEFAULT 0,
                created_by VARCHAR(50),
                created_at TIMESTAMP DEFAULT {now_func}
            );
        """)
        
        # 3. Tabel Vouchers (BARU: Untuk keamanan generate token)
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS vouchers (
                id {pk_type},
                code VARCHAR(50) UNIQUE NOT NULL,
                is_used {bool_type} DEFAULT 0,
                created_at TIMESTAMP DEFAULT {now_func}
            );
        """)

        # 4. Tabel Profiles
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS profiles (
                id VARCHAR(255) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                name VARCHAR(255) NOT NULL,
                avatar_seed VARCHAR(255) NOT NULL,
                CONSTRAINT fk_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        """)
        
        # 5. Tabel Watch History
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS watch_history (
                id {pk_type},
                user_id INTEGER NOT NULL,
                profile_id VARCHAR(255) NOT NULL,
                media_path TEXT NOT NULL,
                media_title TEXT,
                series_title TEXT,
                source TEXT,
                still_path TEXT,
                subtitle_path TEXT,
                season INTEGER,
                episode INTEGER,
                position_ms INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL,
                is_hidden INTEGER DEFAULT 0,
                last_watched TIMESTAMP DEFAULT {now_func},
                UNIQUE (user_id, profile_id, media_path)
            );
        """)
        # Migration: persist episode metadata for continue-watching cards.
        for column_sql in (
            "ALTER TABLE watch_history ADD COLUMN season INTEGER",
            "ALTER TABLE watch_history ADD COLUMN episode INTEGER",
            "ALTER TABLE watch_history ADD COLUMN is_hidden INTEGER DEFAULT 0",
        ):
            try:
                cur.execute(column_sql)
                conn.commit()
            except Exception:
                conn.rollback() if db_type == 'postgres' else None  # Column already exists
        try:
            cur.execute("CREATE INDEX IF NOT EXISTS idx_watch_history_user_profile_last ON watch_history (user_id, profile_id, last_watched DESC)")
            conn.commit()
        except Exception:
            conn.rollback() if db_type == 'postgres' else None

        # 6. Tabel My List
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS my_list (
                id {pk_type},
                user_id INTEGER NOT NULL,
                profile_id VARCHAR(255) NOT NULL,
                folder_name VARCHAR(255) NOT NULL,
                media_type VARCHAR(20) NOT NULL,
                meta_json TEXT,
                status VARCHAR(20) DEFAULT 'plan_to_watch',
                added_at TIMESTAMP DEFAULT {now_func},
                UNIQUE (user_id, profile_id, folder_name)
            );
        """)
        # Migration: add status column to existing my_list table
        try:
            cur.execute("ALTER TABLE my_list ADD COLUMN status VARCHAR(20) DEFAULT 'plan_to_watch'")
            conn.commit()
        except Exception:
            conn.rollback() if db_type == 'postgres' else None  # Column already exists
        
        conn.commit()

        # 7. Tabel TMDB Overrides (Admin override TMDB search query)
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS tmdb_overrides (
                id {pk_type},
                folder_name VARCHAR(255) UNIQUE NOT NULL,
                tmdb_query VARCHAR(255) NOT NULL,
                media_type VARCHAR(20) DEFAULT 'tv',
                override_year INTEGER,
                override_language VARCHAR(10),
                include_adult BOOLEAN DEFAULT FALSE,
                override_region VARCHAR(10),
                updated_by INTEGER,
                updated_at TIMESTAMP DEFAULT {now_func}
            );
        """)
        # Migrations for existing databases: add new columns if they don't exist
        for col, col_type in [('override_year', 'INTEGER'), ('override_language', 'VARCHAR(10)'), ('include_adult', 'BOOLEAN DEFAULT FALSE'), ('override_region', 'VARCHAR(10)')]:
            try:
                cur.execute(f"ALTER TABLE tmdb_overrides ADD COLUMN {col} {col_type}")
                conn.commit()
            except Exception:
                conn.rollback() if db_type == 'postgres' else None  # Column already exists
        conn.commit()

        # 8. Tabel Intro Markers (Admin: manual skip intro per series)
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS intro_markers (
                id {pk_type},
                folder_name VARCHAR(255) UNIQUE NOT NULL,
                intro_end_seconds INTEGER NOT NULL,
                updated_by INTEGER,
                updated_at TIMESTAMP DEFAULT {now_func}
            );
        """)
        conn.commit()

        # 8b. Tabel Outro Markers (Admin: configurable episode completion point per series)
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS outro_markers (
                id {pk_type},
                folder_name VARCHAR(255) UNIQUE NOT NULL,
                outro_start_seconds INTEGER NOT NULL,
                updated_by INTEGER,
                updated_at TIMESTAMP DEFAULT {now_func}
            );
        """)
        conn.commit()

        # 9. Content Releases table (replaces content_releases.json)
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS content_releases (
                id {pk_type},
                folder_name VARCHAR(255) UNIQUE NOT NULL,
                status VARCHAR(20) DEFAULT 'published',
                release_date TEXT,
                media_type VARCHAR(20) DEFAULT 'tv',
                tmdb_title TEXT,
                tmdb_poster_path TEXT,
                tmdb_overview TEXT,
                tmdb_rating REAL,
                created_at REAL,
                updated_at REAL
            );
        """)
        conn.commit()

        # 10. Telegram Catalog (dynamic content source via webhook/bot)
        # Used by telegram_api.py + /api/folders merge.
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS telegram_catalog (
                id {pk_type},
                item_id VARCHAR(255) UNIQUE NOT NULL,
                folder_name TEXT,
                media_type VARCHAR(20) DEFAULT 'movie',
                tmdb_title TEXT,
                tmdb_poster_path TEXT,
                chat_id BIGINT,
                video_message_id BIGINT,
                telegram_file_id TEXT,
                telegram_file_name TEXT,
                telegram_mime_type TEXT,
                telegram_file_size BIGINT,
                added_at TIMESTAMP DEFAULT {now_func}
            );
        """)
        # Migrations: add new columns if they don't exist (sqlite/postgres safe)
        for col, col_type in [
            ('telegram_file_id', 'TEXT'),
            ('telegram_file_name', 'TEXT'),
            ('telegram_mime_type', 'TEXT'),
            ('telegram_file_size', 'BIGINT'),
        ]:
            try:
                cur.execute(f"ALTER TABLE telegram_catalog ADD COLUMN {col} {col_type}")
                conn.commit()
            except Exception:
                conn.rollback() if db_type == 'postgres' else None
        conn.commit()

        # Auto-migrate existing content_releases.json data into DB (only needed on fresh/old installs)
        if not tables_already_exist:
            _migrate_releases_json_to_db(conn, cur)
            conn.commit()

        print(f"Database ({db_type}) initialized successfully with all tables.")
    except Exception as e:
        print(f"Failed to initialize database: {e}")
    finally:
        release_db_connection(conn, db_type)

# Jalankan init saat startup
with app.app_context():
    init_db()

# ==========================================
# OPTIONAL TELEGRAM API BLUEPRINT (catalog + webhook)
# ==========================================
try:
    from telegram_api import telegram_bp
    app.register_blueprint(telegram_bp)
    print("[INIT] Telegram blueprint registered at /api/telegram", flush=True)
except Exception as _telg_ex:
    # Don't crash server if telegram module isn't available
    print(f"[INIT] Telegram blueprint not registered: {_telg_ex}", flush=True)

# ==========================================
# AUTH MIDDLEWARE (Hybrid Logic + RAM Caching)
# ==========================================


def token_required(check_expiry=True):
    """
    [FIX-v3] ZERO DB lookups — construct current_user entirely from JWT payload.
    JWT already contains user_id, username, role, subscription_expires_at.
    This lets Neon fully idle when no direct user-data operations are happening.
    """
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            token = request.headers.get('x-access-token')
            if not token: return jsonify({'message': 'Token missing'}), 401
            
            try:
                # [OPTIMIZATION] Check JWT cache first (~0.01ms)
                now = time.time()
                cached_jwt = _jwt_cache.get(token)
                if cached_jwt and (now - _jwt_cache_ts.get(token, 0)) < _jwt_cache_ttl:
                    data = cached_jwt
                else:
                    data = jwt.decode(token, app.config['SECRET_KEY'], algorithms=["HS256"])
                    # Cache the decoded payload
                    with _jwt_lock:
                        _jwt_cache[token] = data
                        _jwt_cache_ts[token] = now
                        # Evict old entries if cache gets too large (>10000 tokens)
                        if len(_jwt_cache) > 10000:
                            oldest = sorted(_jwt_cache_ts.items(), key=lambda x: x[1])[:5000]
                            for k, _ in oldest:
                                _jwt_cache.pop(k, None)
                                _jwt_cache_ts.pop(k, None)
                
                # [FIX-v3] Construct current_user from JWT — ZERO DB lookups
                current_user = {
                    'id': data['user_id'],
                    'username': data.get('username', ''),
                    'role': data.get('role', 'user'),
                    'subscription_expires_at': data.get('subscription_expires_at'),
                }
                
                # CEK SUBSCRIPTION EXPIRY (from JWT data, no DB needed)
                if check_expiry and current_user.get('role') != 'admin':
                    expiry = current_user.get('subscription_expires_at')
                    is_expired = False
                    if not expiry:
                        is_expired = True
                    else:
                        if isinstance(expiry, str): expiry = datetime.datetime.fromisoformat(expiry)
                        if isinstance(expiry, (int, float)): expiry = datetime.datetime.fromtimestamp(expiry)
                        if datetime.datetime.now() > expiry: is_expired = True
                    
                    if is_expired:
                        return jsonify({
                            'message': 'Subscription Expired', 
                            'code': 'SUBSCRIPTION_EXPIRED',
                            'detail': 'Please redeem a new token to continue.'
                        }), 403

            except Exception as e:
                return jsonify({'message': 'Token invalid', 'error': str(e)}), 401
                
            return f(current_user, *args, **kwargs)
        return decorated
    return decorator

# ==========================================
# DISCORD INTERACTION ROUTE (BARU)
# ==========================================
# ... (kode impor lainnya tetap sama)

# Pastikan threading dan requests sudah diimport di paling atas
# import threading 
# import time
# import requests 

@app.route('/api/discord/interactions', methods=['POST'])
@verify_key_decorator(DISCORD_PUBLIC_KEY)
def discord_interactions():
    if request.json['type'] == InteractionType.APPLICATION_COMMAND:
        data = request.json['data']
        member = request.json['member']
        user_id = member['user']['id']
        application_id = request.json['application_id']
        interaction_token = request.json['token']

        conn, db_type = get_db_connection()
        ph = '%s' if db_type == 'postgres' else '?'

        # --- COMMAND 1: BUAT VOUCHER (ADMIN ONLY) ---
        if data['name'] == 'buat_voucher':
            # Pastikan hanya Admin yang bisa
            if DISCORD_ADMIN_ID and str(user_id) != str(DISCORD_ADMIN_ID):
                 return jsonify({'type': InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, 'data': {'content': '⛔ Khusus Admin.'}})
            
            voucher_code = f"V-{str(uuid.uuid4())[:8].upper()}"
            try:
                cur = conn.cursor()
                cur.execute(f"INSERT INTO vouchers (code) VALUES ({ph})", (voucher_code,))
                conn.commit()
                return jsonify({'type': InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, 'data': {'content': f"🎫 **Voucher Dibuat!**\nCode: `{voucher_code}`\n\nBerikan kode ini ke user."}})
            except Exception as e:
                return jsonify({'type': InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, 'data': {'content': f"Error: {e}"}})
            finally:
                release_db_connection(conn, db_type)

        # --- COMMAND 2: GENERATE TOKEN (USER + VOUCHER CHECK) ---
        elif data['name'] == 'generate_token':
            # Ambil input user
            input_voucher = data['options'][0]['value'] # Urutan sesuai register_command (kode_voucher dulu)
            duration_val = data['options'][1]['value']  # Lalu durasi

            try:
                cur = conn.cursor()
                if db_type == 'postgres': cur = conn.cursor(cursor_factory=RealDictCursor)
                else: conn.row_factory = sqlite3.Row; cur = conn.cursor()

                # 1. CEK VALIDITAS VOUCHER
                is_used_check = "TRUE" if db_type == 'postgres' else "1"
                false_val = "FALSE" if db_type == 'postgres' else "0"
                
                if db_type == 'postgres': cur.execute("SELECT * FROM vouchers WHERE code = %s", (input_voucher,))
                else: cur.execute("SELECT * FROM vouchers WHERE code = ?", (input_voucher,))
                
                voucher_data = cur.fetchone()

                if not voucher_data:
                    return jsonify({
                        'type': InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, 
                        'data': {'content': 'WOI BAJINGAN KODE NYA GAK COCOK 🤬'}
                    })
                
                # Cek manual is_used (karena sqlite/pg beda return type kadang)
                is_used = voucher_data['is_used']
                if is_used == 1 or is_used is True:
                     return jsonify({'type': InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, 'data': {'content': '❌ **Voucher Sudah Terpakai!**'}})

                # 2. JIKA VOUCHER VALID, LANJUT PROSES TOKEN
                raw_token = uuid.uuid4().hex.upper()
                final_token = f"MUTFLIX-{raw_token}"
                days = 36500 if duration_val == 'lifetime' else int(duration_val)

                # Simpan Token
                cur.execute(f"INSERT INTO registration_tokens (code, duration_days, created_by) VALUES ({ph}, {ph}, {ph})", 
                           (final_token, days, str(user_id)))
                
                # Hanguskan Voucher
                cur.execute(f"UPDATE vouchers SET is_used = {is_used_check} WHERE id = {ph}", (voucher_data['id'],))
                conn.commit()

                # Threading Hapus Pesan (5 Menit)
                def delete_message_later(app_id, token):
                    time.sleep(300)
                    try: requests.delete(f"https://discord.com/api/v10/webhooks/{app_id}/{token}/messages/@original")
                    except: pass
                threading.Thread(target=delete_message_later, args=(application_id, interaction_token)).start()

                msg_durasi = "Selamanya" if duration_val == 'lifetime' else f"{days} Hari"
                return jsonify({
                    'type': InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    'data': {'content': f"✅ **Akses Diberikan!**\nToken: `{final_token}`\nDurasi: {msg_durasi}\n\n⚠️ *Pesan otomatis dihapus dalam 5 menit.*"}
                })

            except Exception as e:
                return jsonify({'type': InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, 'data': {'content': f'Error System: {e}'}})
            finally:
                release_db_connection(conn, db_type)

    return jsonify({'type': InteractionResponseType.PONG})
# ==========================================
# AUTH ROUTES (Register Pakai Token)
# ==========================================

@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.get_json()
    if not data or 'token' not in data: return jsonify({"message": "Token required"}), 400
    password = data.get('password') or ''
    if len(password) < 8:
        return jsonify({"message": "Password must be at least 8 characters"}), 400
    
    conn, db_type = get_db_connection()
    try:
        if db_type == 'postgres':
             cur = conn.cursor(cursor_factory=RealDictCursor)
        else:
             conn.row_factory = sqlite3.Row
             cur = conn.cursor()

        ph = '%s' if db_type == 'postgres' else '?'
        
        # 1. Cek Token
        if db_type == 'postgres': cur.execute("SELECT * FROM registration_tokens WHERE code = %s AND is_used = FALSE", (data['token'],))
        else: cur.execute("SELECT * FROM registration_tokens WHERE code = ? AND is_used = 0", (data['token'],))
        
        token_data = cur.fetchone()
        if not token_data: return jsonify({"message": "Invalid or Used Token"}), 400
        token_data = dict(token_data)

        # 2. Hitung Expiry
        duration = token_data['duration_days']
        role = 'admin' if duration > 10000 else 'user'
        expiry = datetime.datetime.now() + datetime.timedelta(days=36500 if role == 'admin' else duration)

        # 3. Create User & Burn Token
        hashed = generate_password_hash(data['password'], method='pbkdf2:sha256')
        
        # Insert User
        cur.execute(f"INSERT INTO users (username, password_hash, role, subscription_expires_at) VALUES ({ph}, {ph}, {ph}, {ph})", 
                   (data['username'], hashed, role, expiry))
        
        # Update Token
        is_used_val = "TRUE" if db_type == 'postgres' else "1"
        cur.execute(f"UPDATE registration_tokens SET is_used = {is_used_val} WHERE id = {ph}", (token_data['id'],))
        
        conn.commit()
        return jsonify({"message": "Registered", "expiry": expiry}), 201
    except Exception as e:
        if conn: conn.rollback()
        return jsonify({"message": "Error/Username Taken", "detail": str(e)}), 400
    finally: release_db_connection(conn, db_type)

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.get_json()
    conn, db_type = get_db_connection()
    try:
        user = None
        if db_type == 'postgres':
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute('SELECT * FROM users WHERE username = %s', (data['username'],))
            res = cur.fetchone()
            if res: user = dict(res)
        else:
            conn.row_factory = sqlite3.Row
            res = conn.execute('SELECT * FROM users WHERE username = ?', (data['username'],)).fetchone()
            if res: user = dict(res)
        
        if not user or not check_password_hash(user['password_hash'], data['password']):
            return jsonify({"message": "Invalid credentials"}), 401
        
        # --- LOGIKA BARU: CEK EXPIRY DI SINI ---
        # Jika bukan admin DAN masa aktif habis, tolak login
        expiry_str = str(user.get('subscription_expires_at'))
        if user.get('role') != 'admin':
             exp = user.get('subscription_expires_at')
             is_expired = False
             
             if not exp: 
                 is_expired = True # Belum punya tanggal = Expired (atau user baru yg belum redeem)
             else:
                 if isinstance(exp, str): exp = datetime.datetime.fromisoformat(exp)
                 if datetime.datetime.now() > exp: is_expired = True
            
             if is_expired:
                 return jsonify({
                     "message": "Subscription Expired",
                     "is_expired": True,
                     "detail": "Please contact admin to renew."
                 }), 403  # <-- 403 Forbidden, Login Gagal
        # ---------------------------------------

        # ---------------------------------------

        # Cek remember_me flag
        remember_me = data.get('remember_me', False)
        # Jika remember_me True, expiry 10 tahun (3650 hari)
        # Jika False, default 24 jam
        delta = datetime.timedelta(days=3650) if remember_me else datetime.timedelta(hours=24)

        token = jwt.encode({
            'user_id': user['id'],
            'username': user['username'],
            'role': user.get('role', 'user'),
            'subscription_expires_at': expiry_str,
            'exp': datetime.datetime.now(datetime.timezone.utc) + delta
        }, app.config['SECRET_KEY'], algorithm="HS256")
        
        return jsonify({
            'token': token, 
            'username': user['username'], 
            'role': user.get('role', 'user'), 
            'expires_at': expiry_str
        })
    finally: release_db_connection(conn, db_type)

@app.route('/api/auth/status', methods=['GET'])
@token_required(check_expiry=False)
def auth_status(current_user):
    conn, db_type = get_db_connection()
    try:
        user = None
        if db_type == 'postgres':
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute('SELECT * FROM users WHERE id = %s', (current_user['id'],))
            res = cur.fetchone()
            if res: user = dict(res)
        else:
            conn.row_factory = sqlite3.Row
            res = conn.execute('SELECT * FROM users WHERE id = ?', (current_user['id'],)).fetchone()
            if res: user = dict(res)
        
        if not user: return jsonify({"message": "User not found"}), 404
        
        expires_at = str(user.get('subscription_expires_at')) if user.get('subscription_expires_at') else None
        
        return jsonify({
            'username': user['username'],
            'role': user.get('role', 'user'),
            'expires_at': expires_at
        })
    finally: release_db_connection(conn, db_type)

# ==========================================
# TMDB OVERRIDES API (Admin only)
# ==========================================

def _tmdb_proxy_cache_key(tmdb_path, params):
    normalized = {
        'path': tmdb_path,
        'params': sorted((params or {}).items()),
    }
    raw = json.dumps(normalized, sort_keys=True, separators=(',', ':'))
    return 'tmdb_proxy_' + hashlib.sha256(raw.encode('utf-8')).hexdigest()

def _tmdb_proxy_response_from_cache(entry, cache_status):
    remaining = max(0, int(TMDB_CACHE_TTL_SECONDS - (time.time() - entry.get('ts', time.time()))))
    resp = Response(
        entry['body'],
        status=entry['status'],
        content_type=entry.get('content_type') or 'application/json',
    )
    resp.headers['Cache-Control'] = f'public, max-age={remaining}'
    resp.headers['X-TMDB-Cache'] = cache_status
    return resp

def _get_tmdb_proxy_cache(cache_key):
    now = time.time()
    with _tmdb_proxy_lock:
        entry = _tmdb_proxy_cache.get(cache_key)
        if entry and now - entry.get('ts', 0) < TMDB_CACHE_TTL_SECONDS:
            return entry, 'HIT-RAM'
        if entry:
            _tmdb_proxy_cache.pop(cache_key, None)
            _tmdb_proxy_cache_ts.pop(cache_key, None)

    try:
        entry = disk_cache.get(cache_key)
    except Exception:
        entry = None

    if entry and now - entry.get('ts', 0) < TMDB_CACHE_TTL_SECONDS:
        with _tmdb_proxy_lock:
            _tmdb_proxy_cache[cache_key] = entry
            _tmdb_proxy_cache_ts[cache_key] = entry.get('ts', now)
        return entry, 'HIT-DISK'
    return None, None

def _set_tmdb_proxy_cache(cache_key, response):
    if response.status_code not in (200, 404):
        return

    entry = {
        'status': response.status_code,
        'content_type': response.headers.get('Content-Type', 'application/json'),
        'body': response.content,
        'ts': time.time(),
    }
    with _tmdb_proxy_lock:
        _tmdb_proxy_cache[cache_key] = entry
        _tmdb_proxy_cache_ts[cache_key] = entry['ts']
        if len(_tmdb_proxy_cache) > 2000:
            oldest = sorted(_tmdb_proxy_cache_ts.items(), key=lambda x: x[1])[:500]
            for key, _ in oldest:
                _tmdb_proxy_cache.pop(key, None)
                _tmdb_proxy_cache_ts.pop(key, None)

    try:
        disk_cache.set(cache_key, entry, expire=TMDB_CACHE_TTL_SECONDS)
    except Exception as e:
        print(f"[TMDB-PROXY] disk cache set failed: {e}", flush=True)

def _tmdb_meta_cache_key(media_type, folder_name, override):
    override_snapshot = None
    if override:
        override_snapshot = {
            'tmdb_query': override.get('tmdb_query'),
            'override_year': override.get('override_year'),
            'override_language': override.get('override_language'),
            'include_adult': override.get('include_adult'),
            'override_region': override.get('override_region'),
        }
    normalized = {
        'v': 1,
        'media_type': media_type,
        'folder_name': folder_name,
        'override': override_snapshot,
    }
    raw = json.dumps(normalized, sort_keys=True, separators=(',', ':'), default=str)
    return 'tmdb_meta_' + hashlib.sha256(raw.encode('utf-8')).hexdigest()

def _get_tmdb_meta_cache(cache_key):
    now = time.time()
    with _tmdb_meta_cache_lock:
        entry = _tmdb_meta_cache.get(cache_key)
        if entry and now - entry.get('ts', 0) < TMDB_CACHE_TTL_SECONDS:
            return entry, 'HIT-RAM'
        if entry:
            _tmdb_meta_cache.pop(cache_key, None)
            _tmdb_meta_cache_ts.pop(cache_key, None)

    try:
        entry = disk_cache.get(cache_key)
    except Exception:
        entry = None

    if entry and now - entry.get('ts', 0) < TMDB_CACHE_TTL_SECONDS:
        with _tmdb_meta_cache_lock:
            _tmdb_meta_cache[cache_key] = entry
            _tmdb_meta_cache_ts[cache_key] = entry.get('ts', now)
        return entry, 'HIT-DISK'
    return None, None

def _set_tmdb_meta_cache(cache_key, status, payload):
    if status not in (200, 404):
        return
    entry = {
        'status': status,
        'payload': payload,
        'ts': time.time(),
    }
    with _tmdb_meta_cache_lock:
        _tmdb_meta_cache[cache_key] = entry
        _tmdb_meta_cache_ts[cache_key] = entry['ts']
        if len(_tmdb_meta_cache) > 2000:
            oldest = sorted(_tmdb_meta_cache_ts.items(), key=lambda x: x[1])[:500]
            for key, _ in oldest:
                _tmdb_meta_cache.pop(key, None)
                _tmdb_meta_cache_ts.pop(key, None)

    try:
        disk_cache.set(cache_key, entry, expire=TMDB_CACHE_TTL_SECONDS)
    except Exception as e:
        print(f"[TMDB-META] disk cache set failed: {e}", flush=True)

def _tmdb_meta_response_from_cache(entry, cache_status):
    remaining = max(0, int(TMDB_CACHE_TTL_SECONDS - (time.time() - entry.get('ts', time.time()))))
    resp = orjson_jsonify(entry.get('payload') or {}, status=entry.get('status', 200))
    resp.headers['Cache-Control'] = f'public, max-age={remaining}'
    resp.headers['X-TMDB-Meta-Cache'] = cache_status
    return resp

def _tmdb_meta_lock_for(cache_key):
    with _tmdb_meta_key_locks_lock:
        lock = _tmdb_meta_key_locks.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _tmdb_meta_key_locks[cache_key] = lock
        return lock

def _get_or_resolve_tmdb_meta_payload(media_type, folder_name):
    """Resolve one TMDB metadata payload, using the same cache path as the GET endpoint."""
    media_type = (media_type or '').strip().lower()
    folder_name = (folder_name or '').strip()
    if media_type not in ('tv', 'movie'):
        return 400, {'error': 'media_type must be tv or movie'}, None
    if not folder_name:
        return 400, {'error': 'folder_name is required'}, None

    override = _get_tmdb_overrides_map().get(folder_name)
    cache_key = _tmdb_meta_cache_key(media_type, folder_name, override)
    cached_entry, cache_status = _get_tmdb_meta_cache(cache_key)
    if cached_entry:
        return cached_entry.get('status', 200), cached_entry.get('payload'), cache_status

    key_lock = _tmdb_meta_lock_for(cache_key)
    with key_lock:
        cached_entry, cache_status = _get_tmdb_meta_cache(cache_key)
        if cached_entry:
            return cached_entry.get('status', 200), cached_entry.get('payload'), cache_status

        status, payload = _resolve_tmdb_meta(media_type, folder_name, override)
        _set_tmdb_meta_cache(cache_key, status, payload)
        return status, payload, 'MISS'

def _parse_year_from_folder_name(folder_name):
    patterns = [
        r'\((\d{4})\)',
        r'[._\s](\d{4})(?:[._\s]|$)',
    ]
    for pattern in patterns:
        match = re.search(pattern, folder_name or '')
        if not match:
            continue
        try:
            year = int(match.group(1))
            if 1900 <= year <= 2100:
                return year
        except Exception:
            pass
    return None

def _clean_tmdb_query_from_folder_name(folder_name):
    cleaned = re.sub(r'\s*\(\d{4}\)\s*', ' ', folder_name or '')
    cleaned = re.sub(r'[._]+', ' ', cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned

def _tmdb_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ('1', 'true', 'yes', 'on')
    return False

def _fetch_tmdb_json_server(tmdb_path, params=None, timeout=10):
    params = dict(params or {})
    params.pop('api_key', None)
    cache_key = _tmdb_proxy_cache_key(tmdb_path, params)
    cached_entry, _ = _get_tmdb_proxy_cache(cache_key)
    if cached_entry:
        try:
            return cached_entry.get('status', 200), orjson.loads(cached_entry.get('body') or b'{}')
        except Exception as e:
            print(f"[TMDB-META] cached JSON decode failed for {tmdb_path}: {e}", flush=True)

    upstream_params = dict(params)
    upstream_params['api_key'] = TMDB_API_KEY
    try:
        response = requests.get(
            f'https://api.themoviedb.org/3/{tmdb_path}',
            params=upstream_params,
            timeout=timeout,
        )
        _set_tmdb_proxy_cache(cache_key, response)
        try:
            data = response.json()
        except ValueError:
            data = {'error': 'Invalid TMDB JSON response'}
        return response.status_code, data
    except requests.RequestException as e:
        print(f"[TMDB-META] request failed for {tmdb_path}: {e}", flush=True)
        return 502, {'error': 'TMDB request failed'}

def _resolve_tmdb_meta(media_type, folder_name, override):
    query = (override.get('tmdb_query') if override else None) or _clean_tmdb_query_from_folder_name(folder_name)
    query = (query or folder_name or '').strip()
    if not query:
        return 400, {'error': 'folder_name cannot be empty'}

    override_year = override.get('override_year') if override else None
    year = override_year or _parse_year_from_folder_name(folder_name)

    search_params = {'query': query}
    if media_type == 'tv':
        if year:
            search_params['first_air_date_year'] = str(year)
        search_path = 'search/tv'
        detail_prefix = 'tv'
        detail_params = {'append_to_response': 'content_ratings'}
    else:
        if year:
            search_params['primary_release_year'] = str(year)
        search_path = 'search/movie'
        detail_prefix = 'movie'
        detail_params = {}

    if override:
        language = (override.get('override_language') or '').strip()
        if language:
            search_params['language'] = language
        if _tmdb_bool(override.get('include_adult')):
            search_params['include_adult'] = 'true'
        region = (override.get('override_region') or '').strip()
        if media_type == 'movie' and region:
            search_params['region'] = region

    search_status, search_data = _fetch_tmdb_json_server(search_path, search_params)
    if search_status != 200:
        return search_status, {
            'error': 'TMDB search failed',
            'status': search_status,
            'folder_name': folder_name,
            'query': query,
        }

    results = search_data.get('results') if isinstance(search_data, dict) else None
    if not results:
        return 404, {
            'error': 'TMDB metadata not found',
            'folder_name': folder_name,
            'query': query,
            'media_type': media_type,
        }

    tmdb_id = results[0].get('id') if isinstance(results[0], dict) else None
    if not tmdb_id:
        return 404, {
            'error': 'TMDB metadata id not found',
            'folder_name': folder_name,
            'query': query,
            'media_type': media_type,
        }

    detail_status, detail_data = _fetch_tmdb_json_server(f'{detail_prefix}/{tmdb_id}', detail_params)
    if detail_status != 200:
        return detail_status, {
            'error': 'TMDB detail failed',
            'status': detail_status,
            'folder_name': folder_name,
            'query': query,
            'tmdb_id': tmdb_id,
        }
    return 200, detail_data

@app.route('/api/tmdb-meta/<media_type>', methods=['GET'])
@token_required(check_expiry=False)
def get_tmdb_meta(current_user, media_type):
    """Resolve folder metadata on the server, including search, detail, overrides, and cache."""
    if not TMDB_API_KEY:
        return orjson_jsonify({'error': 'TMDB_API_KEY is not configured on server'}, 503)

    folder_name = request.args.get('folder_name')
    resolved_name = folder_name
    if folder_name and folder_name.startswith(("gdrive_folder/", "gdrive/", "telegram/")):
        folders_data = mem_get('folders_list')
        if folders_data:
            for movie_item in folders_data.get('movies', []):
                if movie_item.get('source') == folder_name:
                    resolved_name = movie_item['name']
                    break
    status, payload, cache_status = _get_or_resolve_tmdb_meta_payload(media_type, resolved_name)

    resp = orjson_jsonify(payload, status=status)
    resp.headers['Cache-Control'] = f'public, max-age={TMDB_CACHE_TTL_SECONDS}' if status in (200, 404) else 'no-store'
    resp.headers['X-TMDB-Meta-Cache'] = cache_status or 'MISS'
    return resp

@app.route('/api/tmdb-meta/bulk', methods=['POST'])
@token_required(check_expiry=False)
def bulk_tmdb_meta(current_user):
    """Resolve many folder metadata records aggressively in one request."""
    if not TMDB_API_KEY:
        return orjson_jsonify({'error': 'TMDB_API_KEY is not configured on server'}, 503)

    data = request.get_json(silent=True) or {}
    raw_items = data.get('items') or []
    if not isinstance(raw_items, list):
        return orjson_jsonify({'error': 'items must be a list'}, 400)

    unique_items = []
    seen = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        media_type = str(raw.get('media_type') or raw.get('type') or '').strip().lower()
        if media_type == 'series':
            media_type = 'tv'
        folder_name = str(raw.get('folder_name') or raw.get('name') or '').strip()
        key = (media_type, folder_name)
        if media_type not in ('tv', 'movie') or not folder_name or key in seen:
            continue
        seen.add(key)
        unique_items.append({'media_type': media_type, 'folder_name': folder_name})

    def _resolve_item(item):
        status, payload, cache_status = _get_or_resolve_tmdb_meta_payload(
            item['media_type'],
            item['folder_name'],
        )
        return {
            'media_type': item['media_type'],
            'folder_name': item['folder_name'],
            'status': status,
            'cache': cache_status or 'MISS',
            'payload': payload,
        }

    futures = [_tmdb_meta_executor.submit(_resolve_item, item) for item in unique_items]
    results = []
    for future in as_completed(futures):
        try:
            results.append(future.result())
        except Exception as e:
            results.append({
                'status': 500,
                'cache': 'ERROR',
                'payload': {'error': str(e)},
            })

    return orjson_jsonify({'results': results, 'count': len(results)})

def _tmdb_image_cache_key(size, image_path):
    raw = json.dumps({'v': 1, 'size': size, 'path': image_path}, sort_keys=True, separators=(',', ':'))
    return 'tmdb_image_' + hashlib.sha256(raw.encode('utf-8')).hexdigest()

def _tmdb_image_response_from_cache(entry, cache_status):
    remaining = max(0, int(TMDB_CACHE_TTL_SECONDS - (time.time() - entry.get('ts', time.time()))))
    resp = Response(
        entry['body'],
        status=entry.get('status', 200),
        content_type=entry.get('content_type') or 'image/jpeg',
    )
    resp.headers['Cache-Control'] = f'public, max-age={remaining}'
    resp.headers['X-TMDB-Image-Cache'] = cache_status
    return resp

def _get_tmdb_image_cache(cache_key):
    now = time.time()
    try:
        entry = disk_cache.get(cache_key)
    except Exception:
        entry = None
    if entry and now - entry.get('ts', 0) < TMDB_CACHE_TTL_SECONDS:
        return entry, 'HIT-DISK'
    return None, None

def _set_tmdb_image_cache(cache_key, response):
    if response.status_code not in (200, 404):
        return
    entry = {
        'status': response.status_code,
        'content_type': response.headers.get('Content-Type', 'image/jpeg'),
        'body': response.content,
        'ts': time.time(),
    }
    try:
        disk_cache.set(cache_key, entry, expire=TMDB_CACHE_TTL_SECONDS)
    except Exception as e:
        print(f"[TMDB-IMAGE] disk cache set failed: {e}", flush=True)

@app.route('/api/tmdb-image/<size>/<path:image_path>', methods=['GET'])
@rate_limited(limit=600)
def proxy_tmdb_image(size, image_path):
    """Proxy TMDB image assets so Flutter can load posters/backdrops from this server."""
    size = (size or '').strip()
    image_path = (image_path or '').lstrip('/')

    if not re.fullmatch(r'(original|[wh]\d+)', size):
        return orjson_jsonify({'error': 'Invalid TMDB image size'}, 400)
    if not image_path or '..' in image_path or image_path.startswith('/'):
        return orjson_jsonify({'error': 'Invalid TMDB image path'}, 400)

    cache_key = _tmdb_image_cache_key(size, image_path)
    cached_entry, cache_status = _get_tmdb_image_cache(cache_key)
    if cached_entry:
        return _tmdb_image_response_from_cache(cached_entry, cache_status)

    try:
        quoted_path = quote(image_path, safe='/')
        response = requests.get(
            f'https://image.tmdb.org/t/p/{size}/{quoted_path}',
            timeout=15,
        )
        _set_tmdb_image_cache(cache_key, response)
        proxied = Response(
            response.content,
            status=response.status_code,
            content_type=response.headers.get('Content-Type', 'image/jpeg'),
        )
        proxied.headers['Cache-Control'] = f'public, max-age={TMDB_CACHE_TTL_SECONDS}' if response.status_code in (200, 404) else 'no-store'
        proxied.headers['X-TMDB-Image-Cache'] = 'MISS'
        return proxied
    except requests.RequestException as e:
        print(f"[TMDB-IMAGE] request failed for {size}/{image_path}: {e}", flush=True)
        return orjson_jsonify({'error': 'TMDB image request failed'}, 502)

@app.route('/api/tmdb/<path:tmdb_path>', methods=['GET'])
@token_required(check_expiry=False)
@rate_limited(limit=120)
def proxy_tmdb(current_user, tmdb_path):
    """Proxy TMDB requests so the API key stays server-side."""
    if not TMDB_API_KEY:
        return orjson_jsonify({'error': 'TMDB_API_KEY is not configured on server'}, 503)

    if '..' in tmdb_path or tmdb_path.startswith('/'):
        return orjson_jsonify({'error': 'Invalid TMDB path'}, 400)

    params = request.args.to_dict(flat=True)
    params.pop('api_key', None)
    cache_key = _tmdb_proxy_cache_key(tmdb_path, params)
    cached_entry, cache_status = _get_tmdb_proxy_cache(cache_key)
    if cached_entry:
        return _tmdb_proxy_response_from_cache(cached_entry, cache_status)

    params['api_key'] = TMDB_API_KEY

    try:
        response = requests.get(
            f'https://api.themoviedb.org/3/{tmdb_path}',
            params=params,
            timeout=10,
        )
        excluded_headers = {
            'content-encoding',
            'content-length',
            'transfer-encoding',
            'connection',
        }
        headers = [
            (name, value)
            for name, value in response.headers.items()
            if name.lower() not in excluded_headers
        ]
        _set_tmdb_proxy_cache(cache_key, response)
        proxied = Response(response.content, response.status_code, headers)
        proxied.headers['Cache-Control'] = f'public, max-age={TMDB_CACHE_TTL_SECONDS}' if response.status_code in (200, 404) else 'no-store'
        proxied.headers['X-TMDB-Cache'] = 'MISS'
        return proxied
    except requests.RequestException as e:
        print(f"[TMDB-PROXY] request failed for {tmdb_path}: {e}", flush=True)
        return orjson_jsonify({'error': 'TMDB request failed'}, 502)

@app.route('/api/tmdb-overrides', methods=['GET'])
@token_required(check_expiry=False)
@rate_limited()
def get_tmdb_overrides(current_user):
    """Get all TMDB query overrides. Any authenticated user can read."""
    conn, db_type = get_db_connection()
    try:
        select_cols = 'folder_name, tmdb_query, media_type, override_year, override_language, include_adult, override_region'
        if db_type == 'postgres':
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(f'SELECT {select_cols} FROM tmdb_overrides ORDER BY folder_name')
            rows = [dict(r) for r in cur.fetchall()]
        else:
            conn.row_factory = sqlite3.Row
            rows = [dict(r) for r in conn.execute(f'SELECT {select_cols} FROM tmdb_overrides ORDER BY folder_name').fetchall()]
        return orjson_jsonify(rows)
    except Exception as e:
        return orjson_jsonify({'error': str(e)}, 500)
    finally:
        release_db_connection(conn, db_type)

@app.route('/api/tmdb-overrides', methods=['POST'])
@token_required(check_expiry=False)
def set_tmdb_override(current_user):
    """Set/update a TMDB query override. Admin only."""
    if current_user.get('role') != 'admin':
        return orjson_jsonify({'error': 'Admin access required'}, 403)
    
    data = request.get_json()
    if not data or 'folder_name' not in data or 'tmdb_query' not in data:
        return orjson_jsonify({'error': 'folder_name and tmdb_query required'}, 400)
    
    # JSON null → .get('k', default) still returns None if key present; never call .strip() on None
    folder_name = (data.get('folder_name') or '').strip()
    tmdb_query = (data.get('tmdb_query') or '').strip()
    media_type = str(data.get('media_type') or 'tv').strip() or 'tv'
    override_year = data.get('override_year')  # int or None
    override_language = (data.get('override_language') or '').strip() or None
    include_adult = bool(data.get('include_adult', False))
    override_region = (data.get('override_region') or '').strip() or None
    
    if not folder_name or not tmdb_query:
        return orjson_jsonify({'error': 'folder_name and tmdb_query cannot be empty'}, 400)
    
    conn, db_type = get_db_connection()
    try:
        ph = '%s' if db_type == 'postgres' else '?'
        cur = conn.cursor() if db_type == 'postgres' else conn
        
        if db_type == 'postgres':
            cur.execute(f"""
                INSERT INTO tmdb_overrides (folder_name, tmdb_query, media_type, override_year, override_language, include_adult, override_region, updated_by, updated_at)
                VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, NOW())
                ON CONFLICT (folder_name) DO UPDATE SET 
                    tmdb_query = EXCLUDED.tmdb_query, media_type = EXCLUDED.media_type,
                    override_year = EXCLUDED.override_year, override_language = EXCLUDED.override_language,
                    include_adult = EXCLUDED.include_adult, override_region = EXCLUDED.override_region,
                    updated_by = EXCLUDED.updated_by, updated_at = NOW()
            """, (folder_name, tmdb_query, media_type, override_year, override_language, include_adult, override_region, current_user['id']))
        else:
            cur.execute(f"""
                INSERT INTO tmdb_overrides (folder_name, tmdb_query, media_type, override_year, override_language, include_adult, override_region, updated_by)
                VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph})
                ON CONFLICT (folder_name) DO UPDATE SET 
                    tmdb_query = excluded.tmdb_query, media_type = excluded.media_type,
                    override_year = excluded.override_year, override_language = excluded.override_language,
                    include_adult = excluded.include_adult, override_region = excluded.override_region,
                    updated_by = excluded.updated_by
            """, (folder_name, tmdb_query, media_type, override_year, override_language, include_adult, override_region, current_user['id']))
        
        conn.commit()
        _invalidate_tmdb_override_cache()
        print(f"[TMDB-OVERRIDE] Admin {current_user['username']} set override: '{folder_name}' -> '{tmdb_query}' ({media_type}, year={override_year}, lang={override_language}, adult={include_adult}, region={override_region})", flush=True)
        return orjson_jsonify({'success': True, 'folder_name': folder_name, 'tmdb_query': tmdb_query})
    except Exception as e:
        return orjson_jsonify({'error': str(e)}, 500)
    finally:
        release_db_connection(conn, db_type)

@app.route('/api/tmdb-overrides/<path:folder_name>', methods=['DELETE'])
@token_required(check_expiry=False)
def delete_tmdb_override(current_user, folder_name):
    """Delete a TMDB query override. Admin only."""
    if current_user.get('role') != 'admin':
        return orjson_jsonify({'error': 'Admin access required'}, 403)
    
    conn, db_type = get_db_connection()
    try:
        ph = '%s' if db_type == 'postgres' else '?'
        cur = conn.cursor() if db_type == 'postgres' else conn
        cur.execute(f'DELETE FROM tmdb_overrides WHERE folder_name = {ph}', (folder_name,))
        conn.commit()
        _invalidate_tmdb_override_cache()
        print(f"[TMDB-OVERRIDE] Admin {current_user['username']} deleted override: '{folder_name}'", flush=True)
        return orjson_jsonify({'success': True})
    except Exception as e:
        return orjson_jsonify({'error': str(e)}, 500)
    finally:
        release_db_connection(conn, db_type)


def _invalidate_tmdb_override_cache():
    global _tmdb_overrides_cache, _tmdb_overrides_ts
    with _tmdb_overrides_lock:
        _tmdb_overrides_cache = None
        _tmdb_overrides_ts = 0
    _invalidate_response_cache('resp_folders', 'resp_folders_merged')

def _get_tmdb_overrides_map():
    global _tmdb_overrides_cache, _tmdb_overrides_ts
    now = time.time()
    with _tmdb_overrides_lock:
        if _tmdb_overrides_cache is not None and (now - _tmdb_overrides_ts) < 300:
            return _tmdb_overrides_cache

    conn, db_type = None, None
    try:
        conn, db_type = get_db_connection()
        select_cols = 'folder_name, tmdb_query, media_type, override_year, override_language, include_adult, override_region'
        if db_type == 'postgres':
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(f'SELECT {select_cols} FROM tmdb_overrides')
            rows = [dict(r) for r in cur.fetchall()]
        else:
            import sqlite3
            conn.row_factory = sqlite3.Row
            rows = [dict(r) for r in conn.execute(f'SELECT {select_cols} FROM tmdb_overrides').fetchall()]
        by_name = {r['folder_name']: r for r in rows}
        with _tmdb_overrides_lock:
            _tmdb_overrides_cache = by_name
            _tmdb_overrides_ts = now
        return by_name
    except Exception as e:
        print(f"[TMDB-OVERRIDE] load override cache failed: {e}", flush=True)
        with _tmdb_overrides_lock:
            return _tmdb_overrides_cache or {}
    finally:
        release_db_connection(conn, db_type)

def _merge_tmdb_overrides_into_folders(all_c):
    """
    Sisipkan metadata override TMDB dari DB ke setiap item (match key: item['name'] == folder_name).
    Mem-cache daftar folder tetap tanpa override; merge dilakukan pada setiap response GET /api/folders.
    """
    if not all_c:
        return all_c
    try:
        by_name = _get_tmdb_overrides_map()
        if not by_name:
            return all_c
        for cat in ('series', 'movies'):
            for item in all_c.get(cat) or []:
                name = item.get('name')
                if not name or name not in by_name:
                    continue
                o = by_name[name]
                item['tmdb_query'] = o['tmdb_query']
                item['tmdb_override_media_type'] = (o.get('media_type') or 'tv').strip()
                item['override_year'] = o.get('override_year')
                item['override_region'] = o.get('override_region')
                item['override_language'] = o.get('override_language')
                ia = o.get('include_adult')
                item['include_adult'] = bool(ia) if ia is not None else False
    except Exception as e:
        print(f"[TMDB-OVERRIDE] merge into folders failed: {e}", flush=True)
    return all_c

def _normalize_key(name):
    if not name:
        return ""
    import re
    cleaned = name.lower()
    cleaned = re.sub(r'\(?\d{4}\)?', ' ', cleaned) # remove year
    cleaned = re.sub(r'[^a-z0-9]', ' ', cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned

def _merge_content_release_tmdb_into_folders(all_c):
    """Attach lightweight TMDB metadata cached in content_releases to /api/folders."""
    if not all_c:
        return all_c
    try:
        releases = mem_get('content_releases')
        if releases is None:
            releases = _load_releases()
            mem_set('content_releases', releases)
        by_name = {}
        for r in releases:
            f_name = r.get('folder_name')
            if not f_name:
                continue
            f_name_lower = f_name.lower().strip()
            by_name[f_name_lower] = r
            norm_key = _normalize_key(f_name)
            if norm_key:
                by_name[norm_key] = r

        for cat in ('series', 'movies'):
            for item in all_c.get(cat) or []:
                name = item.get('name')
                if not name:
                    continue
                # Try raw exact match first
                rel = by_name.get(name.lower().strip())
                # Try normalized match next
                if not rel:
                    norm_name = _normalize_key(name)
                    rel = by_name.get(norm_name)
                
                if not rel:
                    continue
                if rel.get('tmdb_title'):
                    item['tmdb_title'] = rel['tmdb_title']
                if rel.get('media_type'):
                    mt = str(rel.get('media_type') or '').strip().lower()
                    if mt in ('tv', 'series'):
                        item['media_type'] = 'tv'
                        item['type'] = 'series'
                    elif mt == 'movie':
                        item['media_type'] = 'movie'
                        item['type'] = 'movie'
                if rel.get('tmdb_poster_path'):
                    item['tmdb_poster_path'] = rel['tmdb_poster_path']
                if rel.get('tmdb_overview'):
                    item['tmdb_overview'] = rel['tmdb_overview']
                if rel.get('tmdb_rating') is not None:
                    item['tmdb_rating'] = rel['tmdb_rating']
    except Exception as e:
        print(f"[CONTENT-RELEASES] merge TMDB metadata into folders failed: {e}", flush=True)
    return all_c


def _catalog_item_for_folder(folder_name, resolved_name=None):
    """Build the same lightweight catalog metadata used by /api/folders for one detail page."""
    names = [
        n for n in (folder_name, resolved_name)
        if n and not str(n).startswith(("gdrive/", "gdrive_folder/", "telegram/"))
    ]
    folders_data = mem_get('folders_list') or {}
    for item in (folders_data.get('series') or []) + (folders_data.get('movies') or []):
        item_name = item.get('name')
        item_source = item.get('source')
        if item_name in names or item_source == folder_name:
            catalog_item = copy.deepcopy(item)
            catalog_item['folder_name'] = item_name or resolved_name or folder_name
            payload = {'series': [catalog_item], 'movies': []}
            if catalog_item.get('type') == 'movie' or catalog_item.get('media_type') == 'movie':
                payload = {'series': [], 'movies': [catalog_item]}
            _merge_content_release_tmdb_into_folders(payload)
            _merge_tmdb_overrides_into_folders(payload)
            merged = (payload.get('series') or payload.get('movies') or [catalog_item])[0]
            merged['folder_name'] = merged.get('folder_name') or merged.get('name') or resolved_name or folder_name
            return merged

    name = resolved_name or (names[0] if names else folder_name)
    if not name:
        return None
    catalog_item = {'name': name, 'folder_name': name}
    is_movie = folder_name.startswith(("gdrive/", "gdrive_folder/", "telegram/"))
    payload = {'series': [], 'movies': [catalog_item]} if is_movie else {'series': [catalog_item], 'movies': []}
    _merge_content_release_tmdb_into_folders(payload)
    _merge_tmdb_overrides_into_folders(payload)
    merged = (payload.get('movies') or payload.get('series'))[0]
    if is_movie:
        merged['type'] = 'movie'
        merged['media_type'] = 'movie'
    return merged

# ==========================================
# INTRO MARKERS API (Skip Intro - Admin only write)
# ==========================================

def _load_markers_cache(marker_type):
    """Load all markers of given type from DB into RAM cache. Called once, then served from RAM."""
    global _intro_markers_cache, _outro_markers_cache
    conn, db_type = None, None
    try:
        conn, db_type = get_db_connection()
        if marker_type == 'intro':
            table, col = 'intro_markers', 'intro_end_seconds'
        else:
            table, col = 'outro_markers', 'outro_start_seconds'
        if db_type == 'postgres':
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(f'SELECT folder_name, {col} FROM {table}')
            rows = cur.fetchall()
        else:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f'SELECT folder_name, {col} FROM {table}').fetchall()
        cache = {r['folder_name']: r[col] for r in rows}
        with _markers_lock:
            if marker_type == 'intro':
                _intro_markers_cache = cache
            else:
                _outro_markers_cache = cache
        print(f"[MARKERS] Loaded {len(cache)} {marker_type} markers into RAM cache", flush=True)
    except Exception as e:
        print(f"[MARKERS] Error loading {marker_type} cache: {e}", flush=True)
    finally:
        release_db_connection(conn, db_type)

def _invalidate_markers_cache(marker_type):
    """Invalidate RAM cache for markers — forces reload on next request."""
    global _intro_markers_cache, _outro_markers_cache
    with _markers_lock:
        if marker_type == 'intro':
            _intro_markers_cache = None
        else:
            _outro_markers_cache = None

def _get_markers_cache(marker_type):
    """Get markers cache dict, loading from DB if needed."""
    with _markers_lock:
        cache = _intro_markers_cache if marker_type == 'intro' else _outro_markers_cache
    if cache is None:
        _load_markers_cache(marker_type)
        with _markers_lock:
            cache = _intro_markers_cache if marker_type == 'intro' else _outro_markers_cache
    return cache or {}

# ==========================================
# INTRO MARKERS API (with RAM caching)
# ==========================================

@app.route('/api/intro-markers', methods=['GET'])
@token_required(check_expiry=False)
@rate_limited()
def get_intro_markers(current_user):
    """Get all intro markers from RAM cache."""
    cache = _get_markers_cache('intro')
    rows = [{'folder_name': k, 'intro_end_seconds': v} for k, v in sorted(cache.items())]
    return orjson_jsonify(rows)

@app.route('/api/intro-markers/<path:folder_name>', methods=['GET'])
@token_required(check_expiry=False)
@rate_limited()
def get_intro_marker(current_user, folder_name):
    """Get intro marker for a specific folder from RAM cache."""
    cache = _get_markers_cache('intro')
    seconds = cache.get(folder_name, 0)
    if seconds:
        return orjson_jsonify({'folder_name': folder_name, 'intro_end_seconds': seconds})
    return orjson_jsonify({'intro_end_seconds': 0})

@app.route('/api/intro-markers', methods=['POST'])
@token_required(check_expiry=False)
def set_intro_marker(current_user):
    """Set/update an intro marker. Admin only."""
    if current_user.get('role') != 'admin':
        return orjson_jsonify({'error': 'Admin access required'}, 403)
    
    data = request.get_json()
    if not data or 'folder_name' not in data or 'intro_end_seconds' not in data:
        return orjson_jsonify({'error': 'folder_name and intro_end_seconds required'}, 400)
    
    folder_name = data['folder_name'].strip()
    intro_end_seconds = int(data['intro_end_seconds'])
    
    if not folder_name or intro_end_seconds <= 0:
        return orjson_jsonify({'error': 'folder_name cannot be empty and intro_end_seconds must be > 0'}, 400)
    
    conn, db_type = get_db_connection()
    try:
        ph = '%s' if db_type == 'postgres' else '?'
        cur = conn.cursor() if db_type == 'postgres' else conn
        
        if db_type == 'postgres':
            cur.execute(f"""
                INSERT INTO intro_markers (folder_name, intro_end_seconds, updated_by, updated_at)
                VALUES ({ph}, {ph}, {ph}, NOW())
                ON CONFLICT (folder_name) DO UPDATE SET 
                    intro_end_seconds = EXCLUDED.intro_end_seconds,
                    updated_by = EXCLUDED.updated_by, updated_at = NOW()
            """, (folder_name, intro_end_seconds, current_user['id']))
        else:
            cur.execute(f"""
                INSERT INTO intro_markers (folder_name, intro_end_seconds, updated_by)
                VALUES ({ph}, {ph}, {ph})
                ON CONFLICT (folder_name) DO UPDATE SET 
                    intro_end_seconds = excluded.intro_end_seconds,
                    updated_by = excluded.updated_by
            """, (folder_name, intro_end_seconds, current_user['id']))
        
        conn.commit()
        _invalidate_markers_cache('intro')  # Bust RAM cache
        print(f"[INTRO-MARKER] Admin {current_user['username']} set intro marker: '{folder_name}' -> {intro_end_seconds}s", flush=True)
        return orjson_jsonify({'success': True, 'folder_name': folder_name, 'intro_end_seconds': intro_end_seconds})
    except Exception as e:
        return orjson_jsonify({'error': str(e)}, 500)
    finally:
        release_db_connection(conn, db_type)

@app.route('/api/intro-markers/<path:folder_name>', methods=['DELETE'])
@token_required(check_expiry=False)
def delete_intro_marker(current_user, folder_name):
    """Delete an intro marker. Admin only."""
    if current_user.get('role') != 'admin':
        return orjson_jsonify({'error': 'Admin access required'}, 403)
    
    conn, db_type = get_db_connection()
    try:
        ph = '%s' if db_type == 'postgres' else '?'
        cur = conn.cursor() if db_type == 'postgres' else conn
        cur.execute(f'DELETE FROM intro_markers WHERE folder_name = {ph}', (folder_name,))
        conn.commit()
        _invalidate_markers_cache('intro')  # Bust RAM cache
        print(f"[INTRO-MARKER] Admin {current_user['username']} deleted intro marker: '{folder_name}'", flush=True)
        return orjson_jsonify({'success': True})
    except Exception as e:
        return orjson_jsonify({'error': str(e)}, 500)
    finally:
        release_db_connection(conn, db_type)

# ==========================================
# OUTRO MARKERS API (configurable episode completion point)
# ==========================================

@app.route('/api/outro-markers', methods=['GET'])
@token_required(check_expiry=False)
@rate_limited()
def get_outro_markers(current_user):
    """Get all outro markers from RAM cache."""
    cache = _get_markers_cache('outro')
    rows = [{'folder_name': k, 'outro_start_seconds': v} for k, v in sorted(cache.items())]
    return orjson_jsonify(rows)

@app.route('/api/outro-markers/<path:folder_name>', methods=['GET'])
@token_required(check_expiry=False)
@rate_limited()
def get_outro_marker(current_user, folder_name):
    """Get outro marker for a specific folder from RAM cache.
    outro_start_seconds = seconds from END of video where credits/outro starts."""
    cache = _get_markers_cache('outro')
    seconds = cache.get(folder_name, 0)
    if seconds:
        return orjson_jsonify({'folder_name': folder_name, 'outro_start_seconds': seconds})
    return orjson_jsonify({'outro_start_seconds': 0})

@app.route('/api/outro-markers', methods=['POST'])
@token_required(check_expiry=False)
def set_outro_marker(current_user):
    """Set/update an outro marker. Admin only.
    outro_start_seconds = seconds from END of video where credits start."""
    if current_user.get('role') != 'admin':
        return orjson_jsonify({'error': 'Admin access required'}, 403)
    
    data = request.get_json()
    if not data or 'folder_name' not in data or 'outro_start_seconds' not in data:
        return orjson_jsonify({'error': 'folder_name and outro_start_seconds required'}, 400)
    
    folder_name = data['folder_name'].strip()
    outro_start_seconds = int(data['outro_start_seconds'])
    
    if not folder_name or outro_start_seconds <= 0:
        return orjson_jsonify({'error': 'folder_name cannot be empty and outro_start_seconds must be > 0'}, 400)
    
    conn, db_type = get_db_connection()
    try:
        ph = '%s' if db_type == 'postgres' else '?'
        cur = conn.cursor() if db_type == 'postgres' else conn
        
        if db_type == 'postgres':
            cur.execute(f"""
                INSERT INTO outro_markers (folder_name, outro_start_seconds, updated_by, updated_at)
                VALUES ({ph}, {ph}, {ph}, NOW())
                ON CONFLICT (folder_name) DO UPDATE SET 
                    outro_start_seconds = EXCLUDED.outro_start_seconds,
                    updated_by = EXCLUDED.updated_by, updated_at = NOW()
            """, (folder_name, outro_start_seconds, current_user['id']))
        else:
            cur.execute(f"""
                INSERT INTO outro_markers (folder_name, outro_start_seconds, updated_by)
                VALUES ({ph}, {ph}, {ph})
                ON CONFLICT (folder_name) DO UPDATE SET 
                    outro_start_seconds = excluded.outro_start_seconds,
                    updated_by = excluded.updated_by
            """, (folder_name, outro_start_seconds, current_user['id']))
        
        conn.commit()
        _invalidate_markers_cache('outro')  # Bust RAM cache
        print(f"[OUTRO-MARKER] Admin {current_user['username']} set outro marker: '{folder_name}' -> {outro_start_seconds}s from end", flush=True)
        return orjson_jsonify({'success': True, 'folder_name': folder_name, 'outro_start_seconds': outro_start_seconds})
    except Exception as e:
        return orjson_jsonify({'error': str(e)}, 500)
    finally:
        release_db_connection(conn, db_type)

@app.route('/api/outro-markers/<path:folder_name>', methods=['DELETE'])
@token_required(check_expiry=False)
def delete_outro_marker(current_user, folder_name):
    """Delete an outro marker. Admin only."""
    if current_user.get('role') != 'admin':
        return orjson_jsonify({'error': 'Admin access required'}, 403)
    
    conn, db_type = get_db_connection()
    try:
        ph = '%s' if db_type == 'postgres' else '?'
        cur = conn.cursor() if db_type == 'postgres' else conn
        cur.execute(f'DELETE FROM outro_markers WHERE folder_name = {ph}', (folder_name,))
        conn.commit()
        _invalidate_markers_cache('outro')  # Bust RAM cache
        print(f"[OUTRO-MARKER] Admin {current_user['username']} deleted outro marker: '{folder_name}'", flush=True)
        return orjson_jsonify({'success': True})
    except Exception as e:
        return orjson_jsonify({'error': str(e)}, 500)
    finally:
        release_db_connection(conn, db_type)

@app.route('/api/auth/redeem', methods=['POST'])
@token_required(check_expiry=False)
def redeem_token(current_user):
    data = request.get_json()
    token_code = data.get('token')
    conn, db_type = get_db_connection()
    try:
        if db_type == 'postgres': cur = conn.cursor(cursor_factory=RealDictCursor)
        else: conn.row_factory = sqlite3.Row; cur = conn.cursor()
        
        ph = '%s' if db_type == 'postgres' else '?'
        
        if db_type == 'postgres': cur.execute("SELECT * FROM registration_tokens WHERE code = %s AND is_used = FALSE", (token_code,))
        else: cur.execute("SELECT * FROM registration_tokens WHERE code = ? AND is_used = 0", (token_code,))
        
        token_data = cur.fetchone()
        if not token_data: return jsonify({"message": "Token Invalid/Used"}), 400
        token_data = dict(token_data)
        
        # VALIDASI DURASI SESUAI PLAN
        required_days = data.get('required_days')
        if required_days:
            try:
                required_days = int(required_days)
                actual_days = int(token_data['duration_days'])
                
                # Toleransi sedikit mungkin tidak perlu, strict saja dulu
                if actual_days != required_days:
                     # Khusus logic 1 Year (365) vs 366 (leap) - kita anggap sama 365 utk simplifikasi UI
                     # Atau strictly match. User minta "token 30 hari tidak bisa ke 1 year".
                     return jsonify({
                         "message": "Token Mismatch",
                         "detail": f"This token is for {actual_days} days, but you selected the {required_days} days plan."
                     }), 400
            except ValueError:
                pass # Ignore if invalid format

        
        duration = token_data['duration_days']
        current_expiry = current_user.get('subscription_expires_at')
        now = datetime.datetime.now()
        
        # Logic tambah durasi
        if duration > 10000:
            new_expiry = now + datetime.timedelta(days=36500)
            new_role = 'admin'
        else:
            new_role = current_user.get('role', 'user')
            # Jika user belum punya expiry atau sudah expired, start dari NOW
            # Jika masih aktif, tambah dari expiry lama
            if not current_expiry: 
                new_expiry = now + datetime.timedelta(days=duration)
            else:
                if isinstance(current_expiry, str): current_expiry = datetime.datetime.fromisoformat(current_expiry)
                
                if current_expiry < now: new_expiry = now + datetime.timedelta(days=duration)
                else: new_expiry = current_expiry + datetime.timedelta(days=duration)
        
        is_used_val = "TRUE" if db_type == 'postgres' else "1"
        cur.execute(f"UPDATE users SET subscription_expires_at = {ph}, role = {ph} WHERE id = {ph}", 
                   (new_expiry, new_role, current_user['id']))
        cur.execute(f"UPDATE registration_tokens SET is_used = {is_used_val} WHERE id = {ph}", (token_data['id'],))
        
        conn.commit()
        
        # [FIX-v3] No more user cache — JWT-only auth.
        # User must re-login to get a new JWT with updated subscription.
        
        return jsonify({"message": "Success", "new_expiry": new_expiry.strftime('%Y-%m-%d %H:%M:%S')}), 200
    except Exception as e:
        if conn: conn.rollback()
        return jsonify({"message": "Error", "error": str(e)}), 500
    finally: release_db_connection(conn, db_type)

# ==========================================
# PROFILE, HISTORY & LIST ROUTES
# ==========================================
# (Menggunakan logic dari file asli yang lebih readable)

@app.route('/api/profiles', methods=['GET'])
@token_required(check_expiry=False)
def get_profiles(current_user):
    uid = current_user['id']
    # [FIX] Cross-worker validation sebelum serve dari RAM cache
    cached = _user_profiles_cache.get(uid)
    if cached is not None and _is_user_cache_valid('profiles', uid):
        return orjson_jsonify(cached)
    
    conn, db_type = get_db_connection()
    try:
        if db_type == 'postgres':
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute('SELECT id, name, avatar_seed FROM profiles WHERE user_id = %s', (uid,))
            res = [dict(row) for row in cur.fetchall()]
        else: res = [dict(r) for r in conn.execute('SELECT id, name, avatar_seed FROM profiles WHERE user_id = ?', (uid,)).fetchall()]
        
        now = time.time()
        with _user_data_lock:
            _user_profiles_cache[uid] = res
            _user_profiles_cache_ts[uid] = now
        return add_no_cache_headers(orjson_jsonify(res))
    finally: release_db_connection(conn, db_type)

@app.route('/api/profiles/add', methods=['POST'])
@token_required(check_expiry=True)
def add_profile(current_user):
    data = request.get_json()
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        cur.execute(f'INSERT INTO profiles (id, user_id, name, avatar_seed) VALUES ({ph}, {ph}, {ph}, {ph})',
                   (data['id'], current_user['id'], data['name'], data['avatar_seed']))
        conn.commit()
        _invalidate_user_cache('profiles', current_user['id'])  # Cross-worker invalidate
        return orjson_jsonify({"message": "Profile added"}, 201)
    except: return orjson_jsonify({"message": "Error/Full"}, 400)
    finally: release_db_connection(conn, db_type)

@app.route('/api/profiles/edit', methods=['PUT'])
@token_required(check_expiry=True)
def edit_profile(current_user):
    data = request.get_json()
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        cur.execute(f'UPDATE profiles SET name = {ph}, avatar_seed = {ph} WHERE id = {ph} AND user_id = {ph}',
                   (data['name'], data['avatar_seed'], data['id'], current_user['id']))
        conn.commit()
        _invalidate_user_cache('profiles', current_user['id'])  # Cross-worker invalidate
        return orjson_jsonify({"message": "Profile updated"})
    except: return orjson_jsonify({"message": "Error"}, 400)
    finally: release_db_connection(conn, db_type)

@app.route('/api/profiles/delete', methods=['POST'])
@token_required(check_expiry=True)
def delete_profile(current_user):
    data = request.get_json()
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        cur.execute(f'DELETE FROM profiles WHERE id = {ph} AND user_id = {ph}', (data['id'], current_user['id']))
        conn.commit()
        _invalidate_user_cache('profiles', current_user['id'])  # Cross-worker invalidate
        return orjson_jsonify({"message": "Deleted"})
    finally: release_db_connection(conn, db_type)

@app.route('/api/history/get/<profile_id>', methods=['GET'])
@token_required(check_expiry=True)
def get_history(current_user, profile_id):
    active_only = request.args.get('active_only', 'false').lower() == 'true'
    include_hidden = request.args.get('include_hidden', 'false').lower() == 'true'
    try:
        limit = int(request.args.get('limit', '0') or 0)
    except (TypeError, ValueError):
        limit = 0
    limit = max(0, min(limit, 100))
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    where = f'user_id = {ph} AND profile_id = {ph}'
    params = [current_user['id'], profile_id]
    if not include_hidden:
        where += ' AND (is_hidden = 0 OR is_hidden IS NULL)'
    if active_only:
        where += f' AND (duration_ms <= 0 OR position_ms < (duration_ms * {ph}))'
        params.append(WATCH_HISTORY_ACTIVE_CUTOFF)
    sql = f'''SELECT media_path, media_title, series_title, source, still_path, subtitle_path, season, episode, position_ms, duration_ms, is_hidden, last_watched
              FROM watch_history WHERE {where} ORDER BY last_watched DESC'''
    if limit:
        sql += f' LIMIT {ph}'
        params.append(limit)
    try:
        if db_type == 'postgres':
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(sql, tuple(params))
            res = [dict(r) for r in cur.fetchall()]
        else: res = [dict(r) for r in conn.execute(sql, tuple(params)).fetchall()]
        
        return add_no_cache_headers(orjson_jsonify(res))
    finally: release_db_connection(conn, db_type)

@app.route('/api/history/save', methods=['POST'])
@token_required(check_expiry=True)
def save_history(current_user):
    data = request.get_json()
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        lookup_params = (current_user['id'], data['profile_id'], data['media_path'])
        cur.execute(
            f"SELECT is_hidden FROM watch_history WHERE user_id={ph} AND profile_id={ph} AND media_path={ph}",
            lookup_params,
        )
        existing = cur.fetchone()
        if existing is not None:
            sql_update = f'''
                UPDATE watch_history
                SET media_title={ph}, series_title={ph}, source={ph}, still_path={ph}, subtitle_path={ph},
                    season={ph}, episode={ph}, position_ms={ph}, duration_ms={ph}, is_hidden=0, last_watched=CURRENT_TIMESTAMP
                WHERE user_id={ph} AND profile_id={ph} AND media_path={ph}
            '''
            params = (
                data.get('media_title'), data.get('series_title'), data.get('source'),
                data.get('still_path'), data.get('subtitle_path'), data.get('season'),
                data.get('episode'), data['position_ms'], data['duration_ms'],
                current_user['id'], data['profile_id'], data['media_path'],
            )
            cur.execute(sql_update, params)
        else:
            sql_insert = f'''
                INSERT INTO watch_history (user_id, profile_id, media_path, media_title, series_title, source, still_path, subtitle_path, season, episode, position_ms, duration_ms, is_hidden, last_watched)
                VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, 0, CURRENT_TIMESTAMP)
            '''
            params = (current_user['id'], data['profile_id'], data['media_path'], data.get('media_title'), data.get('series_title'), data.get('source'), data.get('still_path'), data.get('subtitle_path'), data.get('season'), data.get('episode'), data['position_ms'], data['duration_ms'])
            cur.execute(sql_insert, params)
        conn.commit()
        return orjson_jsonify({"message": "Saved"})
    except: return orjson_jsonify({"message": "Error saving"}, 500)
    finally: release_db_connection(conn, db_type)

@app.route('/api/history/hide', methods=['POST'])
@token_required(check_expiry=True)
def hide_history(current_user):
    data = request.get_json()
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        query = f"""
            UPDATE watch_history
            SET is_hidden = 1
            WHERE user_id={ph} AND profile_id={ph} AND media_path={ph}
        """
        cur.execute(
            query,
            (
                current_user['id'], data['profile_id'], data['media_path'],
            ),
        )
        conn.commit()
        return orjson_jsonify({"message": "Hidden"})
    except Exception as e:
        return orjson_jsonify({"message": "Error hiding", "error": str(e)}, 500)
    finally: release_db_connection(conn, db_type)
    
@app.route('/api/history/delete', methods=['POST'])
@token_required(check_expiry=True)
def delete_history(current_user):
    data = request.get_json()
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        query = f"""
            DELETE FROM watch_history
            WHERE user_id={ph} AND profile_id={ph} AND media_path={ph}
        """
        cur.execute(
            query,
            (
                current_user['id'], data['profile_id'], data['media_path'],
            ),
        )
        conn.commit()
        return orjson_jsonify({"message": "Deleted"})
    except Exception as e:
        return orjson_jsonify({"message": "Error deleting", "error": str(e)}, 500)
    finally: release_db_connection(conn, db_type)


@app.route('/api/mylist', methods=['GET'])
@token_required(check_expiry=True)
def get_mylist(current_user):
    profile_id = request.args.get('profile_id')
    cache_key = f"{current_user['id']}_{profile_id}"
    # [FIX] Cross-worker validation sebelum serve dari RAM cache
    cached = _user_mylist_cache.get(cache_key)
    if cached is not None and _is_user_cache_valid('mylist', cache_key):
        return orjson_jsonify(cached)
    
    conn, db_type = get_db_connection()
    try:
        ph = '%s' if db_type == 'postgres' else '?'
        sql = f"SELECT folder_name, media_type, meta_json, COALESCE(status, 'plan_to_watch') as status FROM my_list WHERE user_id = {ph} AND profile_id = {ph} ORDER BY added_at DESC"
        if db_type == 'postgres':
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(sql, (current_user['id'], profile_id))
            res = [dict(r) for r in cur.fetchall()]
        else: res = [dict(r) for r in conn.execute(sql, (current_user['id'], profile_id)).fetchall()]
        for item in res:
             if item.get('meta_json'):
                 try: item['meta_json'] = json.loads(item['meta_json'])
                 except: pass
        
        now = time.time()
        with _user_data_lock:
            _user_mylist_cache[cache_key] = res
            _user_mylist_cache_ts[cache_key] = now
        return orjson_jsonify(res)
    finally: release_db_connection(conn, db_type)

@app.route('/api/mylist/add', methods=['POST'])
@token_required(check_expiry=True)
def add_to_mylist(current_user):
    data = request.get_json()
    meta_json_str = json.dumps(data.get('meta', {}))
    status = data.get('status', 'plan_to_watch')
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        try: cur.execute(f"INSERT INTO my_list (user_id, profile_id, folder_name, media_type, meta_json, status) VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph})", (current_user['id'], data['profile_id'], data['folder_name'], data.get('media_type', 'movie'), meta_json_str, status))
        except:
             conn.rollback()
             cur.execute(f"UPDATE my_list SET meta_json = {ph}, status = {ph}, added_at = CURRENT_TIMESTAMP WHERE user_id={ph} AND profile_id={ph} AND folder_name={ph}", (meta_json_str, status, current_user['id'], data['profile_id'], data['folder_name']))
        conn.commit()
        # Cross-worker invalidate mylist cache
        cache_key = f"{current_user['id']}_{data['profile_id']}"
        _invalidate_user_cache('mylist', cache_key)
        return orjson_jsonify({"message": "Added"}, 201)
    except: return orjson_jsonify({"message": "Error"}, 500)
    finally: release_db_connection(conn, db_type)

@app.route('/api/mylist/remove', methods=['POST'])
@token_required(check_expiry=True)
def remove_from_mylist(current_user):
    data = request.get_json()
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        cur.execute(f"DELETE FROM my_list WHERE user_id={ph} AND profile_id={ph} AND folder_name={ph}", (current_user['id'], data['profile_id'], data['folder_name']))
        conn.commit()
        # Cross-worker invalidate mylist cache
        cache_key = f"{current_user['id']}_{data['profile_id']}"
        _invalidate_user_cache('mylist', cache_key)
        return orjson_jsonify({"message": "Removed"})
    finally: release_db_connection(conn, db_type)

@app.route('/api/mylist/update-status', methods=['PUT'])
@token_required(check_expiry=True)
def update_mylist_status(current_user):
    data = request.get_json()
    folder_name = data.get('folder_name')
    new_status = data.get('status', 'plan_to_watch')  # 'plan_to_watch' or 'completed'
    profile_id = data.get('profile_id')
    if not folder_name or not profile_id:
        return orjson_jsonify({"message": "Missing folder_name or profile_id"}, 400)
    if new_status not in ('plan_to_watch', 'completed'):
        return orjson_jsonify({"message": "Invalid status"}, 400)
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        cur.execute(f"UPDATE my_list SET status = {ph} WHERE user_id = {ph} AND profile_id = {ph} AND folder_name = {ph}",
                    (new_status, current_user['id'], profile_id, folder_name))
        if cur.rowcount == 0:
            conn.rollback()
            return orjson_jsonify({"message": "Item not found"}, 404)
        conn.commit()
        cache_key = f"{current_user['id']}_{profile_id}"
        _invalidate_user_cache('mylist', cache_key)
        return orjson_jsonify({"message": "Updated"})
    except Exception as e:
        return orjson_jsonify({"message": f"Error: {e}"}, 500)
    finally:
        release_db_connection(conn, db_type)

# ==========================================
# GDRIVE LOGIC & CACHING (DARI FILE ASLI)
# ==========================================

def get_gdrive_service():
    if hasattr(_gdrive_local, 'service') and _gdrive_local.service and hasattr(_gdrive_local.service, '_http') and _gdrive_local.service._http.credentials.valid: return _gdrive_local.service
    creds = None
    if GDRIVE_TOKEN_B64:
        try: creds = pickle.loads(base64.b64decode(GDRIVE_TOKEN_B64))
        except: pass
    if not creds and os.path.exists('token.pickle'):
        try:
            with open('token.pickle', 'rb') as t: creds = pickle.load(t)
        except: pass
    if not creds: return None
    if creds.expired and creds.refresh_token: creds.refresh(Request())
    try:
        svc = build('drive', 'v3', credentials=creds, cache_discovery=False)
        _gdrive_local.service = svc
        return svc
    except: return None

_gdrive_sub_local = threading.local()

def get_gdrive_subtitle_service():
    """Separate GDrive service for the subtitle-dedicated account."""
    if hasattr(_gdrive_sub_local, 'service') and _gdrive_sub_local.service and hasattr(_gdrive_sub_local.service, '_http') and _gdrive_sub_local.service._http.credentials.valid:
        return _gdrive_sub_local.service
    creds = None
    if GDRIVE_SUBTITLE_TOKEN_B64:
        try: creds = pickle.loads(base64.b64decode(GDRIVE_SUBTITLE_TOKEN_B64))
        except: pass
    if not creds: return None
    if creds.expired and creds.refresh_token: creds.refresh(Request())
    try:
        svc = build('drive', 'v3', credentials=creds, cache_discovery=False)
        _gdrive_sub_local.service = svc
        return svc
    except: return None

# === CACHE HELPERS (diskcache-based, HuggingFace Optimized) ===

def is_cache_fresh(key, duration):
    """Cek apakah cache masih fresh berdasarkan tag timestamp."""
    ts = disk_cache.get(f"{key}__ts")
    if ts is not None:
        return (time.time() - ts) < duration
    return False

def load_cache(key, duration):
    """Load dari diskcache jika masih dalam durasi."""
    if is_cache_fresh(key, duration):
        return disk_cache.get(key)
    return None

def load_stale_cache(key):
    """Load data dari cache tanpa peduli freshness (fallback)."""
    return disk_cache.get(key)

def save_cache(key, data):
    """Simpan ke diskcache dengan timestamp."""
    try:
        disk_cache.set(key, data)
        disk_cache.set(f"{key}__ts", time.time())
    except: pass

def acquire_lock(key, timeout_seconds=120):
    """Atomic lock menggunakan diskcache (process-safe)."""
    lock_key = f"__lock__{key}"
    # Gunakan add() yang atomic — return True jika key belum ada
    added = disk_cache.add(lock_key, os.getpid(), expire=timeout_seconds)
    return added

def release_lock(key):
    """Release lock."""
    lock_key = f"__lock__{key}"
    try: disk_cache.delete(lock_key)
    except: pass

# === IN-MEMORY CACHE HELPERS (sub-millisecond) ===

def mem_get(key):
    """Get dari RAM (~0.01ms). Fallback ke diskcache (~1-5ms) lalu load ke RAM."""
    val = _mem_cache.get(key)
    if val is not None:
        if _should_sync_data_cache(key):
            try:
                disk_ts = disk_cache.get(f"{key}__ts")
                mem_ts = _mem_cache_ts.get(key, 0)
                if disk_ts and disk_ts > (mem_ts + 0.001):
                    disk_val = disk_cache.get(key)
                    if disk_val is not None:
                        with _mem_lock:
                            _mem_cache[key] = disk_val
                            _mem_cache_ts[key] = disk_ts
                        _invalidate_response_cache(*_response_keys_for_data_cache(key))
                        return disk_val
            except Exception:
                pass
        return val
    # Fallback: load dari disk ke RAM
    val = disk_cache.get(key)
    if val is not None:
        with _mem_lock:
            _mem_cache[key] = val
            ts = disk_cache.get(f"{key}__ts")
            if ts: _mem_cache_ts[key] = ts
    return val

def mem_set(key, data):
    """Write ke RAM + disk sekaligus."""
    now = time.time()
    with _mem_lock:
        _mem_cache[key] = data
        _mem_cache_ts[key] = now
    save_cache(key, data)  # persist ke diskcache juga

def mem_is_fresh(key, duration):
    """Cek freshness dari memory timestamps (tanpa disk I/O)."""
    ts = _mem_cache_ts.get(key)
    if ts is not None:
        return (time.time() - ts) < duration
    # Fallback ke disk timestamp
    return is_cache_fresh(key, duration)

def warmup_cache():
    """Load SEMUA data dari diskcache ke RAM saat startup.
    JUGA build search index dan warm subtitle cache.
    Dipanggil oleh setiap Gunicorn worker agar langsung hot."""
    count = 0
    try:
        for key in disk_cache:
            if isinstance(key, str) and key.endswith('__ts'):
                continue
            if isinstance(key, str) and key.startswith('__lock__'):
                continue
            val = disk_cache.get(key)
            if val is not None:
                _mem_cache[key] = val
                ts = disk_cache.get(f"{key}__ts")
                if ts: _mem_cache_ts[key] = ts
                count += 1
    except Exception as e:
        print(f"[WARMUP] Error: {e}", flush=True)
    
    # Build search index dari cached folders data
    build_search_index()
    
    # [FIX] Pre-load intro & outro markers ke RAM agar first request tidak perlu tunggu DB cold start
    try:
        _load_markers_cache('intro')
        _load_markers_cache('outro')
    except Exception as e:
        print(f"[WARMUP] Error loading markers cache: {e}", flush=True)

    # [FIX] Removed warmup_subtitle_cache() — subtitles are cached on-demand via /subtitle/ endpoint.
    # Downloading ALL subtitles at startup was burning Supabase egress unnecessarily.

def warmup_subtitle_cache():
    """Pre-load semua subtitle files ke RAM dari cached video data.
    Runs in background threads — won't block startup."""
    folders = _mem_cache.get('folders_list')
    if not folders:
        return
    
    all_subtitle_paths = set()
    # Scan semua cached video data untuk subtitle paths
    for key, val in list(_mem_cache.items()):
        if key.startswith('videos_') and isinstance(val, dict):
            for vid in val.get('videos', []):
                sp = vid.get('subtitle_path')
                if sp and sp not in _subtitle_cache:
                    all_subtitle_paths.add(sp)
    
    if not all_subtitle_paths:
        return
    
    def _fetch_and_cache_subtitle(path):
        """Fetch subtitle and store in RAM cache."""
        try:
            content = _download_subtitle(path)
            if content:
                with _subtitle_lock:
                    _subtitle_cache[path] = content
                    _subtitle_cache_ts[path] = time.time()
                return True
        except:
            pass
        return False
    
    # Use global executor for parallel fetch
    futures = []
    for path in all_subtitle_paths:
        futures.append(_global_executor.submit(_fetch_and_cache_subtitle, path))
    
    for f in as_completed(futures): f.result()

def _download_subtitle(file_path):
    """Internal: download subtitle from GDrive or Supabase. Returns bytes or None."""
    try:
        if file_path.startswith("gdrive_sub/"):
            fid = file_path.split('/', 1)[1]
            svc = get_gdrive_subtitle_service()
            if not svc: return None
            return svc.files().get_media(fileId=fid).execute()
        elif file_path.startswith("gdrive/"):
            fid = file_path.split('/', 1)[1]
            svc = get_gdrive_service()
            if not svc: return None
            return svc.files().get_media(fileId=fid).execute()
        elif file_path.startswith("supabase/"):
            if not supabase: return None
            storage_path = file_path.split('/', 1)[1]
            try:
                return supabase.storage.from_('subtitles').download(storage_path)
            except:
                # Case-insensitive fallback
                parts = storage_path.split('/', 1)
                if len(parts) == 2:
                    folder_name, file_name = parts
                    folders = supabase.storage.from_('subtitles').list()
                    for item in folders:
                        if item['name'].lower() == folder_name.lower():
                            return supabase.storage.from_('subtitles').download(f"{item['name']}/{file_name}")
    except:
        pass
    return None

def _normalize_text(text):
    """Normalize text for search index: lowercase, remove accents, split words.
    [FIX] Now supports CJK characters and other Unicode scripts."""
    text = text.lower().strip()
    # Remove accents
    text = unicodedata.normalize('NFD', text)
    text = ''.join(c for c in text if unicodedata.category(c) != 'Mn')
    # Split on non-word chars — \W+ keeps CJK, accented chars, etc.
    words = re.split(r'[\W_]+', text, flags=re.UNICODE)
    # Allow single-char tokens (important for CJK where each char is a word)
    return [w for w in words if w]

def _normalize_search_string(text):
    return ' '.join(_normalize_text(text or ''))

def build_search_index():
    """Build inverted search index from folders data in RAM or Disk Cache.
    Called during warmup and after each BG worker refresh."""
    global _search_index_built
    folders = mem_get('folders_list')
    if not folders: return
    
    # Pre-build TMDB lookup from content_releases cache for enrichment
    releases = mem_get('content_releases') or []
    tmdb_by_folder = {}
    for rel in releases:
        fn = rel.get('folder_name')
        if fn:
            tmdb_by_folder[fn.lower()] = rel
    
    new_index = defaultdict(list)
    seen = set()  # Avoid duplicates
    
    for media_type in ['series', 'movies']:
        for item in folders.get(media_type, []):
            name = item.get('name', '')
            if name in seen: continue
            seen.add(name)
            
            entry = {
                'name': name,
                'folder_name': name,
                'type': item.get('type', media_type.rstrip('s')),
                'source': item.get('source', '')
            }
            # Enrich with TMDB data from content releases if available
            rel = tmdb_by_folder.get(name.lower())
            if rel:
                if rel.get('tmdb_title'): entry['tmdb_title'] = rel['tmdb_title']
                if rel.get('tmdb_poster_path'): entry['tmdb_poster_path'] = rel['tmdb_poster_path']
                if rel.get('tmdb_rating'): entry['tmdb_rating'] = rel['tmdb_rating']
                if rel.get('tmdb_overview'): entry['tmdb_overview'] = rel['tmdb_overview']
            
            # Index folder name plus visible TMDB title, so search follows what users see.
            searchable_text = name
            if entry.get('tmdb_title'):
                searchable_text = f"{searchable_text} {entry['tmdb_title']}"

            words = _normalize_text(searchable_text)
            indexed_words = set()
            for word in words:
                if word in indexed_words:
                    continue
                indexed_words.add(word)
                new_index[word].append(entry)
                # Also index prefixes (untuk autocomplete)
                for i in range(2, len(word)):
                    new_index[word[:i]].append(entry)
    
    with _search_lock:
        _search_index.clear()
        _search_index.update(new_index)
        _search_index_built = True
    


# === ORJSON RESPONSE HELPER (with pre-serialized cache) ===
def orjson_jsonify(data, status=200, cache_key=None):
    """5-10x lebih cepat dari Flask jsonify.
    Jika cache_key diberikan, simpan dan serve pre-serialized bytes."""
    if cache_key:
        # Check pre-serialized cache
        cached_bytes = _response_cache.get(cache_key)
        if cached_bytes:
            return app.response_class(cached_bytes, mimetype='application/json', status=status)
    
    serialized = orjson.dumps(data)
    
    if cache_key:
        with _response_lock:
            _response_cache[cache_key] = serialized
            _response_cache_ts[cache_key] = time.time()
            # Evict if too large (>5000 entries)
            if len(_response_cache) > 5000:
                oldest = sorted(_response_cache_ts.items(), key=lambda x: x[1])[:2500]
                for k, _ in oldest:
                    _response_cache.pop(k, None)
                    _response_cache_ts.pop(k, None)
    
    return app.response_class(serialized, mimetype='application/json', status=status)

def get_season_episode_from_string(filename):
    file_lower = filename.lower()
    # Pattern 1: S01E01 or 01x01
    match = re.search(r'[sS](\d+)[eE](\d+)|(\d+)[xX](\d+)', file_lower)
    if match:
        groups = match.groups()
        s = int(groups[0] or groups[2])
        e = int(groups[1] or groups[3])
        return s, e
    # Pattern 2: "Episode 01", "Ep01", "Ep 1", "EP01", "E01" (standalone E prefix)
    episode_match = re.search(r'episode[\s._-]*(\d+)|ep[\s._-]*(\d+)|(?:^|[\s._\[-])e(\d{1,4})(?:[\s._\]\)-]|$)', file_lower)
    if episode_match:
        e = int(episode_match.group(1) or episode_match.group(2) or episode_match.group(3))
        season_match = re.search(r'season[\s._-]*(\d+)', file_lower)
        s = int(season_match.group(1)) if season_match else 1
        return s, e
    # Pattern 3: "#01" or "- 01" common in anime/series
    hash_match = re.search(r'#(\d{1,4})', file_lower)
    if hash_match:
        return 1, int(hash_match.group(1))
    dash_match = re.search(r'[\s]-[\s](\d{1,4})(?:[\sv.\s]|$)', file_lower)
    if dash_match:
        return 1, int(dash_match.group(1))
    # Pattern 4: Standalone number at end or beginning of filename
    base_name = os.path.splitext(filename)[0]
    standalone_match = re.search(r'[\s._\[\(-](\d{1,4})[\]\)\s._-]?$', base_name)
    if not standalone_match: standalone_match = re.search(r'^(\d{1,4})[\s._-]', base_name)
    if standalone_match:
        try: return 1, int(standalone_match.group(1))
        except ValueError: pass
    return None, None

# === SUBTITLE FUZZY MATCHING ===
_QUALITY_TAGS = re.compile(
    r'[\s._-](?:'
    r'\d{3,4}p|'           # 720p, 1080p, 2160p
    r'WEB[\s._-]?DL|WEBRip|BluRay|BDRip|BRRip|HDRip|DVDRip|HDTV|'  # source
    r'AAC[\s._-]?\d+\.\d+|AAC|AC3|DTS|FLAC|MP3|'  # audio
    r'x264|x265|H[\s._-]?264|H[\s._-]?265|HEVC|AVC|'  # codec
    r'10bit|HDR|SDR|Atmos|DDP?\d*|'  # quality tags
    r'PROPER|REPACK|INTERNAL|EXTENDED|UNRATED|DIRECTORS[\s._-]?CUT|'  # release tags
    r'\d+MB|\d+GB|'  # size tags
    r'AMZN|NF|DSNP|ATVP|HMAX|PCOK|MA|PMTP|iT'  # streaming service tags
    r').*$',
    re.IGNORECASE
)

def _clean_title_for_matching(filename):
    """Strip quality/codec/source tags from filename to extract clean title.
    e.g. 'No.Other.Choice.2025.1080p.WEB-DL.AAC2.0.x264' -> 'no other choice 2025'
    """
    base = os.path.splitext(filename)[0]
    # Remove quality tags and everything after
    cleaned = _QUALITY_TAGS.sub('', base)
    # Replace dots/underscores/dashes with spaces
    cleaned = re.sub(r'[._-]+', ' ', cleaned).strip().lower()
    return cleaned

def fetch_supabase_subtitles_map(folder_name):
    if not supabase:
        return {}
    # [OPTIMIZED] Check RAM cache first (~0.01ms vs ~200-500ms Supabase hit)
    cache_key = f"supa_sub_{folder_name}"
    with _supa_sub_lock:
        cached = _supa_sub_cache.get(cache_key)
        if cached is not None:
            ts = _supa_sub_cache_ts.get(cache_key, 0)
            if _subtitle_map_cache_valid(ts, folder_name, cached):
                return cached
    subs_map = {}
    try:
        res = supabase.storage.from_('subtitles').list(folder_name)
        if not res:
            # Cache empty result too (with short TTL)
            with _supa_sub_lock:
                _supa_sub_cache[cache_key] = {}
                _supa_sub_cache_ts[cache_key] = time.time()
            return {}
        for item in res:
            if item['name'].startswith('.'): continue
            sub_path = f"supabase/{folder_name}/{item['name']}"
            s, e = get_season_episode_from_string(item['name'])
            if s and e:
                subs_map[(s, e)] = sub_path
            # Store by base filename
            base_name = os.path.splitext(item['name'])[0].lower()
            subs_map[('fname', base_name)] = sub_path
            # [NEW] Store by cleaned title for fuzzy matching
            cleaned = _clean_title_for_matching(item['name'])
            if cleaned:
                subs_map[('clean', cleaned)] = sub_path
    except Exception as ex:
        print(f"[SUB-MAP] ERROR for '{folder_name}': {ex}", flush=True)
    # Cache result
    with _supa_sub_lock:
        _supa_sub_cache[cache_key] = subs_map
        _supa_sub_cache_ts[cache_key] = time.time()
    return subs_map

def fetch_gdrive_subtitle_map(folder_name):
    """List subtitle files from the dedicated GDrive subtitle account.
    Mirrors fetch_supabase_subtitles_map() — same key format, uses 'gdrive_sub/<file_id>' prefix."""
    if not GDRIVE_SUBTITLE_FOLDER_ID or not GDRIVE_SUBTITLE_TOKEN_B64:
        return {}
    # [OPTIMIZED] Check RAM cache first
    cache_key = f"gdrive_sub_{folder_name}"
    with _gdrive_sub_lock:
        cached = _gdrive_sub_cache.get(cache_key)
        if cached is not None:
            ts = _gdrive_sub_cache_ts.get(cache_key, 0)
            if _subtitle_map_cache_valid(ts, folder_name, cached):
                return cached
    subs_map = {}
    try:
        svc = get_gdrive_subtitle_service()
        if not svc:
            return {}
        # Find the subfolder matching folder_name inside the subtitle root folder
        clean_name = escape_gdrive_query(folder_name)
        folder_q = f"name = '{clean_name}' and '{GDRIVE_SUBTITLE_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
        folder_res = svc.files().list(q=folder_q, pageSize=5, fields="files(id, name)").execute()
        target_folders = folder_res.get('files', [])
        if not target_folders:
            # Try case-insensitive: list all folders and match
            all_q = f"'{GDRIVE_SUBTITLE_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
            all_res = svc.files().list(q=all_q, pageSize=500, fields="files(id, name)").execute()
            for f in all_res.get('files', []):
                if f['name'].lower() == folder_name.lower():
                    target_folders = [f]
                    break
        if not target_folders:
            # Cache empty result
            with _gdrive_sub_lock:
                _gdrive_sub_cache[cache_key] = {}
                _gdrive_sub_cache_ts[cache_key] = time.time()
            return {}
        # List subtitle files inside the subfolder
        sub_folder_id = target_folders[0]['id']
        files_q = f"'{sub_folder_id}' in parents and (name contains '.srt' or name contains '.vtt') and trashed = false"
        page_token = None
        while True:
            files_res = svc.files().list(q=files_q, pageSize=200, fields="nextPageToken, files(id, name)", pageToken=page_token).execute()
            for item in files_res.get('files', []):
                if item['name'].startswith('.'): continue
                sub_path = f"gdrive_sub/{item['id']}"
                s, e = get_season_episode_from_string(item['name'])
                if s and e:
                    subs_map[(s, e)] = sub_path
                # Store by base filename
                base_name = os.path.splitext(item['name'])[0].lower()
                subs_map[('fname', base_name)] = sub_path
                # Store by cleaned title for fuzzy matching
                cleaned = _clean_title_for_matching(item['name'])
                if cleaned:
                    subs_map[('clean', cleaned)] = sub_path
            page_token = files_res.get('nextPageToken')
            if not page_token: break
    except Exception as ex:
        print(f"[GDRIVE-SUB-MAP] ERROR for '{folder_name}': {ex}", flush=True)
    # Cache result
    with _gdrive_sub_lock:
        _gdrive_sub_cache[cache_key] = subs_map
        _gdrive_sub_cache_ts[cache_key] = time.time()
    return subs_map

def escape_gdrive_query(value): return value.replace("'", "\\'")

def _folder_dedup_key(item):
    name = _normalize_folder_name(item.get('name') or '')
    media_type = (item.get('type') or '').strip().lower()
    return f"{media_type}:{name}"

def _normalize_folder_name(name):
    return re.sub(r'\s+', ' ', (name or '').strip()).lower()

def _deduplicate_all_content(series_list, movies_list):
    seen_keys = {}  # normalized_name -> item
    
    # 1. Process series first (so TV/Series takes priority over Movies)
    deduped_series = []
    for item in series_list:
        norm_name = _normalize_folder_name(item.get('name') or '')
        if norm_name not in seen_keys:
            seen_keys[norm_name] = item
            deduped_series.append(item)
            
    # 2. Process movies next
    deduped_movies = []
    for item in movies_list:
        norm_name = _normalize_folder_name(item.get('name') or '')
        if norm_name not in seen_keys:
            seen_keys[norm_name] = item
            deduped_movies.append(item)
            
    return deduped_series, deduped_movies

def fetch_gdrive_categorized_content(service):
    if not service or not GDRIVE_FOLDER_IDS: return None 
    categorized_content = {"series": [], "movies": []}
    root_folder_ids_set = set(GDRIVE_FOLDER_IDS) 
    try:
        PAGE_SIZE = 150
        query_categories = "(name = 'Series' or name = 'Movies') and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
        results_categories = service.files().list(q=query_categories, pageSize=PAGE_SIZE, fields="files(id, name, parents)").execute()
        
        series_folder_ids, movies_folder_ids = [], []
        for folder in results_categories.get('files', []):
            if folder.get('parents', [None])[0] in root_folder_ids_set:
                if folder['name'].lower() == 'series': series_folder_ids.append(folder['id'])
                elif folder['name'].lower() == 'movies': movies_folder_ids.append(folder['id'])
        del results_categories 
        
        if series_folder_ids:
            series_parent_query = " or ".join([f"'{fid}' in parents" for fid in series_folder_ids])
            series_query = f"({series_parent_query}) and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false"
            page_token = None
            while True:
                series_results = service.files().list(q=series_query, pageSize=PAGE_SIZE, pageToken=page_token, fields="nextPageToken, files(id, name)").execute()
                for item in series_results.get('files', []): categorized_content["series"].append({"name": item['name'], "source": "Google Drive", "type": "tv"})
                page_token = series_results.get('nextPageToken')
                if not page_token: break
                
        if movies_folder_ids:
            movies_parent_query = " or ".join([f"'{fid}' in parents" for fid in movies_folder_ids])
            movies_query = f"({movies_parent_query}) and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'video/' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false"
            page_token = None
            while True:
                movies_results = service.files().list(q=movies_query, pageSize=PAGE_SIZE, pageToken=page_token, fields="nextPageToken, files(id, name, mimeType)").execute()
                for item in movies_results.get('files', []):
                    if item['mimeType'] == 'application/vnd.google-apps.folder' or item['mimeType'] == 'application/vnd.google-apps.shortcut':
                        categorized_content["movies"].append({"name": item['name'], "source": f"gdrive_folder/{item['id']}", "type": "movie"})
                    elif 'video/' in item['mimeType']:
                        movie_name, _ = os.path.splitext(item['name'])
                        categorized_content["movies"].append({"name": movie_name, "source": f"gdrive/{item['id']}", "type": "movie"})
                page_token = movies_results.get('nextPageToken')
                if not page_token: break
        
        root_parent_query = " or ".join([f"'{fid}' in parents" for fid in GDRIVE_FOLDER_IDS])
        root_content_query = f"({root_parent_query}) and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false"
        page_token = None
        while True:
            root_content_results = service.files().list(q=root_content_query, pageSize=PAGE_SIZE, pageToken=page_token, fields="nextPageToken, files(id, name)").execute()
            for item in root_content_results.get('files', []):
                if item['name'].lower() in ['series', 'movies']: continue
                if item['name'] not in [f['name'] for f in categorized_content["series"]]: categorized_content["series"].append({"name": item['name'], "source": "Google Drive", "type": "tv"})
            page_token = root_content_results.get('nextPageToken')
            if not page_token: break

        return categorized_content
    except Exception as e: print(f"Error fetching: {e}"); return None

def _get_category_folder_ids(service):
    """[OPTIMIZED] Get cached category folder IDs (Series/Movies). Saves ~500ms per fetch_gdrive_videos call."""
    global _category_folder_ids_cache, _category_folder_ids_ts
    now = time.time()
    if _category_folder_ids_cache is not None and (now - _category_folder_ids_ts) < _category_folder_ids_ttl:
        return _category_folder_ids_cache
    root_folder_ids_set = set(GDRIVE_FOLDER_IDS)
    query_categories = "(name = 'Series' or name = 'Movies') and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    results_categories = service.files().list(q=query_categories, pageSize=100, fields="files(id, name, parents)").execute()
    ids = set(f['id'] for f in results_categories.get('files', []) if f.get('parents', [None])[0] in root_folder_ids_set)
    _category_folder_ids_cache = ids
    _category_folder_ids_ts = now
    return ids

def fetch_gdrive_videos(service, folder_name):
    if not service or not GDRIVE_FOLDER_IDS: return None
    PAGE_SIZE = 150
    for attempt in range(2):
        try:
            gdrive_videos, has_season_folders_gdrive = [], False
            # [OPTIMIZED] Use cached category folder IDs instead of querying GDrive every time
            category_folder_ids = _get_category_folder_ids(service)
            all_possible_parent_ids = set(GDRIVE_FOLDER_IDS) | category_folder_ids
            clean_folder_name = escape_gdrive_query(folder_name)
            requested_folder_key = _normalize_folder_name(folder_name)
            folder_q = f"name = '{clean_folder_name}' and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false"
            
            series_folder_ids = []
            seen_series_folder_ids = set()

            def add_series_folder(folder):
                if folder.get('parents', [None])[0] not in all_possible_parent_ids:
                    return
                folder_id = None
                if folder['mimeType'] == 'application/vnd.google-apps.folder':
                    folder_id = folder['id']
                elif folder['mimeType'] == 'application/vnd.google-apps.shortcut':
                    folder_id = folder.get('shortcutDetails', {}).get('targetId')
                if folder_id and folder_id not in seen_series_folder_ids:
                    seen_series_folder_ids.add(folder_id)
                    series_folder_ids.append(folder_id)

            folder_res = service.files().list(q=folder_q, pageSize=50, fields="files(id, name, parents, mimeType, shortcutDetails(targetId))").execute()
            for folder in folder_res.get('files', []):
                add_series_folder(folder)

            try:
                parent_clauses = " or ".join([f"'{fid}' in parents" for fid in all_possible_parent_ids])
                normalized_folder_q = f"({parent_clauses}) and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false"
                page_token = None
                while True:
                    folder_res = service.files().list(q=normalized_folder_q, pageSize=PAGE_SIZE, pageToken=page_token, fields="nextPageToken, files(id, name, parents, mimeType, shortcutDetails(targetId))").execute()
                    for folder in folder_res.get('files', []):
                        if _normalize_folder_name(folder.get('name', '')) == requested_folder_key:
                            add_series_folder(folder)
                    page_token = folder_res.get('nextPageToken')
                    if not page_token: break
            except Exception as normalized_lookup_error:
                print(f"[GDRIVE] Normalized folder lookup skipped for '{folder_name}': {normalized_lookup_error}", flush=True)
            
            if not series_folder_ids: return {"videos": [], "has_season_folders": False}
            
            all_folder_ids = []; folder_id_to_name = {}
            new_subfolder_ids = []
            for series_folder_id in series_folder_ids:
                all_folder_ids.append(series_folder_id); folder_id_to_name[series_folder_id] = folder_name
                subfolder_q = f"'{series_folder_id}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false"
                subfolder_res = service.files().list(q=subfolder_q, pageSize=100, fields="files(id, name, mimeType, shortcutDetails(targetId))").execute()
                for sub in subfolder_res.get('files', []):
                    fid = sub['id'] if sub['mimeType'] == 'application/vnd.google-apps.folder' else sub.get('shortcutDetails', {}).get('targetId')
                    if fid:
                        all_folder_ids.append(fid); folder_id_to_name[fid] = sub['name']
                        new_subfolder_ids.append(fid)
                        if not has_season_folders_gdrive and re.search(r'(?:season|s)\s*\d+', sub['name'], re.IGNORECASE): has_season_folders_gdrive = True
                        
            # [NEW] Check sub-sub-folders (e.g. "Episode 3" inside "Season 3")
            if new_subfolder_ids:
                parent_clauses = " or ".join([f"'{fid}' in parents" for fid in new_subfolder_ids])
                subsubfolder_q = f"({parent_clauses}) and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false"
                page_token = None
                while True:
                    subsub_res = service.files().list(q=subsubfolder_q, pageSize=150, pageToken=page_token, fields="nextPageToken, files(id, name, mimeType, shortcutDetails(targetId), parents)").execute()
                    for sub in subsub_res.get('files', []):
                        fid = sub['id'] if sub['mimeType'] == 'application/vnd.google-apps.folder' else sub.get('shortcutDetails', {}).get('targetId')
                        if fid:
                            all_folder_ids.append(fid)
                            parent_id = sub.get('parents', [None])[0]
                            # Inherit "Season X" prefix if parent has it, for accurate episode detection
                            if parent_id and parent_id in folder_id_to_name and re.search(r'(?:season|s)\s*\d+', folder_id_to_name[parent_id], re.IGNORECASE):
                                folder_id_to_name[fid] = folder_id_to_name[parent_id] + " " + sub['name']
                            else:
                                folder_id_to_name[fid] = sub['name']
                    page_token = subsub_res.get('nextPageToken')
                    if not page_token: break
            
            if not all_folder_ids: return {"videos": [], "has_season_folders": False}

            video_files, subtitle_files = [], []
            CHUNK_SIZE = 20
            # [Fix nested folders + HLS] Process folder queries in chunks to avoid GDrive query length limit
            for i in range(0, len(all_folder_ids), CHUNK_SIZE):
                chunk = all_folder_ids[i:i + CHUNK_SIZE]
                parent_clauses = " or ".join([f"'{fid}' in parents" for fid in chunk])
                files_q = f"({parent_clauses}) and (mimeType contains 'video/' or name contains '.srt' or name contains '.vtt' or name contains '.m3u8') and trashed = false"
                
                page_token = None
                while True:
                    files_res = service.files().list(q=files_q, pageSize=PAGE_SIZE, fields="nextPageToken, files(id, name, mimeType, parents)", pageToken=page_token).execute()
                    for f in files_res.get('files', []):
                        lname = f['name'].lower()
                        if 'video/' in f['mimeType'] or lname.endswith('.m3u8'): 
                            video_files.append(f)
                        elif lname.endswith(('.srt', '.vtt')): 
                            subtitle_files.append(f)
                    page_token = files_res.get('nextPageToken')
                    if not page_token: break
                    time.sleep(0.05) 

            # Resolve actual folder name for Supabase subtitle lookup
            # Movies use gdrive_folder/XXXX or gdrive/XXXX as folder_name,
            # but Supabase bucket uses the movie name (e.g. "No Other Choice")
            supabase_folder_name = folder_name
            if folder_name.startswith(("gdrive_folder/", "gdrive/")):
                _folders_data = mem_get('folders_list')
                if _folders_data:
                    for _movie_item in _folders_data.get('movies', []):
                        if _movie_item.get('source') == folder_name:
                            supabase_folder_name = _movie_item['name']
                            break
            supabase_subs_map = fetch_supabase_subtitles_map(supabase_folder_name)
            gdrive_subs_map = fetch_gdrive_subtitle_map(supabase_folder_name)
            for video in video_files:
                video_base_name, _ = os.path.splitext(video['name'])
                video_parent_id = video.get('parents', [None])[0]
                season, episode = get_season_episode_from_string(video['name'])
                if (season == 1 or season is None) and video_parent_id in folder_id_to_name:
                    season_match = re.search(r'(?:season|s)\s*(\d+)', folder_id_to_name[video_parent_id].lower())
                    if season_match: season = int(season_match.group(1))
                
                found_subtitle_gdrive = None
                relevant_subs = [s for s in subtitle_files if s.get('parents', [None])[0] == video_parent_id]
                for sub in relevant_subs:
                    if os.path.splitext(sub['name'])[0].lower() == video_base_name.lower(): found_subtitle_gdrive = sub; break
                if not found_subtitle_gdrive and season and episode:
                    for sub in relevant_subs:
                        ss, se = get_season_episode_from_string(sub['name'])
                        if ss == season and se == episode: found_subtitle_gdrive = sub; break
                # [NEW] Fuzzy match: strip quality tags and compare cleaned titles
                if not found_subtitle_gdrive:
                    cleaned_video = _clean_title_for_matching(video['name'])
                    for sub in relevant_subs:
                        cleaned_sub = _clean_title_for_matching(sub['name'])
                        if cleaned_sub and cleaned_video and cleaned_sub == cleaned_video:
                            found_subtitle_gdrive = sub; break
                
                # Priority chain: Supabase → GDrive Subtitle Account → GDrive co-located
                final_subtitle_path = None
                # [Priority 1] Supabase
                if season and episode:
                    final_subtitle_path = supabase_subs_map.get((season, episode))
                if not final_subtitle_path:
                    lookup_key = ('fname', video_base_name.lower())
                    final_subtitle_path = supabase_subs_map.get(lookup_key)
                if not final_subtitle_path:
                    cleaned_video = _clean_title_for_matching(video['name'])
                    if cleaned_video:
                        final_subtitle_path = supabase_subs_map.get(('clean', cleaned_video))
                # [Priority 2] GDrive Subtitle Account (dedicated subtitle GDrive)
                if not final_subtitle_path and season and episode:
                    final_subtitle_path = gdrive_subs_map.get((season, episode))
                if not final_subtitle_path:
                    final_subtitle_path = gdrive_subs_map.get(('fname', video_base_name.lower()))
                if not final_subtitle_path:
                    cleaned_video = _clean_title_for_matching(video['name'])
                    if cleaned_video:
                        final_subtitle_path = gdrive_subs_map.get(('clean', cleaned_video))
                # [Priority 3] GDrive co-located subtitle
                if not final_subtitle_path and found_subtitle_gdrive:
                    final_subtitle_path = f"gdrive/{found_subtitle_gdrive['id']}"

                gdrive_videos.append({"name": video_base_name, "path": f"gdrive/{video['id']}", "subtitle_path": final_subtitle_path, "season": season if season else 1, "episode": episode, "source": "Google Drive", "original_name": video['name']})
            
            return {"videos": gdrive_videos, "has_season_folders": has_season_folders_gdrive}
        except Exception as e:
            if attempt == 0: _gdrive_local.service = None; service = get_gdrive_service(); time.sleep(1)
            else: return None
    return None

def _bg_refresh_one(service_ignored, args):
    """[OPTIMIZED] Moved to module level — avoids closure recreation every BG cycle."""
    target, cache_key, is_priority = args
    if acquire_lock(cache_key):
        try:
            svc = get_gdrive_service()
            v_res = fetch_gdrive_videos(svc, target)
            if v_res:
                if v_res.get("videos"): v_res["videos"].sort(key=lambda x: (x.get("season", 999), x.get("episode", 999), x["name"]))
                mem_set(cache_key, v_res)
                # Invalidate pre-serialized response cache
                _response_cache.pop(f'resp_{cache_key}', None)
                return True
        except: pass
        finally: release_lock(cache_key)
    return False

def background_cache_worker():
    """Proactive cache worker: refresh data BEFORE it expires.
    [OPTIMIZED] Processes 4 items in parallel via global thread pool.
    Cycle setiap 5 menit — data selalu fresh di RAM untuk response <0.1ms."""
    time.sleep(10)
    while True:
        cycle_started_at = time.time()
        try:
            service = get_gdrive_service()
            updated_count, priority_new_items = 0, set()
            folders_key = "folders_list"
            
            # SELALU refresh folders setiap cycle (proactive, bukan reactive)
            if acquire_lock(folders_key):
                try:
                    if service:
                        old_folders = mem_get(folders_key); old_keys = set()
                        if old_folders: 
                            for cat in old_folders: 
                                for item in old_folders[cat]: old_keys.add(item.get('source') if item.get('source','').startswith(('gdrive/', 'gdrive_folder/', 'telegram/')) else item['name'])
                        folders_data = fetch_gdrive_categorized_content(service)
                        if folders_data:
                            series_dedup, movies_dedup = _deduplicate_all_content(folders_data.get("series", []), folders_data.get("movies", []))
                            series_dedup.sort(key=lambda x: x['name'])
                            movies_dedup.sort(key=lambda x: x['name'])
                            folders_data["series"] = series_dedup
                            folders_data["movies"] = movies_dedup
                            for category in folders_data:
                                for item in folders_data[category]:
                                    k = item.get('source') if item.get('source','').startswith(('gdrive/', 'gdrive_folder/', 'telegram/')) else item['name']
                                    if k not in old_keys: priority_new_items.add(k)
                            mem_set(folders_key, folders_data); updated_count += 1
                            # Invalidate pre-serialized response cache for folders
                            _invalidate_response_cache('resp_folders', 'resp_folders_merged')
                            # Also refresh category folder IDs cache
                            _get_category_folder_ids(service)
                finally: release_lock(folders_key)
            
            # === REBUILD SEARCH INDEX after folders refresh ===
            build_search_index()
            
            # === CLEANUP RATE LIMITER STORE (prevent memory leak) ===
            now = _monotonic()
            with _rate_limit_lock:
                stale_ips = [k for k, v in _rate_limit_store.items() if not v or now - v[-1] > 120]
                for k in stale_ips:
                    del _rate_limit_store[k]
            
            folders_data = mem_get(folders_key)
            if folders_data:
                all_items = folders_data.get('series', []) + folders_data.get('movies', [])
                
                # Refresh every content item on each cycle so cache stays fresh.
                items_to_refresh = []
                for item in all_items:
                    folder_name = item['name']; source_path = item.get('source')
                    target = source_path if (source_path and source_path.startswith(("gdrive/", "gdrive_folder/", "telegram/"))) else folder_name
                    # [FIX] For movies with gdrive_folder/gdrive source, resolve to actual name
                    # so fetch_gdrive_videos can find the folder by name in GDrive
                    resolve_target = folder_name if target.startswith(("gdrive_folder/", "gdrive/")) else target
                    cache_key = f"videos_{target}"; is_priority = target in priority_new_items
                    items_to_refresh.append((resolve_target, cache_key, is_priority))
                
                # [OPTIMIZATION] Process 4 items in parallel instead of 1-by-1
                BATCH_SIZE = 4
                for batch_start in range(0, len(items_to_refresh), BATCH_SIZE):
                    batch = items_to_refresh[batch_start:batch_start + BATCH_SIZE]
                    
                    futures = [_global_executor.submit(_bg_refresh_one, service, item) for item in batch]
                    for f in as_completed(futures):
                        if f.result(): updated_count += 1
                    
                    # Small delay between batches to not hammer GDrive API
                    has_priority = any(p for _, _, p in batch)
                    time.sleep(0.5 if has_priority else 1.5)
            
            # === RE-SCAN ITEMS WITH MISSING SUBTITLES ===
            # After normal refresh, specifically re-fetch items that have videos
            # with subtitle_path=null. Clears subtitle map cache for those folders
            # so the re-fetch queries GDrive/Supabase for newly added subtitle files.
            if folders_data:
                missing_sub_items = []
                for item in all_items:
                    folder_name_bg = item['name']; source_path_bg = item.get('source')
                    target_bg = source_path_bg if (source_path_bg and source_path_bg.startswith(("gdrive/", "gdrive_folder/", "telegram/"))) else folder_name_bg
                    resolve_target_bg = folder_name_bg if target_bg.startswith(("gdrive_folder/", "gdrive/")) else target_bg
                    cache_key_bg = f"videos_{target_bg}"
                    cached_data = mem_get(cache_key_bg)
                    if cached_data and any(v.get('subtitle_path') is None for v in cached_data.get('videos', [])):
                        # Clear subtitle map caches for this folder so fetch is fresh
                        _invalidate_subtitle_maps(resolve_target_bg)
                        missing_sub_items.append((resolve_target_bg, cache_key_bg, True))
                
                if missing_sub_items:
                    print(f"    [BG-WORKER] Re-scanning {len(missing_sub_items)} items with missing subtitles", flush=True)
                    for batch_start in range(0, len(missing_sub_items), BATCH_SIZE):
                        batch = missing_sub_items[batch_start:batch_start + BATCH_SIZE]
                        futures = [_global_executor.submit(_bg_refresh_one, service, item) for item in batch]
                        for f in as_completed(futures):
                            if f.result(): updated_count += 1
                        time.sleep(0.5)
            
            # [FIX] REMOVED warmup_subtitle_cache() from BG loop
            # Subtitles are cached on-demand via /subtitle/ endpoint.
            # Re-downloading ALL subtitles every cycle was draining Supabase egress.
            
            mem_stats = len(_mem_cache)
            sub_stats = len(_subtitle_cache)
            resp_stats = len(_response_cache)
        except Exception as e: print(f"    [BG-WORKER] Error: {e}", flush=True)
        elapsed = time.time() - cycle_started_at
        time.sleep(max(0, CACHE_REFRESH_INTERVAL - elapsed))

# --- ROUTES FETCH CONTENT ---
def add_cache_headers(response, max_age=3600): response.headers['Cache-Control'] = f'public, max-age={max_age}'; return response
def add_no_cache_headers(response): response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'; response.headers['Pragma'] = 'no-cache'; response.headers['Expires'] = '0'; return response

@app.route("/api/folders")
@token_required(check_expiry=False)
@rate_limited()
def get_folders(current_user):
    force = request.args.get('refresh', 'false').lower() == 'true'; key = "folders_list"
    if not force:
        cached_bytes = _response_cache.get('resp_folders_merged')
        if cached_bytes:
            return add_no_cache_headers(app.response_class(cached_bytes, mimetype='application/json', status=200))

        # RAM first; first request after invalidation merges overrides, later requests
        # reuse pre-serialized merged bytes.
        cached = mem_get(key)
        if cached:
            payload = copy.deepcopy(cached)
            _merge_content_release_tmdb_into_folders(payload)
            _merge_tmdb_overrides_into_folders(payload)
            return add_no_cache_headers(orjson_jsonify(payload, cache_key='resp_folders_merged'))
    res = fetch_gdrive_categorized_content(get_gdrive_service())
    if res:
        all_c = {"series": [], "movies": []}
        series_dedup, movies_dedup = _deduplicate_all_content(res.get("series", []), res.get("movies", []))
        all_c["series"] = series_dedup
        all_c["movies"] = movies_dedup

        # [NEW] Merge Telegram catalog items as additional "movies" source.
        # Server returns only metadata; actual bytes are fetched on client via TDLib to avoid server bandwidth.
        conn, db_type = None, None
        try:
            conn, db_type = get_db_connection()
            cur = conn.cursor()
            if db_type == 'postgres':
                cur.execute("SELECT tmdb_title, folder_name, chat_id, video_message_id, tmdb_poster_path FROM telegram_catalog ORDER BY added_at DESC LIMIT 500")
            else:
                cur.execute("SELECT tmdb_title, folder_name, chat_id, video_message_id, tmdb_poster_path FROM telegram_catalog ORDER BY added_at DESC LIMIT 500")
            rows = cur.fetchall() or []
            for r in rows:
                # sqlite row may be tuple; postgres may be tuple too
                tmdb_title, folder_name, chat_id, video_message_id, tmdb_poster_path = r[0], r[1], r[2], r[3], r[4]
                if not chat_id or not video_message_id:
                    continue
                display_name = (tmdb_title or folder_name or "").strip()
                if not display_name:
                    continue
                all_c["movies"].append({
                    "name": folder_name or display_name,
                    "tmdb_title": display_name,
                    "tmdb_poster_path": tmdb_poster_path,
                    "type": "movie",
                    "source": f"telegram/{int(chat_id)}/{int(video_message_id)}",
                })
        except Exception as e:
            print(f"[TELEGRAM] Failed merging telegram_catalog into /api/folders: {e}", flush=True)
        finally:
            release_db_connection(conn, db_type)

        # Deduplicate again after merge (by name across both categories)
        series_dedup, movies_dedup = _deduplicate_all_content(all_c["series"], all_c["movies"])
        series_dedup.sort(key=lambda x: x['name'])
        movies_dedup.sort(key=lambda x: x['name'])
        all_c["series"] = series_dedup
        all_c["movies"] = movies_dedup

        mem_set(key, all_c)
        _invalidate_response_cache('resp_folders', 'resp_folders_merged')
        build_search_index()  # [NEW] Build search index immediately so search works instantly after server restart
        payload = copy.deepcopy(all_c)
        _merge_content_release_tmdb_into_folders(payload)
        _merge_tmdb_overrides_into_folders(payload)
        return add_no_cache_headers(orjson_jsonify(payload, cache_key='resp_folders_merged'))
    stale = mem_get(key)
    if stale:
        payload = copy.deepcopy(stale)
        _merge_content_release_tmdb_into_folders(payload)
        _merge_tmdb_overrides_into_folders(payload)
        return add_no_cache_headers(orjson_jsonify(payload, cache_key='resp_folders_merged'))
    return add_no_cache_headers(orjson_jsonify({"series": [], "movies": []}))

@app.route("/api/videos/<path:folder_name>")
@token_required(check_expiry=False)
@rate_limited()
def get_videos_in_folder(current_user, folder_name):
    # [NEW] Telegram source: "telegram/<chat_id>/<message_id>"
    if folder_name.startswith("telegram/"):
        try:
            parts = folder_name.split("/")
            if len(parts) >= 3:
                chat_id = int(parts[1])
                message_id = int(parts[2])
            else:
                return orjson_jsonify({"error": "Invalid telegram path"}, 400)

            # Optional: resolve a friendly title from DB
            title = None
            conn, db_type = None, None
            try:
                conn, db_type = get_db_connection()
                cur = conn.cursor()
                if db_type == 'postgres':
                    cur.execute(
                        "SELECT tmdb_title, folder_name FROM telegram_catalog WHERE chat_id = %s AND video_message_id = %s LIMIT 1",
                        (chat_id, message_id),
                    )
                else:
                    cur.execute(
                        "SELECT tmdb_title, folder_name FROM telegram_catalog WHERE chat_id = ? AND video_message_id = ? LIMIT 1",
                        (chat_id, message_id),
                    )
                row = cur.fetchone()
                if row:
                    title = (row[0] or row[1] or None)
            except Exception:
                pass
            finally:
                release_db_connection(conn, db_type)

            name = (title or f"Telegram {chat_id}/{message_id}").strip()
            final = {
                "videos": [{
                    "name": name,
                    "path": folder_name,
                    "subtitle_path": None,
                    "season": 1,
                    "episode": 1,
                    "source": "Telegram",
                }],
                "has_season_folders": False,
            }
            return add_cache_headers(orjson_jsonify(final), max_age=60)
        except Exception as e:
            print(f"[VIDEOS] Telegram handler error for '{folder_name}': {e}", flush=True)
            return orjson_jsonify({"error": "Telegram handler error"}, 500)

    force = request.args.get('refresh', 'false').lower() == 'true'; key = f"videos_{folder_name}"
    resp_key = f"resp_{key}"
    if not force:
        # RAM first → pre-serialized response (~0.01ms)
        cached = mem_get(key)
        if cached:
            dur = CACHE_DURATION_EMPTY if not cached.get("videos") else CACHE_DURATION_VIDEOS
            if mem_is_fresh(key, dur):
                if not cached.get('catalog_item'):
                    cached = copy.deepcopy(cached)
                    cached['catalog_item'] = _catalog_item_for_folder(folder_name)
                    _response_cache.pop(resp_key, None)
                return add_cache_headers(orjson_jsonify(cached, cache_key=resp_key), max_age=dur)
            # Stale cache refreshes on this request; fallback below serves stale if GDrive fails.

    svc = get_gdrive_service()

    # [FIX] Resolve gdrive_folder/ and gdrive/ paths to actual folder name
    # Client sends source path (e.g. "gdrive_folder/XXXX") but fetch_gdrive_videos
    # needs the actual folder name (e.g. "No Other Choice") to search GDrive
    resolved_name = folder_name
    movie_name_for_supa = None
    if folder_name.startswith(("gdrive_folder/", "gdrive/")):
        folders_data = mem_get('folders_list')
        if folders_data:
            for movie_item in folders_data.get('movies', []):
                if movie_item.get('source') == folder_name:
                    resolved_name = movie_item['name']
                    movie_name_for_supa = movie_item['name']

                    break
    catalog_item = _catalog_item_for_folder(folder_name, resolved_name)

    # === CLEAR SUBTITLE MAP CACHES ON FORCE REFRESH ===
    # Tanpa ini, subtitle map yang cached kosong tetap return {} selama 12 jam
    if force:
        resolved_for_sub = resolved_name
        _invalidate_subtitle_maps(resolved_for_sub)

    res = fetch_gdrive_videos(svc, resolved_name)
    if res is not None:
        vids, has_s = res["videos"], res["has_season_folders"]
        if not vids and folder_name.startswith(("gdrive/", "gdrive_folder/")):
             try:
                fid = folder_name.split('/', 1)[1]
                # Handle gdrive_folder/ — list files inside the folder
                if folder_name.startswith("gdrive_folder/"):
                    try:
                        folder_meta = svc.files().get(fileId=fid, fields="name").execute()
                        resolved_folder_name = folder_meta.get('name', resolved_name)
                        catalog_item = _catalog_item_for_folder(folder_name, resolved_folder_name)
                    except Exception as fe:
                        print(f"[VIDEOS] Failed to resolve gdrive_folder name: {fe}", flush=True)

                    PAGE_SIZE = 100
                    files_q = f"'{fid}' in parents and (mimeType contains 'video/' or name contains '.srt' or name contains '.vtt') and trashed = false"
                    files_res = svc.files().list(q=files_q, pageSize=PAGE_SIZE, fields="files(id, name, mimeType, parents)").execute()
                    video_files = [f for f in files_res.get('files', []) if 'video/' in f.get('mimeType', '')]
                    subtitle_files_gd = [f for f in files_res.get('files', []) if f['name'].lower().endswith(('.srt', '.vtt'))]
                    
                    if video_files:
                        # Resolve supa subtitle
                        supa_folder = movie_name_for_supa or resolved_name
                        supabase_subs_map = fetch_supabase_subtitles_map(supa_folder)
                        
                        result_vids = []
                        for video in video_files:
                            video_base_name, _ = os.path.splitext(video['name'])
                            sub_path = None
                            
                            # 1. Supabase by fname
                            sub_path = supabase_subs_map.get(('fname', video_base_name.lower()))
                            # 2. Supabase by cleaned title
                            if not sub_path:
                                cleaned_v = _clean_title_for_matching(video['name'])
                                if cleaned_v:
                                    sub_path = supabase_subs_map.get(('clean', cleaned_v))
                            # 3. Supabase by (1,1) for single-movie folder
                            if not sub_path:
                                sub_path = supabase_subs_map.get((1, 1))
                            # 4. GDrive subtitle fallback 
                            if not sub_path:
                                for s in subtitle_files_gd:
                                    if os.path.splitext(s['name'])[0].lower() == video_base_name.lower():
                                        sub_path = f"gdrive/{s['id']}"; break
                                if not sub_path:
                                    cleaned_v = _clean_title_for_matching(video['name'])
                                    for s in subtitle_files_gd:
                                        if _clean_title_for_matching(s['name']) == cleaned_v:
                                            sub_path = f"gdrive/{s['id']}"; break
                            
                            result_vids.append({"name": video_base_name, "path": f"gdrive/{video['id']}", "subtitle_path": sub_path, "season": 1, "episode": 1, "source": "Google Drive", "original_name": video['name']})
                        
                        final = {"videos": result_vids, "has_season_folders": False, "catalog_item": catalog_item}
                        mem_set(key, final); _response_cache.pop(resp_key, None)
                        return orjson_jsonify(final, cache_key=resp_key)
                    else:
                        # Folder exists but has no video files
                        final = {"videos": [], "has_season_folders": False, "catalog_item": catalog_item}
                        mem_set(key, final); _response_cache.pop(resp_key, None)
                        return orjson_jsonify(final, cache_key=resp_key)
                else:
                    # Handle gdrive/ — standalone video file
                    meta = svc.files().get(fileId=fid, fields="name, parents").execute()
                    name, _ = os.path.splitext(meta.get('name', 'Unknown'))
                    catalog_item = _catalog_item_for_folder(folder_name, name)
                    sub_path = None; pid = meta.get('parents', [None])[0]
                    # Cek Supabase subtitle
                    supa_folder = movie_name_for_supa or name
                    supa_subs = fetch_supabase_subtitles_map(supa_folder)
                    sub_path = supa_subs.get(('fname', name.lower()))
                    if not sub_path:
                        sub_path = supa_subs.get((1, 1))
                    if not sub_path:
                        cleaned = _clean_title_for_matching(name)
                        if cleaned:
                            sub_path = supa_subs.get(('clean', cleaned))
                    # Fallback: cek GDrive subtitle
                    if not sub_path and pid:
                        sq = f"'{pid}' in parents and (name contains '.srt' or name contains '.vtt') and trashed = false"
                        sr = svc.files().list(q=sq, fields="files(id, name)").execute()
                        for s in sr.get('files', []):
                            if s['name'].lower().startswith(name.lower()): sub_path = f"gdrive/{s['id']}"; break
                    final = {"videos": [{"name": name, "path": folder_name, "subtitle_path": sub_path, "season": 1, "episode": 1, "source": "Google Drive", "original_name": meta.get('name', 'Unknown')}], "has_season_folders": False, "catalog_item": catalog_item}
                    mem_set(key, final); _response_cache.pop(resp_key, None)
                    return orjson_jsonify(final, cache_key=resp_key)
             except Exception as e:
                print(f"[VIDEOS] Error handling '{folder_name}': {e}", flush=True)
                return orjson_jsonify({"error": "File not found"}, 404)
        vids.sort(key=lambda x: (x.get("season", 999), x.get("episode", 999), x["name"]))
        final = {"videos": vids, "has_season_folders": has_s, "catalog_item": catalog_item}
        mem_set(key, final); _response_cache.pop(resp_key, None)
        return add_cache_headers(orjson_jsonify(final, cache_key=resp_key), max_age=(CACHE_DURATION_EMPTY if not final.get("videos") else CACHE_DURATION_VIDEOS))
    
    stale = mem_get(key)
    if stale:
        if not stale.get('catalog_item'):
            stale = copy.deepcopy(stale)
            stale['catalog_item'] = _catalog_item_for_folder(folder_name, resolved_name)
            _response_cache.pop(resp_key, None)
        return add_cache_headers(orjson_jsonify(stale, cache_key=resp_key), max_age=60)
    return add_no_cache_headers(orjson_jsonify({"error": "API Error"}, 500))

@app.route('/api/media-details', methods=['POST'])
@token_required(check_expiry=False)
@rate_limited()
def get_media_details(current_user):
    def get_details(s, fid):
        try:
            m = s.files().get(fileId=fid, fields="name, id").execute()
            n, _ = os.path.splitext(m.get('name', 'Unknown'))
            return {"name": n, "source": f"gdrive/{m['id']}", "type": "movie"}
        except: return None

    data = request.get_json()
    if not data or 'paths' not in data: return jsonify({"error": "Invalid"}), 400
    key = "media_" + json.dumps(sorted(data['paths']))
    # RAM first
    cached = mem_get(key)
    if cached and mem_is_fresh(key, CACHE_DURATION_VIDEOS): return orjson_jsonify(cached)
    paths = data['paths']; ids = [p.split('/', 1)[1] for p in paths if p.startswith("gdrive/")]; d_map = {}
    svc = get_gdrive_service()
    if svc and ids:
        # [OPTIMIZATION] Use global thread pool instead of creating new one per request
        future_to_id = {_global_executor.submit(get_details, svc, i): i for i in ids}
        for f in as_completed(future_to_id):
            r = f.result()
            if r: d_map[r['source']] = r
    mem_set(key, d_map)
    return orjson_jsonify(d_map)

# ==========================================
# STREAMING ROUTES (PROTECTED)
# ==========================================


# Endpoint yang hilang di kodingan baru, dikembalikan di sini (PROTECTED)
@app.route("/api/gdrive-stream-details/<path:file_path>")
@token_required(check_expiry=True)
def get_gdrive_stream_details(current_user,file_path):
    global _gdrive_token, _gdrive_token_ts
    fid = file_path.split('/', 1)[1] if '/' in file_path else file_path
    
    try:
        # [OPTIMIZATION] Use cached bearer token (~0.01ms) instead of credential check (~50-100ms)
        now = time.time()
        if _gdrive_token and (now - _gdrive_token_ts) < _gdrive_token_ttl:
            token = _gdrive_token
        else:
            # Token expired or first request — refresh and cache
            svc = get_gdrive_service()
            if not svc: return orjson_jsonify({"error": "GDrive unavailable"}, 503)
            with _gdrive_token_lock:
                # Double-check after lock
                if _gdrive_token and (time.time() - _gdrive_token_ts) < _gdrive_token_ttl:
                    token = _gdrive_token
                else:
                    if svc._http.credentials.expired: svc._http.credentials.refresh(Request())
                    token = svc._http.credentials.token
                    _gdrive_token = token
                    _gdrive_token_ts = time.time()
        
        res = {
            "url": f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media", 
            "stream_url": f"/api/gdrive-stream/{fid}?stream_token={quote(_make_stream_token(fid), safe='')}",
            "hls_manifest_url": f"/api/hls-manifest/{fid}?stream_token={quote(_make_stream_token(fid), safe='')}",
            "headers": {
                "Authorization": f"Bearer {token}",
                "User-Agent": "Mutflix/1.0" 
            }
        }
        return orjson_jsonify(res)
    except Exception as e: 
        # If cached token failed, force refresh next time
        _gdrive_token = None
        _gdrive_token_ts = 0
        return add_no_cache_headers(orjson_jsonify({"error": "Error getting details"}, 500))


## NOTE:
## Telegram streaming endpoint moved to `telegram_api.py` blueprint (`/api/telegram/stream/...`)
## to guarantee it is registered whenever the Telegram blueprint is enabled.

def _hls_cors_response(content, status=200):
    """Helper: return HLS manifest with proper CORS headers."""
    resp = Response(content, status=status, mimetype='application/vnd.apple.mpegurl')
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = 'Range'
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp

def _get_fresh_gdrive_token():
    """Get a fresh GDrive bearer token, using server-side cache with auto-refresh."""
    global _gdrive_token, _gdrive_token_ts
    now = time.time()
    if _gdrive_token and (now - _gdrive_token_ts) < _gdrive_token_ttl:
        return _gdrive_token
    svc = get_gdrive_service()
    if not svc:
        return None
    with _gdrive_token_lock:
        # Double-check after acquiring lock
        if _gdrive_token and (time.time() - _gdrive_token_ts) < _gdrive_token_ttl:
            return _gdrive_token
        if svc._http.credentials.expired:
            svc._http.credentials.refresh(Request())
        token = svc._http.credentials.token
        _gdrive_token = token
        _gdrive_token_ts = time.time()
        return token


def _make_stream_token(fid, ttl=None):
    """Create a file-scoped token usable by <video>, where custom auth headers are not possible."""
    exp = int(time.time() + (ttl or _stream_token_ttl))
    payload = f"{fid}:{exp}"
    secret = app.config['SECRET_KEY'].encode('utf-8')
    sig = hmac.new(secret, payload.encode('utf-8'), hashlib.sha256).hexdigest()
    raw = f"{payload}:{sig}".encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _verify_stream_token(fid, token):
    if not token:
        return False
    try:
        padded = token + ('=' * (-len(token) % 4))
        raw = base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8')
        token_fid, exp_raw, sig = raw.rsplit(':', 2)
        if token_fid != fid:
            return False
        exp = int(exp_raw)
        if time.time() > exp:
            return False
        payload = f"{token_fid}:{exp}"
        secret = app.config['SECRET_KEY'].encode('utf-8')
        expected = hmac.new(secret, payload.encode('utf-8'), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, expected)
    except Exception:
        return False


def _proxy_gdrive_media(fid):
    """Proxy media with a fresh server-side GDrive token on every Range request."""
    global _gdrive_token, _gdrive_token_ts

    token = _get_fresh_gdrive_token()
    if not token:
        return jsonify({"error": "GDrive token unavailable"}), 503

    media_url = f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media"
    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "Mutflix/1.0",
    }
    range_header = request.headers.get('Range')
    headers["Range"] = range_header or "bytes=0-"

    upstream = requests.get(media_url, headers=headers, stream=True, timeout=(10, 120))
    if upstream.status_code in (401, 403):
        svc = get_gdrive_service()
        if not svc:
            upstream.close()
            return jsonify({"error": "GDrive unavailable"}), 503
        upstream.close()
        with _gdrive_token_lock:
            svc._http.credentials.refresh(Request())
            token = svc._http.credentials.token
            _gdrive_token = token
            _gdrive_token_ts = time.time()
        headers["Authorization"] = f"Bearer {token}"
        upstream = requests.get(media_url, headers=headers, stream=True, timeout=(10, 120))

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=256 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    response_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type",
        "Accept-Ranges": upstream.headers.get("Accept-Ranges", "bytes"),
        "Cache-Control": "private, max-age=3600",
        "X-Accel-Buffering": "no",
    }
    for header in ("Content-Type", "Content-Length", "Content-Range"):
        value = upstream.headers.get(header)
        if value:
            response_headers[header] = value

    return Response(
        stream_with_context(generate()),
        status=upstream.status_code,
        headers=response_headers,
        direct_passthrough=True,
    )


@app.route("/api/gdrive-stream/<fid>")
def gdrive_stream(fid):
    if not _verify_stream_token(fid, request.args.get('stream_token')):
        return jsonify({"error": "Unauthorized stream"}), 401
    return _proxy_gdrive_media(fid)

@app.route("/api/hls-manifest/<fid>")
def get_hls_manifest(fid):
    # Accept access_token from query for backward compat, but always use server-side token
    # so playback doesn't break when client token expires during long sessions.
    access_token = request.args.get('access_token')
    stream_token = request.args.get('stream_token')
    if stream_token and not _verify_stream_token(fid, stream_token):
        return _hls_cors_response("Unauthorized", 401)
    if not access_token and not stream_token:
        return _hls_cors_response("Unauthorized", 401)
    
    svc = get_gdrive_service()
    if not svc:
        return _hls_cors_response("GDrive unavailable", 503)
    
    # Use server's own GDrive token — auto-refreshes, won't expire mid-playback
    server_token = _get_fresh_gdrive_token()
    if not server_token:
        return _hls_cors_response("GDrive token unavailable", 503)
    manifest_nonce = str(int(time.time() * 1000))
    
    headers = {"Authorization": f"Bearer {server_token}"}
    m3u8_url = f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media"
    resp = requests.get(m3u8_url, headers=headers, timeout=15)
    if resp.status_code != 200:
        return _hls_cors_response(f"Failed to fetch m3u8 (status={resp.status_code})", resp.status_code)
        
    m3u8_content = resp.text
    try:
        meta = svc.files().get(fileId=fid, fields="parents").execute()
        parents = meta.get('parents', [])
        if not parents:
            return _hls_cors_response(m3u8_content)
        parent_id = parents[0]
        
        # Get all files in parent to map filenames to file IDs
        files_q = f"'{parent_id}' in parents and trashed = false"
        page_token = None
        file_map = {}
        while True:
            res = svc.files().list(q=files_q, pageSize=1000, fields="nextPageToken, files(id, name)", pageToken=page_token).execute()
            for f in res.get('files', []):
                file_map[f['name']] = f['id']
            page_token = res.get('nextPageToken')
            if not page_token: break
            
        # Rewrite manifest to backend proxy URLs. The proxy refreshes GDrive tokens server-side,
        # so HLS segments keep loading without forcing the player to reset.
        lines = m3u8_content.splitlines()
        new_lines = []
        for line in lines:
            stripped = line.strip()
            if stripped and not stripped.startswith('#'):
                if stripped in file_map:
                    mapped_id = file_map[stripped]
                    mapped_stream_token = quote(_make_stream_token(mapped_id), safe='')
                    if stripped.lower().endswith('.m3u8'):
                        new_lines.append(f"/api/hls-manifest/{mapped_id}?stream_token={mapped_stream_token}&_={manifest_nonce}")
                    else:
                        new_lines.append(f"/api/gdrive-stream/{mapped_id}?stream_token={mapped_stream_token}&_={manifest_nonce}")
                else:
                    new_lines.append(line)
            else:
                new_lines.append(line)
                
        rewritten_m3u8 = "\n".join(new_lines)
        return _hls_cors_response(rewritten_m3u8)
    except Exception as e:
        print(f"[HLS] Error rewriting manifest: {e}")
        return _hls_cors_response(m3u8_content)

@app.route("/subtitle/<path:file_path>")
@rate_limited(limit=120)
def serve_subtitle(file_path):
    """[OPTIMIZED] Serve subtitle from RAM cache first (~0.01ms).
    Falls back to download on cache miss, then auto-caches for next time."""
    # === RAM CACHE HIT (~0.01ms) ===
    cached_content = _subtitle_cache.get(file_path)
    if cached_content:
        mimetype = 'text/vtt' if '.vtt' in file_path.lower() else 'text/plain; charset=utf-8'
        return Response(cached_content, mimetype=mimetype)
    
    # === CACHE MISS: download and cache ===
    content = _download_subtitle(file_path)
    if content:
        # Cache for next request
        with _subtitle_lock:
            _subtitle_cache[file_path] = content
            _subtitle_cache_ts[file_path] = time.time()
        mimetype = 'text/vtt' if '.vtt' in file_path.lower() else 'text/plain; charset=utf-8'
        return Response(content, mimetype=mimetype)
    
    return jsonify({"error": "Not found"}), 404

# ==========================================
# SEARCH API (Server-side instant search)
# ==========================================

@app.route("/api/search")
@token_required(check_expiry=False)
@rate_limited()
def search_content(current_user):
    """[IMPROVED] Server-side instant search with fallback substring matching.
    Query params: q=search_term"""
    query = request.args.get('q', '').strip()
    if not query or len(query) < 1:
        return orjson_jsonify([])

    normalized_query = _normalize_search_string(query)
    resp_key = "resp_search_v2_" + hashlib.md5(normalized_query.encode("utf-8")).hexdigest()
    cached_bytes = _response_cache.get(resp_key)
    if cached_bytes:
        return add_cache_headers(app.response_class(cached_bytes, mimetype='application/json', status=200), max_age=30)
    
    words = _normalize_text(query)
    if not words:
        return orjson_jsonify([])
    
    results = []
    seen = set()

    def _item_search_text(item):
        return _normalize_search_string(
            f"{item.get('name', '')} {item.get('tmdb_title', '')}"
        )
    
    # Strategy 1: Inverted index intersection (fast, exact word matching)
    if words:
        result_sets = []
        for word in words:
            matches = _search_index.get(word, [])
            result_sets.append({item['name'] for item in matches})
        
        if result_sets:
            common_names = result_sets[0]
            for s in result_sets[1:]:
                common_names &= s
            
            first_matches = _search_index.get(words[0], [])
            for item in first_matches:
                item_text = _item_search_text(item)
                if (
                    item['name'] in common_names and
                    item['name'] not in seen and
                    all(word in item_text for word in words)
                ):
                    seen.add(item['name'])
                    results.append(item)
    
    # Strategy 2: Substring fallback — search folder names directly if index gave nothing
    if not results:
        query_lower = normalized_query
        folders = mem_get('folders_list')
        releases = mem_get('content_releases') or []
        tmdb_by_folder = {r.get('folder_name', '').lower(): r for r in releases if r.get('folder_name')}
        if folders:
            for media_type in ['series', 'movies']:
                for item in folders.get(media_type, []):
                    name = item.get('name', '')
                    if name in seen:
                        continue
                    rel = tmdb_by_folder.get(name.lower()) or {}
                    item_text = _normalize_search_string(
                        f"{name} {rel.get('tmdb_title', '')}"
                    )
                    # Match the full normalized query, or every query word for spaced titles.
                    if query_lower in item_text or all(word in item_text for word in words):
                        seen.add(name)
                        result = {
                            'name': name,
                            'folder_name': name,
                            'type': item.get('type', media_type.rstrip('s')),
                            'source': item.get('source', '')
                        }
                        if rel.get('tmdb_title'): result['tmdb_title'] = rel['tmdb_title']
                        if rel.get('tmdb_poster_path'): result['tmdb_poster_path'] = rel['tmdb_poster_path']
                        if rel.get('tmdb_rating'): result['tmdb_rating'] = rel['tmdb_rating']
                        if rel.get('tmdb_overview'): result['tmdb_overview'] = rel['tmdb_overview']
                        results.append(result)
    
    # Sort by relevance: exact prefix match first, then alphabetical
    query_lower = normalized_query
    results.sort(key=lambda x: (
        0 if _item_search_text(x).startswith(query_lower) else 1,
        0 if query_lower in _item_search_text(x) else 1,
        x['name']
    ))
    
    # Final TMDB enrichment for fallback results (Strategy 1 already has it, but it's safe to overwrite/ensure)
    releases = mem_get('content_releases') or []
    tmdb_by_folder = {r.get('folder_name', '').lower(): r for r in releases if r.get('folder_name')}
    
    for res in results[:50]:
        rel = tmdb_by_folder.get(res['name'].lower())
        if rel:
            if rel.get('tmdb_title'): res['tmdb_title'] = rel['tmdb_title']
            if rel.get('tmdb_poster_path'): res['tmdb_poster_path'] = rel['tmdb_poster_path']
            if rel.get('tmdb_rating'): res['tmdb_rating'] = rel['tmdb_rating']
            if rel.get('tmdb_overview'): res['tmdb_overview'] = rel['tmdb_overview']
            
    return add_cache_headers(orjson_jsonify(results[:50], cache_key=resp_key), max_age=30)  # Max 50 results

# ==========================================
# CONTENT RELEASES API (Publish / Schedule)
# ==========================================



def _load_releases():
    """Load content releases from database."""
    conn, db_type = None, None
    try:
        conn, db_type = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT folder_name, status, release_date, media_type, tmdb_title, tmdb_poster_path, tmdb_overview, tmdb_rating, created_at, updated_at FROM content_releases ORDER BY updated_at DESC")
        rows = cur.fetchall()
        return [{
            'folder_name': r[0], 'status': r[1], 'release_date': r[2], 'media_type': r[3],
            'tmdb_title': r[4], 'tmdb_poster_path': r[5], 'tmdb_overview': r[6], 'tmdb_rating': r[7],
            'created_at': r[8], 'updated_at': r[9]
        } for r in rows]
    except Exception as e:
        print(f"Error loading releases: {e}")
        return []
    finally:
        release_db_connection(conn, db_type)

def _save_release(folder_name, data):
    """Upsert a single content release into the database."""
    conn, db_type = None, None
    try:
        conn, db_type = get_db_connection()
        cur = conn.cursor()
        now = time.time()
        # Try update first
        cur.execute(
            "UPDATE content_releases SET status=?, release_date=?, media_type=?, tmdb_title=?, tmdb_poster_path=?, tmdb_overview=?, tmdb_rating=?, updated_at=? WHERE folder_name=?",
            (data.get('status', 'published'), data.get('release_date'), data.get('media_type', 'tv'),
             data.get('tmdb_title'), data.get('tmdb_poster_path'), data.get('tmdb_overview'), data.get('tmdb_rating'),
             now, folder_name)
        )
        if cur.rowcount == 0:
            # Insert new
            cur.execute(
                "INSERT INTO content_releases (folder_name, status, release_date, media_type, tmdb_title, tmdb_poster_path, tmdb_overview, tmdb_rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (folder_name, data.get('status', 'published'), data.get('release_date'), data.get('media_type', 'tv'),
                 data.get('tmdb_title'), data.get('tmdb_poster_path'), data.get('tmdb_overview'), data.get('tmdb_rating'),
                 now, now)
            )
        conn.commit()
    except Exception as e:
        print(f"Error saving release: {e}")
    finally:
        release_db_connection(conn, db_type)

def _delete_release(folder_name):
    """Delete a content release from the database."""
    conn, db_type = None, None
    try:
        conn, db_type = get_db_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM content_releases WHERE folder_name=?", (folder_name,))
        conn.commit()
    except Exception as e:
        print(f"Error deleting release: {e}")
    finally:
        release_db_connection(conn, db_type)

@app.route("/api/content-releases", methods=["GET"])
@token_required(check_expiry=False)
def get_content_releases(current_user):
    """Get all content releases — cached in RAM."""
    key = "content_releases"
    cached = mem_get(key)
    if cached is not None and mem_is_fresh(key, 300):  # 5 min TTL
        return add_cache_headers(orjson_jsonify(cached, cache_key='resp_releases'), max_age=300)
    releases = _load_releases()
    mem_set(key, releases)
    _response_cache.pop('resp_releases', None)
    return add_cache_headers(orjson_jsonify(releases, cache_key='resp_releases'), max_age=300)

@app.route("/api/content-releases", methods=["POST"])
@token_required(check_expiry=False)
def set_content_release(current_user):
    """Create or update a content release (admin only)."""
    data = request.get_json()
    if not data or 'folder_name' not in data:
        return jsonify({"error": "Missing folder_name"}), 400
    
    folder_name = data['folder_name']
    _save_release(folder_name, data)
    # Invalidate content_releases cache
    _mem_cache.pop('content_releases', None)
    _mem_cache_ts.pop('content_releases', None)
    _response_cache.pop('resp_releases', None)
    _invalidate_response_cache('resp_folders_merged')
    return orjson_jsonify({"success": True, "status": data.get('status', 'published')})

@app.route("/api/content-releases/<path:folder_name>", methods=["DELETE"])
@token_required(check_expiry=False)
def delete_content_release(current_user, folder_name):
    """Delete a content release."""
    _delete_release(folder_name)
    # Invalidate content_releases cache
    _mem_cache.pop('content_releases', None)
    _mem_cache_ts.pop('content_releases', None)
    _response_cache.pop('resp_releases', None)
    _invalidate_response_cache('resp_folders_merged')
    return orjson_jsonify({"success": True})


# ==========================================
# DEBUG ROUTES (temporary)
# ==========================================

@app.route("/api/debug/routes", methods=["GET"])
@token_required(check_expiry=False)
def debug_routes(current_user):
    """Return a list of registered routes. Useful to verify deployments."""
    try:
        rules = []
        for r in app.url_map.iter_rules():
            rules.append({
                "rule": str(r),
                "methods": sorted([m for m in r.methods if m not in ("HEAD", "OPTIONS")]),
                "endpoint": r.endpoint,
            })
        # Keep payload small: filter only api/telegram + api/debug
        filtered = [x for x in rules if x["rule"].startswith("/api/telegram") or x["rule"].startswith("/api/debug")]
        filtered.sort(key=lambda x: x["rule"])
        return orjson_jsonify(filtered)
    except Exception as e:
        return orjson_jsonify({"error": str(e)}, 500)

# Frontend Serve
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_fe(path):
    if path.startswith("api/") or path.startswith("video/") or path.startswith("subtitle/"): return jsonify({"error": "Not found"}), 404
    if path and os.path.exists(os.path.join(app.static_folder, path)): return send_from_directory(app.static_folder, path)
    return send_from_directory(app.static_folder, "index.html")


if __name__ == '__main__':
    # Build search index immediately using disk cache
    print("[INIT] Building initial search index from disk cache...", flush=True)
    build_search_index()
    print("[INIT] Search index ready.", flush=True)
    
    # Start background cache worker thread
    
    threading.Thread(target=background_cache_worker, daemon=True).start()
    port = int(os.environ.get("PORT", 8000))
    app.run(host='0.0.0.0', port=port, threaded=True)
