import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { saveTmdbOverride, TMDB_ORIGIN_COUNTRIES, clearAllTmdbInfoLocalCache, cacheClear } from '../services/api';

const folderKeyOf = (item) => (item?.name || item?.folder_name || '').trim();

const TmdbPosterEditModal = ({ item, onClose, onSaved }) => {
  const folderName = folderKeyOf(item);
  const [tmdbQuery, setTmdbQuery] = useState('');
  const [mediaType, setMediaType] = useState('tv');
  const [year, setYear] = useState('');
  const [region, setRegion] = useState('');
  const [includeAdult, setIncludeAdult] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!item) return;
    setTmdbQuery(item.tmdb_query || item.name || item.folder_name || '');
    setMediaType(item.tmdb_override_media_type === 'movie' ? 'movie' : 'tv');
    setYear(item.override_year != null && item.override_year !== '' ? String(item.override_year) : '');
    setRegion(item.override_region || '');
    setIncludeAdult(!!item.include_adult);
    setError(null);
  }, [item]);

  if (!item || !folderName) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    const q = tmdbQuery.trim();
    if (!q) {
      setError('Title query wajib diisi.');
      return;
    }
    setSaving(true);
    try {
      const y = year.trim() === '' ? null : parseInt(year, 10);
      if (year.trim() !== '' && Number.isNaN(y)) {
        setError('Tahun tidak valid.');
        setSaving(false);
        return;
      }
      await saveTmdbOverride({
        folder_name: folderName,
        tmdb_query: q,
        media_type: mediaType,
        override_year: y,
        override_region: region || null,
        include_adult: includeAdult,
      });
      clearAllTmdbInfoLocalCache();
      cacheClear();
      onSaved?.();
      onClose?.();
    } catch (err) {
      setError(err.message || 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100000] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div
        className="w-full max-w-md bg-[#16181d] border border-white/10 rounded-xl shadow-2xl overflow-hidden"
        role="dialog"
        aria-labelledby="tmdb-edit-title"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <h2 id="tmdb-edit-title" className="text-lg font-bold text-white">
            Edit poster (TMDB)
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition"
            aria-label="Tutup"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-xs text-gray-500">
            Folder: <span className="text-gray-300 font-mono">{folderName}</span>
          </p>

          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-1.5">Title query (TMDB)</label>
            <input
              type="text"
              value={tmdbQuery}
              onChange={(e) => setTmdbQuery(e.target.value)}
              className="w-full bg-[#0a0b0f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-[#00dc41] focus:outline-none"
              placeholder="Judul untuk pencarian TMDB"
              autoComplete="off"
            />
          </div>

          <div>
            <span className="block text-xs font-semibold text-gray-400 mb-2">Tipe</span>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                <input
                  type="radio"
                  name="mediaType"
                  checked={mediaType === 'tv'}
                  onChange={() => setMediaType('tv')}
                  className="accent-[#00dc41]"
                />
                Series (TV)
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                <input
                  type="radio"
                  name="mediaType"
                  checked={mediaType === 'movie'}
                  onChange={() => setMediaType('movie')}
                  className="accent-[#00dc41]"
                />
                Movie
              </label>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-1.5">Tahun (opsional)</label>
            <input
              type="number"
              min="1900"
              max="2100"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              className="w-full bg-[#0a0b0f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-[#00dc41] focus:outline-none"
              placeholder="Mis. 2023"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-1.5">Negara produksi (opsional, kode TMDB)</label>
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="w-full bg-[#0a0b0f] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:border-[#00dc41] focus:outline-none"
            >
              {TMDB_ORIGIN_COUNTRIES.map((c) => (
                <option key={c.code || 'none'} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-400">
            <input
              type="checkbox"
              checked={includeAdult}
              onChange={(e) => setIncludeAdult(e.target.checked)}
              className="accent-[#00dc41]"
            />
            Sertakan hasil dewasa (TMDB)
          </label>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-lg border border-white/15 text-gray-300 hover:bg-white/5 text-sm font-semibold"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2.5 rounded-lg bg-[#00dc41] text-black text-sm font-bold hover:bg-[#00f04a] disabled:opacity-50"
            >
              {saving ? 'Menyimpan…' : 'Simpan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default TmdbPosterEditModal;
