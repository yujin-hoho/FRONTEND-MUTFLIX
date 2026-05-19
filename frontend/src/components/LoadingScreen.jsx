import React from 'react';
import { createPortal } from 'react-dom';

const LoadingScreen = () => {
  const overlay = (
    <div
      className="fixed inset-0 z-[99999] bg-[#080a0e] flex items-center justify-center"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="relative flex flex-col items-center px-6">
        <div className="text-[#00dc41] text-3xl font-black tracking-tight mb-7">MUTFLIX</div>
        <div className="relative w-14 h-14">
          <div className="absolute inset-0 rounded-full border border-[#00dc41]/15" />
          <div className="absolute inset-1 rounded-full border-[3px] border-[#00dc41]/15 border-t-[#00dc41] animate-spin shadow-[0_0_24px_rgba(0,220,65,0.18)]" />
          <div className="absolute inset-[18px] rounded-full bg-[#00dc41] shadow-[0_0_18px_rgba(0,220,65,0.45)]" />
        </div>
        <div className="mt-5 h-1 w-44 overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-1/2 rounded-full bg-[#00dc41] animate-[slideUp_1.1s_ease-in-out_infinite_alternate]" />
        </div>
        <span className="sr-only">Loading content</span>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
};

export default LoadingScreen;
