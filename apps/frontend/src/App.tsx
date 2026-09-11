/**
 * App – Root shell / client-side router.
 *
 * Screens (simple state machine – no router dependency needed for Epic 2):
 *   "login"  →  LoginPage   (unauthenticated)
 *   "lobby"  →  LobbyPage   (authenticated, before entering the game world)
 *   "class-selection" → binding class confirmation
 *   "preflight" → GPS check and server-side map release
 *   "map"    →  GameMap     (authenticated, active play)
 *
 * The AuthProvider is mounted here so all child components can use useAuth().
 */

import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./contexts/auth.context.js";
import { WebSocketProvider } from "./contexts/websocket.context.js";
import { ConnectionIndicator } from "./components/common/connection-indicator.js";
import { LoginPage } from "./pages/login.page.js";
import { LobbyPage } from "./pages/lobby.page.js";
import { GameMap } from "./components/map/game-map.js";
import { ClassSelectionPage } from "./pages/class-selection.page.js";
import { PreflightPage } from "./pages/preflight.page.js";

// ── Screen type ───────────────────────────────────────────────────────────────

type Screen = "login" | "lobby" | "class-selection" | "preflight" | "map";

// ── Inner shell (needs AuthContext) ──────────────────────────────────────────

function AppShell() {
  const { isAuthenticated } = useAuth();

  // Determine initial screen from persisted auth state
  const [screen, setScreen] = useState<Screen>(() =>
    isAuthenticated ? "lobby" : "login",
  );
  const [autoReleaseSuppressed, setAutoReleaseSuppressed] = useState(false);

  // Sync screen state with auth state:
  // - If token disappears (logout / localStorage cleared) → back to login
  // - If token appears while on login screen (login succeeded) → to lobby
  useEffect(() => {
    if (!isAuthenticated) {
      setScreen("login");
    } else if (isAuthenticated && screen === "login") {
      setScreen("lobby");
    }
  }, [isAuthenticated]); // intentionally omit `screen` to avoid loop

  // Start the mandatory setup flow from the lobby.
  function handleEnterMap() {
    setScreen("class-selection");
  }

  function handleGameReleased(preflightCompleted: boolean) {
    setAutoReleaseSuppressed(false);
    setScreen(preflightCompleted ? "map" : "preflight");
  }

  function handleSetupBack() {
    setAutoReleaseSuppressed(true);
    setScreen("lobby");
  }

  // Callback fired by GameMap to return to lobby
  function handleBackToLobby() {
    setAutoReleaseSuppressed(true);
    setScreen("lobby");
  }

  // Render current screen with connection indicator
  let content: JSX.Element;

  switch (screen) {
    case "login":
      content = <LoginPage />;
      break;

    case "lobby":
      if (!isAuthenticated) {
        // Guard: should not happen, but be defensive
        content = <LoginPage />;
      } else {
        content = <LobbyPage onEnterMap={handleEnterMap} onGameReleased={handleGameReleased} autoRelease={!autoReleaseSuppressed} />;
      }
      break;

    case "map":
      if (!isAuthenticated) {
        content = <LoginPage />;
      } else {
        content = <GameMap onBack={handleBackToLobby} />;
      }
      break;
    case "class-selection":
      content = isAuthenticated ? <ClassSelectionPage onConfirmed={() => setScreen("preflight")} onBack={handleSetupBack} /> : <LoginPage />;
      break;
    case "preflight":
      content = isAuthenticated ? <PreflightPage onGranted={() => setScreen("map")} onBack={handleSetupBack} onWaiting={() => { setAutoReleaseSuppressed(false); setScreen("lobby"); }} /> : <LoginPage />;
      break;
  }

  return (
    <>
      {content}
      {/* Show connection indicator when authenticated */}
      {isAuthenticated && <ConnectionIndicator position="top-right" />}
    </>
  );
}

// ── Root export ───────────────────────────────────────────────────────────────

export default function App() {
  return (
    <AuthProvider>
      <WebSocketProvider debug={import.meta.env.DEV}>
        <AppShell />
      </WebSocketProvider>
    </AuthProvider>
  );
}
