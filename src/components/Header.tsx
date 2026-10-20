import React from 'react';

interface HeaderProps {
  activeTab: 'voice' | 'dialer' | 'api';
  onTabChange: (tab: 'voice' | 'dialer' | 'api') => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, onTabChange }) => {
  return (
    <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-6 sm:px-8 pt-7 pb-5 text-white">
      <div className="flex justify-between items-center flex-wrap gap-3">
        <h1 className="text-2xl sm:text-[1.75rem] font-extrabold tracking-tight flex items-center gap-2.5">
          <span>🤖</span> AI Call Assistant
        </h1>
        <span className="bg-emerald-500/25 border border-emerald-400 text-emerald-100 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">
          Telephony & Dialer Ready
        </span>
      </div>
      <p className="text-slate-200 text-sm sm:text-[0.95rem] mt-1.5">
        AI Voice Agent with Automated Greetings, Extension Transfers & Dialer Webhooks
      </p>

      {/* Tabs */}
      <div className="flex bg-slate-900/35 rounded-xl p-1 mt-5 gap-1.5">
        <button
          type="button"
          onClick={() => onTabChange('voice')}
          className={`flex-1 py-2.5 px-3 sm:px-4 rounded-lg text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer ${
            activeTab === 'voice'
              ? 'bg-white text-slate-900 shadow-md'
              : 'text-slate-200 hover:text-white hover:bg-white/10'
          }`}
        >
          <span>🎙️</span>
          <span className="hidden sm:inline">Live Voice Assistant</span>
          <span className="sm:hidden">Voice Call</span>
        </button>

        <button
          type="button"
          onClick={() => onTabChange('dialer')}
          className={`flex-1 py-2.5 px-3 sm:px-4 rounded-lg text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer ${
            activeTab === 'dialer'
              ? 'bg-white text-slate-900 shadow-md'
              : 'text-slate-200 hover:text-white hover:bg-white/10'
          }`}
        >
          <span>📞</span>
          <span className="hidden sm:inline">Dialer Simulator & PBX</span>
          <span className="sm:hidden">Dialer</span>
        </button>

        <button
          type="button"
          onClick={() => onTabChange('api')}
          className={`flex-1 py-2.5 px-3 sm:px-4 rounded-lg text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer ${
            activeTab === 'api'
              ? 'bg-white text-slate-900 shadow-md'
              : 'text-slate-200 hover:text-white hover:bg-white/10'
          }`}
        >
          <span>🔌</span>
          <span className="hidden sm:inline">Dialer API & Webhooks</span>
          <span className="sm:hidden">API Specs</span>
        </button>
      </div>
    </div>
  );
};
