/**
 * PvP Challenge Warning Screen (Epic 6)
 * Shows 20-second warning when a PvP challenge is initiated.
 */

import { useState, useEffect } from "react";
import { AlertTriangle } from "lucide-react";

interface PvPChallengeWarningProps {
  challengeId: string;
  role: "attacker" | "defender";
  opponentTeamId: string;
  expiresAt: string;
  currentDistanceM: number;
  escapeDistanceM: number;
}

export function PvPChallengeWarning({
  challengeId,
  role,
  opponentTeamId,
  expiresAt,
  currentDistanceM,
  escapeDistanceM,
}: PvPChallengeWarningProps) {
  const [timeRemaining, setTimeRemaining] = useState(0);

  useEffect(() => {
    const updateTimer = () => {
      const now = Date.now();
      const expiresTime = new Date(expiresAt).getTime();
      const remaining = Math.max(0, Math.floor((expiresTime - now) / 1000));
      setTimeRemaining(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 100);

    return () => clearInterval(interval);
  }, [expiresAt]);

  const progressPercentage = (timeRemaining / 20) * 100;

  return (
    <div className="fixed inset-0 z-40 bg-red-900/80 backdrop-blur flex items-center justify-center p-4">
      <div className="bg-gray-900 border-4 border-red-600 rounded-xl p-6 max-w-md w-full space-y-4 animate-pulse-slow">
        {/* Warning Icon */}
        <div className="flex justify-center">
          <div className="bg-red-600 rounded-full p-4">
            <AlertTriangle className="w-16 h-16 text-white" />
          </div>
        </div>

        {/* Title */}
        <h1 className="text-3xl font-bold text-red-400 text-center">
          ⚔️ PvP Challenge!
        </h1>

        {/* Message */}
        <div className="text-center space-y-2">
          {role === "attacker" ? (
            <p className="text-white text-lg">
              You are initiating a PvP battle!
            </p>
          ) : (
            <>
              <p className="text-white text-lg">
                Another team is attacking you!
              </p>
              <p className="text-yellow-400 text-sm">
                Run to escape or find a safe zone!
              </p>
            </>
          )}
          <p className="text-xs text-gray-400">
            Opponent team: {opponentTeamId.substring(0, 8)}
          </p>
          <p className="text-lg font-bold text-white">Bestätigte Distanz: {currentDistanceM.toFixed(1)} m</p>
        </div>

        {/* Timer */}
        <div className="space-y-2">
          <div className="text-center">
            <span className="text-5xl font-bold text-white">
              {timeRemaining}
            </span>
            <span className="text-xl text-gray-400 ml-2">seconds</span>
          </div>

          {/* Progress Bar */}
          <div className="h-4 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-red-600 to-red-400 transition-all"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
        </div>

        {/* Instructions */}
        <div className="bg-gray-800 rounded-lg p-4 space-y-2">
          <p className="text-sm text-gray-300">
            {role === "attacker" ? (
              <>Stay within <strong className="text-red-400">20m</strong> to start combat.</>
            ) : (
              <>
                <strong className="text-red-400">Run!</strong> Get more than{" "}
                <strong className="text-red-400">{escapeDistanceM} m Abstand</strong> (zwei gültige Messungen) oder eine{" "}
                <strong className="text-green-400">safe zone</strong> to escape!
              </>
            )}
          </p>
        </div>

        {/* Challenge ID (debug) */}
        <p className="text-xs text-gray-500 text-center">
          Challenge ID: {challengeId.substring(0, 8)}...
        </p>
      </div>
    </div>
  );
}
