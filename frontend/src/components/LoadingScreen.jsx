import React from 'react';
import { createPortal } from 'react-dom';

/**
 * Di-portal ke document.body supaya menutupi seluruh viewport.
 * Kalau tetap di dalam subtree yang punya transform (mis. animate-page-enter),
 * fixed positioning terikat ke ancestor — footer di luar bisa tampil di "depan" overlay.
 */
const LoadingScreen = () => {
  const overlay = (
    <div
      className="fixed inset-0 z-[99999] bg-[#0a0b0f] flex items-center justify-center"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="relative flex flex-col items-center">
        <div className="w-12 h-12 border-4 border-[#00dc41]/20 border-t-[#00dc41] rounded-full animate-spin shadow-[0_0_15px_rgba(0,220,65,0.2)]" />
        <div className="mt-4 flex items-center gap-1 opacity-50">
          <div className="w-1.5 h-1.5 bg-[#00dc41] rounded-full animate-bounce" style={{ animationDelay: '0s' }} />
          <div className="w-1.5 h-1.5 bg-[#00dc41] rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
          <div className="w-1.5 h-1.5 bg-[#00dc41] rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} />
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
};

export default LoadingScreen;
