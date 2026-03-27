import React from 'react';

const LoadingScreen = () => {
  return (
    <div className="fixed inset-0 z-[9999] bg-[#0a0b0f] flex items-center justify-center">
      <div className="relative flex flex-col items-center">
        {/* Simple Green Buffering Spinner */}
        <div className="w-12 h-12 border-4 border-[#00dc41]/20 border-t-[#00dc41] rounded-full animate-spin shadow-[0_0_15px_rgba(0,220,65,0.2)]"></div>
        
        {/* Optional: Subtle branding if desired, but keeping it minimal for now */}
        <div className="mt-4 flex items-center gap-1 opacity-50">
          <div className="w-1.5 h-1.5 bg-[#00dc41] rounded-full animate-bounce" style={{ animationDelay: '0s' }}></div>
          <div className="w-1.5 h-1.5 bg-[#00dc41] rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
          <div className="w-1.5 h-1.5 bg-[#00dc41] rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></div>
        </div>
      </div>
    </div>
  );
};

export default LoadingScreen;
