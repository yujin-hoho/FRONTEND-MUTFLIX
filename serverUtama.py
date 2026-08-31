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
import shutil
import subprocess
from functools import wraps, lru_cache
import concurrent.futures
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
from urllib.parse import quote, unquote, urlparse
import unicodedata
from time import monotonic as _monotonic
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import io

try:
    from PIL import Image, ImageOps
    _HAS_PIL = True
except ImportError:
    _HAS_PIL = False
    print("WARNING: 'PIL' (Pillow) library not installed. Image resizing fallback to raw.", flush=True)

# --- HIGH-PERFORMANCE LIBRARIES (HuggingFace Optimized) ---
import orjson
import diskcache
from flask_compress import Compress

# --- REDIS (Shared cross-worker cache layer) ---
try:
    import redis as _redis_lib
    _HAS_REDIS = True
except ImportError:
    _redis_lib = None
    _HAS_REDIS = False
    print("WARNING: 'redis' library not installed. Redis caching disabled.", flush=True)

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
from google.oauth2.credentials import Credentials
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
# Poster memakai akun/credential yang sama dengan subtitle. Token poster lama
# hanya menjadi fallback untuk deployment lama yang belum punya token subtitle.
GDRIVE_POSTER_TOKEN_B64 = (
    GDRIVE_SUBTITLE_TOKEN_B64 or os.environ.get('GDRIVE_POSTER_TOKEN_B64')
)
GDRIVE_POSTER_FOLDER_ID = os.environ.get('GDRIVE_POSTER_FOLDER_ID')
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
_SUBTITLE_RATE_LIMIT_RPM = int(os.environ.get('SUBTITLE_RATE_LIMIT_RPM', '600'))
_rate_limit_store = {}  # {(scope, ip): [timestamp, timestamp, ...]}
_rate_limit_lock = threading.Lock()

def _rate_limit_check(limit=None, scope=None):
    """Check rate limit for current request IP. Returns (allowed, retry_after_seconds)."""
    if limit is None:
        limit = _RATE_LIMIT_RPM
    ip = request.headers.get('X-Forwarded-For', request.remote_addr)
    if ip and ',' in ip:
        ip = ip.split(',')[0].strip()  # Take first IP from proxy chain
    bucket_key = (scope or request.endpoint or 'default', ip or 'unknown')
    now = _monotonic()
    window = 60.0  # 1 minute window
    
    with _rate_limit_lock:
        if bucket_key not in _rate_limit_store:
            _rate_limit_store[bucket_key] = []
        
        # Clean old entries outside window
        _rate_limit_store[bucket_key] = [t for t in _rate_limit_store[bucket_key] if now - t < window]
        
        if len(_rate_limit_store[bucket_key]) >= limit:
            oldest = _rate_limit_store[bucket_key][0]
            retry_after = int(window - (now - oldest)) + 1
            return False, max(retry_after, 1)
        
        _rate_limit_store[bucket_key].append(now)
        
        # Periodic cleanup: remove IPs with no recent activity (every ~100 requests)
        if len(_rate_limit_store) > 1000:
            stale_ips = [k for k, v in _rate_limit_store.items() if not v or now - v[-1] > window * 2]
            for k in stale_ips:
                del _rate_limit_store[k]
    
    return True, 0

def rate_limited(limit=None, scope=None, cors=False):
    """Decorator: rate limit an endpoint by IP address."""
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            allowed, retry_after = _rate_limit_check(limit, scope or f.__name__)
            if not allowed:
                resp = orjson_jsonify({"error": "Rate limit exceeded", "retry_after": retry_after}, 429)
                resp.headers['Retry-After'] = str(retry_after)
                if cors:
                    resp.headers['Access-Control-Allow-Origin'] = '*'
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
TMDB_META_WORKERS = max(1, int(os.environ.get('TMDB_META_WORKERS', '8')))
TMDB_META_BULK_MAX_ITEMS = max(1, int(os.environ.get('TMDB_META_BULK_MAX_ITEMS', '40')))
TMDB_HTTP_RETRIES = max(0, int(os.environ.get('TMDB_HTTP_RETRIES', '1')))
TMDB_HTTP_BACKOFF_SECONDS = max(0.0, float(os.environ.get('TMDB_HTTP_BACKOFF_SECONDS', '0.35')))
SEARCH_RESPONSE_CACHE_TTL_SECONDS = 30
WATCH_HISTORY_ACTIVE_CUTOFF = 0.90  # >=90% watched is treated as completed server-side
WATCH_HISTORY_STALE_SKEW = datetime.timedelta(seconds=5)
AUDIO_TRANSCODE_AUDIO_BITRATE = os.environ.get('AUDIO_TRANSCODE_AUDIO_BITRATE', '192k')
AUDIO_TRANSCODE_MAX_CONCURRENT = max(1, int(os.environ.get('AUDIO_TRANSCODE_MAX_CONCURRENT', '2')))
AUDIO_TRANSCODE_SLOT_WAIT_SECONDS = max(0.0, float(os.environ.get('AUDIO_TRANSCODE_SLOT_WAIT_SECONDS', '3')))
AUDIO_TRANSCODE_PROBE_TIMEOUT_SECONDS = max(5, int(os.environ.get('AUDIO_TRANSCODE_PROBE_TIMEOUT_SECONDS', '25')))
AUDIO_TRANSCODE_KEYFRAME_CACHE_TTL_SECONDS = max(60, int(os.environ.get('AUDIO_TRANSCODE_KEYFRAME_CACHE_TTL_SECONDS', '86400')))
AUDIO_TRANSCODE_KEYFRAME_PROBE_TIMEOUT_SECONDS = max(1, int(os.environ.get('AUDIO_TRANSCODE_KEYFRAME_PROBE_TIMEOUT_SECONDS', '6')))
AUDIO_TRANSCODE_KEYFRAME_LOOKBEHIND_SECONDS = max(1.0, float(os.environ.get('AUDIO_TRANSCODE_KEYFRAME_LOOKBEHIND_SECONDS', '60')))
AUDIO_TRANSCODE_KEYFRAME_PROBE_ATTEMPTS = max(1, int(os.environ.get('AUDIO_TRANSCODE_KEYFRAME_PROBE_ATTEMPTS', '1')))
AUDIO_TRANSCODE_KEYFRAME_PROBE_RETRY_DELAY_SECONDS = max(0.0, float(os.environ.get('AUDIO_TRANSCODE_KEYFRAME_PROBE_RETRY_DELAY_SECONDS', '0.35')))
EMBEDDED_SUBTITLE_CACHE_TTL_SECONDS = max(300, int(os.environ.get('EMBEDDED_SUBTITLE_CACHE_TTL_SECONDS', str(7 * 24 * 60 * 60))))
EMBEDDED_SUBTITLE_EMPTY_CACHE_TTL_SECONDS = max(30, int(os.environ.get('EMBEDDED_SUBTITLE_EMPTY_CACHE_TTL_SECONDS', '300')))
EMBEDDED_SUBTITLE_EXTRACT_TIMEOUT_SECONDS = max(30, int(os.environ.get('EMBEDDED_SUBTITLE_EXTRACT_TIMEOUT_SECONDS', '300')))
EMBEDDED_SUBTITLE_MAX_CONCURRENT = max(1, int(os.environ.get('EMBEDDED_SUBTITLE_MAX_CONCURRENT', '2')))
EMBEDDED_SUBTITLE_FAST_PROBE_TIMEOUT_SECONDS = max(2, int(os.environ.get('EMBEDDED_SUBTITLE_FAST_PROBE_TIMEOUT_SECONDS', '6')))
EMBEDDED_SUBTITLE_DEEP_PROBE_TIMEOUT_SECONDS = max(10, int(os.environ.get('EMBEDDED_SUBTITLE_DEEP_PROBE_TIMEOUT_SECONDS', '120')))
EMBEDDED_SUBTITLE_VTT_CACHE_VERSION = 'v6'

# diskcache: thread-safe, process-safe, persistent backup — 5GB for 16GB RAM machine
disk_cache = diskcache.Cache(CACHE_DIR, size_limit=5 * 1024 * 1024 * 1024)

# --- REDIS CLIENT INITIALIZATION ---
redis_client = None
_REDIS_URL = os.environ.get('REDIS_URL')
if _HAS_REDIS and _REDIS_URL:
    try:
        redis_client = _redis_lib.from_url(
            _REDIS_URL,
            decode_responses=False,   # kita handle encode/decode sendiri pakai orjson
            socket_timeout=2,         # timeout 2 detik biar gak blocking
            socket_connect_timeout=2,
            retry_on_timeout=True,
        )
        redis_client.ping()
        print("[INIT] \u2705 Redis connected successfully!", flush=True)
    except Exception as _redis_err:
        redis_client = None
        print(f"[INIT] \u26a0\ufe0f Redis connection failed: {_redis_err} — falling back to DiskCache", flush=True)
elif not _REDIS_URL:
    print("[INIT] \u26a0\ufe0f REDIS_URL not set — Redis caching disabled, using DiskCache fallback", flush=True)

# === REDIS HELPER FUNCTIONS ===
# Semua operasi Redis dibungkus try/except supaya KALAU Redis mati,
# server tetap jalan pakai fallback (DiskCache / RAM)

def redis_get(key):
    """Get value from Redis, return None if miss or error."""
    if not redis_client:
        return None
    try:
        raw = redis_client.get(key)
        if raw is None:
            return None
        return orjson.loads(raw)
    except Exception as e:
        print(f"[REDIS] GET error ({key}): {e}", flush=True)
        return None

def redis_set(key, value, ttl_seconds=1800):
    """Set value in Redis with TTL. Silently fails if Redis down."""
    if not redis_client:
        return
    try:
        raw = orjson.dumps(value)
        redis_client.setex(key, ttl_seconds, raw)
    except Exception as e:
        print(f"[REDIS] SET error ({key}): {e}", flush=True)

def redis_delete(*keys):
    """Delete one or more keys from Redis."""
    if not redis_client or not keys:
        return
    try:
        redis_client.delete(*keys)
    except Exception as e:
        print(f"[REDIS] DEL error: {e}", flush=True)

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
_tmdb_meta_executor = ThreadPoolExecutor(max_workers=TMDB_META_WORKERS)
_tmdb_http_local = threading.local()

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
FOLDERS_MERGED_RESPONSE_CACHE_KEY = 'resp_folders_merged_v3'
_folders_build_lock = threading.Lock()
_tmdb_folder_meta_prefetch_lock = threading.Lock()
_tmdb_folder_meta_prefetch_running = False

# === TMDB OVERRIDE RAM CACHE ===
# Avoids DB reads + deepcopy/merge work on every /api/folders request.
_tmdb_overrides_cache = None      # {folder_name: override_dict}
_tmdb_overrides_ts = 0
_tmdb_overrides_lock = threading.Lock()
_tmdb_overrides_refresh_lock = threading.Lock()
_tmdb_overrides_retry_after = 0

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
_gdrive_file_metadata_cache = {}
_gdrive_file_metadata_cache_ts = {}
_gdrive_file_metadata_cache_ttl = 24 * 60 * 60
_gdrive_file_metadata_retry_ttl = 60
_gdrive_file_metadata_cache_lock = threading.Lock()
_gdrive_file_metadata_key_locks = {}
_gdrive_file_metadata_key_locks_lock = threading.Lock()
_browser_supported_audio_codecs = frozenset({'aac', 'mp3', 'mp2', 'opus', 'vorbis'})

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

def _invalidate_response_cache_prefix(prefix):
    with _response_lock:
        for key in [key for key in _response_cache if key.startswith(prefix)]:
            _response_cache.pop(key, None)
            _response_cache_ts.pop(key, None)

def _response_keys_for_data_cache(key):
    """Map shared data-cache keys to per-worker serialized response keys."""
    if key == 'folders_list':
        return ('resp_folders', FOLDERS_MERGED_RESPONSE_CACHE_KEY)
    if key == 'content_releases':
        return ('resp_releases', FOLDERS_MERGED_RESPONSE_CACHE_KEY)
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
    """Cross-worker invalidation: Redis + diskcache + RAM."""
    now = time.time()
    cache_keys = [cache_key]
    if cache_type == 'mylist' and not cache_key.endswith(('_all', '_plan_to_watch', '_completed')):
        cache_keys = [f"{cache_key}_{status}" for status in ('all', 'plan_to_watch', 'completed')]

    for next_cache_key in cache_keys:
        inv_key = f"_inv_{cache_type}_{next_cache_key}"
        try:
            disk_cache.set(inv_key, now, expire=3600)  # TTL 1 jam
        except: pass
    # === REDIS INVALIDATION ===
    if cache_type == 'profiles':
        redis_delete(f"profiles:{cache_key}")
    elif cache_type == 'mylist':
        for next_cache_key in cache_keys:
            redis_delete(f"mylist:{next_cache_key}")
    with _user_data_lock:
        if cache_type == 'profiles':
            _user_profiles_cache.pop(cache_key, None)
            _user_profiles_cache_ts.pop(cache_key, None)
        elif cache_type == 'mylist':
            for next_cache_key in cache_keys:
                _user_mylist_cache.pop(next_cache_key, None)
                _user_mylist_cache_ts.pop(next_cache_key, None)

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
                series_path TEXT,
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
            "ALTER TABLE watch_history ADD COLUMN series_path TEXT",
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
                tmdb_id INTEGER,
                override_year INTEGER,
                override_language VARCHAR(10),
                include_adult BOOLEAN DEFAULT FALSE,
                override_region VARCHAR(10),
                updated_by INTEGER,
                updated_at TIMESTAMP DEFAULT {now_func}
            );
        """)
        # Migrations for existing databases: add new columns if they don't exist
        for col, col_type in [('tmdb_id', 'INTEGER'), ('override_year', 'INTEGER'), ('override_language', 'VARCHAR(10)'), ('include_adult', 'BOOLEAN DEFAULT FALSE'), ('override_region', 'VARCHAR(10)')]:
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

        # Permanent catalog ID registry. Rows are intentionally never deleted:
        # a removed movie/series must keep its old ID reserved forever.
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS catalog_item_ids (
                media_type VARCHAR(20) NOT NULL,
                folder_name TEXT NOT NULL,
                catalog_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT {now_func},
                PRIMARY KEY (media_type, folder_name),
                UNIQUE (media_type, catalog_id)
            );
        """)
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
            'tmdb_id': override.get('tmdb_id'),
            'tmdb_query': override.get('tmdb_query'),
            'override_year': override.get('override_year'),
            'override_language': override.get('override_language'),
            'include_adult': override.get('include_adult'),
            'override_region': override.get('override_region'),
        }
    normalized = {
        'v': 2,
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

def _get_or_resolve_tmdb_meta_payload(media_type, folder_name, explicit_tmdb_id=None):
    """Resolve one TMDB metadata payload, using the same cache path as the GET endpoint."""
    media_type = (media_type or '').strip().lower()
    folder_name = (folder_name or '').strip()
    if media_type not in ('tv', 'movie'):
        return 400, {'error': 'media_type must be tv or movie'}, None
    if not folder_name:
        return 400, {'error': 'folder_name is required'}, None

    override = _get_tmdb_overrides_map().get(folder_name)
    if not override and explicit_tmdb_id:
        override = {'tmdb_id': explicit_tmdb_id}

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

def _positive_int_or_none(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        parsed = int(str(value).strip())
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None

def _get_tmdb_http_session():
    """Return a per-thread TMDB session with small, bounded transient retries."""
    session = getattr(_tmdb_http_local, 'session', None)
    if session is not None:
        return session

    retry = Retry(
        total=TMDB_HTTP_RETRIES,
        connect=TMDB_HTTP_RETRIES,
        read=TMDB_HTTP_RETRIES,
        status=TMDB_HTTP_RETRIES,
        backoff_factor=TMDB_HTTP_BACKOFF_SECONDS,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({'GET'}),
        raise_on_status=False,
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=2, pool_maxsize=2)
    session = requests.Session()
    session.mount('https://', adapter)
    _tmdb_http_local.session = session
    return session

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
        started_at = _monotonic()
        response = _get_tmdb_http_session().get(
            f'https://api.themoviedb.org/3/{tmdb_path}',
            params=upstream_params,
            timeout=timeout,
        )
        elapsed_ms = int((_monotonic() - started_at) * 1000)
        if response.status_code == 429 or response.status_code >= 500:
            print(f"[TMDB-UPSTREAM] path={tmdb_path} status={response.status_code} elapsed_ms={elapsed_ms}", flush=True)
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
        detail_params = {'append_to_response': 'content_ratings,videos'}
    else:
        if year:
            search_params['primary_release_year'] = str(year)
        search_path = 'search/movie'
        detail_prefix = 'movie'
        detail_params = {'append_to_response': 'videos'}

    if override:
        language = (override.get('override_language') or '').strip()
        if language:
            search_params['language'] = language
        if _tmdb_bool(override.get('include_adult')):
            search_params['include_adult'] = 'true'
        region = (override.get('override_region') or '').strip()
        if media_type == 'movie' and region:
            search_params['region'] = region

    override_tmdb_id = _positive_int_or_none(override.get('tmdb_id')) if override else None
    if override_tmdb_id:
        detail_status, detail_data = _fetch_tmdb_json_server(
            f'{detail_prefix}/{override_tmdb_id}',
            detail_params,
        )
        if detail_status != 200:
            return detail_status, {
                'error': 'TMDB detail failed',
                'status': detail_status,
                'folder_name': folder_name,
                'query': query,
                'tmdb_id': override_tmdb_id,
            }
        return 200, detail_data

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

@app.route('/api/search-trailer', methods=['GET'])
@token_required(check_expiry=False)
def search_trailer(current_user):
    query = request.args.get('q')
    if not query:
        return orjson_jsonify({'error': 'query is required'}, 400)
    
    cache_key = f"trailer_search_{query.lower().strip()}"
    try:
        cached_val = disk_cache.get(cache_key)
        if cached_val:
            return orjson_jsonify({'videoId': cached_val})
    except:
        pass

    instances = [
        'https://yewtu.be',
        'https://vid.puffyan.us',
        'https://invidious.flokinet.to',
        'https://inv.tux.im',
        'https://invidious.io.lol'
    ]
    for instance in instances:
        try:
            r = requests.get(f"{instance}/api/v1/search", params={'q': query}, timeout=4)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list):
                    first_video = next((vid for vid in data if vid.get('type') == 'video'), None)
                    if first_video and first_video.get('videoId'):
                        vid_id = first_video['videoId']
                        try:
                            disk_cache.set(cache_key, vid_id, expire=86400 * 7)
                        except:
                            pass
                        return orjson_jsonify({'videoId': vid_id})
        except Exception:
            pass
            
    return orjson_jsonify({'error': 'no trailer found'}, 404)

@app.route('/api/tmdb-meta/bulk', methods=['POST'])
@token_required(check_expiry=False)
def bulk_tmdb_meta(current_user):
    """Resolve many folder metadata records with bounded upstream concurrency."""
    request_id = request.headers.get('X-Request-ID') or uuid.uuid4().hex[:12]
    started_at = _monotonic()

    def _response(payload, status=200):
        resp = orjson_jsonify(payload, status)
        resp.headers['X-TMDB-Bulk-Request-ID'] = request_id
        return resp

    try:
        if not TMDB_API_KEY:
            return _response({'error': 'TMDB_API_KEY is not configured on server'}, 503)

        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return _response({'error': 'JSON body must be an object'}, 400)

        raw_items = data.get('items') or []
        if not isinstance(raw_items, list):
            return _response({'error': 'items must be a list'}, 400)
        if len(raw_items) > TMDB_META_BULK_MAX_ITEMS:
            return _response({
                'error': 'Too many TMDB metadata items',
                'max_items': TMDB_META_BULK_MAX_ITEMS,
            }, 413)

        unique_items = []
        seen = set()
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            media_type = str(raw.get('media_type') or raw.get('type') or '').strip().lower()
            if media_type == 'series':
                media_type = 'tv'
            folder_name = str(raw.get('folder_name') or raw.get('name') or '').strip()
            tmdb_id = _positive_int_or_none(raw.get('tmdb_id'))
            key = (media_type, folder_name)
            if media_type not in ('tv', 'movie') or not folder_name or key in seen:
                continue
            seen.add(key)
            unique_items.append({'media_type': media_type, 'folder_name': folder_name, 'tmdb_id': tmdb_id})

        def _resolve_item(item):
            status, payload, cache_status = _get_or_resolve_tmdb_meta_payload(
                item['media_type'],
                item['folder_name'],
                explicit_tmdb_id=item.get('tmdb_id'),
            )
            return {
                'media_type': item['media_type'],
                'folder_name': item['folder_name'],
                'status': status,
                'cache': cache_status or 'MISS',
                'payload': payload,
            }

        futures = {
            _tmdb_meta_executor.submit(_resolve_item, item): item
            for item in unique_items
        }
        results = []
        for future in as_completed(futures):
            item = futures[future]
            try:
                results.append(future.result())
            except Exception as e:
                print(f"[TMDB-BULK] request_id={request_id} item={item!r} failed: {e}", flush=True)
                results.append({
                    'media_type': item['media_type'],
                    'folder_name': item['folder_name'],
                    'status': 500,
                    'cache': 'ERROR',
                    'payload': {'error': 'TMDB metadata item failed'},
                })

        status_counts = defaultdict(int)
        cache_counts = defaultdict(int)
        for result in results:
            status_counts[result['status']] += 1
            cache_counts[result['cache']] += 1
        elapsed_ms = int((_monotonic() - started_at) * 1000)
        print(
            f"[TMDB-BULK] request_id={request_id} items={len(results)} elapsed_ms={elapsed_ms} "
            f"statuses={dict(status_counts)} caches={dict(cache_counts)}",
            flush=True,
        )
        return _response({'results': results, 'count': len(results)})
    except Exception as e:
        print(f"[TMDB-BULK] request_id={request_id} route failed: {e}\n{traceback.format_exc()}", flush=True)
        return _response({'error': 'TMDB bulk metadata request failed', 'request_id': request_id}, 500)

import collections
_IMG_MEM_CACHE = collections.OrderedDict()
_IMG_MEM_LOCK = threading.Lock()

def _get_img_mem(key):
    with _IMG_MEM_LOCK:
        if key in _IMG_MEM_CACHE:
            _IMG_MEM_CACHE.move_to_end(key)
            return _IMG_MEM_CACHE[key]
        return None

def _set_img_mem(key, val):
    with _IMG_MEM_LOCK:
        _IMG_MEM_CACHE[key] = val
        _IMG_MEM_CACHE.move_to_end(key)
        if len(_IMG_MEM_CACHE) > 5000:
            _IMG_MEM_CACHE.popitem(last=False)

_TMDB_IMAGE_SESSION = requests.Session()
_tmdb_img_adapter = requests.adapters.HTTPAdapter(pool_connections=64, pool_maxsize=64, max_retries=1)
_TMDB_IMAGE_SESSION.mount('https://', _tmdb_img_adapter)

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
    resp.headers['Cache-Control'] = f'public, max-age={remaining}, immutable'
    resp.headers['X-TMDB-Image-Cache'] = cache_status
    return resp

def _get_tmdb_image_cache(cache_key):
    now = time.time()
    # 1. RAM Memory Cache
    mem_entry = _get_img_mem(cache_key)
    if mem_entry and now - mem_entry.get('ts', 0) < TMDB_CACHE_TTL_SECONDS:
        return mem_entry, 'HIT-MEM'

    # 2. Disk Cache
    try:
        entry = disk_cache.get(cache_key)
    except Exception:
        entry = None
    if entry and now - entry.get('ts', 0) < TMDB_CACHE_TTL_SECONDS:
        _set_img_mem(cache_key, entry)
        return entry, 'HIT-DISK'
    return None, None

def _set_tmdb_image_cache(cache_key, response, size="w500"):
    if response.status_code not in (200, 404):
        return
    body = response.content
    content_type = response.headers.get('Content-Type', 'image/jpeg')
    if response.status_code == 200 and _HAS_PIL:
        target_w = 500
        if size.startswith('w') and size[1:].isdigit():
            target_w = int(size[1:])
        elif size == 'original':
            target_w = 1280
        opt_bytes, opt_mime = optimize_image_bytes(body, target_width=target_w, quality=82, output_format="WEBP")
        if opt_bytes:
            body = opt_bytes
            content_type = opt_mime or "image/webp"

    entry = {
        'status': response.status_code,
        'content_type': content_type,
        'body': body,
        'ts': time.time(),
    }
    _set_img_mem(cache_key, entry)
    try:
        disk_cache.set(cache_key, entry, expire=TMDB_CACHE_TTL_SECONDS)
    except Exception as e:
        print(f"[TMDB-IMAGE] disk cache set failed: {e}", flush=True)

@app.route('/api/tmdb-image/<size>/<path:image_path>', methods=['GET'])
@rate_limited(limit=3000)
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
        response = _TMDB_IMAGE_SESSION.get(
            f'https://image.tmdb.org/t/p/{size}/{quoted_path}',
            timeout=10,
        )
        _set_tmdb_image_cache(cache_key, response, size=size)
        cached_entry, _ = _get_tmdb_image_cache(cache_key)
        if cached_entry:
            return _tmdb_image_response_from_cache(cached_entry, 'MISS-OPT')

        proxied = Response(
            response.content,
            status=response.status_code,
            content_type=response.headers.get('Content-Type', 'image/jpeg'),
        )
        proxied.headers['Cache-Control'] = f'public, max-age={TMDB_CACHE_TTL_SECONDS}, immutable' if response.status_code in (200, 404) else 'no-store'
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
        select_cols = 'folder_name, tmdb_query, media_type, tmdb_id, override_year, override_language, include_adult, override_region'
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
    tmdb_id = _positive_int_or_none(data.get('tmdb_id'))
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
                INSERT INTO tmdb_overrides (folder_name, tmdb_query, media_type, tmdb_id, override_year, override_language, include_adult, override_region, updated_by, updated_at)
                VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, NOW())
                ON CONFLICT (folder_name) DO UPDATE SET 
                    tmdb_query = EXCLUDED.tmdb_query, media_type = EXCLUDED.media_type,
                    tmdb_id = EXCLUDED.tmdb_id,
                    override_year = EXCLUDED.override_year, override_language = EXCLUDED.override_language,
                    include_adult = EXCLUDED.include_adult, override_region = EXCLUDED.override_region,
                    updated_by = EXCLUDED.updated_by, updated_at = NOW()
            """, (folder_name, tmdb_query, media_type, tmdb_id, override_year, override_language, include_adult, override_region, current_user['id']))
        else:
            cur.execute(f"""
                INSERT INTO tmdb_overrides (folder_name, tmdb_query, media_type, tmdb_id, override_year, override_language, include_adult, override_region, updated_by)
                VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph})
                ON CONFLICT (folder_name) DO UPDATE SET 
                    tmdb_query = excluded.tmdb_query, media_type = excluded.media_type,
                    tmdb_id = excluded.tmdb_id,
                    override_year = excluded.override_year, override_language = excluded.override_language,
                    include_adult = excluded.include_adult, override_region = excluded.override_region,
                    updated_by = excluded.updated_by
            """, (folder_name, tmdb_query, media_type, tmdb_id, override_year, override_language, include_adult, override_region, current_user['id']))
        
        conn.commit()
        _invalidate_tmdb_override_cache()
        print(f"[TMDB-OVERRIDE] Admin {current_user['username']} set override: '{folder_name}' -> '{tmdb_query}' ({media_type}, tmdb_id={tmdb_id}, year={override_year}, lang={override_language}, adult={include_adult}, region={override_region})", flush=True)
        return orjson_jsonify({'success': True, 'folder_name': folder_name, 'tmdb_query': tmdb_query, 'tmdb_id': tmdb_id})
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
    global _tmdb_overrides_cache, _tmdb_overrides_ts, _tmdb_overrides_retry_after
    with _tmdb_overrides_lock:
        _tmdb_overrides_cache = None
        _tmdb_overrides_ts = 0
        _tmdb_overrides_retry_after = 0
    redis_delete("tmdb_overrides:all")
    _invalidate_response_cache('resp_folders', FOLDERS_MERGED_RESPONSE_CACHE_KEY)

def _get_tmdb_overrides_map():
    global _tmdb_overrides_cache, _tmdb_overrides_ts, _tmdb_overrides_retry_after
    
    # Try Redis first (Tier 1)
    redis_key = "tmdb_overrides:all"
    redis_data = redis_get(redis_key)
    if redis_data is not None:
        with _tmdb_overrides_lock:
            _tmdb_overrides_cache = redis_data
            _tmdb_overrides_ts = time.time()
            _tmdb_overrides_retry_after = 0
        return redis_data

    now = time.time()
    with _tmdb_overrides_lock:
        if _tmdb_overrides_cache is not None and (now - _tmdb_overrides_ts) < 300:
            return _tmdb_overrides_cache
        if now < _tmdb_overrides_retry_after:
            return _tmdb_overrides_cache or {}

    # 1. Load baseline overrides from static list.json (Zero DB overhead)
    base_overrides = {}
    list_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'list.json')
    if os.path.exists(list_path):
        try:
            with open(list_path, 'r', encoding='utf-8') as f:
                ld = json.load(f)
                for cat in ('series', 'movies'):
                    for entry in ld.get(cat, []):
                        if isinstance(entry, dict) and entry.get('name'):
                            t_id = entry.get('tmdb_id') or entry.get('idtmdb')
                            if t_id:
                                base_overrides[entry['name']] = {
                                    'folder_name': entry['name'],
                                    'tmdb_query': entry.get('tmdb_query') or entry['name'],
                                    'media_type': entry.get('media_type') or ('tv' if cat == 'series' else 'movie'),
                                    'tmdb_id': int(t_id),
                                    'override_year': entry.get('override_year'),
                                    'override_language': entry.get('override_language'),
                                    'override_region': entry.get('override_region'),
                                    'include_adult': entry.get('include_adult', False),
                                }
        except Exception as e:
            print(f"[TMDB-OVERRIDE] failed reading list.json overrides: {e}", flush=True)

    with _tmdb_overrides_refresh_lock:
        now = time.time()
        with _tmdb_overrides_lock:
            if _tmdb_overrides_cache is not None and (now - _tmdb_overrides_ts) < 300:
                return _tmdb_overrides_cache
            if now < _tmdb_overrides_retry_after:
                return _tmdb_overrides_cache or base_overrides

        select_cols = 'folder_name, tmdb_query, media_type, tmdb_id, override_year, override_language, include_adult, override_region'
        last_error = None
        for attempt in range(3):
            conn, db_type = None, None
            try:
                conn, db_type = get_db_connection()
                if db_type == 'postgres':
                    cur = conn.cursor(cursor_factory=RealDictCursor)
                    cur.execute(f'SELECT {select_cols} FROM tmdb_overrides')
                    rows = [dict(r) for r in cur.fetchall()]
                else:
                    import sqlite3
                    conn.row_factory = sqlite3.Row
                    rows = [dict(r) for r in conn.execute(f'SELECT {select_cols} FROM tmdb_overrides').fetchall()]
                
                by_name = dict(base_overrides)
                for r in rows:
                    by_name[r['folder_name']] = r

                with _tmdb_overrides_lock:
                    _tmdb_overrides_cache = by_name
                    _tmdb_overrides_ts = time.time()
                    _tmdb_overrides_retry_after = 0
                
                # Write to Redis
                redis_set(redis_key, by_name, ttl_seconds=43200) # 12 hours
                return by_name
            except Exception as e:
                last_error = e
                if attempt < 2:
                    time.sleep(0.25 * (attempt + 1))
            finally:
                release_db_connection(conn, db_type)

        print(f"[TMDB-OVERRIDE] load override cache failed after retries: {last_error}", flush=True)
        with _tmdb_overrides_lock:
            _tmdb_overrides_retry_after = time.time() + 30
            _tmdb_overrides_cache = base_overrides
            return base_overrides

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
            default_mt = 'tv' if cat == 'series' else 'movie'
            for item in all_c.get(cat) or []:
                name = item.get('name')
                if not name or name not in by_name:
                    continue
                o = by_name[name]
                item['tmdb_query'] = o['tmdb_query']
                item['tmdb_override_media_type'] = (o.get('media_type') or default_mt).strip()
                item['tmdb_id'] = o.get('tmdb_id')
                item['override_year'] = o.get('override_year')
                item['override_region'] = o.get('override_region')
                item['override_language'] = o.get('override_language')
                ia = o.get('include_adult')
                item['include_adult'] = bool(ia) if ia is not None else False
    except Exception as e:
        print(f"[TMDB-OVERRIDE] merge into folders failed: {e}", flush=True)
    return all_c

def _get_tmdb_meta_by_id(tmdb_id, media_type='movie'):
    """Fetch TMDB rating, description/overview & genres based on tmdb_id."""
    if not tmdb_id:
        return {}
    try:
        t_id = int(tmdb_id)
        if t_id <= 0:
            return {}
    except (ValueError, TypeError):
        return {}

    prefix = 'tv' if str(media_type).lower() in ('tv', 'series') else 'movie'
    cache_key = f"tmdb_meta_info:{prefix}:{t_id}"

    # 1. Check RAM memory cache
    cached_val = mem_get(cache_key)
    if cached_val is not None and isinstance(cached_val, dict):
        return cached_val

    # 2. Check Redis cache
    r_val = redis_get(cache_key)
    if r_val is not None:
        try:
            val = json.loads(r_val) if isinstance(r_val, str) else r_val
            if isinstance(val, dict):
                mem_set(cache_key, val)
                return val
        except Exception:
            pass

    if not TMDB_API_KEY:
        return {}

    # 3. Fetch from TMDB (via server proxy cache or upstream)
    try:
        status, data = _fetch_tmdb_json_server(f"{prefix}/{t_id}", {})
        if status == 200 and isinstance(data, dict):
            va = data.get('vote_average')
            rating = round(float(va), 1) if va is not None else None
            overview = data.get('overview') or ''
            title = data.get('title') or data.get('name') or ''
            raw_genres = data.get('genres') or []
            genres = [g.get('name') for g in raw_genres if isinstance(g, dict) and g.get('name')]
            result = {
                'rating': rating,
                'description': overview,
                'overview': overview,
                'tmdb_title': title,
                'genres': genres,
            }
            mem_set(cache_key, result)
            redis_set(cache_key, json.dumps(result), ttl_seconds=604800)  # 7 days cache
            return result
    except Exception as e:
        print(f"[TMDB-META-INFO] Fetch meta failed for {prefix}/{t_id}: {e}", flush=True)

    return {}

def _merge_tmdb_ratings_into_folders(all_c):
    """Attach rating, tmdb_rating, description, overview & genres to each item based on tmdb_id."""
    if not all_c:
        return all_c
    try:
        items_to_fetch = []
        for cat in ('series', 'movies'):
            default_mt = 'tv' if cat == 'series' else 'movie'
            for item in all_c.get(cat) or []:
                # Synchronize existing description/overview if present
                existing_desc = item.get('description') or item.get('overview') or item.get('tmdb_overview')
                if existing_desc:
                    item['description'] = existing_desc
                    item['overview'] = existing_desc
                    item['tmdb_overview'] = existing_desc

                existing_rating = item.get('rating') or item.get('tmdb_rating')
                if existing_rating is not None:
                    try:
                        r_val = round(float(existing_rating), 1)
                        item['rating'] = r_val
                        item['tmdb_rating'] = r_val
                    except (ValueError, TypeError):
                        pass

                existing_genres = item.get('genres') or item.get('genre')
                if existing_genres and isinstance(existing_genres, list):
                    item['genres'] = existing_genres
                    item['genre'] = existing_genres

                # If rating, description, and genres are already populated, no need to fetch
                if item.get('rating') is not None and item.get('description') and item.get('genres'):
                    continue

                t_id = item.get('tmdb_id') or item.get('idtmdb')
                if t_id:
                    mt = item.get('tmdb_override_media_type') or item.get('type') or default_mt
                    prefix = 'tv' if str(mt).lower() in ('tv', 'series') else 'movie'
                    cache_key = f"tmdb_meta_info:{prefix}:{t_id}"
                    cached = mem_get(cache_key)
                    if cached and isinstance(cached, dict):
                        if cached.get('rating') is not None and item.get('rating') is None:
                            item['rating'] = cached['rating']
                            item['tmdb_rating'] = cached['rating']
                        if cached.get('description') and not item.get('description'):
                            item['description'] = cached['description']
                            item['overview'] = cached['description']
                            item['tmdb_overview'] = cached['description']
                        if cached.get('genres') and not item.get('genres'):
                            item['genres'] = cached['genres']
                            item['genre'] = cached['genres']
                    else:
                        items_to_fetch.append((t_id, prefix))

        # Never block /api/folders on live TMDB. Missing meta is filled in
        # the background so catalog requests stay under the app timeout.
        if items_to_fetch:
            _schedule_tmdb_folder_meta_prefetch(items_to_fetch)

    except Exception as e:
        print(f"[TMDB-METADATA] merge into folders failed: {e}", flush=True)
    return all_c


def _schedule_tmdb_folder_meta_prefetch(entries):
    """Warm TMDB rating/overview cache without delaying /api/folders."""
    global _tmdb_folder_meta_prefetch_running
    unique = []
    seen = set()
    for tmdb_id, prefix in entries:
        key = (str(tmdb_id), prefix)
        if key in seen:
            continue
        seen.add(key)
        unique.append((tmdb_id, prefix))
    if not unique:
        return
    with _tmdb_folder_meta_prefetch_lock:
        if _tmdb_folder_meta_prefetch_running:
            return
        _tmdb_folder_meta_prefetch_running = True

    def _run():
        global _tmdb_folder_meta_prefetch_running
        try:
            for tmdb_id, prefix in unique:
                try:
                    _get_tmdb_meta_by_id(tmdb_id, prefix)
                except Exception:
                    pass
            _invalidate_response_cache(FOLDERS_MERGED_RESPONSE_CACHE_KEY)
        finally:
            with _tmdb_folder_meta_prefetch_lock:
                _tmdb_folder_meta_prefetch_running = False

    threading.Thread(target=_run, name='tmdb-folder-meta-prefetch', daemon=True).start()


_catalog_id_assignment_lock = threading.RLock()
_catalog_id_fallback_maps = {'series': {}, 'movies': {}}
_catalog_id_fallback_max = {'series': 0, 'movies': 0}
_catalog_id_persisted_keys = {'series': set(), 'movies': set()}


def _reserve_catalog_ids(category, candidates, minimum_high_water_mark=0):
    """Return permanent IDs for (folder_name, preferred_id) candidates.

    The database table is an append-only registry. Consequently MAX(catalog_id)
    includes deleted catalog entries and an old ID can never be issued again.
    """
    media_type = 'series' if category == 'series' else 'movie'
    resolved = {}
    candidate_keys = [str(name or '').strip() for name, _ in candidates]
    candidate_keys = [key for key in candidate_keys if key]
    if not candidate_keys:
        return resolved
    if all(key in _catalog_id_persisted_keys[category] for key in candidate_keys):
        fallback = _catalog_id_fallback_maps[category]
        return {key: fallback[key] for key in candidate_keys}

    conn, db_type = None, None
    try:
        conn, db_type = get_db_connection()
        cur = conn.cursor()

        # Serialize allocators across gunicorn workers. SQLite's immediate
        # transaction provides the equivalent write lock.
        if db_type == 'postgres':
            lock_id = 780001 if category == 'series' else 780002
            cur.execute('SELECT pg_advisory_xact_lock(%s)', (lock_id,))
        else:
            cur.execute('BEGIN IMMEDIATE')

        ph = '%s' if db_type == 'postgres' else '?'
        cur.execute(
            f'SELECT folder_name, catalog_id FROM catalog_item_ids WHERE media_type = {ph}',
            (media_type,),
        )
        rows = cur.fetchall() or []
        registry = {str(row[0]): int(row[1]) for row in rows}
        used_ids = set(registry.values())
        high_water_mark = max(
            max(used_ids, default=0),
            int(minimum_high_water_mark or 0),
        )

        for folder_name, preferred_id in candidates:
            key = str(folder_name or '').strip()
            if not key:
                continue
            item_id = registry.get(key)
            if item_id is None:
                preferred_is_free = (
                    isinstance(preferred_id, int)
                    and preferred_id > 0
                    and preferred_id not in used_ids
                )
                if preferred_is_free:
                    item_id = preferred_id
                else:
                    item_id = high_water_mark + 1
                    while item_id in used_ids:
                        item_id += 1
                cur.execute(
                    f'INSERT INTO catalog_item_ids (media_type, folder_name, catalog_id) '
                    f'VALUES ({ph}, {ph}, {ph})',
                    (media_type, key, item_id),
                )
                registry[key] = item_id
                used_ids.add(item_id)
                high_water_mark = max(high_water_mark, item_id)
            resolved[key] = item_id

        conn.commit()
        _catalog_id_fallback_maps[category].update(registry)
        _catalog_id_persisted_keys[category].update(registry)
        _catalog_id_fallback_max[category] = max(
            _catalog_id_fallback_max[category], high_water_mark
        )
        return resolved
    except Exception as exc:
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f'[CATALOG-ID] persistent registry unavailable: {exc}', flush=True)

        # Keep IDs monotonic for the lifetime of this process even if the DB is
        # temporarily unavailable. A later successful call persists the map.
        fallback = _catalog_id_fallback_maps[category]
        high_water_mark = max(
            _catalog_id_fallback_max[category],
            int(minimum_high_water_mark or 0),
        )
        used_ids = set(fallback.values())
        for folder_name, preferred_id in candidates:
            key = str(folder_name or '').strip()
            if not key:
                continue
            item_id = fallback.get(key)
            if item_id is None:
                preferred_is_free = (
                    isinstance(preferred_id, int)
                    and preferred_id > 0
                    and preferred_id not in used_ids
                )
                if preferred_is_free:
                    item_id = preferred_id
                else:
                    item_id = high_water_mark + 1
                    while item_id in used_ids:
                        item_id += 1
                fallback[key] = item_id
                used_ids.add(item_id)
                high_water_mark = max(high_water_mark, item_id)
            resolved[key] = item_id
        _catalog_id_fallback_max[category] = high_water_mark
        return resolved
    finally:
        release_db_connection(conn, db_type)


def _assign_ids_to_folders(all_c):
    """
    [PERMANENT & STABLE ID MAPPING - ZERO ID SHIFTING]
    Memastikan ID setiap item bersifat permanen, stabil, dan TIDAK PERNAH bergeser/mundur
    meskipun ada item di tengah (misal ID 230) yang dihapus.
    
    Aturan Kunci:
    1. Prioritas 1: Gunakan mapping permanen append-only dari database.
    2. ID list.json/item lama dipakai untuk migrasi awal jika belum pernah terdaftar.
    3. Item baru menggunakan high-water mark kategori + 1.
    4. DILARANG KERAS menggunakan urutan indeks/enumerate (1..N) sebagai fallback,
       karena akan membuat seluruh poster Google Drive (movies_<id> / series_<id>) bergeser kacau.
    5. Urutkan berdasarkan ID (bukan abjad/name), sehingga item baru berada di bawah ID terakhir.
    """
    if not all_c:
        return all_c
    list_map, known_max_id = _get_list_json_folder_ids()

    with _catalog_id_assignment_lock:
        for cat in ('series', 'movies'):
            items = all_c.get(cat) or []
            for name, item_id in list_map[cat].items():
                _catalog_id_fallback_maps[cat].setdefault(name, item_id)
            _catalog_id_fallback_max[cat] = max(
                _catalog_id_fallback_max[cat], known_max_id[cat]
            )

            candidates = []
            for item in items:
                name = str(item.get('name') or '').strip()
                preferred_id = list_map[cat].get(name)
                if not isinstance(preferred_id, int) or preferred_id <= 0:
                    preferred_id = item.get('id')
                candidates.append((name, preferred_id))
            permanent_ids = _reserve_catalog_ids(
                cat,
                candidates,
                minimum_high_water_mark=_catalog_id_fallback_max[cat],
            )

            new_items = []
            for item in items:
                name = str(item.get('name') or '').strip()
                item_id = permanent_ids.get(name)
                if not isinstance(item_id, int) or item_id <= 0:
                    # Nameless malformed entries are not persisted, but still
                    # receive a non-recycled process-local ID.
                    _catalog_id_fallback_max[cat] += 1
                    item_id = _catalog_id_fallback_max[cat]

                reordered = {'id': item_id}
                for k, v in item.items():
                    if k != 'id':
                        reordered[k] = v
                new_items.append(reordered)

            new_items.sort(key=lambda x: x.get('id', 99999999))
            all_c[cat] = new_items
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
        by_name_series = {}
        by_name_movies = {}
        for r in releases:
            f_name = r.get('folder_name')
            if not f_name:
                continue
            mt = str(r.get('media_type') or '').strip().lower()
            target_dict = by_name_series if mt in ('tv', 'series') else by_name_movies
            target_dict[f_name.lower().strip()] = r
            norm_key = _normalize_key(f_name)
            if norm_key:
                target_dict[norm_key] = r

        for cat in ('series', 'movies'):
            lookup = by_name_series if cat == 'series' else by_name_movies
            for item in all_c.get(cat) or []:
                name = item.get('name')
                if not name:
                    continue
                # Try raw exact match first
                rel = lookup.get(name.lower().strip())
                # Try normalized match next
                if not rel:
                    norm_name = _normalize_key(name)
                    rel = lookup.get(norm_name)
                
                if not rel:
                    continue
                if rel.get('tmdb_title'):
                    item['tmdb_title'] = rel['tmdb_title']
                if rel.get('tmdb_poster_path'):
                    item['tmdb_poster_path'] = rel['tmdb_poster_path']
                if rel.get('tmdb_overview'):
                    item['tmdb_overview'] = rel['tmdb_overview']
                if rel.get('tmdb_rating') is not None:
                    item['tmdb_rating'] = rel['tmdb_rating']
                if rel.get('release_date'):
                    item['release_date'] = rel['release_date']
                    if cat == 'series':
                        item['first_air_date'] = rel['release_date']
    except Exception as e:
        print(f"[CONTENT-RELEASES] merge TMDB metadata into folders failed: {e}", flush=True)
    return all_c

def _merge_gdrive_posters_into_folders(all_c, force=False):
    """Attach poster_url and backdrop_url from dedicated GDrive poster account to each item in /api/folders."""
    if not all_c:
        return all_c
    try:
        poster_map, backdrop_map, *rest = fetch_gdrive_poster_map(force=force, sync=force)
        if not poster_map and not backdrop_map:
            return all_c

        for cat in ('series', 'movies', 'tv'):
            p_cat = 'series' if cat in ('series', 'tv') else 'movies'
            for item in all_c.get(cat) or []:
                name = item.get('name') or ''
                tmdb_title = item.get('tmdb_title') or ''
                item_id = str(item.get('id') or '')

                # 1. Poster Match (by cat_id, exact name, normalized name)
                p_id = poster_map.get(f"{p_cat}_{item_id}") or poster_map.get(f"{cat}_{item_id}")
                if not p_id and not item_id.isdigit():
                    p_id = poster_map.get(item_id)
                if not p_id and name:
                    p_id = poster_map.get(name.lower().strip()) or poster_map.get(_normalize_key(name))
                if not p_id and tmdb_title:
                    p_id = poster_map.get(tmdb_title.lower().strip()) or poster_map.get(_normalize_key(tmdb_title))

                if p_id:
                    # 6-hour server rolling poster
                    roll_interval = 6 * 3600
                    time_bucket = int(time.time() // roll_interval)
                    seed = sum(ord(c) for c in (item_id or name))
                    idx = (time_bucket + seed) % len(p_id)
                    selected_fid = p_id[idx]

                    item['poster_url'] = f"/api/gdrive-poster/{selected_fid}"
                    item['poster_file_id'] = selected_fid
                    item['all_poster_urls'] = [f"/api/gdrive-poster/{fid}" for fid in p_id]
                    item['total_posters'] = len(p_id)

                # 2. Backdrop Match from GDrive (by cat_id, exact name, normalized name)
                b_id = backdrop_map.get(f"{p_cat}_{item_id}") or backdrop_map.get(f"{cat}_{item_id}")
                if not b_id and not item_id.isdigit():
                    b_id = backdrop_map.get(item_id)
                if not b_id and name:
                    b_id = backdrop_map.get(name.lower().strip()) or backdrop_map.get(_normalize_key(name))
                if not b_id and tmdb_title:
                    b_id = backdrop_map.get(tmdb_title.lower().strip()) or backdrop_map.get(_normalize_key(tmdb_title))

                if b_id:
                    item['backdrop_url'] = f"/api/gdrive-poster/{b_id[0]}"
                    item['backdrop_file_id'] = b_id[0]
                    item['all_backdrop_urls'] = [f"/api/gdrive-poster/{fid}" for fid in b_id]
                    item['total_backdrops'] = len(b_id)
    except Exception as e:
        print(f"[POSTER-GDRIVE] merge into folders failed: {e}", flush=True)
    return all_c

# Poster mapping & RAM cache (from media.db & local filesystem posters/)
_poster_local_map_cache = None
_poster_local_map_ts = 0
_poster_local_map_lock = threading.Lock()

def _get_local_poster_map():
    """Load poster map from media.db or local posters filesystem."""
    global _poster_local_map_cache, _poster_local_map_ts
    now = time.time()
    if _poster_local_map_cache is not None and (now - _poster_local_map_ts) < 3600:
        return _poster_local_map_cache

    with _poster_local_map_lock:
        if _poster_local_map_cache is not None and (now - _poster_local_map_ts) < 3600:
            return _poster_local_map_cache

        p_map = {'movies': {'by_id': {}, 'by_name': {}}, 'series': {'by_id': {}, 'by_name': {}}}
        base_dir = os.path.dirname(os.path.abspath(__file__))
        db_paths = [
            os.path.join(base_dir, 'media.db'),
            os.path.join(base_dir, 'storage', 'media.db'),
        ]

        # 1. SQLite media.db
        for db_path in db_paths:
            if os.path.exists(db_path):
                try:
                    conn = sqlite3.connect(db_path, timeout=5.0)
                    c = conn.cursor()
                    c.execute('SELECT list_id, media_type, primary_poster_url, original_list_name, title, poster_folder, total_posters FROM media_items WHERE primary_poster_url IS NOT NULL')
                    for list_id, media_type, p_url, orig_name, title, poster_folder, total_posters in c.fetchall():
                        cat = 'series' if str(media_type).lower() in ('tv', 'series') else 'movies'
                        if p_url:
                            if poster_folder and total_posters:
                                all_urls = [f"{poster_folder}/{i}.jpg" for i in range(1, int(total_posters) + 1)]
                            else:
                                all_urls = [p_url]
                            
                            if list_id is not None:
                                p_map[cat]['by_id'][str(list_id)] = all_urls
                            if orig_name:
                                p_map[cat]['by_name'][orig_name.lower().strip()] = all_urls
                                norm_k = _normalize_key(orig_name)
                                if norm_k and not norm_k.isdigit():
                                    p_map[cat]['by_name'][norm_k] = all_urls
                            if title:
                                p_map[cat]['by_name'][title.lower().strip()] = all_urls
                                norm_k = _normalize_key(title)
                                if norm_k and not norm_k.isdigit():
                                    p_map[cat]['by_name'][norm_k] = all_urls
                    conn.close()
                    break
                except Exception as e:
                    print(f"[POSTER-LOCAL] SQLite media.db read failed: {e}", flush=True)

        # 2. Filesystem scan fallback for posters/{movies,series}/{id}/1.jpg
        for cat in ('movies', 'series'):
            cat_dirs = [
                os.path.join(base_dir, 'posters', cat),
                os.path.join(base_dir, 'storage', 'posters', cat),
            ]
            for cat_dir in cat_dirs:
                if os.path.exists(cat_dir):
                    try:
                        for entry in os.scandir(cat_dir):
                            if entry.is_dir():
                                item_id = entry.name
                                if str(item_id) not in p_map[cat]['by_id']:
                                    imgs = sorted(
                                        [f.name for f in os.scandir(entry.path) if f.is_file() and f.name.lower().endswith('.jpg')],
                                        key=lambda x: int(os.path.splitext(x)[0]) if os.path.splitext(x)[0].isdigit() else x
                                    )
                                    if imgs:
                                        all_urls = [f"/posters/{cat}/{item_id}/{img}" for img in imgs]
                                        p_map[cat]['by_id'][str(item_id)] = all_urls
                    except Exception as e:
                        print(f"[POSTER-LOCAL] filesystem scan failed: {e}", flush=True)

        _poster_local_map_cache = p_map
        _poster_local_map_ts = now
        return _poster_local_map_cache

def _merge_local_posters_into_folders(all_c):
    """Attach local poster_url from media.db / local filesystem if not already present."""
    if not all_c:
        return all_c
    try:
        p_map = _get_local_poster_map()
        if not p_map:
            return all_c

        for cat in ('series', 'movies', 'tv'):
            p_cat = 'series' if cat in ('series', 'tv') else 'movies'
            by_id = p_map.get(p_cat, {}).get('by_id', {})
            by_name = p_map.get(p_cat, {}).get('by_name', {})
            for item in all_c.get(cat) or []:
                if item.get('poster_url'):
                    continue
                name = item.get('name') or ''
                tmdb_title = item.get('tmdb_title') or ''
                item_id = str(item.get('id') or '')

                # 1. Match by exact ID (highest priority)
                p_url = by_id.get(item_id) if item_id else None
                # 2. Match by exact or normalized name
                if not p_url and name:
                    p_url = by_name.get(name.lower().strip()) or by_name.get(_normalize_key(name))
                # 3. Match by tmdb_title
                if not p_url and tmdb_title:
                    p_url = by_name.get(tmdb_title.lower().strip()) or by_name.get(_normalize_key(tmdb_title))

                if p_url:
                    p_urls = p_url if isinstance(p_url, list) else [p_url]
                    roll_interval = 6 * 3600
                    time_bucket = int(time.time() // roll_interval)
                    seed = sum(ord(c) for c in (item_id or name))
                    idx = (time_bucket + seed) % len(p_urls)

                    item['poster_url'] = p_urls[idx]
                    item['all_poster_urls'] = p_urls
                    item['total_posters'] = len(p_urls)
    except Exception as e:
        print(f"[POSTER-LOCAL] merge into folders failed: {e}", flush=True)
    return all_c

# Backdrop mapping & RAM cache
_backdrop_map_cache = None
_backdrop_map_ts = 0
_backdrop_map_lock = threading.Lock()

def _get_backdrop_map():
    """Load backdrop map from storage/media.db or local storage/backdrops filesystem."""
    global _backdrop_map_cache, _backdrop_map_ts
    now = time.time()
    if _backdrop_map_cache is not None and (now - _backdrop_map_ts) < 3600:
        return _backdrop_map_cache

    with _backdrop_map_lock:
        if _backdrop_map_cache is not None and (now - _backdrop_map_ts) < 3600:
            return _backdrop_map_cache

        b_map = {'movies': {'by_id': {}, 'by_name': {}}, 'series': {'by_id': {}, 'by_name': {}}}
        base_dir = os.path.dirname(os.path.abspath(__file__))
        db_paths = [
            os.path.join(base_dir, 'media.db'),
            os.path.join(base_dir, 'storage', 'media.db'),
        ]

        # 1. SQLite media.db
        for db_path in db_paths:
            if os.path.exists(db_path):
                try:
                    conn = sqlite3.connect(db_path, timeout=5.0)
                    c = conn.cursor()
                    c.execute('SELECT list_id, media_type, primary_backdrop_url, original_list_name, title FROM media_items WHERE primary_backdrop_url IS NOT NULL')
                    for list_id, media_type, p_url, orig_name, title in c.fetchall():
                        cat = 'series' if str(media_type).lower() in ('tv', 'series') else 'movies'
                        if p_url:
                            if list_id is not None:
                                b_map[cat]['by_id'][str(list_id)] = p_url
                            if orig_name:
                                b_map[cat]['by_name'][orig_name.lower().strip()] = p_url
                                norm_k = _normalize_key(orig_name)
                                if norm_k and not norm_k.isdigit():
                                    b_map[cat]['by_name'][norm_k] = p_url
                            if title:
                                b_map[cat]['by_name'][title.lower().strip()] = p_url
                                norm_k = _normalize_key(title)
                                if norm_k and not norm_k.isdigit():
                                    b_map[cat]['by_name'][norm_k] = p_url
                    conn.close()
                    break
                except Exception as e:
                    print(f"[BACKDROP] SQLite media.db read failed: {e}", flush=True)

        # 2. Filesystem scan fallback for backdrops/{movies,series}/{id}/1.jpg
        for cat in ('movies', 'series'):
            cat_dirs = [
                os.path.join(base_dir, 'backdrops', cat),
                os.path.join(base_dir, 'storage', 'backdrops', cat),
            ]
            for cat_dir in cat_dirs:
                if os.path.exists(cat_dir):
                    try:
                        for entry in os.scandir(cat_dir):
                            if entry.is_dir():
                                item_id = entry.name
                                if str(item_id) not in b_map[cat]['by_id']:
                                    img_path = os.path.join(entry.path, '1.jpg')
                                    if os.path.exists(img_path):
                                        b_map[cat]['by_id'][str(item_id)] = f"/backdrops/{cat}/{item_id}/1.jpg"
                    except Exception as e:
                        print(f"[BACKDROP] filesystem scan failed: {e}", flush=True)

        _backdrop_map_cache = b_map
        _backdrop_map_ts = now
        return _backdrop_map_cache

def _merge_backdrops_into_folders(all_c):
    """Attach backdrop_url to each item in /api/folders and detail responses."""
    if not all_c:
        return all_c
    try:
        b_map = _get_backdrop_map()
        if not b_map:
            return all_c

        for cat in ('series', 'movies', 'tv'):
            p_cat = 'series' if cat in ('series', 'tv') else 'movies'
            by_id = b_map.get(p_cat, {}).get('by_id', {})
            by_name = b_map.get(p_cat, {}).get('by_name', {})
            for item in all_c.get(cat) or []:
                if item.get('backdrop_url'):
                    continue
                name = item.get('name') or ''
                tmdb_title = item.get('tmdb_title') or ''
                item_id = str(item.get('id') or '')

                # 1. Match by exact ID (highest priority)
                bd_url = by_id.get(item_id) if item_id else None
                # 2. Match by exact or normalized name
                if not bd_url and name:
                    bd_url = by_name.get(name.lower().strip()) or by_name.get(_normalize_key(name))
                # 3. Match by tmdb_title
                if not bd_url and tmdb_title:
                    bd_url = by_name.get(tmdb_title.lower().strip()) or by_name.get(_normalize_key(tmdb_title))

                if bd_url:
                    item['backdrop_url'] = bd_url
    except Exception as e:
        print(f"[BACKDROP] merge into folders failed: {e}", flush=True)
    return all_c

def _normalize_title(s):
    """Normalize media titles by removing years, quality tags, and special characters."""
    if not s:
        return ''
    s = str(s).lower()
    s = re.sub(r'\.(mkv|mp4|avi|mov|ts)$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'[\(\[]\s*\d{4}\s*[\)\]]', '', s)
    s = re.sub(r'\b(1080p|720p|480p|4k|2160p|webdl|web-dl|bluray|x264|h264|hevc|aac|dts|chios)\b', '', s, flags=re.IGNORECASE)
    s = re.sub(r'[^a-z0-9]', '', s)
    return s

def _catalog_item_for_folder(folder_name, resolved_name=None):
    """Build the same lightweight catalog metadata used by /api/folders for one detail page."""
    names = [
        n for n in (folder_name, resolved_name)
        if n and not str(n).startswith(("gdrive/", "gdrive_folder/", "telegram/"))
    ]

    # 1. Load folders list from memory or list.json
    folders_data = mem_get('folders_list')
    if not folders_data or not isinstance(folders_data, dict) or not (folders_data.get('series') or folders_data.get('movies')):
        list_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'list.json')
        if os.path.exists(list_path):
            try:
                with open(list_path, 'r', encoding='utf-8') as f:
                    folders_data = json.load(f)
            except Exception:
                folders_data = {}
    folders_data = folders_data or {}

    all_items = (folders_data.get('series') or []) + (folders_data.get('movies') or [])

    # Priority 1: Exact match by item['name'] or item['source']
    matched_item = None
    for item in all_items:
        item_name = item.get('name')
        item_source = item.get('source')
        if item_name in names or (folder_name and item_source == folder_name):
            matched_item = item
            break

    # Priority 2: Normalized match (ignoring year, punctuation, case)
    if not matched_item and names:
        norm_names = [_normalize_title(n) for n in names if _normalize_title(n)]
        for item in all_items:
            item_norm = _normalize_title(item.get('name', ''))
            query_norm = _normalize_title(item.get('tmdb_query', ''))
            for n_norm in norm_names:
                if n_norm and (item_norm == n_norm or query_norm == n_norm or 
                              (len(n_norm) >= 5 and (n_norm in item_norm or item_norm in n_norm))):
                    matched_item = item
                    break
            if matched_item:
                break

    # Priority 3: Fuzzy sequence match
    if not matched_item and names:
        import difflib
        norm_names = [_normalize_title(n) for n in names if _normalize_title(n)]
        best_ratio = 0.0
        best_candidate = None
        for item in all_items:
            item_norm = _normalize_title(item.get('name', ''))
            for n_norm in norm_names:
                ratio = difflib.SequenceMatcher(None, item_norm, n_norm).ratio()
                if ratio > best_ratio and ratio >= 0.75:
                    best_ratio = ratio
                    best_candidate = item
        if best_candidate:
            matched_item = best_candidate

    if matched_item:
        catalog_item = copy.deepcopy(matched_item)
        catalog_item['folder_name'] = catalog_item.get('name') or resolved_name or folder_name
        payload = {'series': [catalog_item], 'movies': []}
        if catalog_item.get('type') == 'movie' or catalog_item.get('media_type') == 'movie':
            payload = {'series': [], 'movies': [catalog_item]}
        _assign_ids_to_folders(payload)
        _merge_content_release_tmdb_into_folders(payload)
        _merge_tmdb_overrides_into_folders(payload)
        _merge_tmdb_ratings_into_folders(payload)
        _merge_gdrive_posters_into_folders(payload)
        _merge_local_posters_into_folders(payload)
        _merge_backdrops_into_folders(payload)
        merged = (payload.get('series') or payload.get('movies') or [catalog_item])[0]
        merged['folder_name'] = merged.get('folder_name') or merged.get('name') or resolved_name or folder_name
        return merged

    name = resolved_name or (names[0] if names else folder_name)
    if not name:
        return None
    catalog_item = {'name': name, 'folder_name': name}
    is_movie = folder_name.startswith(("gdrive/", "gdrive_folder/", "telegram/"))
    payload = {'series': [], 'movies': [catalog_item]} if is_movie else {'series': [catalog_item], 'movies': []}
    _assign_ids_to_folders(payload)
    _merge_content_release_tmdb_into_folders(payload)
    _merge_tmdb_overrides_into_folders(payload)
    _merge_tmdb_ratings_into_folders(payload)
    _merge_gdrive_posters_into_folders(payload)
    _merge_local_posters_into_folders(payload)
    _merge_backdrops_into_folders(payload)
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
    
    redis_key = f"markers:{marker_type}"
    redis_data = redis_get(redis_key)
    if redis_data is not None:
        with _markers_lock:
            if marker_type == 'intro':
                _intro_markers_cache = redis_data
            else:
                _outro_markers_cache = redis_data
        print(f"[MARKERS] Loaded {len(redis_data)} {marker_type} markers from Redis", flush=True)
        return
        
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
        
        # Write to Redis (12 hours)
        redis_set(redis_key, cache, ttl_seconds=43200)
        
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
    redis_delete(f"markers:{marker_type}")

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
    redis_key = f"profiles:{uid}"
    
    # Tier 0: RAM cache
    cached = _user_profiles_cache.get(uid)
    if cached is not None and _is_user_cache_valid('profiles', uid):
        return orjson_jsonify(cached)
        
    # Tier 1: Redis cache
    redis_data = redis_get(redis_key)
    if redis_data is not None:
        now = time.time()
        with _user_data_lock:
            _user_profiles_cache[uid] = redis_data
            _user_profiles_cache_ts[uid] = now
        return orjson_jsonify(redis_data)
    
    # Tier 2: Database
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
            
        redis_set(redis_key, res, ttl_seconds=1800)
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

def _normalize_history_media_path(media_path):
    value = str(media_path or '').strip().replace('\\', '/')
    if not value:
        return ''

    value = unquote(value).strip().replace('\\', '/')
    canonical_match = re.match(r'^/?(gdrive|telegram)/(.+?)/*(?:[?#].*)?$', value, re.IGNORECASE)
    if canonical_match:
        prefix = canonical_match.group(1).lower()
        suffix = canonical_match.group(2).strip('/')
        return f'{prefix}/{suffix}' if suffix else ''

    parsed = urlparse(value)
    path = unquote(parsed.path or value).replace('\\', '/')
    for pattern in (
        r'(?:^|/)api/gdrive-stream/([^/?#]+)',
        r'(?:^|/)api/gdrive-audio-transcode/([^/?#]+)',
        r'(?:^|/)api/gdrive-audio-transcode-start/([^/?#]+)',
        r'(?:^|/)api/gdrive-embedded-subtitles/([^/?#]+)',
        r'(?:^|/)api/hls-manifest/([^/?#]+)',
        r'(?:^|/)gdrive-proxy/([^/?#]+)',
    ):
        match = re.search(pattern, path, re.IGNORECASE)
        if match:
            return f"gdrive/{match.group(1)}"

    if parsed.netloc.endswith('googleapis.com'):
        match = re.search(r'(?:^|/)drive/v3/files/([^/?#]+)', path)
        if match:
            return f"gdrive/{match.group(1)}"

    worker_id = path.strip('/')
    if parsed.scheme and parsed.netloc and worker_id and '/' not in worker_id and 'token=' in parsed.query:
        return f'gdrive/{worker_id}'

    return value.strip('/')


def _history_lookup_paths(raw_media_path):
    raw = str(raw_media_path or '').strip()
    normalized = _normalize_history_media_path(raw)
    paths = [normalized] if normalized else []
    if raw and raw != normalized:
        paths.append(raw)
    return paths


def _looks_like_history_technical_title(title, media_path):
    text = str(title or '').strip()
    if not text:
        return True
    lower = text.lower().replace('\\', '/')
    path = str(media_path or '').lower().replace('\\', '/')
    if lower == path:
        return True
    if lower.startswith(('gdrive/', 'gdrive_folder/', 'telegram/', 'http://', 'https://')):
        return True
    path_tail = path.split('/')[-1]
    if path_tail and lower == path_tail:
        return True
    if re.match(r'^[a-z0-9_-]{20,}$', text, re.IGNORECASE) and lower in path:
        return True
    normalized = re.sub(r'\s+', ' ', re.sub(r'[._-]+', ' ', lower)).strip()
    return bool(re.match(r'^(?:s\s*\d+\s*e\s*\d+|episode\s*\d+|ep\s*\d+)$', normalized))


def _history_display_media_title(data):
    media_path = data.get('media_path')
    title = data.get('media_title')
    if not _looks_like_history_technical_title(title, media_path):
        return title

    season = data.get('season')
    episode = data.get('episode')
    try:
        season = int(season) if season is not None else None
    except (TypeError, ValueError):
        season = None
    try:
        episode = int(episode) if episode is not None else None
    except (TypeError, ValueError):
        episode = None

    if season and episode:
        return f'Season {season} Episode {episode}'
    if episode:
        return f'Episode {episode}'
    return title


def _parse_history_timestamp(value):
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        dt = value
        if dt.tzinfo is None:
            return dt.replace(tzinfo=datetime.timezone.utc)
        return dt.astimezone(datetime.timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if 'T' not in text and ' ' in text:
        text = text.replace(' ', 'T', 1)
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        dt = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc)


def _history_db_timestamp(dt, db_type):
    if dt is None:
        return None
    utc = dt.astimezone(datetime.timezone.utc)
    if db_type == 'postgres':
        return utc
    return utc.strftime('%Y-%m-%d %H:%M:%S')


def _history_series_key(item):
    series_path = str(item.get('series_path') or '').strip().lower()
    if series_path:
        return f'path:{series_path}'
    series_title = str(item.get('series_title') or '').strip().lower()
    if series_title:
        return f'title:{series_title}'
    media_path = str(item.get('media_path') or '').strip().lower()
    return f'media:{media_path}'


def _collapse_history_by_series(items):
    """Keep the newest entry per series (input must be last_watched DESC)."""
    seen = set()
    collapsed = []
    for item in items:
        key = _history_series_key(item)
        if key in seen:
            continue
        seen.add(key)
        collapsed.append(item)
    return collapsed


def _history_row_value(row, index, key):
    if isinstance(row, dict):
        return row.get(key)
    return row[index]


def _history_legacy_profile_candidates(user_id, username, profile_id_str):
    candidates = []
    for candidate in (str(user_id), username, 'default', ''):
        if candidate and candidate != profile_id_str and candidate not in candidates:
            candidates.append(candidate)
    return candidates


def _migrate_legacy_history(conn, cur, ph, db_type, user_id, profile_id_str, username):
    """Move watch history from legacy profile_ids (web/old app) to the active profile."""
    if not profile_id_str:
        return 0
    fallback_candidates = _history_legacy_profile_candidates(user_id, username, profile_id_str)
    if not fallback_candidates:
        return 0
    fb_ph = ', '.join([ph] * len(fallback_candidates))
    migrate_sql = f'''UPDATE watch_history SET profile_id = {ph}
                     WHERE user_id = {ph} AND (profile_id IN ({fb_ph}) OR profile_id IS NULL)'''
    try:
        cur.execute(migrate_sql, (profile_id_str, user_id, *fallback_candidates))
        migrated = cur.rowcount if hasattr(cur, 'rowcount') else 0
        conn.commit()
        if migrated:
            print(f"[HISTORY-MIGRATE] Migrated {migrated} legacy rows to profile {profile_id_str}", flush=True)
        return migrated
    except Exception as mig_err:
        print(f"[HISTORY-MIGRATE] Warning: failed to migrate legacy history: {mig_err}", flush=True)
        try:
            conn.rollback()
        except Exception:
            pass
        return 0


def _supersede_other_series_episodes(cur, ph, user_id, profile_id, media_path, series_path, series_title):
    series_path = str(series_path or '').strip()
    series_title = str(series_title or '').strip()
    if not series_path and not series_title:
        return 0
    match_parts = []
    params = [user_id, profile_id, media_path]
    if series_path:
        match_parts.append(f'series_path = {ph}')
        params.append(series_path)
    if series_title:
        match_parts.append(f'series_title = {ph}')
        params.append(series_title)
    params.append(WATCH_HISTORY_ACTIVE_CUTOFF)
    sql = f'''
        UPDATE watch_history
        SET is_hidden = 1
        WHERE user_id = {ph}
          AND profile_id = {ph}
          AND media_path <> {ph}
          AND (is_hidden = 0 OR is_hidden IS NULL)
          AND ({' OR '.join(match_parts)})
          AND (duration_ms <= 0 OR position_ms < (duration_ms * {ph}))
    '''
    cur.execute(sql, tuple(params))
    return cur.rowcount or 0


def _newest_series_sibling(cur, ph, user_id, profile_id, media_path, series_path, series_title):
    series_path = str(series_path or '').strip()
    series_title = str(series_title or '').strip()
    if not series_path and not series_title:
        return None
    match_parts = []
    params = [user_id, profile_id, media_path]
    if series_path:
        match_parts.append(f'series_path = {ph}')
        params.append(series_path)
    if series_title:
        match_parts.append(f'series_title = {ph}')
        params.append(series_title)
    sql = f'''
        SELECT media_path, last_watched
        FROM watch_history
        WHERE user_id = {ph}
          AND profile_id = {ph}
          AND media_path <> {ph}
          AND ({' OR '.join(match_parts)})
        ORDER BY last_watched DESC
        LIMIT 1
    '''
    cur.execute(sql, tuple(params))
    row = cur.fetchone()
    if not row:
        return None
    return {
        'media_path': _history_row_value(row, 0, 'media_path'),
        'last_watched': _parse_history_timestamp(_history_row_value(row, 1, 'last_watched')),
    }


_list_json_folder_ids = None
_list_json_folder_ids_mtime = None
_list_json_folder_ids_lock = threading.Lock()


def _get_list_json_folder_ids():
    """Cached list.json name->id maps used by /api/folders."""
    global _list_json_folder_ids, _list_json_folder_ids_mtime
    list_map = {'series': {}, 'movies': {}}
    known_max_id = {'series': 0, 'movies': 0}
    list_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'list.json')
    try:
        mtime = os.path.getmtime(list_path)
    except OSError:
        return list_map, known_max_id
    with _list_json_folder_ids_lock:
        if _list_json_folder_ids is not None and _list_json_folder_ids_mtime == mtime:
            cached_map, cached_max = _list_json_folder_ids
            return (
                {'series': dict(cached_map['series']), 'movies': dict(cached_map['movies'])},
                dict(cached_max),
            )
        try:
            with open(list_path, 'r', encoding='utf-8') as f:
                ld = json.load(f)
            for cat in ('series', 'movies'):
                for entry in ld.get(cat, []):
                    if isinstance(entry, dict) and 'name' in entry:
                        e_id = entry.get('id')
                        if isinstance(e_id, int):
                            list_map[cat][entry['name']] = e_id
                            if e_id > known_max_id[cat]:
                                known_max_id[cat] = e_id
        except Exception:
            pass
        _list_json_folder_ids = (list_map, known_max_id)
        _list_json_folder_ids_mtime = mtime
        return (
            {'series': dict(list_map['series']), 'movies': dict(list_map['movies'])},
            dict(known_max_id),
        )


_list_json_media_index = None
_list_json_media_index_mtime = None
_list_json_media_index_lock = threading.Lock()


def _extract_list_json_image_fids(entry, url_key, all_urls_key, file_id_key):
    urls = entry.get(all_urls_key) or ([entry.get(url_key)] if entry.get(url_key) else [])
    fids = []
    for url in urls:
        if url:
            match = re.search(r'/api/gdrive-poster/([a-zA-Z0-9_-]+)', str(url))
            if match:
                fids.append(match.group(1))
    file_id = entry.get(file_id_key)
    if file_id and file_id not in fids:
        fids.append(file_id)
    return fids


def _get_list_json_media_index():
    """Build a name-keyed index of list.json once per file change."""
    global _list_json_media_index, _list_json_media_index_mtime
    list_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'list.json')
    try:
        mtime = os.path.getmtime(list_path)
    except OSError:
        return {}
    with _list_json_media_index_lock:
        if _list_json_media_index is not None and _list_json_media_index_mtime == mtime:
            return _list_json_media_index
        index = {}
        try:
            with open(list_path, 'r', encoding='utf-8') as f:
                ld = json.load(f)
            for cat in ('movies', 'series', 'tv'):
                media_type = 'movie' if cat == 'movies' else 'series'
                for entry in ld.get(cat, []):
                    if not isinstance(entry, dict):
                        continue
                    info = (
                        media_type,
                        str(entry.get('id') or ''),
                        _extract_list_json_image_fids(
                            entry, 'backdrop_url', 'all_backdrop_urls', 'backdrop_file_id',
                        ),
                        _extract_list_json_image_fids(
                            entry, 'poster_url', 'all_poster_urls', 'poster_file_id',
                        ),
                    )
                    for raw_name in (entry.get('name'), entry.get('tmdb_title')):
                        name = str(raw_name or '').strip()
                        if not name:
                            continue
                        index[name.lower()] = info
                        index[_normalize_key(name)] = info
        except Exception:
            pass
        _list_json_media_index = index
        _list_json_media_index_mtime = mtime
        return index


def _get_media_info_from_list_json(name):
    """Resolve (media_type, id, backdrop_fids, poster_fids) from list.json by name."""
    if not name:
        return None, None, [], []
    index = _get_list_json_media_index()
    info = index.get(str(name).lower().strip()) or index.get(_normalize_key(name))
    if info:
        return info
    return None, None, [], []


def _history_series_match_clause(ph, series_path, series_title):
    """Match all rows for one series/movie, including hidden/completed progress."""
    match_parts = []
    match_params = []
    seen = set()
    for value in (series_path, series_title):
        text = str(value or '').strip()
        if not text or text in seen:
            continue
        seen.add(text)
        match_parts.extend((
            f'series_path = {ph}',
            f'series_title = {ph}',
            f'media_path = {ph}',
            f'media_path LIKE {ph}',
        ))
        match_params.extend((text, text, text, text + '/%'))
    if not match_parts:
        return '', []
    return ' AND (' + ' OR '.join(match_parts) + ')', match_params


def _get_series_id_from_list_json(name):
    """Resolve series/movie ID from list.json by name."""
    _, item_id, _, _ = _get_media_info_from_list_json(name)
    return item_id


def _enrich_history_item_still(item):
    """Ensure history item has valid still_path:
       - For Movies: strictly uses the Movie's Backdrop.
       - For Series: uses the Episode Still path (or Series Backdrop fallback)."""
    if not item or not isinstance(item, dict):
        return
    try:
        series_title = (item.get('series_title') or item.get('series_path') or '').strip()
        media_title = (item.get('media_title') or '').strip()
        media_path = str(item.get('media_path') or '').strip()

        # Deteksi tipe media: Movie vs Series
        is_movie = False
        media_type = (item.get('type') or item.get('media_type') or '').lower()
        if media_type == 'movie':
            is_movie = True
        elif not series_title and (media_path.startswith(('gdrive/', 'gdrive_folder/', 'telegram/')) or not item.get('season')):
            is_movie = True

        lookup_title = media_title if is_movie else (series_title or media_title)
        list_type, list_id, list_b_fids, _ = _get_media_info_from_list_json(lookup_title)
        if list_type:
            is_movie = (list_type == 'movie')
            item_id = list_id
        else:
            item_id = _get_series_id_from_list_json(lookup_title)

        gmaps = fetch_gdrive_poster_map()
        episode_still_map = gmaps[2] if len(gmaps) > 2 and isinstance(gmaps[2], dict) else {}
        backdrop_map = gmaps[1] if len(gmaps) > 1 and isinstance(gmaps[1], dict) else {}

        # ==========================================
        # 1. KASUS FILM (MOVIE) -> Ambil BACKDROP FILM
        # ==========================================
        if is_movie:
            # a. Dari backdrop_map GDrive
            if item_id:
                b_ids = backdrop_map.get(f"movies_{item_id}") or backdrop_map.get(str(item_id))
                if b_ids:
                    fid = b_ids[0] if isinstance(b_ids, list) else b_ids
                    item['still_path'] = f"/api/gdrive-poster/{fid}"
                    item['still_url'] = f"/api/gdrive-poster/{fid}"
                    return
            if lookup_title:
                b_ids = backdrop_map.get(lookup_title.lower().strip()) or backdrop_map.get(_normalize_key(lookup_title))
                if b_ids:
                    fid = b_ids[0] if isinstance(b_ids, list) else b_ids
                    item['still_path'] = f"/api/gdrive-poster/{fid}"
                    item['still_url'] = f"/api/gdrive-poster/{fid}"
                    return
            # b. Dari list.json backdrop
            if list_b_fids:
                item['still_path'] = f"/api/gdrive-poster/{list_b_fids[0]}"
                item['still_url'] = f"/api/gdrive-poster/{list_b_fids[0]}"
                return
            return

        # ==========================================
        # 2. KASUS SERIAL (SERIES) -> Cari EPISODE STILL
        # ==========================================
        season = item.get('season')
        episode = item.get('episode')
        if episode is None:
            s_p, e_p = get_season_episode_from_string(media_title or media_path)
            if e_p is not None:
                episode = e_p
                if s_p is not None:
                    season = s_p

        # a. Episode still lookup (pencocokan episode yang akurat)
        if episode is not None:
            fid = _lookup_episode_still_fid(episode_still_map, item_id, lookup_title, None, season or 1, episode)
            if fid:
                item['still_path'] = f"/api/gdrive-poster/{fid}"
                item['still_url'] = f"/api/gdrive-poster/{fid}"
                return

        # b. Fallback: Backdrop serial jika episode still spesifik belum tersedia
        if item_id:
            b_ids = backdrop_map.get(f"series_{item_id}") or backdrop_map.get(str(item_id))
            if b_ids:
                fid = b_ids[0] if isinstance(b_ids, list) else b_ids
                item['still_path'] = f"/api/gdrive-poster/{fid}"
                item['still_url'] = f"/api/gdrive-poster/{fid}"
                return
        if lookup_title:
            b_ids = backdrop_map.get(lookup_title.lower().strip()) or backdrop_map.get(_normalize_key(lookup_title))
            if b_ids:
                fid = b_ids[0] if isinstance(b_ids, list) else b_ids
                item['still_path'] = f"/api/gdrive-poster/{fid}"
                item['still_url'] = f"/api/gdrive-poster/{fid}"
                return
        if list_b_fids:
            item['still_path'] = f"/api/gdrive-poster/{list_b_fids[0]}"
            item['still_url'] = f"/api/gdrive-poster/{list_b_fids[0]}"
            return

    except Exception as e:
        print(f"[HISTORY-STILL] Enrich history still failed: {e}", flush=True)


@app.route('/api/history/get/<profile_id>', methods=['GET'])
@token_required(check_expiry=True)
def get_history(current_user, profile_id):
    active_only = request.args.get('active_only', 'false').lower() == 'true'
    include_hidden = request.args.get('include_hidden', 'false').lower() == 'true'
    enrich_stills_requested = request.args.get('enrich_stills', 'false').lower() == 'true'
    series_path = (request.args.get('series_path') or '').strip()
    series_title = (request.args.get('series_title') or '').strip()
    scoped_to_series = bool(series_path or series_title)
    if scoped_to_series:
        # Detail pages need completed + dashboard-hidden progress after an app wipe.
        include_hidden = True
        active_only = False
    try:
        limit = int(request.args.get('limit', '0') or 0)
    except (TypeError, ValueError):
        limit = 0
    limit = max(0, min(limit, 500))
    try:
        offset = int(request.args.get('offset', '0') or 0)
    except (TypeError, ValueError):
        offset = 0
    offset = max(0, offset)
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'

    user_id = current_user['id']
    username = str(current_user.get('username') or '').strip()
    profile_id_str = str(profile_id or '').strip()

    try:
        cur = conn.cursor(cursor_factory=RealDictCursor) if db_type == 'postgres' else conn.cursor()
        _migrate_legacy_history(conn, cur, ph, db_type, user_id, profile_id_str, username)
    except Exception:
        pass

    where = f'user_id = {ph} AND profile_id = {ph}'
    params = [user_id, profile_id_str]
    series_clause, series_params = _history_series_match_clause(ph, series_path, series_title)
    if series_clause:
        where += series_clause
        params.extend(series_params)
    if not include_hidden:
        where += ' AND (is_hidden = 0 OR is_hidden IS NULL)'
    if active_only:
        where += f' AND (duration_ms <= 0 OR position_ms < (duration_ms * {ph}))'
        params.append(WATCH_HISTORY_ACTIVE_CUTOFF)
    # Fetch extra rows when collapsing by series so limit still yields enough cards.
    fetch_limit = (limit * 4) if (limit and active_only) else limit
    sql = f'''SELECT media_path, media_title, series_title, series_path, source, still_path, subtitle_path, season, episode, position_ms, duration_ms, is_hidden, last_watched
              FROM watch_history WHERE {where} ORDER BY last_watched DESC'''
    if fetch_limit:
        sql += f' LIMIT {ph}'
        params.append(fetch_limit)
    if offset:
        sql += f' OFFSET {ph}'
        params.append(offset)
    try:
        if db_type == 'postgres':
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(sql, tuple(params))
            res = [dict(r) for r in cur.fetchall()]
        else:
            cur = conn.cursor()
            res = [dict(r) for r in conn.execute(sql, tuple(params)).fetchall()]

        # Still enrichment is only needed for dashboard Continue Watching cards.
        # Bulk/hidden/series restores exist for playback progress; skipping this
        # keeps /api/history/get from stalling /api/videos.
        enrich_stills = (active_only or enrich_stills_requested) and not scoped_to_series
        for item in res:
            item['media_path'] = _normalize_history_media_path(item.get('media_path'))
            item['media_title'] = _history_display_media_title(item)
            duration_ms = max(0, int(item.get('duration_ms') or 0))
            position_ms = max(0, int(item.get('position_ms') or 0))
            is_active = duration_ms <= 0 or position_ms < duration_ms * WATCH_HISTORY_ACTIVE_CUTOFF
            if enrich_stills and not int(item.get('is_hidden') or 0) and is_active:
                _enrich_history_item_still(item)

        if active_only:
            res = _collapse_history_by_series(res)
            if limit:
                res = res[:limit]

        return add_no_cache_headers(orjson_jsonify(res))
    finally: release_db_connection(conn, db_type)

@app.route('/api/history/get-paths/<profile_id>', methods=['POST'])
@token_required(check_expiry=True)
def get_history_by_paths(current_user, profile_id):
    """Restore exact episode progress, including old rows without series metadata."""
    data = request.get_json(silent=True) or {}
    raw_paths = data.get('media_paths') or []
    if not isinstance(raw_paths, list):
        return orjson_jsonify({"message": "media_paths must be a list"}, 400)

    media_paths = []
    seen_paths = set()
    for raw_path in raw_paths[:1000]:
        normalized = _normalize_history_media_path(raw_path)
        if normalized and normalized not in seen_paths:
            seen_paths.add(normalized)
            media_paths.append(normalized)
    if not media_paths:
        return orjson_jsonify([])

    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    user_id = current_user['id']
    profile_id_str = str(profile_id or '').strip()
    username = str(current_user.get('username') or '').strip()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor) if db_type == 'postgres' else conn.cursor()
        try:
            _migrate_legacy_history(
                conn, cur, ph, db_type, user_id, profile_id_str, username,
            )
        except Exception:
            pass

        results = []
        for start in range(0, len(media_paths), 200):
            chunk = media_paths[start:start + 200]
            placeholders = ', '.join([ph] * len(chunk))
            sql = f'''SELECT media_path, media_title, series_title, series_path, source, still_path, subtitle_path,
                             season, episode, position_ms, duration_ms, is_hidden, last_watched
                      FROM watch_history
                      WHERE user_id = {ph} AND profile_id = {ph}
                        AND media_path IN ({placeholders})'''
            params = (user_id, profile_id_str, *chunk)
            if db_type == 'postgres':
                cur.execute(sql, params)
                rows = [dict(row) for row in cur.fetchall()]
            else:
                rows = [dict(row) for row in conn.execute(sql, params).fetchall()]
            for item in rows:
                item['media_path'] = _normalize_history_media_path(item.get('media_path'))
                item['media_title'] = _history_display_media_title(item)
                results.append(item)
        return add_no_cache_headers(orjson_jsonify(results))
    finally:
        release_db_connection(conn, db_type)


@app.route('/api/history/save', methods=['POST'])
@token_required(check_expiry=True)
def save_history(current_user):
    data = request.get_json() or {}
    raw_media_path = data.get('media_path')
    normalized_media_path = _normalize_history_media_path(raw_media_path)
    if not normalized_media_path:
        return orjson_jsonify({"message": "media_path required"}, 400)
    data['media_path'] = normalized_media_path
    data['media_title'] = _history_display_media_title(data)
    _enrich_history_item_still(data)
    try:
        position_ms = int(data.get('position_ms') or 0)
        duration_ms = int(data.get('duration_ms') or 0)
    except (TypeError, ValueError):
        return orjson_jsonify({"message": "Invalid position_ms/duration_ms"}, 400)
    data['position_ms'] = max(0, position_ms)
    data['duration_ms'] = max(0, duration_ms)

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    client_ts = _parse_history_timestamp(data.get('client_updated_at'))
    if client_ts and client_ts > now_utc + WATCH_HISTORY_STALE_SKEW:
        client_ts = now_utc
    effective_ts = client_ts or now_utc

    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        profile_id_str = str(data.get('profile_id') or '').strip()
        username = str(current_user.get('username') or '').strip()
        _migrate_legacy_history(
            conn, cur, ph, db_type, current_user['id'], profile_id_str, username,
        )
        lookup_paths = _history_lookup_paths(raw_media_path)
        path_placeholders = ', '.join([ph] * len(lookup_paths))
        cur.execute(
            f"SELECT media_path, last_watched, position_ms, duration_ms FROM watch_history WHERE user_id={ph} AND profile_id={ph} AND media_path IN ({path_placeholders})",
            (current_user['id'], data['profile_id'], *lookup_paths),
        )
        existing_rows = cur.fetchall()
        existing_path = None
        existing_last_watched = None
        existing_position_ms = 0
        existing_duration_ms = 0
        for row in existing_rows:
            row_path = _history_row_value(row, 0, 'media_path')
            if row_path == data['media_path']:
                existing_path = row_path
                existing_last_watched = _parse_history_timestamp(_history_row_value(row, 1, 'last_watched'))
                existing_position_ms = int(_history_row_value(row, 2, 'position_ms') or 0)
                existing_duration_ms = int(_history_row_value(row, 3, 'duration_ms') or 0)
                break
            if existing_path is None:
                existing_path = row_path
                existing_last_watched = _parse_history_timestamp(_history_row_value(row, 1, 'last_watched'))
                existing_position_ms = int(_history_row_value(row, 2, 'position_ms') or 0)
                existing_duration_ms = int(_history_row_value(row, 3, 'duration_ms') or 0)

        if existing_path is not None and existing_last_watched is not None and client_ts is not None:
            if client_ts + WATCH_HISTORY_STALE_SKEW < existing_last_watched:
                return orjson_jsonify({
                    "message": "Ignored stale",
                    "ignored": True,
                    "reason": "older_timestamp",
                })
            near_equal = abs((client_ts - existing_last_watched).total_seconds()) <= WATCH_HISTORY_STALE_SKEW.total_seconds()
            if near_equal:
                existing_completed = (
                    existing_duration_ms > 0
                    and existing_position_ms >= existing_duration_ms * WATCH_HISTORY_ACTIVE_CUTOFF
                )
                restarting = (
                    existing_completed
                    and data['duration_ms'] > 0
                    and data['position_ms'] <= data['duration_ms'] * 0.20
                )
                if (
                    not restarting
                    and data['position_ms'] + 5000 < existing_position_ms
                ):
                    return orjson_jsonify({
                        "message": "Ignored stale",
                        "ignored": True,
                        "reason": "older_position",
                    })

        sibling = _newest_series_sibling(
            cur, ph, current_user['id'], data['profile_id'], data['media_path'],
            data.get('series_path'), data.get('series_title'),
        )
        series_is_stale = bool(
            sibling
            and sibling.get('last_watched')
            and effective_ts + WATCH_HISTORY_STALE_SKEW < sibling['last_watched']
        )
        is_hidden = 1 if series_is_stale else 0
        last_watched_value = _history_db_timestamp(effective_ts, db_type)

        if existing_path is not None:
            sql_update = f'''
                UPDATE watch_history
                SET media_path={ph}, media_title={ph}, series_title={ph}, series_path={ph}, source={ph}, still_path={ph}, subtitle_path={ph},
                    season={ph}, episode={ph}, position_ms={ph}, duration_ms={ph}, is_hidden={ph}, last_watched={ph}
                WHERE user_id={ph} AND profile_id={ph} AND media_path={ph}
            '''
            params = (
                data['media_path'], data.get('media_title'), data.get('series_title'), data.get('series_path'), data.get('source'),
                data.get('still_path'), data.get('subtitle_path'), data.get('season'),
                data.get('episode'), data['position_ms'], data['duration_ms'], is_hidden, last_watched_value,
                current_user['id'], data['profile_id'], existing_path,
            )
            cur.execute(sql_update, params)
        else:
            sql_insert = f'''
                INSERT INTO watch_history (user_id, profile_id, media_path, media_title, series_title, series_path, source, still_path, subtitle_path, season, episode, position_ms, duration_ms, is_hidden, last_watched)
                VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph})
            '''
            params = (
                current_user['id'], data['profile_id'], data['media_path'], data.get('media_title'), data.get('series_title'),
                data.get('series_path'), data.get('source'), data.get('still_path'), data.get('subtitle_path'),
                data.get('season'), data.get('episode'), data['position_ms'], data['duration_ms'], is_hidden, last_watched_value,
            )
            try:
                cur.execute(sql_insert, params)
            except Exception:
                conn.rollback()
                # Concurrent insert race: fall back to conditional update.
                sql_update = f'''
                    UPDATE watch_history
                    SET media_title={ph}, series_title={ph}, series_path={ph}, source={ph}, still_path={ph}, subtitle_path={ph},
                        season={ph}, episode={ph}, position_ms={ph}, duration_ms={ph}, is_hidden={ph}, last_watched={ph}
                    WHERE user_id={ph} AND profile_id={ph} AND media_path={ph}
                      AND (last_watched IS NULL OR last_watched <= {ph})
                '''
                cur.execute(sql_update, (
                    data.get('media_title'), data.get('series_title'), data.get('series_path'), data.get('source'),
                    data.get('still_path'), data.get('subtitle_path'), data.get('season'), data.get('episode'),
                    data['position_ms'], data['duration_ms'], is_hidden, last_watched_value,
                    current_user['id'], data['profile_id'], data['media_path'], last_watched_value,
                ))

        superseded = 0
        if not series_is_stale:
            superseded = _supersede_other_series_episodes(
                cur, ph, current_user['id'], data['profile_id'], data['media_path'],
                data.get('series_path'), data.get('series_title'),
            )
        conn.commit()
        return orjson_jsonify({
            "message": "Saved",
            "superseded": superseded,
            "hidden": bool(series_is_stale),
        })
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return orjson_jsonify({"message": "Error saving", "error": str(e)}, 500)
    finally: release_db_connection(conn, db_type)

@app.route('/api/history/hide', methods=['POST'])
@token_required(check_expiry=True)
def hide_history(current_user):
    data = request.get_json() or {}
    lookup_paths = _history_lookup_paths(data.get('media_path'))
    if not lookup_paths:
        return orjson_jsonify({"message": "media_path required"}, 400)
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        profile_id_str = str(data.get('profile_id') or '').strip()
        username = str(current_user.get('username') or '').strip()
        _migrate_legacy_history(
            conn, cur, ph, db_type, current_user['id'], profile_id_str, username,
        )
        path_placeholders = ', '.join([ph] * len(lookup_paths))
        query = f"""
            UPDATE watch_history
            SET is_hidden = 1
            WHERE user_id={ph} AND profile_id={ph} AND media_path IN ({path_placeholders})
        """
        cur.execute(
            query,
            (
                current_user['id'], data['profile_id'], *lookup_paths,
            ),
        )
        conn.commit()
        return orjson_jsonify({"message": "Hidden", "updated": cur.rowcount if hasattr(cur, 'rowcount') else None})
    except Exception as e:
        return orjson_jsonify({"message": "Error hiding", "error": str(e)}, 500)
    finally: release_db_connection(conn, db_type)
    
@app.route('/api/history/delete', methods=['POST'])
@token_required(check_expiry=True)
def delete_history(current_user):
    data = request.get_json() or {}
    lookup_paths = _history_lookup_paths(data.get('media_path'))
    if not lookup_paths:
        return orjson_jsonify({"message": "media_path required"}, 400)
    conn, db_type = get_db_connection()
    ph = '%s' if db_type == 'postgres' else '?'
    try:
        cur = conn.cursor()
        profile_id_str = str(data.get('profile_id') or '').strip()
        username = str(current_user.get('username') or '').strip()
        _migrate_legacy_history(
            conn, cur, ph, db_type, current_user['id'], profile_id_str, username,
        )
        path_placeholders = ', '.join([ph] * len(lookup_paths))
        query = f"""
            DELETE FROM watch_history
            WHERE user_id={ph} AND profile_id={ph} AND media_path IN ({path_placeholders})
        """
        cur.execute(
            query,
            (
                current_user['id'], data['profile_id'], *lookup_paths,
            ),
        )
        deleted_count = cur.rowcount if hasattr(cur, 'rowcount') else None
        conn.commit()
        return orjson_jsonify({"message": "Deleted", "deleted": deleted_count})
    except Exception as e:
        return orjson_jsonify({"message": "Error deleting", "error": str(e)}, 500)
    finally: release_db_connection(conn, db_type)


@app.route('/api/mylist', methods=['GET'])
@token_required(check_expiry=True)
def get_mylist(current_user):
    profile_id = request.args.get('profile_id')
    status = request.args.get('status')
    if status and status not in ('plan_to_watch', 'completed'):
        return orjson_jsonify({"message": "Invalid status"}, 400)

    cache_key = f"{current_user['id']}_{profile_id}_{status or 'all'}"
    redis_key = f"mylist:{cache_key}"
    
    # Tier 0: RAM
    cached = _user_mylist_cache.get(cache_key)
    if cached is not None and _is_user_cache_valid('mylist', cache_key):
        return orjson_jsonify(cached)
        
    # Tier 1: Redis
    redis_data = redis_get(redis_key)
    if redis_data is not None:
        now = time.time()
        with _user_data_lock:
            _user_mylist_cache[cache_key] = redis_data
            _user_mylist_cache_ts[cache_key] = now
        return orjson_jsonify(redis_data)
    
    # Tier 2: DB
    conn, db_type = get_db_connection()
    try:
        ph = '%s' if db_type == 'postgres' else '?'
        where_clauses = [f"user_id = {ph}", f"profile_id = {ph}"]
        params = [current_user['id'], profile_id]
        if status:
            where_clauses.append(f"COALESCE(status, 'plan_to_watch') = {ph}")
            params.append(status)

        sql = f"SELECT folder_name, media_type, meta_json, COALESCE(status, 'plan_to_watch') as status FROM my_list WHERE {' AND '.join(where_clauses)} ORDER BY added_at DESC"
        if db_type == 'postgres':
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(sql, tuple(params))
            res = [dict(r) for r in cur.fetchall()]
        else: res = [dict(r) for r in conn.execute(sql, tuple(params)).fetchall()]
        for item in res:
             if item.get('meta_json'):
                 try: item['meta_json'] = json.loads(item['meta_json'])
                 except: pass
        
        now = time.time()
        with _user_data_lock:
            _user_mylist_cache[cache_key] = res
            _user_mylist_cache_ts[cache_key] = now
            
        redis_set(redis_key, res, ttl_seconds=1800)
        return orjson_jsonify(res)
    finally: release_db_connection(conn, db_type)

@app.route('/api/mylist/counts', methods=['GET'])
@token_required(check_expiry=True)
def get_mylist_counts(current_user):
    profile_id = request.args.get('profile_id')
    if not profile_id:
        return orjson_jsonify({"message": "Missing profile_id"}, 400)

    counts = {'completed': 0, 'plan_to_watch': 0}
    conn, db_type = get_db_connection()
    try:
        ph = '%s' if db_type == 'postgres' else '?'
        sql = f"""
            SELECT COALESCE(status, 'plan_to_watch') as status, COUNT(*) as count
            FROM my_list
            WHERE user_id = {ph} AND profile_id = {ph}
            GROUP BY COALESCE(status, 'plan_to_watch')
        """
        if db_type == 'postgres':
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(sql, (current_user['id'], profile_id))
            rows = cur.fetchall()
        else:
            rows = conn.execute(sql, (current_user['id'], profile_id)).fetchall()

        for row in rows:
            status = row['status'] if isinstance(row, dict) else row[0]
            count = row['count'] if isinstance(row, dict) else row[1]
            if status in counts:
                counts[status] = int(count or 0)
        return orjson_jsonify(counts)
    finally:
        release_db_connection(conn, db_type)

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

def _creds_from_dict(info):
    if not isinstance(info, dict):
        return None
    # Deteksi jika yang dimasukkan adalah file credentials.json (OAuth Client) bukan Token
    if 'installed' in info or 'web' in info:
        print("[GDRIVE-AUTH] ERROR: File credentials.json (OAuth Client Secret) terdeteksi, bukan Token Pengguna! Jalankan get_poster_token.py untuk membuat token.", flush=True)
        return None
    try:
        return Credentials.from_authorized_user_info(info)
    except Exception:
        pass
    scopes = info.get('scopes')
    if isinstance(scopes, str):
        scopes = [scopes]
    return Credentials(
        token=info.get('token'),
        refresh_token=info.get('refresh_token'),
        token_uri=info.get('token_uri', 'https://oauth2.googleapis.com/token'),
        client_id=info.get('client_id'),
        client_secret=info.get('client_secret'),
        scopes=scopes or ['https://www.googleapis.com/auth/drive.readonly']
    )

def _load_gdrive_credentials(b64_str):
    """Universal robust loader for Google OAuth credentials supporting JSON Base64, Raw JSON, and Pickle."""
    if not b64_str:
        return None

    if isinstance(b64_str, bytes):
        b64_str = b64_str.decode('utf-8', errors='ignore')

    clean_str = str(b64_str).strip().strip('"\'').replace('\n', '').replace('\r', '')

    # 1. Jika dimasukkan raw JSON string langsung
    if clean_str.startswith('{'):
        try:
            info = json.loads(clean_str)
            return _creds_from_dict(info)
        except Exception as e:
            print(f"[GDRIVE-AUTH] Raw JSON decode error (periksa apakah string JSON terpotong): {e}", flush=True)
            return None

    # Auto fix Base64 padding & trailing invalid dot
    if clean_str.endswith('.'):
        clean_str = clean_str[:-1] + 'u'

    missing_padding = len(clean_str) % 4
    if missing_padding:
        clean_str += '=' * (4 - missing_padding)

    try:
        raw_bytes = base64.b64decode(clean_str)
    except Exception as e:
        print(f"[GDRIVE-AUTH] Base64 decode failed: {e}", flush=True)
        return None

    # 2. Jika data adalah JSON (diawali '{') -> jangan coba pickle
    if raw_bytes.strip().startswith(b'{'):
        try:
            data_str = raw_bytes.decode('utf-8')
            info = json.loads(data_str)
            return _creds_from_dict(info)
        except Exception as e:
            print(f"[GDRIVE-AUTH] JSON format error in token (periksa apakah string token terpotong): {e}", flush=True)
            return None

    # 3. Coba format Pickle standar
    try:
        import sys, types
        if 'google.auth._regional_access_boundary_utils' not in sys.modules:
            try:
                import google.auth._regional_access_boundary_utils
            except Exception:
                sys.modules['google.auth._regional_access_boundary_utils'] = types.ModuleType('google.auth._regional_access_boundary_utils')
        return pickle.loads(raw_bytes)
    except Exception:
        pass

    # 4. Fallback Custom Unpickler (ekstrak credential jika class Google Auth beda versi)
    try:
        import io
        class FallbackUnpickler(pickle.Unpickler):
            def find_class(self, module, name):
                if 'google.auth' in module or 'RegionalAccessBoundary' in name:
                    class Dummy:
                        def __init__(self, *args, **kwargs): pass
                        def __setstate__(self, state): self.__dict__.update(state)
                    return Dummy
                return super().find_class(module, name)
        obj = FallbackUnpickler(io.BytesIO(raw_bytes)).load()
        d = getattr(obj, '__dict__', {})
        info = {
            'token': d.get('token'),
            'refresh_token': d.get('_refresh_token') or d.get('refresh_token'),
            'token_uri': d.get('_token_uri') or d.get('token_uri', 'https://oauth2.googleapis.com/token'),
            'client_id': d.get('_client_id') or d.get('client_id'),
            'client_secret': d.get('_client_secret') or d.get('client_secret'),
            'scopes': d.get('_scopes') or d.get('scopes', []),
            'universe_domain': d.get('_universe_domain', 'googleapis.com'),
            'account': d.get('_account', ''),
        }
        return _creds_from_dict(info)
    except Exception as e:
        print(f"[GDRIVE-AUTH] Failed to load credentials from token: {e}", flush=True)
        return None

def get_gdrive_service():
    if hasattr(_gdrive_local, 'service') and _gdrive_local.service and hasattr(_gdrive_local.service, '_http') and _gdrive_local.service._http.credentials.valid: return _gdrive_local.service
    creds = None
    if GDRIVE_TOKEN_B64:
        creds = _load_gdrive_credentials(GDRIVE_TOKEN_B64)
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
        creds = _load_gdrive_credentials(GDRIVE_SUBTITLE_TOKEN_B64)
    if not creds: return None
    if creds.expired and creds.refresh_token: creds.refresh(Request())
    try:
        svc = build('drive', 'v3', credentials=creds, cache_discovery=False)
        _gdrive_sub_local.service = svc
        return svc
    except: return None

_gdrive_poster_local = threading.local()

def get_gdrive_poster_service():
    """Separate GDrive service for the poster-dedicated account."""
    if hasattr(_gdrive_poster_local, 'service') and _gdrive_poster_local.service and hasattr(_gdrive_poster_local.service, '_http') and _gdrive_poster_local.service._http.credentials.valid:
        return _gdrive_poster_local.service
    creds = None
    if GDRIVE_POSTER_TOKEN_B64:
        creds = _load_gdrive_credentials(GDRIVE_POSTER_TOKEN_B64)
    if not creds: return None
    if creds.expired and creds.refresh_token: creds.refresh(Request())
    try:
        svc = build('drive', 'v3', credentials=creds, cache_discovery=False)
        _gdrive_poster_local.service = svc
        return svc
    except Exception as e:
        print(f"[POSTER-GDRIVE] Error building GDrive service: {e}", flush=True)
        return None

# Poster, Backdrop, and Episode Still map RAM and Disk cache state
_poster_map_cache = ({}, {}, {})
_poster_map_ts = 0
_poster_map_lock = threading.Lock()
_poster_map_is_fetching = False
_POSTER_MAP_TTL = 21600  # 6 hours

def _bg_fetch_gdrive_poster_map():
    global _poster_map_cache, _poster_map_ts, _poster_map_is_fetching
    for _attempt in range(3):
        try:
            # Force fresh service on retry to avoid stale SSL connections
            if _attempt > 0:
                if hasattr(_gdrive_poster_local, 'service'):
                    delattr(_gdrive_poster_local, 'service')
                time.sleep(1)
                print(f"[POSTER-GDRIVE] Retry attempt {_attempt + 1}/3...", flush=True)
            svc = get_gdrive_poster_service()
            if not svc:
                return

            poster_map = {}
            backdrop_map = {}
            episode_still_map = {}

            # 1. Fetch all folders
            folder_map = {}
            p_token = None
            while True:
                res = svc.files().list(
                    q="mimeType = 'application/vnd.google-apps.folder' and trashed = false",
                    pageSize=1000,
                    fields="nextPageToken, files(id, name, parents)",
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True,
                    pageToken=p_token
                ).execute()
                for f in res.get('files', []):
                    folder_map[f['id']] = {'name': f.get('name', '').strip(), 'parents': f.get('parents', [])}
                p_token = res.get('nextPageToken')
                if not p_token:
                    break

            # 2. Fetch image files only (posters + backdrops + episode stills).
            # A non-folder query also returned JSON/DB/HTML files, which later
            # reached Pillow and were incorrectly served as JPEG.
            image_files = []
            p_token = None
            while True:
                res = svc.files().list(
                    q="mimeType contains 'image/' and trashed = false",
                    pageSize=1000,
                    fields="nextPageToken, files(id, name, parents)",
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True,
                    pageToken=p_token
                ).execute()
                image_files.extend(res.get('files', []))
                p_token = res.get('nextPageToken')
                if not p_token:
                    break

            def _get_path_parts(fid):
                parts = []
                curr = fid
                visited = set()
                while curr in folder_map and curr not in visited:
                    visited.add(curr)
                    parts.insert(0, folder_map[curr]['name'].lower())
                    p = folder_map[curr]['parents']
                    curr = p[0] if p else None
                return parts

            def _gdrive_map_append(target, key, fid):
                if key not in target:
                    target[key] = [fid]
                elif fid not in target[key]:
                    target[key].append(fid)

            for f in image_files:
                fid = f.get('id')
                fname = f.get('name', '').strip()
                if not fid or not fname:
                    continue

                parents = f.get('parents', [])
                parent_id = parents[0] if parents else None
                parts = _get_path_parts(parent_id) if parent_id else []

                # Tentukan apakah episode still, backdrop, atau poster
                is_episode = any('episode' in part for part in parts) or 'episode' in fname.lower()
                if is_episode:
                    s, e = get_season_episode_from_string(fname)
                    base_name, _ = os.path.splitext(fname)
                    if e is None and base_name.isdigit():
                        s, e = 1, int(base_name)
                    if e is not None:
                        s = s if s is not None else 1
                        for p in parts:
                            p_clean = p.lower().strip()
                            if p_clean not in ('posters', 'backdrops', 'series', 'movies', 'tv', 'shows', 'episodes', 'episode', 'root', 'drive', 'storage'):
                                _gdrive_map_append(episode_still_map, f"series_{p_clean}_{s}_{e}", fid)
                                _gdrive_map_append(episode_still_map, f"{p_clean}_{s}_{e}", fid)
                                if s == 1:
                                    _gdrive_map_append(episode_still_map, f"series_{p_clean}_{e}", fid)
                                    _gdrive_map_append(episode_still_map, f"{p_clean}_{e}", fid)
                                norm_p = _normalize_key(p_clean)
                                if norm_p and not norm_p.isdigit():
                                    _gdrive_map_append(episode_still_map, f"series_{norm_p}_{s}_{e}", fid)
                                    _gdrive_map_append(episode_still_map, f"{norm_p}_{s}_{e}", fid)
                                    if s == 1:
                                        _gdrive_map_append(episode_still_map, f"series_{norm_p}_{e}", fid)
                                        _gdrive_map_append(episode_still_map, f"{norm_p}_{e}", fid)
                    continue

                is_backdrop = any('backdrop' in part for part in parts) or 'backdrop' in fname.lower()
                target = backdrop_map if is_backdrop else poster_map

                # Deteksi kategori (series / movies) dari jalur folder
                cat = ''
                for p in parts:
                    if p in ('series', 'tv', 'shows', 'drama', 'drakor', 'anime'):
                        cat = 'series'
                        break
                    elif p in ('movies', 'movie', 'film', 'films'):
                        cat = 'movies'
                        break

                if parts:
                    item_id = parts[-1]
                    if cat:
                        _gdrive_map_append(target, f"{cat}_{item_id}", fid)
                        _gdrive_map_append(target, f"{cat}_{item_id}_{fname.lower()}", fid)
                    elif not item_id.isdigit():
                        _gdrive_map_append(target, item_id, fid)

                    # Map setiap nama folder non-generik (seperti judul serial/film)
                    for p in parts:
                        p_clean = p.lower().strip()
                        if p_clean not in ('posters', 'backdrops', 'series', 'movies', 'tv', 'shows', 'root', 'drive', 'storage'):
                            if not p_clean.isdigit() and len(p_clean) > 1:
                                _gdrive_map_append(target, p_clean, fid)
                                norm_p = _normalize_key(p_clean)
                                if norm_p and not norm_p.isdigit():
                                    _gdrive_map_append(target, norm_p, fid)

                base_name, _ = os.path.splitext(fname)
                if base_name and not base_name.isdigit() and len(base_name) > 1:
                    base_clean = base_name.lower().strip()
                    if base_clean not in ('poster', 'backdrop', 'cover', 'folder', 'fanart', 'thumb'):
                        _gdrive_map_append(target, fname.lower(), fid)
                        _gdrive_map_append(target, base_clean, fid)
                        norm_k = _normalize_key(base_name)
                        if norm_k and not norm_k.isdigit():
                            _gdrive_map_append(target, norm_k, fid)
                _gdrive_map_append(target, f"file_{fid}", fid)

            now = time.time()
            res_tuple = (poster_map, backdrop_map, episode_still_map)
            with _poster_map_lock:
                _poster_map_cache = res_tuple
                _poster_map_ts = now
            try:
                disk_cache.set("gdrive_poster_map_all_v5", res_tuple)
                disk_cache.set("gdrive_poster_map_all_v5__ts", now)
            except Exception:
                pass
            print(f"[POSTER-GDRIVE] Loaded {len(poster_map)} posters, {len(backdrop_map)} backdrops, and {len(episode_still_map)} episode stills from GDrive", flush=True)
            _invalidate_response_cache('resp_folders', FOLDERS_MERGED_RESPONSE_CACHE_KEY)
            return  # Success, exit retry loop
        except Exception as e:
            print(f"[POSTER-GDRIVE] fetch_gdrive_poster_map attempt {_attempt + 1} failed: {e}", flush=True)
            if _attempt >= 2:
                print("[POSTER-GDRIVE] All 3 attempts failed, giving up.", flush=True)
            continue
        finally:
            _poster_map_is_fetching = False


def _load_base_poster_map_from_list_json():
    """Load baseline poster_map & backdrop_map from static list.json (Zero API / DB overhead)."""
    p_map = {}
    b_map = {}
    e_map = {}
    list_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'list.json')
    if os.path.exists(list_path):
        try:
            with open(list_path, 'r', encoding='utf-8') as f:
                ld = json.load(f)
                for cat in ('series', 'movies', 'tv'):
                    p_cat = 'series' if cat in ('series', 'tv') else 'movies'
                    for entry in ld.get(cat, []):
                        if not isinstance(entry, dict):
                            continue
                        name = entry.get('name') or ''
                        tmdb_title = entry.get('tmdb_title') or ''
                        item_id = str(entry.get('id') or '')

                        # 1. Posters
                        p_urls = entry.get('all_poster_urls') or ([entry.get('poster_url')] if entry.get('poster_url') else [])
                        p_fids = []
                        for u in p_urls:
                            if not u:
                                continue
                            m = re.search(r'/api/gdrive-poster/([a-zA-Z0-9_-]+)', str(u))
                            if m:
                                p_fids.append(m.group(1))
                            elif entry.get('poster_file_id'):
                                p_fids.append(entry.get('poster_file_id'))
                        if entry.get('poster_file_id') and entry.get('poster_file_id') not in p_fids:
                            p_fids.insert(0, entry.get('poster_file_id'))

                        if p_fids:
                            if item_id:
                                p_map[f"{p_cat}_{item_id}"] = p_fids
                                p_map[f"{cat}_{item_id}"] = p_fids
                                if not item_id.isdigit():
                                    p_map[item_id] = p_fids
                            if name:
                                p_map[name.lower().strip()] = p_fids
                                norm_n = _normalize_key(name)
                                if norm_n:
                                    p_map[norm_n] = p_fids
                            if tmdb_title:
                                p_map[tmdb_title.lower().strip()] = p_fids
                                norm_t = _normalize_key(tmdb_title)
                                if norm_t:
                                    p_map[norm_t] = p_fids

                        # 2. Backdrops
                        b_urls = entry.get('all_backdrop_urls') or ([entry.get('backdrop_url')] if entry.get('backdrop_url') else [])
                        b_fids = []
                        for u in b_urls:
                            if not u:
                                continue
                            m = re.search(r'/api/gdrive-poster/([a-zA-Z0-9_-]+)', str(u))
                            if m:
                                b_fids.append(m.group(1))
                            elif entry.get('backdrop_file_id'):
                                b_fids.append(entry.get('backdrop_file_id'))
                        if entry.get('backdrop_file_id') and entry.get('backdrop_file_id') not in b_fids:
                            b_fids.insert(0, entry.get('backdrop_file_id'))

                        if b_fids:
                            if item_id:
                                b_map[f"{p_cat}_{item_id}"] = b_fids
                                b_map[f"{cat}_{item_id}"] = b_fids
                                if not item_id.isdigit():
                                    b_map[item_id] = b_fids
                            if name:
                                b_map[name.lower().strip()] = b_fids
                                norm_n = _normalize_key(name)
                                if norm_n:
                                    b_map[norm_n] = b_fids
                            if tmdb_title:
                                b_map[tmdb_title.lower().strip()] = b_fids
                                norm_t = _normalize_key(tmdb_title)
                                if norm_t:
                                    b_map[norm_t] = b_fids
        except Exception as e:
            print(f"[POSTER-GDRIVE] failed reading list.json baseline poster map: {e}", flush=True)
    return p_map, b_map, e_map

def fetch_gdrive_poster_map(force=False, sync=False):
    """List actual image files from dedicated GDrive poster account and map to poster_map, backdrop_map & episode_still_map."""
    global _poster_map_cache, _poster_map_ts, _poster_map_is_fetching
    base_maps = _load_base_poster_map_from_list_json()
    if not GDRIVE_POSTER_FOLDER_ID or not GDRIVE_POSTER_TOKEN_B64:
        return base_maps
    now = time.time()
    with _poster_map_lock:
        if not force and _poster_map_cache and _poster_map_cache[0] and (now - _poster_map_ts) < _POSTER_MAP_TTL:
            return _poster_map_cache

    if not force:
        try:
            cached_disk = disk_cache.get("gdrive_poster_map_all_v5")
            ts_disk = disk_cache.get("gdrive_poster_map_all_v5__ts")
            if cached_disk and ts_disk and (now - ts_disk) < _POSTER_MAP_TTL:
                with _poster_map_lock:
                    _poster_map_cache = cached_disk
                    _poster_map_ts = ts_disk
                return _poster_map_cache
        except Exception:
            pass

    # Trigger background fetch if not already fetching
    if not _poster_map_is_fetching:
        _poster_map_is_fetching = True
        if sync:
            _bg_fetch_gdrive_poster_map()
        else:
            threading.Thread(target=_bg_fetch_gdrive_poster_map, daemon=True).start()

    return _poster_map_cache if (_poster_map_cache and _poster_map_cache[0]) else base_maps

def _lookup_episode_still_fid(episode_still_map, series_id, series_name, tmdb_title, season, episode):
    """Find matching GDrive file ID for a series episode."""
    if not episode_still_map or episode is None:
        return None
    s = int(season or 1)
    e = int(episode)

    candidates = []
    # 1. By series_id (highest priority)
    if series_id:
        sid = str(series_id).strip()
        candidates.extend([
            f"series_{sid}_{s}_{e}",
            f"{sid}_{s}_{e}",
            f"series_{sid}_s{s:02d}e{e:02d}",
            f"{sid}_s{s:02d}e{e:02d}",
            f"{sid}_{s:02d}_{e:02d}",
        ])
        if s == 1:
            candidates.extend([
                f"series_{sid}_{e}",
                f"{sid}_{e}",
                f"{sid}_e{e:02d}",
            ])

    # 2. By series_name (exact, lowercase, normalized)
    if series_name:
        sn = series_name.lower().strip()
        candidates.extend([
            f"series_{sn}_{s}_{e}",
            f"{sn}_{s}_{e}",
            f"series_{sn}_s{s:02d}e{e:02d}",
            f"{sn}_s{s:02d}e{e:02d}",
        ])
        if s == 1:
            candidates.extend([
                f"series_{sn}_{e}",
                f"{sn}_{e}",
                f"{sn}_e{e:02d}",
            ])
        norm_sn = _normalize_key(series_name)
        if norm_sn:
            candidates.extend([
                f"series_{norm_sn}_{s}_{e}",
                f"{norm_sn}_{s}_{e}",
                f"series_{norm_sn}_s{s:02d}e{e:02d}",
                f"{norm_sn}_s{s:02d}e{e:02d}",
            ])
            if s == 1:
                candidates.extend([
                    f"series_{norm_sn}_{e}",
                    f"{norm_sn}_{e}",
                    f"{norm_sn}_e{e:02d}",
                ])

    # 3. By tmdb_title
    if tmdb_title:
        tt = tmdb_title.lower().strip()
        candidates.extend([
            f"series_{tt}_{s}_{e}",
            f"{tt}_{s}_{e}",
            f"series_{tt}_s{s:02d}e{e:02d}",
            f"{tt}_s{s:02d}e{e:02d}",
        ])
        if s == 1:
            candidates.extend([
                f"series_{tt}_{e}",
                f"{tt}_{e}",
                f"{tt}_e{e:02d}",
            ])
        norm_tt = _normalize_key(tmdb_title)
        if norm_tt:
            candidates.extend([
                f"series_{norm_tt}_{s}_{e}",
                f"{norm_tt}_{s}_{e}",
                f"series_{norm_tt}_s{s:02d}e{e:02d}",
                f"{norm_tt}_s{s:02d}e{e:02d}",
            ])
            if s == 1:
                candidates.extend([
                    f"series_{norm_tt}_{e}",
                    f"{norm_tt}_{e}",
                    f"{norm_tt}_e{e:02d}",
                ])

    for key in candidates:
        fid = episode_still_map.get(key)
        if fid:
            return fid[0] if isinstance(fid, list) else fid
    return None

def _get_tmdb_season_episodes_map(tmdb_id, season=1):
    """Fetch all episodes for a given season from TMDB and return {episode_number: info_dict}."""
    if not tmdb_id:
        return {}
    try:
        t_id = int(tmdb_id)
        s_num = int(season or 1)
        if t_id <= 0:
            return {}
    except (ValueError, TypeError):
        return {}

    cache_key = f"tmdb_season_eps:{t_id}:{s_num}"
    cached = mem_get(cache_key)
    if cached is not None and isinstance(cached, dict):
        return cached

    r_val = redis_get(cache_key)
    if r_val is not None:
        try:
            val = json.loads(r_val) if isinstance(r_val, str) else r_val
            if isinstance(val, dict):
                mem_set(cache_key, val)
                return val
        except Exception:
            pass

    if not TMDB_API_KEY:
        return {}

    eps_map = {}
    try:
        status, data = _fetch_tmdb_json_server(f"tv/{t_id}/season/{s_num}", {})
        if status == 200 and isinstance(data, dict):
            episodes = data.get('episodes') or []
            # If overviews are blank in primary language, attempt English fallback
            has_desc = any(ep.get('overview') for ep in episodes if isinstance(ep, dict))
            if not has_desc:
                st_en, data_en = _fetch_tmdb_json_server(f"tv/{t_id}/season/{s_num}", {'language': 'en-US'})
                if st_en == 200 and isinstance(data_en, dict) and data_en.get('episodes'):
                    episodes = data_en.get('episodes')

            for ep in episodes:
                if isinstance(ep, dict):
                    ep_num = ep.get('episode_number')
                    ep_title = ep.get('name') or ''
                    ep_overview = ep.get('overview') or ''
                    ep_still = ep.get('still_path') or ''
                    ep_air = ep.get('air_date') or ''
                    if ep_num is not None:
                        eps_map[str(ep_num)] = {
                            'title': ep_title,
                            'overview': ep_overview,
                            'description': ep_overview,
                            'still_path': ep_still,
                            'air_date': ep_air,
                            'air_on': ep_air,
                        }
            if eps_map:
                mem_set(cache_key, eps_map)
                redis_set(cache_key, json.dumps(eps_map), ttl_seconds=604800)
            return eps_map
    except Exception as e:
        print(f"[TMDB-SEASON] Failed fetching season {s_num} for tv/{t_id}: {e}", flush=True)

    return eps_map

def _merge_episode_metadata_into_videos(videos, catalog_item=None, folder_name=None, resolved_name=None):
    """Enrich each video item in /api/videos with title (episode title), description/overview, and air_date/air_on."""
    if not videos:
        return videos
    try:
        t_id = None
        media_type = 'tv'
        fallback_overview = ''
        fallback_title = ''
        
        if catalog_item and isinstance(catalog_item, dict):
            t_id = catalog_item.get('tmdb_id') or catalog_item.get('idtmdb')
            media_type = catalog_item.get('tmdb_override_media_type') or catalog_item.get('type') or catalog_item.get('media_type') or 'tv'
            fallback_overview = catalog_item.get('description') or catalog_item.get('overview') or catalog_item.get('tmdb_overview') or ''
            fallback_title = catalog_item.get('tmdb_title') or catalog_item.get('name') or ''

        # Auto-resolve tmdb_id if missing from catalog_item
        if not t_id:
            candidate_names = [n for n in (folder_name, resolved_name) if n]
            if videos and isinstance(videos[0], dict):
                v_name = videos[0].get('name') or videos[0].get('original_name') or ''
                m = re.match(r'^(.*?)(?:\s*-\s*s\d+|\s+s\d+e\d+|\s*-\s*episode\s*\d+)', v_name, flags=re.IGNORECASE)
                if m:
                    candidate_names.append(m.group(1).strip())

            overrides = _get_tmdb_overrides_map() or {}
            for cname in candidate_names:
                if not cname: continue
                # Exact
                if cname in overrides and overrides[cname].get('tmdb_id'):
                    t_id = overrides[cname]['tmdb_id']
                    break
                # Normalized
                cn_norm = _normalize_title(cname)
                for ov_name, ov in overrides.items():
                    ov_norm = _normalize_title(ov_name)
                    if ov_norm == cn_norm or (len(cn_norm) >= 5 and (cn_norm in ov_norm or ov_norm in cn_norm)):
                        if ov.get('tmdb_id'):
                            t_id = ov['tmdb_id']
                            break
                if t_id: break

        is_movie = str(media_type).lower() in ('movie', 'movies')

        if is_movie:
            if t_id and not fallback_overview:
                movie_meta = _get_tmdb_meta_by_id(t_id, 'movie')
                if movie_meta:
                    fallback_overview = movie_meta.get('description') or movie_meta.get('overview') or fallback_overview
                    fallback_title = movie_meta.get('tmdb_title') or fallback_title

            for video in videos:
                if not isinstance(video, dict):
                    continue
                v_name = video.get('name') or ''
                if not video.get('title'):
                    video['title'] = fallback_title or v_name
                if not video.get('description'):
                    video['description'] = fallback_overview
                    video['overview'] = fallback_overview
            return videos

        # For TV series, resolve distinct seasons in the video list
        seasons_present = set()
        for video in videos:
            if isinstance(video, dict):
                s = video.get('season') or 1
                try:
                    seasons_present.add(int(s))
                except (ValueError, TypeError):
                    seasons_present.add(1)

        season_maps = {}
        if t_id:
            for s in seasons_present:
                season_maps[s] = _get_tmdb_season_episodes_map(t_id, s)

        for video in videos:
            if not isinstance(video, dict):
                continue
            season = video.get('season') or 1
            try:
                s_int = int(season)
            except (ValueError, TypeError):
                s_int = 1

            episode = video.get('episode')
            if episode is None:
                s_p, e_p = get_season_episode_from_string(video.get('name', ''))
                if e_p is not None:
                    episode = e_p
                    video['episode'] = e_p
                if s_p is not None:
                    video['season'] = s_p
                    s_int = s_p

            ep_info = None
            if episode is not None and s_int in season_maps:
                ep_info = season_maps[s_int].get(str(episode)) or season_maps[s_int].get(int(episode))

            if ep_info:
                ep_title = ep_info.get('title')
                ep_desc = ep_info.get('overview') or ep_info.get('description') or ''
                ep_air = ep_info.get('air_date') or ep_info.get('air_on') or ''
                if ep_title:
                    video['title'] = ep_title
                else:
                    video['title'] = video.get('title') or (f"Episode {episode}" if episode else video.get('name'))
                video['description'] = ep_desc
                video['overview'] = ep_desc
                if ep_air:
                    video['air_date'] = ep_air
                    video['air_on'] = ep_air
            else:
                if not video.get('title'):
                    video['title'] = f"Episode {episode}" if episode is not None else video.get('name')
                if not video.get('description'):
                    video['description'] = fallback_overview
                    video['overview'] = fallback_overview

    except Exception as e:
        print(f"[EPISODE-META] Enrich episode metadata failed: {e}", flush=True)
    return videos

def _merge_episode_stills_into_videos(videos, catalog_item=None, folder_name=None, resolved_name=None):
    """Attach still_path and still_url from GDrive episode still map to each video, and enrich with TMDB metadata."""
    if not videos:
        return videos
    try:
        gmaps = fetch_gdrive_poster_map()
        episode_still_map = gmaps[2] if len(gmaps) > 2 and isinstance(gmaps[2], dict) else {}
        if episode_still_map:
            series_id = None
            series_name = None
            tmdb_title = None
            if catalog_item and isinstance(catalog_item, dict):
                series_id = str(catalog_item.get('id') or '')
                series_name = catalog_item.get('name') or catalog_item.get('folder_name') or ''
                tmdb_title = catalog_item.get('tmdb_title') or ''

            if not series_name:
                series_name = resolved_name or folder_name or ''

            if not series_id and series_name:
                series_id = _get_series_id_from_list_json(series_name)

            for video in videos:
                if not isinstance(video, dict):
                    continue
                season = video.get('season') or 1
                episode = video.get('episode')
                if episode is None:
                    s_p, e_p = get_season_episode_from_string(video.get('name', ''))
                    if e_p is not None:
                        episode = e_p
                        if s_p is not None:
                            season = s_p

                if episode is not None:
                    fid = _lookup_episode_still_fid(episode_still_map, series_id, series_name, tmdb_title, season, episode)
                    if fid:
                        still_url = f"/api/gdrive-poster/{fid}"
                        video['still_path'] = still_url
                        video['still_url'] = still_url
                        video['still_file_id'] = fid
    except Exception as e:
        print(f"[EPISODE-STILL] Merge stills failed: {e}", flush=True)

    # Enrich with episode title & description from TMDB
    _merge_episode_metadata_into_videos(videos, catalog_item, folder_name, resolved_name)
    return videos

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
            fid = _subtitle_gdrive_file_id(file_path)
            svc = get_gdrive_subtitle_service()
            if not svc:
                print(f"[SUBTITLE] Dedicated GDrive service unavailable for '{file_path}'", flush=True)
                return None
            return svc.files().get_media(fileId=fid).execute()
        elif file_path.startswith("gdrive/"):
            fid = _subtitle_gdrive_file_id(file_path)
            svc = get_gdrive_service()
            if not svc:
                print(f"[SUBTITLE] GDrive service unavailable for '{file_path}'", flush=True)
                return None
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
    except Exception as e:
        print(f"[SUBTITLE] Download failed for '{file_path}': {e}", flush=True)
    return None

def _subtitle_gdrive_file_id(file_path):
    """Extract the file ID from legacy and extension-preserving subtitle paths."""
    return file_path.split('/', 2)[1]

def _subtitle_source_path(prefix, item):
    """Keep the original extension so /subtitle can return the correct MIME type."""
    extension = os.path.splitext(item.get('name', ''))[1].lower()
    return f"{prefix}/{item['id']}/subtitle{extension}"

def _is_supported_subtitle(filename):
    return str(filename or '').lower().endswith(('.srt', '.vtt', '.ass', '.ssa'))

def _gdrive_subtitle_query():
    return "(name contains '.srt' or name contains '.vtt' or name contains '.ass' or name contains '.ssa')"

def _subtitle_mimetype(file_path):
    return 'text/vtt' if str(file_path or '').lower().endswith('.vtt') else 'text/plain; charset=utf-8'

def _videos_cache_duration(payload):
    videos = payload.get("videos") or []
    if not videos:
        return CACHE_DURATION_EMPTY
    for video in videos:
        subtitle_path = video.get("subtitle_path")
        if not subtitle_path:
            return _subtitle_empty_map_ttl
        if subtitle_path.startswith(("gdrive/", "gdrive_sub/")) and "/subtitle." not in subtitle_path:
            return 0
    return CACHE_DURATION_VIDEOS

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

def _search_item_aliases(item):
    """Return normalized title aliases without blending their word boundaries."""
    aliases = []
    for field in ('tmdb_title', 'tmdb_query', 'title', 'name', 'folder_name'):
        alias = _normalize_search_string(item.get(field, ''))
        if alias and alias not in aliases:
            aliases.append(alias)
    return aliases

def _search_relevance_score(item, normalized_query):
    """Rank strict title matches and reject incidental inside-word matches."""
    query_words = normalized_query.split()
    if not query_words:
        return 0

    best_score = 0
    for alias in _search_item_aliases(item):
        alias_words = alias.split()
        if alias == normalized_query:
            best_score = max(best_score, 1000)
            continue
        if alias.startswith(normalized_query + ' '):
            best_score = max(best_score, 900)
            continue
        if any(
            alias_words[start:start + len(query_words)] == query_words
            for start in range(len(alias_words) - len(query_words) + 1)
        ):
            best_score = max(best_score, 800)
            continue
        if all(word in alias_words for word in query_words):
            coverage_bonus = round((len(query_words) / len(alias_words)) * 50)
            best_score = max(best_score, 700 + coverage_bonus)
            continue
        if (
            all(len(word) >= 2 for word in query_words)
            and all(any(alias_word.startswith(word) for alias_word in alias_words) for word in query_words)
        ):
            best_score = max(best_score, 550)
    return best_score

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
                'source': item.get('source', ''),
                'tmdb_query': item.get('tmdb_query', ''),
            }
            # Enrich with TMDB data from content releases if available
            rel = tmdb_by_folder.get(name.lower())
            if rel:
                if rel.get('tmdb_title'): entry['tmdb_title'] = rel['tmdb_title']
                if rel.get('tmdb_poster_path'): entry['tmdb_poster_path'] = rel['tmdb_poster_path']
                if rel.get('tmdb_rating'): entry['tmdb_rating'] = rel['tmdb_rating']
                if rel.get('tmdb_overview'): entry['tmdb_overview'] = rel['tmdb_overview']
                if rel.get('tmdb_query'): entry['tmdb_query'] = rel['tmdb_query']
            
            # Index folder name plus visible TMDB title, so search follows what users see.
            searchable_text = ' '.join(_search_item_aliases(entry))

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
    _invalidate_response_cache_prefix('resp_search_v3_')
    


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
            if not _is_supported_subtitle(item['name']): continue
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
        # List everything, then filter locally. Drive's `name contains` filter
        # can miss uppercase extensions such as .VTT or .ASS.
        files_q = f"'{sub_folder_id}' in parents and trashed = false"
        page_token = None
        while True:
            files_res = svc.files().list(q=files_q, pageSize=200, fields="nextPageToken, files(id, name)", pageToken=page_token).execute()
            for item in files_res.get('files', []):
                if item['name'].startswith('.'): continue
                if not _is_supported_subtitle(item['name']): continue
                sub_path = _subtitle_source_path("gdrive_sub", item)
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
    seen_series_keys = set()
    deduped_series = []
    for item in series_list:
        key = _folder_dedup_key(item)
        if key not in seen_series_keys:
            seen_series_keys.add(key)
            deduped_series.append(item)

    seen_movie_keys = set()
    deduped_movies = []
    for item in movies_list:
        key = _folder_dedup_key(item)
        if key not in seen_movie_keys:
            seen_movie_keys.add(key)
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
                files_q = f"({parent_clauses}) and (mimeType contains 'video/' or {_gdrive_subtitle_query()} or name contains '.m3u8') and trashed = false"
                
                page_token = None
                while True:
                    files_res = service.files().list(q=files_q, pageSize=PAGE_SIZE, fields="nextPageToken, files(id, name, mimeType, parents)", pageToken=page_token).execute()
                    for f in files_res.get('files', []):
                        lname = f['name'].lower()
                        if 'video/' in f['mimeType'] or lname.endswith('.m3u8'): 
                            video_files.append(f)
                        elif _is_supported_subtitle(lname):
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
                    final_subtitle_path = _subtitle_source_path("gdrive", found_subtitle_gdrive)

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
                            folders_data["series"] = series_dedup
                            folders_data["movies"] = movies_dedup
                            _assign_ids_to_folders(folders_data)
                            for category in folders_data:
                                for item in folders_data[category]:
                                    k = item.get('source') if item.get('source','').startswith(('gdrive/', 'gdrive_folder/', 'telegram/')) else item['name']
                                    if k not in old_keys: priority_new_items.add(k)
                            mem_set(folders_key, folders_data); updated_count += 1
                            # Invalidate pre-serialized response cache for folders
                            _invalidate_response_cache('resp_folders', FOLDERS_MERGED_RESPONSE_CACHE_KEY)
                            # Also refresh category folder IDs cache
                            _get_category_folder_ids(service)
                finally: release_lock(folders_key)
            
            # === REBUILD SEARCH INDEX after folders refresh ===
            build_search_index()
            
            # === REFRESH POSTER GDRIVE MAP ===
            try:
                fetch_gdrive_poster_map()
            except Exception:
                pass
            
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
        cached_bytes = _response_cache.get(FOLDERS_MERGED_RESPONSE_CACHE_KEY)
        if cached_bytes:
            return add_no_cache_headers(app.response_class(cached_bytes, mimetype='application/json', status=200))

        with _folders_build_lock:
            cached_bytes = _response_cache.get(FOLDERS_MERGED_RESPONSE_CACHE_KEY)
            if cached_bytes:
                return add_no_cache_headers(app.response_class(cached_bytes, mimetype='application/json', status=200))

            # RAM first; first request after invalidation merges overrides, later requests
            # reuse pre-serialized merged bytes.
            cached = mem_get(key)
            if cached:
                payload = copy.deepcopy(cached)
                _assign_ids_to_folders(payload)
                _merge_content_release_tmdb_into_folders(payload)
                _merge_tmdb_overrides_into_folders(payload)
                _merge_tmdb_ratings_into_folders(payload)
                _merge_gdrive_posters_into_folders(payload)
                _merge_local_posters_into_folders(payload)
                _merge_backdrops_into_folders(payload)
                return add_no_cache_headers(orjson_jsonify(payload, cache_key=FOLDERS_MERGED_RESPONSE_CACHE_KEY))

            # [OFFLINE-FIRST] Cek list.json lokal jika ada dan berisi item
            list_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'list.json')
            if os.path.exists(list_path):
                try:
                    with open(list_path, 'r', encoding='utf-8') as f:
                        local_list = json.load(f)
                    if local_list.get('series') or local_list.get('movies'):
                        payload = copy.deepcopy(local_list)
                        _assign_ids_to_folders(payload)
                        _merge_content_release_tmdb_into_folders(payload)
                        _merge_tmdb_overrides_into_folders(payload)
                        _merge_tmdb_ratings_into_folders(payload)
                        _merge_gdrive_posters_into_folders(payload, force=False)
                        _merge_local_posters_into_folders(payload)
                        _merge_backdrops_into_folders(payload)
                        _assign_ids_to_folders(local_list)
                        mem_set(key, local_list)
                        return add_no_cache_headers(orjson_jsonify(payload, cache_key=FOLDERS_MERGED_RESPONSE_CACHE_KEY))
                except Exception as e:
                    print(f"[CATALOG-OFFLINE] Fallback ke GDrive karena list.json error: {e}", flush=True)

    # Fallback / Live Scan ke Google Drive API
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
        all_c["series"] = series_dedup
        all_c["movies"] = movies_dedup

        _assign_ids_to_folders(all_c)
        mem_set(key, all_c)
        _invalidate_response_cache('resp_folders', FOLDERS_MERGED_RESPONSE_CACHE_KEY)
        build_search_index()  # [NEW] Build search index immediately so search works instantly after server restart
        payload = copy.deepcopy(all_c)
        _assign_ids_to_folders(payload)
        _merge_content_release_tmdb_into_folders(payload)
        _merge_tmdb_overrides_into_folders(payload)
        _merge_tmdb_ratings_into_folders(payload)
        _merge_gdrive_posters_into_folders(payload, force=force)
        _merge_local_posters_into_folders(payload)
        _merge_backdrops_into_folders(payload)
        return add_no_cache_headers(orjson_jsonify(payload, cache_key=FOLDERS_MERGED_RESPONSE_CACHE_KEY))
    stale = mem_get(key)
    if stale:
        payload = copy.deepcopy(stale)
        _assign_ids_to_folders(payload)
        _merge_content_release_tmdb_into_folders(payload)
        _merge_tmdb_overrides_into_folders(payload)
        _merge_tmdb_ratings_into_folders(payload)
        _merge_gdrive_posters_into_folders(payload, force=force)
        _merge_local_posters_into_folders(payload)
        _merge_backdrops_into_folders(payload)
        return add_no_cache_headers(orjson_jsonify(payload, cache_key=FOLDERS_MERGED_RESPONSE_CACHE_KEY))
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
            dur = _videos_cache_duration(cached)
            if mem_is_fresh(key, dur):
                if not cached.get('catalog_item'):
                    cached = copy.deepcopy(cached)
                    cached['catalog_item'] = _catalog_item_for_folder(folder_name)
                    _response_cache.pop(resp_key, None)
                _merge_episode_stills_into_videos(cached.get('videos') or [], cached.get('catalog_item'), folder_name)
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
                    files_q = f"'{fid}' in parents and (mimeType contains 'video/' or {_gdrive_subtitle_query()}) and trashed = false"
                    files_res = svc.files().list(q=files_q, pageSize=PAGE_SIZE, fields="files(id, name, mimeType, parents)").execute()
                    video_files = [f for f in files_res.get('files', []) if 'video/' in f.get('mimeType', '')]
                    subtitle_files_gd = [f for f in files_res.get('files', []) if _is_supported_subtitle(f['name'])]
                    
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
                                        sub_path = _subtitle_source_path("gdrive", s); break
                                if not sub_path:
                                    cleaned_v = _clean_title_for_matching(video['name'])
                                    for s in subtitle_files_gd:
                                        if _clean_title_for_matching(s['name']) == cleaned_v:
                                            sub_path = _subtitle_source_path("gdrive", s); break
                            
                            result_vids.append({"name": video_base_name, "path": f"gdrive/{video['id']}", "subtitle_path": sub_path, "season": 1, "episode": 1, "source": "Google Drive", "original_name": video['name']})
                        
                        _merge_episode_stills_into_videos(result_vids, catalog_item, folder_name, resolved_name)
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
                        sq = f"'{pid}' in parents and {_gdrive_subtitle_query()} and trashed = false"
                        sr = svc.files().list(q=sq, fields="files(id, name)").execute()
                        for s in sr.get('files', []):
                            if _is_supported_subtitle(s['name']) and s['name'].lower().startswith(name.lower()):
                                sub_path = _subtitle_source_path("gdrive", s); break
                    single_vids = [{"name": name, "path": folder_name, "subtitle_path": sub_path, "season": 1, "episode": 1, "source": "Google Drive", "original_name": meta.get('name', 'Unknown')}]
                    _merge_episode_stills_into_videos(single_vids, catalog_item, folder_name, resolved_name)
                    final = {"videos": single_vids, "has_season_folders": False, "catalog_item": catalog_item}
                    mem_set(key, final); _response_cache.pop(resp_key, None)
                    return orjson_jsonify(final, cache_key=resp_key)
             except Exception as e:
                print(f"[VIDEOS] Error handling '{folder_name}': {e}", flush=True)
                return orjson_jsonify({"error": "File not found"}, 404)
        vids.sort(key=lambda x: (x.get("season", 999), x.get("episode", 999), x["name"]))
        _merge_episode_stills_into_videos(vids, catalog_item, folder_name, resolved_name)
        final = {"videos": vids, "has_season_folders": has_s, "catalog_item": catalog_item}
        mem_set(key, final); _response_cache.pop(resp_key, None)
        return add_cache_headers(orjson_jsonify(final, cache_key=resp_key), max_age=_videos_cache_duration(final))
    
    stale = mem_get(key)
    if stale:
        if not stale.get('catalog_item'):
            stale = copy.deepcopy(stale)
            stale['catalog_item'] = _catalog_item_for_folder(folder_name, resolved_name)
            _response_cache.pop(resp_key, None)
        _merge_episode_stills_into_videos(stale.get('videos') or [], stale.get('catalog_item'), folder_name, resolved_name)
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
        
        file_metadata = _get_gdrive_file_metadata(fid)
        file_name = request.args.get('file_name') or file_metadata.get('file_name', '')
        res = {
            "url": f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media", 
            "stream_url": f"/api/gdrive-stream/{fid}?stream_token={quote(_make_stream_token(fid), safe='')}",
            "audio_transcode_url": f"/api/gdrive-audio-transcode/{fid}?stream_token={quote(_make_stream_token(fid), safe='')}",
            "audio_transcode_start_url": f"/api/gdrive-audio-transcode-start/{fid}?stream_token={quote(_make_stream_token(fid), safe='')}",
            "embedded_subtitles_url": f"/api/gdrive-embedded-subtitles/{fid}?stream_token={quote(_make_stream_token(fid), safe='')}",
            "hls_manifest_url": f"/api/hls-manifest/{fid}?stream_token={quote(_make_stream_token(fid), safe='')}",
            "file_name": file_name,
            "duration_ms": file_metadata.get('duration_ms', 0),
            "audio_codec": file_metadata.get('audio_codec', ''),
            "audio_codec_label": file_metadata.get('audio_codec_label', ''),
            "audio_channels": file_metadata.get('audio_channels', 0),
            "audio_profile": file_metadata.get('audio_profile', ''),
            "audio_probe_status": file_metadata.get('audio_probe_status', ''),
            "audio_streams": file_metadata.get('audio_streams', []),
            "browser_audio_supported": file_metadata.get('browser_audio_supported'),
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

def _get_gdrive_file_metadata(fid):
    now = time.time()
    with _gdrive_file_metadata_cache_lock:
        cached_metadata = _gdrive_file_metadata_cache.get(fid)
        cached_at = _gdrive_file_metadata_cache_ts.get(fid, 0)
        if cached_metadata and _is_gdrive_file_metadata_cache_fresh(cached_metadata, cached_at, now):
            return cached_metadata

    with _gdrive_file_metadata_key_locks_lock:
        key_lock = _gdrive_file_metadata_key_locks.setdefault(fid, threading.Lock())
    with key_lock:
        now = time.time()
        with _gdrive_file_metadata_cache_lock:
            cached_metadata = _gdrive_file_metadata_cache.get(fid)
            cached_at = _gdrive_file_metadata_cache_ts.get(fid, 0)
            if cached_metadata and _is_gdrive_file_metadata_cache_fresh(cached_metadata, cached_at, now):
                return cached_metadata

        svc = get_gdrive_service()
        if not svc:
            return {}
        try:
            payload = svc.files().get(fileId=fid, fields="name,videoMediaMetadata(durationMillis)").execute()
            duration_ms = int(payload.get("videoMediaMetadata", {}).get("durationMillis") or 0)
            probed_metadata = _probe_gdrive_media_metadata(fid)
            if duration_ms <= 0:
                duration_ms = probed_metadata.get("duration_ms", 0)
            metadata = {
                "duration_ms": duration_ms,
                "file_name": payload.get("name", ""),
                **probed_metadata,
            }
            metadata["duration_ms"] = duration_ms
        except Exception:
            return {}
        with _gdrive_file_metadata_cache_lock:
            _gdrive_file_metadata_cache[fid] = metadata
            _gdrive_file_metadata_cache_ts[fid] = now
        return metadata

def _is_gdrive_file_metadata_cache_fresh(metadata, cached_at, now):
    stable_audio_probe = metadata.get('audio_probe_status') in ('ok', 'no-audio')
    ttl = _gdrive_file_metadata_cache_ttl if metadata.get('duration_ms', 0) > 0 and stable_audio_probe else _gdrive_file_metadata_retry_ttl
    return now - cached_at < ttl

def _probe_gdrive_duration_ms(fid):
    return _probe_gdrive_media_metadata(fid).get("duration_ms", 0)

def _probe_gdrive_media_metadata(fid):
    if not shutil.which("ffprobe"):
        return {"audio_probe_status": "ffprobe-unavailable", "duration_ms": 0}
    token = _get_fresh_gdrive_token()
    if not token:
        return {"audio_probe_status": "token-unavailable", "duration_ms": 0}

    media_url = f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media"
    ffprobe_headers = f"Authorization: Bearer {token}\r\nUser-Agent: Mutflix/1.0\r\n"
    command = [
        "ffprobe",
        "-v", "error",
        "-headers", ffprobe_headers,
        "-show_entries", "format=duration:stream=index,codec_type,codec_name,profile,channels,channel_layout,duration:stream_tags=language,title:stream_disposition=default",
        "-of", "json",
        media_url,
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=AUDIO_TRANSCODE_PROBE_TIMEOUT_SECONDS,
        )
        if result.returncode != 0:
            return {"audio_probe_status": "failed", "duration_ms": 0}
        payload = json.loads(result.stdout or '{}')
        durations = [
            payload.get('format', {}).get('duration'),
            *[stream.get('duration') for stream in payload.get('streams', [])],
        ]
        numeric_durations = [
            float(duration)
            for duration in durations
            if duration not in (None, '', 'N/A')
        ]
        audio_streams = [
            _normalize_audio_stream_metadata(stream)
            for stream in payload.get('streams', [])
            if stream.get('codec_type') == 'audio'
        ]
        audio_streams = [stream for stream in audio_streams if stream]
        primary_audio = next((stream for stream in audio_streams if stream.get('default')), None)
        if not primary_audio and audio_streams:
            primary_audio = audio_streams[0]

        if not primary_audio:
            return {
                "audio_probe_status": "no-audio",
                "browser_audio_supported": True,
                "duration_ms": round(max(numeric_durations) * 1000) if numeric_durations else 0,
                "audio_streams": audio_streams,
            }

        audio_codec = primary_audio.get('codec', '')
        return {
            "audio_codec": audio_codec,
            "audio_codec_label": _format_audio_codec_label(primary_audio),
            "audio_channels": primary_audio.get('channels', 0),
            "audio_profile": primary_audio.get('profile', ''),
            "audio_probe_status": "ok",
            "audio_streams": audio_streams,
            "browser_audio_supported": _is_browser_supported_audio_codec(audio_codec),
            "duration_ms": round(max(numeric_durations) * 1000) if numeric_durations else 0,
        }
    except Exception:
        return {"audio_probe_status": "failed", "duration_ms": 0}

def _normalize_audio_stream_metadata(stream):
    codec = str(stream.get('codec_name') or '').lower()
    try:
        channels = int(stream.get('channels') or 0)
    except (TypeError, ValueError):
        channels = 0
    tags = stream.get('tags') or {}
    disposition = stream.get('disposition') or {}
    return {
        "index": stream.get('index'),
        "codec": codec,
        "profile": str(stream.get('profile') or ''),
        "channels": channels,
        "channel_layout": str(stream.get('channel_layout') or ''),
        "language": str(tags.get('language') or ''),
        "title": str(tags.get('title') or ''),
        "default": bool(disposition.get('default')),
        "browser_supported": _is_browser_supported_audio_codec(codec),
    }

def _is_browser_supported_audio_codec(codec):
    return str(codec or '').lower() in _browser_supported_audio_codecs

def _format_audio_codec_label(audio_stream):
    codec = str(audio_stream.get('codec') or '').upper()
    codec_labels = {
        "AAC": "AAC",
        "AC3": "AC-3",
        "EAC3": "E-AC-3",
        "DTS": "DTS",
        "TRUEHD": "TrueHD",
        "MP3": "MP3",
        "OPUS": "Opus",
        "VORBIS": "Vorbis",
        "FLAC": "FLAC",
    }
    label = codec_labels.get(codec, codec or "Unknown audio")
    channels = audio_stream.get('channels') or 0
    if channels:
        label = f"{label} {channels}ch"
    return label


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


_gdrive_stream_http_local = threading.local()
_audio_transcode_slots = threading.BoundedSemaphore(AUDIO_TRANSCODE_MAX_CONCURRENT)
_embedded_subtitle_slots = threading.BoundedSemaphore(EMBEDDED_SUBTITLE_MAX_CONCURRENT)
_embedded_subtitle_probe_slots = threading.BoundedSemaphore(EMBEDDED_SUBTITLE_MAX_CONCURRENT)
_embedded_subtitle_probe_inflight = set()
_embedded_subtitle_probe_inflight_lock = threading.Lock()
_embedded_text_subtitle_codecs = frozenset({'ass', 'mov_text', 'ssa', 'subrip', 'text', 'webvtt'})

def _get_gdrive_stream_http_session():
    """Reuse upstream TCP/TLS connections for stream ranges and HLS segments."""
    session = getattr(_gdrive_stream_http_local, 'session', None)
    if session is None:
        session = requests.Session()
        session.headers.update({"User-Agent": "Mutflix/1.0"})
        retry = Retry(
            total=2,
            connect=2,
            read=0,
            status=2,
            backoff_factor=0.35,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset({'GET'}),
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=8)
        session.mount('https://', adapter)
        _gdrive_stream_http_local.session = session
    return session


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

    stream_http = _get_gdrive_stream_http_session()
    try:
        upstream = stream_http.get(media_url, headers=headers, stream=True, timeout=(10, 120))
    except requests.RequestException:
        return jsonify({"error": "GDrive stream temporarily unavailable"}), 502
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
        try:
            upstream = stream_http.get(media_url, headers=headers, stream=True, timeout=(10, 120))
        except requests.RequestException:
            return jsonify({"error": "GDrive stream temporarily unavailable"}), 502

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=1024 * 1024):
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

@app.route("/api/gdrive-audio-transcode/<fid>", methods=["GET", "OPTIONS"])
def gdrive_audio_transcode(fid):
    """Stream browser-compatible fragmented MP4 while converting unsupported audio to AAC."""
    if request.method == "OPTIONS":
        return Response(status=204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Range",
        })
    if not _verify_stream_token(fid, request.args.get('stream_token')):
        return jsonify({"error": "Unauthorized stream"}), 401
    if not shutil.which("ffmpeg"):
        return jsonify({"error": "FFmpeg unavailable"}), 503
    if not _audio_transcode_slots.acquire(timeout=AUDIO_TRANSCODE_SLOT_WAIT_SECONDS):
        return jsonify({"error": "Audio transcoder busy"}), 503

    token = _get_fresh_gdrive_token()
    if not token:
        _audio_transcode_slots.release()
        return jsonify({"error": "GDrive token unavailable"}), 503

    media_url = f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media"
    ffmpeg_headers = f"Authorization: Bearer {token}\r\nUser-Agent: Mutflix/1.0\r\n"
    start_seconds = _clamp_audio_transcode_start(request.args.get('start_seconds'))
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-headers", ffmpeg_headers,
    ]
    if start_seconds > 0:
        # Video stays stream-copied, so preserve the same keyframe preroll for
        # transcoded audio instead of discarding it with FFmpeg's accurate seek.
        command.extend(["-ss", str(start_seconds), "-noaccurate_seek"])
    command.extend([
        "-i", media_url,
        "-map", "0:v:0?",
        "-map", "0:a:0?",
        "-sn",
        "-dn",
        "-c:v", "copy",
        "-c:a", "aac",
        "-ac", "2",
        "-b:a", AUDIO_TRANSCODE_AUDIO_BITRATE,
        "-avoid_negative_ts", "make_zero",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4",
        "pipe:1",
    ])
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
    except Exception:
        _audio_transcode_slots.release()
        return jsonify({"error": "Failed to start audio transcoder"}), 500

    def generate():
        try:
            while True:
                chunk = process.stdout.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                process.stdout.close()
            except Exception:
                pass
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
            _audio_transcode_slots.release()

    return Response(
        stream_with_context(generate()),
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Expose-Headers": "Content-Type",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Content-Type": "video/mp4",
            "X-Accel-Buffering": "no",
        },
        direct_passthrough=True,
    )

@app.route("/api/gdrive-audio-transcode-start/<fid>", methods=["GET"])
def get_gdrive_audio_transcode_start(fid):
    if not _verify_stream_token(fid, request.args.get('stream_token')):
        return orjson_jsonify({"error": "Unauthorized stream"}, 401)

    requested_start = _clamp_audio_transcode_start(request.args.get('start_seconds'))
    timeline_offset_seconds, timeline_offset_source = _resolve_gdrive_audio_transcode_start_info(fid, requested_start)
    response = orjson_jsonify({
        "stream_start_seconds": requested_start,
        "timeline_offset_seconds": timeline_offset_seconds,
        "timeline_offset_ready": timeline_offset_source in {"origin", "cache", "probe"},
        "timeline_offset_source": timeline_offset_source,
    })
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response

def _clamp_audio_transcode_start(value):
    try:
        numeric_value = float(value)
    except (TypeError, ValueError):
        return 0
    return round(min(24 * 60 * 60, max(0, numeric_value)), 3)

def _resolve_gdrive_audio_transcode_start(fid, requested_start):
    return _resolve_gdrive_audio_transcode_start_info(fid, requested_start)[0]

def _resolve_gdrive_audio_transcode_start_info(fid, requested_start):
    """Resolve the keyframe FFmpeg will use for stream-copy video seeking."""
    if requested_start <= 0:
        return requested_start, "origin"
    if not shutil.which("ffprobe"):
        return requested_start, "ffprobe-unavailable"

    cache_key = f"audio_transcode_keyframe_v2_{fid}_{requested_start:g}"
    cached_start = disk_cache.get(cache_key)
    if cached_start is not None:
        return float(cached_start), "cache"

    token = _get_fresh_gdrive_token()
    if not token:
        return requested_start, "token-unavailable"

    media_url = f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media"
    ffprobe_headers = f"Authorization: Bearer {token}\r\nUser-Agent: Mutflix/1.0\r\n"
    probe_start = max(0, requested_start - AUDIO_TRANSCODE_KEYFRAME_LOOKBEHIND_SECONDS)
    probe_duration = max(0.1, requested_start - probe_start + 0.1)
    command = [
        "ffprobe",
        "-v", "error",
        "-headers", ffprobe_headers,
        "-read_intervals", f"{probe_start:g}%+{probe_duration:g}",
        "-select_streams", "v:0",
        "-skip_frame", "nokey",
        "-show_entries", "frame=best_effort_timestamp_time",
        "-of", "csv=p=0",
        media_url,
    ]
    last_error = None
    for attempt in range(AUDIO_TRANSCODE_KEYFRAME_PROBE_ATTEMPTS):
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                check=False,
                text=True,
                timeout=AUDIO_TRANSCODE_KEYFRAME_PROBE_TIMEOUT_SECONDS,
            )
            timestamps = [
                float(match.group(0))
                for line in (result.stdout or '').splitlines()
                if (match := re.search(r'-?\d+(?:\.\d+)?', line))
            ]
            valid_timestamps = [
                timestamp
                for timestamp in timestamps
                if 0 <= timestamp <= requested_start
            ]
            if valid_timestamps:
                resolved_start = max(valid_timestamps)
                disk_cache.set(cache_key, resolved_start, expire=AUDIO_TRANSCODE_KEYFRAME_CACHE_TTL_SECONDS)
                return resolved_start, "probe"
            last_error = "empty"
        except Exception as exc:
            last_error = exc.__class__.__name__

        if attempt < AUDIO_TRANSCODE_KEYFRAME_PROBE_ATTEMPTS - 1 and AUDIO_TRANSCODE_KEYFRAME_PROBE_RETRY_DELAY_SECONDS > 0:
            time.sleep(AUDIO_TRANSCODE_KEYFRAME_PROBE_RETRY_DELAY_SECONDS)

    return requested_start, f"fallback-{last_error or 'unknown'}"

@app.route("/api/gdrive-embedded-subtitles/<fid>")
@rate_limited(limit=_SUBTITLE_RATE_LIMIT_RPM, scope='embedded-subtitle-list', cors=True)
def list_gdrive_embedded_subtitles(fid):
    stream_token = request.args.get('stream_token')
    if not _verify_stream_token(fid, stream_token):
        return _embedded_subtitle_json_response({"error": "Unauthorized stream"}, 401)

    detected_tracks = _probe_gdrive_embedded_subtitles(fid)
    tracks = []
    for track in detected_tracks:
        track_url = (
            f"/api/gdrive-embedded-subtitle/{fid}/{track['stream_index']}.vtt"
            f"?stream_token={quote(stream_token, safe='')}"
        )
        tracks.append({**track, "url": track_url})
    return _embedded_subtitle_json_response({
        "probing": _is_gdrive_embedded_subtitle_probe_inflight(fid),
        "tracks": tracks,
    })

@app.route("/api/gdrive-embedded-subtitle/<fid>/<int:stream_index>.vtt")
@rate_limited(limit=_SUBTITLE_RATE_LIMIT_RPM, scope='embedded-subtitle-track', cors=True)
def serve_gdrive_embedded_subtitle(fid, stream_index):
    if not _verify_stream_token(fid, request.args.get('stream_token')):
        return _embedded_subtitle_json_response({"error": "Unauthorized stream"}, 401)

    tracks = _probe_gdrive_embedded_subtitles(fid)
    if not any(track['stream_index'] == stream_index for track in tracks):
        return _embedded_subtitle_json_response({"error": "Text subtitle track not found"}, 404)

    start_seconds = _clamp_embedded_subtitle_time(request.args.get('start_seconds'), default=0, maximum=24 * 60 * 60)
    duration_seconds = _clamp_embedded_subtitle_time(request.args.get('duration_seconds'), default=0, maximum=10 * 60)
    cache_key = _embedded_subtitle_vtt_cache_key(fid, stream_index, start_seconds, duration_seconds)
    cached_content = disk_cache.get(cache_key)
    if cached_content:
        return _embedded_subtitle_vtt_response(cached_content, start_seconds, duration_seconds)

    if not acquire_lock(cache_key, timeout_seconds=EMBEDDED_SUBTITLE_EXTRACT_TIMEOUT_SECONDS):
        deadline = time.time() + 15
        while time.time() < deadline:
            cached_content = disk_cache.get(cache_key)
            if cached_content:
                return _embedded_subtitle_vtt_response(cached_content, start_seconds, duration_seconds)
            time.sleep(0.2)
        return _embedded_subtitle_json_response({"error": "Subtitle extraction is already running"}, 503)

    if not _embedded_subtitle_slots.acquire(blocking=False):
        release_lock(cache_key)
        return _embedded_subtitle_json_response({"error": "Subtitle extractor busy"}, 503)

    process = _start_gdrive_embedded_subtitle_extract(
        fid,
        stream_index,
        start_seconds=start_seconds,
        duration_seconds=duration_seconds,
    )
    if not process:
        _embedded_subtitle_slots.release()
        release_lock(cache_key)
        return _embedded_subtitle_json_response({"error": "Failed to start subtitle extraction"}, 502)

    def generate():
        chunks = []
        try:
            while True:
                chunk = process.stdout.readline()
                if not chunk:
                    break
                chunks.append(chunk)
                yield chunk
            if process.wait() == 0 and chunks:
                disk_cache.set(cache_key, b''.join(chunks), expire=EMBEDDED_SUBTITLE_CACHE_TTL_SECONDS)
        finally:
            try:
                process.stdout.close()
            except Exception:
                pass
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
            _embedded_subtitle_slots.release()
            release_lock(cache_key)

    return _embedded_subtitle_vtt_stream_response(generate(), start_seconds, duration_seconds)

def _probe_gdrive_embedded_subtitles(fid):
    cache_key = f"embedded_subtitle_tracks_v2_{fid}"
    cached_tracks = disk_cache.get(cache_key)
    if cached_tracks is not None:
        return cached_tracks

    token = _get_fresh_gdrive_token()
    if not token:
        return []

    tracks = _run_gdrive_embedded_subtitle_probe(
        fid,
        token,
        fast=True,
        timeout=EMBEDDED_SUBTITLE_FAST_PROBE_TIMEOUT_SECONDS,
    )
    if tracks is None:
        _schedule_gdrive_embedded_subtitle_probe(fid)
        return []

    _cache_gdrive_embedded_subtitle_tracks(cache_key, tracks)
    return tracks

def _run_gdrive_embedded_subtitle_probe(fid, token, *, fast, timeout):
    if not shutil.which("ffprobe"):
        return []

    media_url = f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media"
    ffprobe_headers = f"Authorization: Bearer {token}\r\nUser-Agent: Mutflix/1.0\r\n"
    command = [
        "ffprobe",
        "-v", "error",
        "-headers", ffprobe_headers,
    ]
    if fast:
        command.extend([
            "-probesize", "2097152",
            "-analyzeduration", "1000000",
        ])
    command.extend([
        "-select_streams", "s",
        "-show_entries", "stream=index,codec_name:stream_tags=language,title:stream_disposition=default,forced",
        "-of", "json",
        media_url,
    ])
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            return None
        tracks = []
        for stream in json.loads(result.stdout or '{}').get('streams', []):
            codec = str(stream.get('codec_name') or '').lower()
            if codec not in _embedded_text_subtitle_codecs:
                continue
            tags = stream.get('tags') or {}
            disposition = stream.get('disposition') or {}
            language = str(tags.get('language') or '').lower()
            tracks.append({
                "codec": codec,
                "default": bool(disposition.get('default')),
                "forced": bool(disposition.get('forced')),
                "label": tags.get('title') or language or f"Subtitle {len(tracks) + 1}",
                "language": language,
                "stream_index": int(stream['index']),
            })
        return tracks
    except Exception:
        return None

def _schedule_gdrive_embedded_subtitle_probe(fid):
    with _embedded_subtitle_probe_inflight_lock:
        if fid in _embedded_subtitle_probe_inflight:
            return
        _embedded_subtitle_probe_inflight.add(fid)

    def run_probe():
        if not _embedded_subtitle_probe_slots.acquire(blocking=False):
            with _embedded_subtitle_probe_inflight_lock:
                _embedded_subtitle_probe_inflight.discard(fid)
            return
        try:
            token = _get_fresh_gdrive_token()
            if not token:
                return
            tracks = _run_gdrive_embedded_subtitle_probe(
                fid,
                token,
                fast=False,
                timeout=EMBEDDED_SUBTITLE_DEEP_PROBE_TIMEOUT_SECONDS,
            )
            if tracks is not None:
                _cache_gdrive_embedded_subtitle_tracks(f"embedded_subtitle_tracks_v2_{fid}", tracks)
        finally:
            _embedded_subtitle_probe_slots.release()
            with _embedded_subtitle_probe_inflight_lock:
                _embedded_subtitle_probe_inflight.discard(fid)

    _global_executor.submit(run_probe)

def _is_gdrive_embedded_subtitle_probe_inflight(fid):
    with _embedded_subtitle_probe_inflight_lock:
        return fid in _embedded_subtitle_probe_inflight

def _cache_gdrive_embedded_subtitle_tracks(cache_key, tracks):
    ttl = EMBEDDED_SUBTITLE_CACHE_TTL_SECONDS if tracks else EMBEDDED_SUBTITLE_EMPTY_CACHE_TTL_SECONDS
    disk_cache.set(cache_key, tracks, expire=ttl)

def _start_gdrive_embedded_subtitle_extract(fid, stream_index, *, start_seconds=0, duration_seconds=0):
    if not shutil.which("ffmpeg"):
        return None
    token = _get_fresh_gdrive_token()
    if not token:
        return None

    media_url = f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media"
    ffmpeg_headers = f"Authorization: Bearer {token}\r\nUser-Agent: Mutflix/1.0\r\n"
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-headers", ffmpeg_headers,
    ]
    if start_seconds > 0:
        command.extend(["-ss", str(start_seconds)])
    command.extend(["-copyts", "-start_at_zero"])
    command.extend([
        "-i", media_url,
    ])
    if duration_seconds > 0:
        command.extend(["-to", str(start_seconds + duration_seconds)])
    command.extend([
        "-map", f"0:{stream_index}",
        "-vn",
        "-an",
        "-dn",
        "-c:s", "webvtt",
        "-flush_packets", "1",
        "-f", "webvtt",
        "pipe:1",
    ])
    try:
        return subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
    except Exception:
        return None

def _clamp_embedded_subtitle_time(value, *, default, maximum):
    try:
        numeric_value = float(value)
    except (TypeError, ValueError):
        return default
    return round(min(maximum, max(0, numeric_value)), 3)

def _embedded_subtitle_vtt_cache_key(fid, stream_index, start_seconds=0, duration_seconds=0):
    return f"embedded_subtitle_vtt_{EMBEDDED_SUBTITLE_VTT_CACHE_VERSION}_{fid}_{stream_index}_{start_seconds:g}_{duration_seconds:g}"

def _embedded_subtitle_json_response(payload, status=200):
    response = orjson_jsonify(payload, status)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response

def _embedded_subtitle_timing_headers(start_seconds=0, duration_seconds=0):
    return {
        "Access-Control-Expose-Headers": "X-Mutflix-Subtitle-Timeline, X-Mutflix-Subtitle-Cue-Offset, X-Mutflix-Subtitle-Window-Duration, X-Mutflix-Subtitle-Cache-Version",
        "X-Mutflix-Subtitle-Cache-Version": EMBEDDED_SUBTITLE_VTT_CACHE_VERSION,
        "X-Mutflix-Subtitle-Cue-Offset": "0",
        "X-Mutflix-Subtitle-Timeline": "absolute",
        "X-Mutflix-Subtitle-Window-Duration": f"{float(duration_seconds):g}",
    }

def _embedded_subtitle_vtt_response(content, start_seconds=0, duration_seconds=0):
    response = Response(content, mimetype='text/vtt')
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Cache-Control'] = 'public, max-age=86400'
    response.headers.update(_embedded_subtitle_timing_headers(start_seconds, duration_seconds))
    return response

def _embedded_subtitle_vtt_stream_response(content, start_seconds=0, duration_seconds=0):
    return Response(
        stream_with_context(content),
        headers={
            "Access-Control-Allow-Origin": "*",
            **_embedded_subtitle_timing_headers(start_seconds, duration_seconds),
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Content-Type": "text/vtt; charset=utf-8",
            "X-Accel-Buffering": "no",
        },
        direct_passthrough=True,
    )

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
    resp = _get_gdrive_stream_http_session().get(m3u8_url, headers=headers, timeout=15)
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
@rate_limited(limit=_SUBTITLE_RATE_LIMIT_RPM, scope='subtitle', cors=True)
def serve_subtitle(file_path):
    """[OPTIMIZED] Serve subtitle from RAM cache first (~0.01ms).
    Falls back to download on cache miss, then auto-caches for next time."""
    # === RAM CACHE HIT (~0.01ms) ===
    cached_content = _subtitle_cache.get(file_path)
    if cached_content:
        return _subtitle_response(cached_content, file_path)
    
    # === CACHE MISS: download and cache ===
    content = _download_subtitle(file_path)
    if content:
        # Cache for next request
        with _subtitle_lock:
            _subtitle_cache[file_path] = content
            _subtitle_cache_ts[file_path] = time.time()
        return _subtitle_response(content, file_path)
    
    response = jsonify({"error": "Not found"})
    response.status_code = 404
    response.headers['Access-Control-Allow-Origin'] = '*'
    return response

def _subtitle_response(content, file_path):
    response = Response(content, mimetype=_subtitle_mimetype(file_path))
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Cache-Control'] = 'public, max-age=86400'
    return response

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
    resp_key = "resp_search_v3_" + hashlib.md5(normalized_query.encode("utf-8")).hexdigest()
    cached_bytes = _response_cache.get(resp_key)
    cached_at = _response_cache_ts.get(resp_key, 0)
    if cached_bytes and (time.time() - cached_at) < SEARCH_RESPONSE_CACHE_TTL_SECONDS:
        return add_cache_headers(app.response_class(cached_bytes, mimetype='application/json', status=200), max_age=30)
    if cached_bytes:
        _invalidate_response_cache(resp_key)
    
    words = _normalize_text(query)
    if not words:
        return orjson_jsonify([])
    
    results = []
    seen = set()

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
                if (
                    item['name'] in common_names and
                    item['name'] not in seen and
                    _search_relevance_score(item, normalized_query) > 0
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
                    search_candidate = {
                        **item,
                        'folder_name': name,
                        'tmdb_title': rel.get('tmdb_title', ''),
                        'tmdb_query': rel.get('tmdb_query') or item.get('tmdb_query', ''),
                    }
                    if _search_relevance_score(search_candidate, query_lower) > 0:
                        seen.add(name)
                        result = {
                            'name': name,
                            'folder_name': name,
                            'type': item.get('type', media_type.rstrip('s')),
                            'source': item.get('source', ''),
                            'tmdb_query': search_candidate.get('tmdb_query', ''),
                        }
                        if rel.get('tmdb_title'): result['tmdb_title'] = rel['tmdb_title']
                        if rel.get('tmdb_poster_path'): result['tmdb_poster_path'] = rel['tmdb_poster_path']
                        if rel.get('tmdb_rating'): result['tmdb_rating'] = rel['tmdb_rating']
                        if rel.get('tmdb_overview'): result['tmdb_overview'] = rel['tmdb_overview']
                        if rel.get('release_date'):
                            result['release_date'] = rel['release_date']
                            if result.get('type') in ('tv', 'series'):
                                result['first_air_date'] = rel['release_date']
                        results.append(result)
    
    # Sort every source with the same relevance rules used for filtering.
    query_lower = normalized_query
    results.sort(key=lambda x: (
        -_search_relevance_score(x, query_lower),
        _normalize_search_string(x.get('tmdb_title') or x.get('name', '')),
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
            if rel.get('release_date'):
                res['release_date'] = rel['release_date']
                if res.get('type') in ('tv', 'series'):
                    res['first_air_date'] = rel['release_date']
            
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
    """Get all content releases — cached in RAM/Redis."""
    key = "content_releases"
    
    # Tier 0: RAM
    cached = mem_get(key)
    if cached is not None and mem_is_fresh(key, 300):  # 5 min TTL
        return add_cache_headers(orjson_jsonify(cached, cache_key='resp_releases'), max_age=300)
        
    # Tier 1: Redis
    redis_data = redis_get("releases:all")
    if redis_data is not None:
        mem_set(key, redis_data)
        return add_cache_headers(orjson_jsonify(redis_data, cache_key='resp_releases'), max_age=300)
        
    # Tier 2: DB
    releases = _load_releases()
    mem_set(key, releases)
    redis_set("releases:all", releases, ttl_seconds=300)
    _response_cache.pop('resp_releases', None)
    return add_cache_headers(orjson_jsonify(releases, cache_key='resp_releases'), max_age=300)

def _refresh_content_releases_cache():
    releases = _load_releases()
    mem_set('content_releases', releases)
    redis_set("releases:all", releases, ttl_seconds=300)
    _invalidate_response_cache('resp_releases', FOLDERS_MERGED_RESPONSE_CACHE_KEY)
    build_search_index()

@app.route("/api/content-releases", methods=["POST"])
@token_required(check_expiry=False)
def set_content_release(current_user):
    """Create or update a content release (admin only)."""
    data = request.get_json()
    if not data or 'folder_name' not in data:
        return jsonify({"error": "Missing folder_name"}), 400
    
    folder_name = data['folder_name']
    _save_release(folder_name, data)
    _refresh_content_releases_cache()
    return orjson_jsonify({"success": True, "status": data.get('status', 'published')})

@app.route("/api/content-releases/<path:folder_name>", methods=["DELETE"])
@token_required(check_expiry=False)
def delete_content_release(current_user, folder_name):
    """Delete a content release."""
    _delete_release(folder_name)
    _refresh_content_releases_cache()
    return orjson_jsonify({"success": True})


# ==========================================
# DEBUG ROUTES (temporary)
# ==========================================

@app.route("/api/server-location")
def server_location():
    import socket
    import requests
    import os
    data = {
        "hostname": socket.gethostname(),
        "env_region_candidates": {
            k: v for k, v in os.environ.items()
            if "REGION" in k.upper()
            or "ZONE" in k.upper()
            or "LOCATION" in k.upper()
            or "SPACE" in k.upper()
        }
    }

    try:
        r = requests.get("https://ipinfo.io/json", timeout=5)
        data["ipinfo"] = r.json()
    except Exception as e:
        data["ipinfo_error"] = str(e)

    return jsonify(data)

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

# --- ALL POSTERS LIST ENDPOINT ---
@app.route("/api/posters/<media_type>/<path:item_id>")
@token_required(check_expiry=False)
@rate_limited()
def get_all_posters(current_user, media_type, item_id):
    """Return all available poster URLs strictly for a given media item (local + GDrive + TMDB)."""
    if media_type not in ('movies', 'series', 'movie', 'tv'):
        return jsonify({"error": "Invalid media type"}), 400
    p_cat = 'series' if media_type in ('series', 'tv') else 'movies'
    item_id_str = str(item_id).strip()
    name_param = (request.args.get('name') or request.args.get('folder_name') or '').strip()
    tmdb_id_param = (request.args.get('tmdb_id') or '').strip()
    clean_name = _normalize_key(name_param) if name_param else ''
    
    posters = []
    seen_urls = set()

    # 1. Local filesystem posters (strictly by name/clean_name)
    base_dir = os.path.dirname(os.path.abspath(__file__))
    poster_dirs = []
    if name_param:
        poster_dirs.extend([
            os.path.join(base_dir, 'storage', 'posters', p_cat, name_param),
            os.path.join(base_dir, 'posters', p_cat, name_param),
        ])
    if clean_name and clean_name != name_param:
        poster_dirs.extend([
            os.path.join(base_dir, 'storage', 'posters', p_cat, clean_name),
            os.path.join(base_dir, 'posters', p_cat, clean_name),
        ])

    for p_dir in poster_dirs:
        if os.path.isdir(p_dir):
            try:
                imgs = sorted(
                    [f.name for f in os.scandir(p_dir) if f.is_file() and f.name.lower().endswith(('.jpg', '.jpeg', '.png', '.webp'))],
                    key=lambda x: int(os.path.splitext(x)[0]) if os.path.splitext(x)[0].isdigit() else x
                )
                for img in imgs:
                    folder_base = os.path.basename(p_dir)
                    url = f"/posters/{p_cat}/{folder_base}/{img}"
                    if url not in seen_urls:
                        seen_urls.add(url)
                        posters.append({"url": url, "source": "local", "filename": img})
            except Exception:
                pass

    # 2. GDrive posters (strictly by name keys)
    try:
        poster_map, *rest = fetch_gdrive_poster_map()
        if poster_map:
            candidate_keys = []
            if name_param:
                candidate_keys.extend([
                    f"{p_cat}_{name_param.lower().strip()}",
                    name_param.lower().strip(),
                ])
            if clean_name:
                candidate_keys.extend([
                    f"{p_cat}_{clean_name}",
                    clean_name,
                ])

            p_ids = []
            for ck in candidate_keys:
                found = poster_map.get(ck)
                if found:
                    if isinstance(found, list):
                        p_ids.extend(found)
                    elif isinstance(found, str):
                        p_ids.append(found)

            for fid in p_ids:
                url = f"/api/gdrive-poster/{fid}"
                if url not in seen_urls:
                    seen_urls.add(url)
                    posters.append({"url": url, "source": "gdrive", "file_id": fid})
    except Exception:
        pass

    # 3. media.db primary poster (only matching by_name)
    try:
        p_map = _get_local_poster_map()
        by_name = p_map.get(p_cat, {}).get('by_name', {})
        candidate_urls = []
        if name_param:
            for k in (name_param.lower().strip(), clean_name):
                if k and k in by_name:
                    val = by_name[k]
                    candidate_urls.extend(val if isinstance(val, list) else [val])

        for url in candidate_urls:
            if url and url not in seen_urls:
                seen_urls.add(url)
                posters.append({"url": url, "source": "local", "filename": os.path.basename(url)})
    except Exception:
        pass

    # 4. TMDB alternative official posters
    eff_tmdb_id = tmdb_id_param if (tmdb_id_param and tmdb_id_param.isdigit()) else None
    if eff_tmdb_id:
        tmdb_endpoint_type = 'movie' if p_cat == 'movies' else 'tv'
        try:
            status, tmdb_data = _fetch_tmdb_proxy_cached(f"{tmdb_endpoint_type}/{eff_tmdb_id}/images", {})
            if status == 200 and isinstance(tmdb_data, dict):
                tmdb_posters = tmdb_data.get('posters') or []
                if isinstance(tmdb_posters, list):
                    for tp in tmdb_posters:
                        fp = tp.get('file_path')
                        if fp:
                            url = f"/api/tmdb-image/w342{fp}"
                            if url not in seen_urls:
                                seen_urls.add(url)
                                posters.append({"url": url, "source": "tmdb", "file_path": fp})
        except Exception as tmdb_err:
            print(f"[POSTER-PICKER] TMDB images lookup error for {eff_tmdb_id}: {tmdb_err}", flush=True)

    return jsonify({
        "media_type": p_cat,
        "item_id": item_id,
        "total": len(posters),
        "posters": posters
    })

def optimize_image_bytes(raw_bytes, target_width=None, quality=75, output_format="WEBP", log_errors=True):
    """
    Downscale and convert image to WebP (or specified format) using high-speed encoding
    to minimize CPU time and bandwidth while maximizing frontend load speed.
    """
    if not raw_bytes:
        return None, None
    if not _HAS_PIL:
        return raw_bytes, "image/jpeg"
    try:
        with Image.open(io.BytesIO(raw_bytes)) as im:
            # Correct orientation from EXIF
            try:
                im = ImageOps.exif_transpose(im)
            except Exception:
                pass

            orig_w, orig_h = im.size
            if target_width and target_width > 0 and orig_w > target_width:
                target_height = max(1, int(orig_h * (target_width / orig_w)))
                resample = getattr(Image, 'Resampling', Image).BILINEAR
                im = im.resize((target_width, target_height), resample=resample)

            fmt = (output_format or "WEBP").upper()
            mimetype = "image/webp" if fmt == "WEBP" else "image/jpeg"

            buf = io.BytesIO()
            if fmt == "WEBP":
                if im.mode not in ('RGB', 'RGBA'):
                    im = im.convert('RGBA' if 'A' in im.mode else 'RGB')
                # method=0 provides ultra-fast WebP compression with excellent quality
                im.save(buf, format="WEBP", quality=quality, method=0)
            else:
                if im.mode not in ('RGB', 'L'):
                    if 'A' in im.mode:
                        bg = Image.new('RGB', im.size, (255, 255, 255))
                        bg.paste(im, mask=im.split()[-1])
                        im = bg
                    else:
                        im = im.convert('RGB')
                im.save(buf, format="JPEG", quality=quality, optimize=False)

            return buf.getvalue(), mimetype
    except Exception as e:
        if log_errors:
            print(f"[IMAGE-OPT] Error optimizing image: {e}", flush=True)
        # Never disguise arbitrary/corrupt bytes as JPEG. Callers can reject
        # the source or fall back to serving a known local file directly.
        return None, None


def parse_requested_width(default=None, max_limit=2560):
    w_arg = request.args.get('w') or request.args.get('width') or request.args.get('size')
    if not w_arg:
        return default
    match = re.search(r'(\d+)', str(w_arg))
    if match:
        try:
            w = int(match.group(1))
            if 10 <= w <= max_limit:
                # Snap to standard width buckets for maximum cache hit ratio
                for standard_w in (185, 342, 500, 780, 1280, 1920):
                    if abs(w - standard_w) <= 20:
                        return standard_w
                return w
        except (ValueError, TypeError):
            pass
    return default


_CACHED_GDRIVE_CREDS = {}
_CACHED_CREDS_LOCK = threading.Lock()

def _get_cached_gdrive_creds(b64):
    if not b64:
        return None
    with _CACHED_CREDS_LOCK:
        creds = _CACHED_GDRIVE_CREDS.get(b64)
        if not creds:
            creds = _load_gdrive_credentials(b64)
            if creds:
                _CACHED_GDRIVE_CREDS[b64] = creds
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception:
                pass
        return creds

_GDRIVE_POSTER_SESSION = requests.Session()
_gdrive_adapter = requests.adapters.HTTPAdapter(pool_connections=64, pool_maxsize=64, max_retries=1)
_GDRIVE_POSTER_SESSION.mount('https://', _gdrive_adapter)

_in_flight_poster_locks = defaultdict(threading.Lock)
_in_flight_meta_lock = threading.Lock()

def _get_poster_flight_lock(file_id):
    with _in_flight_meta_lock:
        return _in_flight_poster_locks[file_id]


def _fetch_gdrive_raw_poster_bytes(file_id):
    """Direct fast token-based fetch from Google Drive with service fallback."""
    # 1. Fast direct Bearer token request via connection pool
    token_sources = []
    for token_source in (GDRIVE_POSTER_TOKEN_B64, GDRIVE_TOKEN_B64, GDRIVE_SUBTITLE_TOKEN_B64):
        if token_source and token_source not in token_sources:
            token_sources.append(token_source)

    for b64 in token_sources:
        try:
            creds = _get_cached_gdrive_creds(b64)
            if creds and creds.token:
                res = _GDRIVE_POSTER_SESSION.get(
                    f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&supportsAllDrives=true",
                    headers={"Authorization": f"Bearer {creds.token}", "User-Agent": "Mutflix/1.0"},
                    timeout=8,
                )
                if res.status_code == 200 and res.content:
                    return res.content
        except Exception:
            pass

    # 2. Fallback to standard Google API client service
    services = []
    poster_svc = get_gdrive_poster_service()
    if poster_svc:
        services.append(poster_svc)
    main_svc = get_gdrive_service()
    if main_svc and main_svc not in services:
        services.append(main_svc)
    sub_svc = get_gdrive_subtitle_service()
    if sub_svc and sub_svc not in services:
        services.append(sub_svc)

    for svc in services:
        try:
            req = svc.files().get_media(fileId=file_id, supportsAllDrives=True)
            img_bytes = req.execute()
            if img_bytes:
                return img_bytes
        except Exception:
            continue
    return None


def _serve_optimized_local_file(directories, filename, default_width=None, max_width=1920):
    full_path = None
    for d in directories:
        candidate = os.path.join(d, filename)
        if os.path.exists(candidate) and os.path.isfile(candidate):
            full_path = candidate
            break

    if not full_path:
        return jsonify({"error": "File not found"}), 404

    target_width = parse_requested_width(default=default_width, max_limit=max_width)
    ext = os.path.splitext(filename)[1].lower()

    # If SVG or not standard raster image and no width requested, serve directly
    if not target_width and ext not in ('.png', '.jpg', '.jpeg', '.webp'):
        return send_from_directory(os.path.dirname(full_path), os.path.basename(full_path))

    accept = request.headers.get('Accept', '')
    fmt = "WEBP" if "image/webp" in accept or "*/*" in accept or not accept else "JPEG"
    mimetype = "image/webp" if fmt == "WEBP" else "image/jpeg"

    mtime = os.path.getmtime(full_path)
    cache_key_opt = f"local_img_opt_{filename}_{int(mtime)}_w{target_width or 'orig'}_{fmt.lower()}"

    etag = f'"{hashlib.md5(cache_key_opt.encode()).hexdigest()}"'
    if request.headers.get('If-None-Match') == etag:
        return Response(status=304)

    # 1. Ultra-fast RAM memory cache
    mem_cached = _get_img_mem(cache_key_opt)
    if mem_cached:
        resp = Response(mem_cached, mimetype=mimetype)
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        resp.headers['ETag'] = etag
        resp.headers['X-Image-Cache'] = 'HIT-MEM'
        return resp

    # 2. Disk cache
    cached_opt = disk_cache.get(cache_key_opt)
    if cached_opt:
        _set_img_mem(cache_key_opt, cached_opt)
        resp = Response(cached_opt, mimetype=mimetype)
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        resp.headers['ETag'] = etag
        resp.headers['X-Image-Cache'] = 'HIT-OPT'
        return resp

    try:
        with open(full_path, 'rb') as f:
            raw_bytes = f.read()
        opt_bytes, out_mime = optimize_image_bytes(raw_bytes, target_width=target_width, quality=75, output_format=fmt)
        if opt_bytes:
            disk_cache.set(cache_key_opt, opt_bytes, expire=86400 * 30)
            _set_img_mem(cache_key_opt, opt_bytes)
            resp = Response(opt_bytes, mimetype=out_mime or mimetype)
            resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
            resp.headers['ETag'] = etag
            resp.headers['X-Image-Cache'] = 'MISS-OPT'
            return resp
    except Exception as e:
        print(f"[LOCAL-IMAGE] Error optimizing {filename}: {e}", flush=True)

    return send_from_directory(os.path.dirname(full_path), os.path.basename(full_path))


# --- POSTER & BACKDROP SERVING ENDPOINTS ---
@app.route("/posters/<path:filename>")
def serve_posters(filename):
    poster_dirs = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage", "posters"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "posters"),
    ]
    return _serve_optimized_local_file(poster_dirs, filename, default_width=342, max_width=780)


@app.route("/backdrops/<path:filename>")
def serve_backdrops(filename):
    backdrop_dirs = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage", "backdrops"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "backdrops"),
    ]
    return _serve_optimized_local_file(backdrop_dirs, filename, default_width=1280, max_width=1920)


@app.route("/api/gdrive-poster/<file_id>")
def serve_gdrive_poster(file_id):
    """Proxy, optimize, resize and cache poster images from dedicated GDrive poster account."""
    if not file_id or not re.fullmatch(r'^[a-zA-Z0-9_-]{10,100}$', file_id):
        return jsonify({"error": "Invalid file ID"}), 400

    target_width = parse_requested_width(default=342, max_limit=1920)
    accept = request.headers.get('Accept', '')
    fmt = "WEBP" if "image/webp" in accept or "*/*" in accept or not accept else "JPEG"
    mimetype = "image/webp" if fmt == "WEBP" else "image/jpeg"

    # Do not repeatedly download known corrupt/non-image Drive objects.
    invalid_cache_key = f"gdrive_poster_invalid_v1_{file_id}"
    try:
        if disk_cache.get(invalid_cache_key):
            return jsonify({"error": "Invalid poster image"}), 404
    except Exception:
        pass

    # Fast path: Resized/Optimized cache key
    # v2 ignores legacy cache entries that may contain non-image payloads
    # previously mislabeled and cached as JPEG.
    cache_key_opt = f"gdrive_poster_opt_v2_{file_id}_w{target_width or 'orig'}_{fmt.lower()}"
    etag = f'"{hashlib.md5(cache_key_opt.encode()).hexdigest()}"'

    if request.headers.get('If-None-Match') == etag:
        return Response(status=304)

    # 1. RAM Memory Cache
    mem_cached = _get_img_mem(cache_key_opt)
    if mem_cached:
        resp = Response(mem_cached, mimetype=mimetype)
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        resp.headers['ETag'] = etag
        resp.headers['X-Image-Cache'] = 'HIT-MEM'
        return resp

    # 2. Disk Cache
    cached_opt = disk_cache.get(cache_key_opt)
    if cached_opt:
        _set_img_mem(cache_key_opt, cached_opt)
        resp = Response(cached_opt, mimetype=mimetype)
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        resp.headers['ETag'] = etag
        resp.headers['X-Image-Cache'] = 'HIT-OPT'
        return resp

    # Single-flight deduplication to avoid duplicate downloads on concurrent requests
    lock = _get_poster_flight_lock(file_id)
    with lock:
        # Check cache again inside lock
        mem_cached = _get_img_mem(cache_key_opt)
        if mem_cached:
            resp = Response(mem_cached, mimetype=mimetype)
            resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
            resp.headers['ETag'] = etag
            resp.headers['X-Image-Cache'] = 'HIT-MEM'
            return resp

        cached_opt = disk_cache.get(cache_key_opt)
        if cached_opt:
            _set_img_mem(cache_key_opt, cached_opt)
            resp = Response(cached_opt, mimetype=mimetype)
            resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
            resp.headers['ETag'] = etag
            resp.headers['X-Image-Cache'] = 'HIT-OPT'
            return resp

        # Check raw original image blob cache
        raw_cache_key = f"gdrive_poster_blob_{file_id}"
        raw_img = disk_cache.get(raw_cache_key)

        if not raw_img:
            raw_img = _fetch_gdrive_raw_poster_bytes(file_id)
            if raw_img:
                disk_cache.set(raw_cache_key, raw_img, expire=86400 * 60)

        if not raw_img:
            return jsonify({"error": "Poster not found"}), 404

        # Optimize and resize image
        opt_bytes, out_mime = optimize_image_bytes(
            raw_img,
            target_width=target_width,
            quality=75,
            output_format=fmt,
            log_errors=False,
        )
        if opt_bytes:
            disk_cache.set(cache_key_opt, opt_bytes, expire=86400 * 60)
            _set_img_mem(cache_key_opt, opt_bytes)
            resp = Response(opt_bytes, mimetype=out_mime or mimetype)
            resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
            resp.headers['ETag'] = etag
            resp.headers['X-Image-Cache'] = 'MISS-OPT'
            return resp

        # Remove a previously cached API/error payload or corrupt Drive file;
        # otherwise every request would retry the same invalid bytes for 60 days.
        try:
            disk_cache.delete(raw_cache_key)
        except Exception:
            pass
        payload_size = len(raw_img)
        payload_signature = raw_img[:12].hex()
        try:
            disk_cache.set(
                invalid_cache_key,
                {"size": payload_size, "signature": payload_signature},
                expire=86400 * 7,
            )
        except Exception:
            pass
        print(
            f"[POSTER-GDRIVE] Skipping invalid image file={file_id} "
            f"bytes={payload_size} signature={payload_signature}",
            flush=True,
        )
        return jsonify({"error": "Invalid poster image"}), 422

# Frontend Serve
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_fe(path):
    if path.startswith("api/") or path.startswith("video/") or path.startswith("subtitle/") or path.startswith("posters/") or path.startswith("backdrops/"): return jsonify({"error": "Not found"}), 404
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
