/**
 * GM Dashboard – Epic 9
 * Desktop-first, landscape layout with live map and control panels.
 */

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DashboardLayout } from "./components/DashboardLayout";
import { LiveMap } from "./components/LiveMap";
import { MediaInbox } from "./components/MediaInbox";
import { CommandPanel } from "./components/CommandPanel";
import { EventControls } from "./components/EventControls";
import { TeamStatusPanel } from "./components/TeamStatusPanel";
import { LeaderboardPanel } from "./components/LeaderboardPanel";
import { AccountPanel } from "./components/AccountPanel";
import { LoginPage } from "./components/LoginPage";
import { useGMAuth } from "./contexts/AuthContext";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 5000, // Refresh every 5 seconds for live data
      staleTime: 3000,
    },
  },
});

type ActiveTab = "map" | "media" | "commands" | "accounts" | "leaderboard";

export default function App() {
  const { account, ready, logout } = useGMAuth();
  const [activeTab, setActiveTab] = useState<ActiveTab>("map");
  if (!ready) return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-300">Sitzung wird geprüft…</div>;
  if (!account) return <LoginPage />;

  return (
    <QueryClientProvider client={queryClient}>
      <DashboardLayout
        header={
          <div className="flex items-center justify-between px-6 py-4 bg-slate-800 border-b border-slate-700">
            <div>
              <h1 className="text-2xl font-bold text-slate-100">
                JLW 2026 – GM Dashboard 🛡️
              </h1>
              <p className="text-sm text-slate-400">Game Master Control Center</p>
            </div>
            <EventControls />
            <button onClick={logout} className="rounded border border-slate-600 px-3 py-1 text-sm">Abmelden</button>
          </div>
        }
        sidebar={
          <div className="flex flex-col gap-4 p-4 bg-slate-800 border-r border-slate-700 h-full overflow-y-auto">
            <TeamStatusPanel />
          </div>
        }
        tabs={
          <div className="flex gap-2 px-6 py-3 bg-slate-800 border-b border-slate-700">
            <TabButton
              active={activeTab === "accounts"}
              onClick={() => setActiveTab("accounts")}
            >
              👥 Accounts
            </TabButton>
            <TabButton
              active={activeTab === "map"}
              onClick={() => setActiveTab("map")}
            >
              🗺️ Live Map
            </TabButton>
            <TabButton
              active={activeTab === "media"}
              onClick={() => setActiveTab("media")}
            >
              📸 Media Inbox
            </TabButton>
            <TabButton
              active={activeTab === "commands"}
              onClick={() => setActiveTab("commands")}
            >
              ⚙️ Commands
            </TabButton>
            <TabButton
              active={activeTab === "leaderboard"}
              onClick={() => setActiveTab("leaderboard")}
            >
              🏆 Leaderboard
            </TabButton>
          </div>
        }
        main={
          <div className="h-full w-full bg-slate-900">
            {activeTab === "map" && <LiveMap />}
            {activeTab === "media" && <MediaInbox />}
            {activeTab === "commands" && <CommandPanel />}
            {activeTab === "accounts" && <AccountPanel />}
            {activeTab === "leaderboard" && <LeaderboardPanel />}
          </div>
        }
      />
    </QueryClientProvider>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-lg font-medium transition-colors ${
        active
          ? "bg-slate-700 text-slate-100"
          : "text-slate-400 hover:text-slate-200 hover:bg-slate-700/50"
      }`}
    >
      {children}
    </button>
  );
}
