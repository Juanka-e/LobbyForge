import { ReactNode } from 'react';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-[#0f1115] text-[#e6e8eb]">
      {/* Server Dock */}
      <nav className="w-16 flex-none border-r border-[#1f242c] p-3 flex flex-col items-center gap-4">
        <div className="w-10 h-10 bg-[#1f242c] rounded-full flex items-center justify-center font-bold">L</div>
        {/* Server placeholders */}
        <div className="w-10 h-10 bg-[#1f242c] rounded-full"></div>
      </nav>

      {/* Channel Sidebar */}
      <aside className="w-60 flex-none border-r border-[#1f242c] p-4">
        <h2 className="font-bold mb-4">LobbyForge</h2>
        <div className="space-y-6">
          <div>
            <h3 className="text-[#9aa3ad] text-xs font-semibold uppercase mb-2">Text Channels</h3>
            <ul className="space-y-1">
              <li className="px-2 py-1 bg-[#1f242c] rounded"># general</li>
              <li className="px-2 py-1 text-[#9aa3ad]"># announcements</li>
            </ul>
          </div>
          <div>
            <h3 className="text-[#9aa3ad] text-xs font-semibold uppercase mb-2">Voice Channels</h3>
            <ul className="space-y-1">
              <li className="px-2 py-1 text-[#9aa3ad]">🔊 Lounge</li>
            </ul>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-[#1f242c] flex items-center px-6 font-semibold">
          # general
        </header>
        <div className="flex-1 p-6 overflow-y-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
