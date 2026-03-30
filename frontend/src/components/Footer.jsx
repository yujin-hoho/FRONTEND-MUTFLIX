import React from 'react';
import { Monitor, Smartphone, Tv, Globe, Search } from 'lucide-react';

const Footer = () => {
  const APK_DRIVE_URL =
    'https://drive.google.com/drive/folders/16sQCGO3jGX1uUJ-gH2BbZh92LG2B3yfF?usp=drive_link';

  const devices = [
    { name: 'Computer', icon: Monitor },
    { name: 'Phone', icon: Smartphone, href: APK_DRIVE_URL },
    { name: 'TV', icon: Tv, badge: true },
    { name: 'Web', icon: Globe },
  ];

  return (
    <footer className="w-full bg-[#0a0b0f] pt-16 pb-12 px-6 flex flex-col items-center border-t border-white/5 mt-auto">
      <h2 className="text-white text-xl md:text-2xl font-bold mb-3 tracking-tight text-center">
        Get the Best Experience on the APP
      </h2>
      
      <div className="flex items-center gap-2 mb-10">
        <Search className="w-4 h-4 text-[#00dc41]" />
        <span className="text-[#00dc41] font-bold text-sm tracking-wide">MUTFLIX</span>
        <span className="text-gray-500 text-sm">Search in App Store</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 w-full max-w-5xl">
        {devices.map((device) => {
          const Icon = device.icon;
          const cardClass =
            'bg-[#1a1c22] border border-white/10 rounded-lg py-4 px-8 flex items-center justify-center gap-3 hover:bg-[#252830] transition-all cursor-pointer group relative shadow-lg';
          const inner = (
            <>
              {device.badge && (
                <div className="absolute top-2 right-2 w-2 h-2 bg-red-600 rounded-full shadow-[0_0_8px_rgba(220,38,38,0.5)]" />
              )}
              <Icon className="w-5 h-5 text-gray-400 group-hover:text-[#00dc41] transition-colors" strokeWidth={2} />
              <span className="text-gray-300 font-semibold text-sm group-hover:text-white transition-colors">
                {device.name}
              </span>
            </>
          );
          if (device.href) {
            return (
              <a
                key={device.name}
                href={device.href}
                target="_blank"
                rel="noopener noreferrer"
                className={cardClass}
              >
                {inner}
              </a>
            );
          }
          return (
            <div key={device.name} className={cardClass}>
              {inner}
            </div>
          );
        })}
      </div>

      <div className="mt-12 pt-8 border-t border-white/5 w-full max-w-5xl flex flex-col md:flex-row justify-between items-center gap-4 text-[12px] text-gray-500 font-medium">
        <div className="flex gap-6">
          <a href="#" className="hover:text-gray-300 transition">Privacy Policy</a>
          <a href="#" className="hover:text-gray-300 transition">Terms of Service</a>
          <a href="#" className="hover:text-gray-300 transition">Cookie Policy</a>
        </div>
        <div className="text-center md:text-right">
          © 2026 MUTFLIX. All rights reserved.
        </div>
      </div>
    </footer>
  );
};

export default Footer;
