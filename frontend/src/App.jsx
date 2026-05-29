import React from 'react';

function App() {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-100 font-sans p-6 select-none relative overflow-hidden">
      {/* Background radial glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-sky-500/10 rounded-full blur-[120px] pointer-events-none"></div>
      
      <div className="max-w-md w-full text-center z-10 space-y-6">
        {/* Status Indicator */}
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-400 text-sm font-medium tracking-wide">
          <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse"></span>
          Frontend Clean Canvas
        </div>
        
        {/* Title */}
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-white">
          MUTFLIX
        </h1>
        
        {/* Subtitle */}
        <p className="text-slate-400 text-base leading-relaxed">
          Proyek React dan Tailwind CSS kosong berhasil diinisialisasi. Halaman ini siap untuk dibangun kembali dari awal.
        </p>

        {/* Tech Badges */}
        <div className="flex justify-center gap-3 pt-2">
          <span className="px-3 py-1 bg-slate-900 border border-slate-800 rounded-lg text-xs font-semibold text-slate-300">
            React
          </span>
          <span className="px-3 py-1 bg-slate-900 border border-slate-800 rounded-lg text-xs font-semibold text-slate-300">
            Tailwind CSS
          </span>
          <span className="px-3 py-1 bg-slate-900 border border-slate-800 rounded-lg text-xs font-semibold text-slate-300">
            Vite
          </span>
        </div>
      </div>
    </div>
  );
}

export default App;
