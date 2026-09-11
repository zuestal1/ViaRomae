/**
 * QuestBottomSheet
 * ────────────────────────────────────────────────────────────────────────────
 * Full-screen interaction sheet für alle Quest-Flow-Phasen.
 *
 * Modes (abhängig vom Prop `mode`):
 *   "available"  → DISCOVER / DIALOGUE phase: Quest-Info + "Annehmen"-Button
 *   "active"     → OBJECTIVE phase: aktueller Schritt + Eingabe (Answer / Reach)
 *   "complete"   → Alle Objectives erledigt: "Abschließen"-Button + Belohnungs-Preview
 *   "reward"     → Quest abgeschlossen: Belohnungs-Anzeige
 *
 * Team-Sync Indikator: Zeigt an ob alle Mitglieder online sind (für Answer-Steps).
 *
 * Design: dunkles Roman-Theme (#1a1a2e Hintergrund, #cd7f32 Gold-Akzent),
 * Bottom-to-Top Slide-Animation via Tailwind.
 */

import { useEffect, useRef, useState } from "react";
import type {
  CompleteQuestResponse,
  MediaSubmission,
  PresignedUploadResponse,
  QuestAvailable,
  QuestRunDetail,
  StepResult,
} from "@jlw/contracts";
import { api } from "../../lib/api.js";
import { useQueryClient } from "@tanstack/react-query";
import { QUEST_QUERY_KEYS } from "../../hooks/use-quests.js";

// ── Props ─────────────────────────────────────────────────────────────────────

interface QuestBottomSheetProps {
  /** If set, shows an available (not-yet-accepted) quest in DISCOVER/DIALOGUE mode. */
  availableQuest?: QuestAvailable | undefined;
  /** If set, shows an active QuestRun in OBJECTIVE/COMPLETE mode. */
  activeRun?: QuestRunDetail | undefined;
  /** Current player GPS position for REACH_LOCATION steps. */
  playerLat?: number | undefined;
  playerLng?: number | undefined;
  playerAccuracy?: number | undefined;
  /** Callback when user taps "Annehmen" */
  onAccept?: ((questDefinitionId: string, dialogueOptionId?: string) => Promise<void>) | undefined;
  /** Callback when user submits an answer */
  onSubmitAnswer?: ((
    questRunId: string,
    stepId: string,
    answer: string,
  ) => Promise<StepResult>) | undefined;
  /** Callback when user confirms REACH_LOCATION */
  onConfirmReach?: ((
    questRunId: string,
    stepId: string,
  ) => Promise<StepResult>) | undefined;
  /** Callback when user taps "Quest abschließen" */
  onComplete?: ((questRunId: string) => Promise<CompleteQuestResponse>) | undefined;
  /** Close the sheet */
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function QuestBottomSheet({
  availableQuest,
  activeRun,
  playerLat,
  playerLng,
  playerAccuracy,
  onAccept,
  onSubmitAnswer,
  onConfirmReach,
  onComplete,
  onClose,
}: QuestBottomSheetProps) {
  const queryClient = useQueryClient();
  const [answerInput, setAnswerInput] = useState("");
  const [dialogueOptionId, setDialogueOptionId] = useState<string | undefined>();
  const [feedback, setFeedback] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [reward, setReward] = useState<CompleteQuestResponse | null>(null);
  const [mediaSubmission, setMediaSubmission] = useState<MediaSubmission | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const mediaStep = activeRun?.currentStep?.stepActionType === "UPLOAD_MEDIA"
    ? activeRun.currentStep
    : null;

  useEffect(() => {
    if (!activeRun || !mediaStep) return;
    let cancelled = false;
    const loadSubmission = async () => {
      try {
        const result = await api.get<{ submissions: MediaSubmission[] }>(
          `/media/quest/${activeRun.id}`,
        );
        if (!cancelled) {
          const latest = result.submissions.find((item) => item.stepId === mediaStep.stepId) ?? null;
          setMediaSubmission((previous) => {
            if (latest && latest.status !== previous?.status && ["APPROVED", "REJECTED"].includes(latest.status)) {
              void queryClient.invalidateQueries({ queryKey: QUEST_QUERY_KEYS.active });
            }
            return latest;
          });
        }
      } catch {
        // Upload controls remain usable; actionable errors are shown on submission.
      }
    };
    void loadSubmission();
    const interval = window.setInterval(() => void loadSubmission(), 5_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [activeRun?.id, mediaStep?.stepId, queryClient]);

  // ── Determine mode ──────────────────────────────────────────────────────────
  const allDone =
    activeRun &&
    activeRun.objectives.filter((o) => o.required).length > 0 &&
    activeRun.objectives
      .filter((o) => o.required)
      .every((o) => o.progress?.status === "COMPLETED");

  const mode: "available" | "active" | "complete" | "reward" = reward
    ? "reward"
    : availableQuest
      ? "available"
      : allDone
        ? "complete"
        : "active";

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleAccept() {
    if (!availableQuest || !onAccept) return;
    setIsLoading(true);
    try {
      await onAccept(availableQuest.questDefinitionId, dialogueOptionId);
      onClose();
    } catch (e) {
      setFeedback({ text: (e as Error).message, ok: false });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleAnswer() {
    if (!activeRun?.currentStep || !onSubmitAnswer) return;
    if (!answerInput.trim()) return;

    setIsLoading(true);
    setFeedback(null);

    try {
      const result = await onSubmitAnswer(
        activeRun.id,
        activeRun.currentStep.stepId,
        answerInput.trim(),
      );

      setFeedback({
        text: result.message,
        ok: result.status === "COMPLETED",
      });

      if (result.status === "COMPLETED") {
        setAnswerInput("");
      }
    } catch (e) {
      setFeedback({ text: (e as Error).message, ok: false });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleReach() {
    if (!activeRun?.currentStep || !onConfirmReach) return;
    if (playerLat == null || playerLng == null) {
      setFeedback({ text: "GPS-Position nicht verfügbar.", ok: false });
      return;
    }

    setIsLoading(true);
    setFeedback(null);

    try {
      const result = await onConfirmReach(
        activeRun.id,
        activeRun.currentStep.stepId,
      );

      setFeedback({
        text: result.message,
        ok: result.status === "COMPLETED",
      });
    } catch (e) {
      setFeedback({ text: (e as Error).message, ok: false });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDirectAction(optionId?: string) {
    if (!activeRun?.currentStep) return;
    setIsLoading(true); setFeedback(null);
    try {
      const result = await api.post<StepResult>(`/quests/runs/${activeRun.id}/steps/${activeRun.currentStep.stepId}/action`, optionId ? { optionId } : {});
      setFeedback({ text: result.message, ok: result.status === "COMPLETED" });
      await queryClient.invalidateQueries({ queryKey: QUEST_QUERY_KEYS.active });
    } catch (error) { setFeedback({ text: (error as Error).message, ok: false }); }
    finally { setIsLoading(false); }
  }

  async function handleStartTimer(timerId: string) {
    if (!activeRun) return;
    setIsLoading(true);
    try {
      await api.post(`/quests/runs/${activeRun.id}/timers/${timerId}/start`, {});
      await queryClient.invalidateQueries({ queryKey: QUEST_QUERY_KEYS.active });
    } catch (error) { setFeedback({ text: (error as Error).message, ok: false }); }
    finally { setIsLoading(false); }
  }

  async function handleComplete() {
    if (!activeRun || !onComplete) return;
    setIsLoading(true);
    setFeedback(null);

    try {
      const rewards = await onComplete(activeRun.id);
      setReward(rewards);
    } catch (e) {
      setFeedback({ text: (e as Error).message, ok: false });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleMediaFile(file: File) {
    if (!activeRun || !mediaStep) return;
    setIsLoading(true);
    setFeedback(null);
    setUploadProgress(0);
    try {
      const upload = await api.post<PresignedUploadResponse>("/media/upload-url", {
        questRunId: activeRun.id,
        stepId: mediaStep.stepId,
        fileType: file.type,
        fileSizeBytes: file.size,
      });
      await uploadFile(upload.uploadUrl, file, setUploadProgress);
      const confirmed = await api.post<{ submission: MediaSubmission }>(
        `/media/confirm/${encodeURIComponent(upload.objectKey)}`,
        {},
      );
      setMediaSubmission(confirmed.submission);
      setFeedback({ text: "Upload abgeschlossen. Das Foto wartet auf die Prüfung durch den GM.", ok: true });
    } catch (error) {
      setFeedback({ text: (error as Error).message, ok: false });
    } finally {
      setIsLoading(false);
      setUploadProgress(null);
      if (cameraInputRef.current) cameraInputRef.current.value = "";
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop */}
      <div
        className="absolute inset-0 z-30 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        className="absolute bottom-0 left-0 right-0 z-40
                   rounded-t-3xl bg-[#1a1a2e] border-t border-[#cd7f32]/30
                   px-5 py-6 shadow-2xl
                   animate-in slide-in-from-bottom duration-300"
      >
        {/* Drag handle */}
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />

        {/* ── MODE: reward ──────────────────────────────────────────────────── */}
        {mode === "reward" && reward && (
          <RewardView
            questTitle={activeRun?.questTitle ?? "Quest"}
            glory={reward.glory}
            denarii={reward.denarii}
            items={reward.items ?? []}
            itemsSkipped={reward.itemsSkipped}
            onClose={onClose}
          />
        )}

        {/* ── MODE: available ───────────────────────────────────────────────── */}
        {mode === "available" && availableQuest && (
          <AvailableView
            quest={availableQuest}
            isLoading={isLoading}
            feedback={feedback}
            onAccept={handleAccept}
            selectedOptionId={dialogueOptionId}
            onSelectOption={setDialogueOptionId}
            onClose={onClose}
          />
        )}

        {/* ── MODE: active ──────────────────────────────────────────────────── */}
        {mode === "active" && activeRun && (
          <ActiveView
            run={activeRun}
            answerInput={answerInput}
            setAnswerInput={setAnswerInput}
            isLoading={isLoading}
            feedback={feedback}
            playerLat={playerLat}
            playerLng={playerLng}
            playerAccuracy={playerAccuracy}
            onAnswer={handleAnswer}
            onReach={handleReach}
            onDirectAction={handleDirectAction}
            onStartTimer={handleStartTimer}
            mediaSubmission={mediaSubmission}
            uploadProgress={uploadProgress}
            cameraInputRef={cameraInputRef}
            fileInputRef={fileInputRef}
            onMediaFile={handleMediaFile}
            onClose={onClose}
          />
        )}

        {/* ── MODE: complete ────────────────────────────────────────────────── */}
        {mode === "complete" && activeRun && (
          <CompleteView
            run={activeRun}
            isLoading={isLoading}
            feedback={feedback}
            onComplete={handleComplete}
            onClose={onClose}
          />
        )}
      </div>
    </>
  );
}

// ── Sub-views ─────────────────────────────────────────────────────────────────

// ── Available view ────────────────────────────────────────────────────────────

function AvailableView({
  quest,
  isLoading,
  feedback,
  onAccept,
  selectedOptionId,
  onSelectOption,
  onClose,
}: {
  quest: QuestAvailable;
  isLoading: boolean;
  feedback: { text: string; ok: boolean } | null;
  onAccept: () => void;
  selectedOptionId: string | undefined;
  onSelectOption: (value: string) => void;
  onClose: () => void;
}) {
  const isDialogue = quest.discoveryPhase === "DIALOGUE";

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold tracking-widest text-[#cd7f32] uppercase">
              {isDialogue ? "💬 Quest verfügbar" : "🗺 Quest entdeckt"}
            </span>
            <QuestTypeBadge type={quest.type} />
          </div>
          <h2 className="text-lg font-bold text-[#f4e4c1]">{quest.title}</h2>
          {quest.day && (
            <p className="text-xs text-white/40 mt-0.5">
              {formatDay(quest.day)}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-white/40 hover:text-white/70 text-xl leading-none"
        >
          ✕
        </button>
      </div>

      {quest.offerDialogue && isDialogue && (
        <div className="rounded-xl border border-[#cd7f32]/30 bg-black/20 p-4" role="dialog" aria-label={`Dialog mit ${quest.offerDialogue.speaker}`}>
          <p className="text-xs font-bold text-[#cd7f32]">{quest.offerDialogue.speaker}</p>
          {quest.offerDialogue.mood && <p className="text-[10px] italic text-white/40">{quest.offerDialogue.mood}</p>}
          <p className="mt-2 text-sm leading-relaxed text-[#f4e4c1]">{quest.offerDialogue.text}</p>
          <div className="mt-3 flex flex-col gap-2">
            {quest.offerDialogue.options.map((option) => (
              <button key={option.id} onClick={() => onSelectOption(option.id)}
                className={`rounded-lg border p-3 text-left text-xs ${selectedOptionId === option.id ? "border-[#cd7f32] bg-[#cd7f32]/15" : "border-white/15 bg-white/5"}`}>
                {option.text}
                {selectedOptionId === option.id && <span className="mt-1 block text-white/50">{option.response}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Location info */}
      <div className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
        <span className="text-base">📍</span>
        <div>
          <p className="text-xs text-white/60">Gestartet bei</p>
          <p className="text-sm font-medium text-[#f4e4c1]">
            {quest.triggerObjectName}
          </p>
        </div>
      </div>

      {/* Phase hint */}
      {isDialogue && (
        <p className="text-sm text-[#f4e4c1]/70 leading-relaxed">
          Ihr seid in Reichweite. Nehmt die Quest an um sie im Slot zu aktivieren.
          <span className="block mt-1 text-[10px] text-white/30">
            ⚠ Max. 3 aktive Quests gleichzeitig.
          </span>
        </p>
      )}
      {!isDialogue && (
        <p className="text-sm text-white/40 leading-relaxed">
          Kommt näher um die Quest anzunehmen.
        </p>
      )}

      {/* Feedback */}
      {feedback && (
        <FeedbackBanner ok={feedback.ok} text={feedback.text} />
      )}

      {/* Actions */}
      <div className="flex gap-3 pt-1">
        <button
          onClick={onClose}
          className="flex-1 rounded-xl border border-white/15 py-3 text-sm
                     text-white/60 hover:bg-white/5 transition"
        >
          Schließen
        </button>
        {isDialogue && (
          <button
            onClick={onAccept}
            disabled={isLoading || Boolean(quest.offerDialogue && !selectedOptionId)}
            className="flex-1 rounded-xl bg-[#cd7f32] py-3 text-sm font-bold
                       text-[#1a1a2e] hover:bg-[#b8712d] disabled:opacity-50
                       transition active:scale-95"
          >
            {isLoading ? "Laden…" : "Quest annehmen ⚔"}
          </button>
        )}
      </div>
    </div>
  );
}

function QuestTimerView({ timer, runtime, disabled, onStart }: {
  timer: QuestRunDetail["timers"][number];
  runtime: { state: string; deadlineAt: string; consequence?: string } | undefined;
  disabled: boolean; onStart: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (runtime?.state !== "RUNNING") return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [runtime?.state, runtime?.deadlineAt]);
  const remaining = runtime ? Math.max(0, Math.ceil((new Date(runtime.deadlineAt).getTime() - now) / 1000)) : timer.durationSec;
  return <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3" aria-live="polite">
    <div className="flex justify-between"><strong className="text-sm text-amber-200">⏱ {timer.title}</strong><span className="font-mono text-amber-100">{remaining}s</span></div>
    <p className="mt-1 text-xs text-white/60">{timer.startsWhen}</p>
    <p className="mt-1 text-xs text-white/50">Bei Ablauf: {timer.onExpire}</p>
    {!runtime && <button disabled={disabled} onClick={onStart} className="mt-2 rounded-lg bg-amber-300 px-3 py-2 text-xs font-bold text-black disabled:opacity-50">Timer starten</button>}
    {runtime?.state === "EXPIRED" && <p className="mt-2 text-xs font-bold text-red-300">Zeit abgelaufen – die angekündigte Konsequenz ist aktiv.</p>}
    {runtime?.state === "COMPLETED" && <p className="mt-2 text-xs font-bold text-green-300">Ziel rechtzeitig erfüllt.</p>}
  </div>;
}

// ── Active view ───────────────────────────────────────────────────────────────

function ActiveView({
  run,
  answerInput,
  setAnswerInput,
  isLoading,
  feedback,
  playerLat,
  playerLng,
  playerAccuracy,
  onAnswer,
  onReach,
  onDirectAction,
  onStartTimer,
  mediaSubmission,
  uploadProgress,
  cameraInputRef,
  fileInputRef,
  onMediaFile,
  onClose,
}: {
  run: QuestRunDetail;
  answerInput: string;
  setAnswerInput: (v: string) => void;
  isLoading: boolean;
  feedback: { text: string; ok: boolean } | null;
  playerLat?: number | undefined;
  playerLng?: number | undefined;
  playerAccuracy?: number | undefined;
  onAnswer: () => void;
  onReach: () => void;
  onDirectAction: (optionId?: string) => Promise<void>;
  onStartTimer: (timerId: string) => Promise<void>;
  mediaSubmission: MediaSubmission | null;
  uploadProgress: number | null;
  cameraInputRef: React.RefObject<HTMLInputElement>;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onMediaFile: (file: File) => Promise<void>;
  onClose: () => void;
}) {
  const step = run.currentStep;
  const done = run.objectives.filter(
    (o) => o.required && o.progress?.status === "COMPLETED",
  ).length;
  const total = run.objectives.filter((o) => o.required).length;
  const dialogue = step ? run.dialogues.find((item) => item.sequenceId === step.targetRef) : undefined;
  const timer = step ? run.timers.find((item) => item.stepId === step.stepId) : undefined;
  const timerRuntime = timer ? (run.runtimeState.timers as Record<string, { state: string; deadlineAt: string; consequence?: string }> | undefined)?.[timer.id] : undefined;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-bold tracking-widest text-[#cd7f32] uppercase mb-1">
            {run.state === "PENDING_REVIEW" ? "⏳ Prüfung ausstehend" : "⚔ Aktive Quest"}
          </p>
          <h2 className="text-base font-bold text-[#f4e4c1]">{run.questTitle}</h2>
        </div>
        <button
          onClick={onClose}
          className="text-white/40 hover:text-white/70 text-xl leading-none"
        >
          ✕
        </button>
      </div>

      {/* Progress bar */}
      <ProgressBar done={done} total={total} />

      {/* Current step */}
      {step && (
        <div className="rounded-xl bg-white/5 border border-white/10 p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">{stepEmoji(step.stepActionType)}</span>
            <div>
              <p className="text-[10px] text-white/40 uppercase tracking-wide">
                Schritt {step.sequence}
              </p>
              <p className="text-sm font-semibold text-[#f4e4c1]">
                {stepLabel(step.stepActionType)}
              </p>
            </div>
          </div>

          {step.instruction && <p className="text-sm leading-relaxed text-[#f4e4c1]/90">{step.instruction}</p>}
          {step.puzzle && (
            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <p className="text-sm font-medium text-[#f4e4c1]">{step.puzzle.prompt}</p>
              {step.puzzle.evidence && <p className="mt-2 text-xs text-white/50">Beobachtung: {step.puzzle.evidence}</p>}
              <details className="mt-2 text-xs text-[#cd7f32]"><summary>Hinweise</summary>
                <p className="mt-1 text-white/60">{step.puzzle.hint1}</p><p className="mt-1 text-white/60">{step.puzzle.hint2}</p>
              </details>
            </div>
          )}

          {timer && <QuestTimerView timer={timer} runtime={timerRuntime} disabled={isLoading} onStart={() => onStartTimer(timer.id)} />}

          {dialogue && (
            <div className="rounded-xl border border-[#cd7f32]/30 bg-black/20 p-3">
              <p className="text-xs font-bold text-[#cd7f32]">{dialogue.speaker}</p>
              <p className="mt-2 text-sm text-[#f4e4c1]">{dialogue.text}</p>
              <div className="mt-3 flex flex-col gap-2">{dialogue.options.map((option) => (
                <button key={option.id} disabled={isLoading} onClick={() => void onDirectAction(option.id)} className="rounded-lg border border-white/15 bg-white/5 p-3 text-left text-xs text-[#f4e4c1] disabled:opacity-50">{option.text}</button>
              ))}</div>
            </div>
          )}

          {/* REACH_LOCATION */}
          {step.stepActionType === "REACH_LOCATION" && (
            <div className="flex flex-col gap-2">
              {/* Target location name */}
              {step.targetObjectName && (
                <div className="flex items-center gap-2 rounded-lg bg-[#cd7f32]/10 border border-[#cd7f32]/30 px-3 py-2">
                  <span className="text-base">🗺</span>
                  <div>
                    <p className="text-xs text-white/50">Zielort</p>
                    <p className="text-sm font-semibold text-[#f4e4c1]">{step.targetObjectName}</p>
                  </div>
                </div>
              )}
              <p className="text-xs text-white/50">
                GPS: {playerLat != null ? `${playerLat.toFixed(5)}, ${playerLng?.toFixed(5)}` : "wird ermittelt…"}{" "}
                {playerAccuracy != null && `(±${Math.round(playerAccuracy)} m)`}
              </p>
              <button
                onClick={onReach}
                disabled={isLoading || playerLat == null}
                className="w-full rounded-xl bg-[#cd7f32] py-3 text-sm font-bold
                           text-[#1a1a2e] disabled:opacity-50 transition active:scale-95
                           hover:bg-[#b8712d]"
              >
                {isLoading ? "Prüfe Position…" : "📍 Standort bestätigen"}
              </button>
            </div>
          )}

          {/* ANSWER_QUESTION / SOLVE_PUZZLE */}
          {(step.stepActionType === "ANSWER_QUESTION" ||
            step.stepActionType === "SOLVE_PUZZLE") && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-white/50">
                💡 Team-Sync erforderlich – alle müssen online sein.
              </p>
              <input
                type="text"
                value={answerInput}
                onChange={(e) => setAnswerInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void onAnswer()}
                placeholder="Eure Antwort eingeben…"
                className="w-full rounded-xl bg-white/10 border border-white/20
                           px-4 py-3 text-sm text-[#f4e4c1] placeholder:text-white/30
                           focus:border-[#cd7f32] focus:outline-none"
              />
              {step.puzzle && step.puzzle.options.length > 0 && (
                <div className="grid grid-cols-1 gap-2">
                  {step.puzzle.options.map((option) => <button key={option} onClick={() => setAnswerInput(option)}
                    className="rounded-lg border border-white/15 bg-white/5 p-2 text-left text-xs text-[#f4e4c1]">{option}</button>)}
                </div>
              )}
              <button
                onClick={onAnswer}
                disabled={isLoading || !answerInput.trim()}
                className="w-full rounded-xl bg-[#cd7f32] py-3 text-sm font-bold
                           text-[#1a1a2e] disabled:opacity-50 transition active:scale-95
                           hover:bg-[#b8712d]"
              >
                {isLoading ? "Prüfe Antwort…" : "✓ Antwort abschicken"}
              </button>
            </div>
          )}

          {/* DEFEAT_ENEMY */}
          {step.stepActionType === "DEFEAT_ENEMY" && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-white/50">
                ⚔️ Besiegt den Gegner, um Beute zu erhalten und den Schritt abzuschließen.
                (Volles Kampfsystem folgt in Epic 6.)
              </p>
              <p className="rounded-lg border border-red-500/30 bg-red-900/20 p-3 text-xs text-red-200">Nähert euch dem markierten Gegner. Der Kampf startet serverseitig im Aggro-Radius; nur ein bestätigter Kampfsieg schließt diesen Schritt ab.</p>
            </div>
          )}

          {/* UPLOAD_MEDIA */}
          {step.stepActionType === "UPLOAD_MEDIA" && (
            <MediaUploadControls
              submission={mediaSubmission}
              isLoading={isLoading}
              uploadProgress={uploadProgress}
              cameraInputRef={cameraInputRef}
              fileInputRef={fileInputRef}
              onMediaFile={onMediaFile}
              allowMore={run.objectives.find((item) => item.stepId === step.stepId)?.progress?.status !== "COMPLETED"}
              progressCount={run.objectives.find((item) => item.stepId === step.stepId)?.progress?.progressCount ?? 0}
            />
          )}
          {!dialogue && ["TALK_TO_NPC", "TEAM_DECISION", "CLASS_ACTION", "USE_ITEM"].includes(step.stepActionType) && (
            <button disabled={isLoading} onClick={() => void onDirectAction()} className="w-full rounded-xl bg-[#cd7f32] py-3 text-sm font-bold text-[#1a1a2e] disabled:opacity-50">Schritt bestätigen</button>
          )}
        </div>
      )}

      {/* Feedback */}
      {feedback && <FeedbackBanner ok={feedback.ok} text={feedback.text} />}

      {/* Objectives overview */}
      <ObjectivesList objectives={run.objectives} />
    </div>
  );
}

// ── Complete view ─────────────────────────────────────────────────────────────

function CompleteView({
  run,
  isLoading,
  feedback,
  onComplete,
  onClose,
}: {
  run: QuestRunDetail;
  isLoading: boolean;
  feedback: { text: string; ok: boolean } | null;
  onComplete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-bold tracking-widest text-green-400 uppercase mb-1">
            ✓ Alle Schritte erledigt!
          </p>
          <h2 className="text-base font-bold text-[#f4e4c1]">
            {run.questTitle}
          </h2>
        </div>
        <button
          onClick={onClose}
          className="text-white/40 hover:text-white/70 text-xl leading-none"
        >
          ✕
        </button>
      </div>

      <div className="rounded-xl bg-green-900/20 border border-green-500/20 p-4">
        <p className="text-sm text-green-300">
          💬 Kehrt zum Quest-Geber zurück und schließt die Quest ab.
        </p>
        <p className="text-xs text-white/30 mt-2">
          Belohnungen: {run.reward.glory} Ruhm · {run.reward.denarii} Denare
          {run.reward.itemRule && <span className="block mt-1">{run.reward.itemRule}</span>}
        </p>
      </div>

      {feedback && <FeedbackBanner ok={feedback.ok} text={feedback.text} />}

      <div className="flex gap-3">
        <button
          onClick={onClose}
          className="flex-1 rounded-xl border border-white/15 py-3 text-sm
                     text-white/60 hover:bg-white/5 transition"
        >
          Zurück
        </button>
        <button
          onClick={onComplete}
          disabled={isLoading}
          className="flex-1 rounded-xl bg-green-600 py-3 text-sm font-bold
                     text-white disabled:opacity-50 transition active:scale-95
                     hover:bg-green-500"
        >
          {isLoading ? "Laden…" : "🏆 Quest abschließen"}
        </button>
      </div>
    </div>
  );
}

function MediaUploadControls({
  submission,
  isLoading,
  uploadProgress,
  cameraInputRef,
  fileInputRef,
  onMediaFile,
  allowMore,
  progressCount,
}: {
  submission: MediaSubmission | null;
  isLoading: boolean;
  uploadProgress: number | null;
  cameraInputRef: React.RefObject<HTMLInputElement>;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onMediaFile: (file: File) => Promise<void>;
  allowMore: boolean;
  progressCount: number;
}) {
  const awaitingReview = submission && ["UPLOADING", "RECEIVED", "IN_REVIEW"].includes(submission.status);
  const rejected = submission?.status === "REJECTED";

  return (
    <div className="flex flex-col gap-3">
      {awaitingReview && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-900/20 px-3 py-3">
          <p className="text-sm font-semibold text-yellow-300">
            {submission.status === "IN_REVIEW" ? "🔎 Wird gerade geprüft" : "⏳ Prüfung ausstehend"}
          </p>
          <p className="mt-1 text-xs text-white/50">Die Quest bleibt sichtbar. Ein GM gibt eure Aufnahme frei.</p>
        </div>
      )}
      {submission?.status === "APPROVED" && (
        <div className="rounded-lg border border-green-500/30 bg-green-900/20 px-3 py-3 text-sm text-green-300">
          ✓ Aufnahme freigegeben. Bestätigte Medien: {progressCount}{allowMore ? " – mindestens 6 erforderlich." : " – Schritt abgeschlossen."}
        </div>
      )}
      {rejected && (
        <div className="rounded-lg border border-red-500/30 bg-red-900/20 px-3 py-3">
          <p className="text-sm font-semibold text-red-300">✗ Aufnahme abgelehnt</p>
          <p className="mt-1 text-xs text-red-200/80">
            GM-Feedback: {submission.reviewReason ?? "Bitte nehmt eine neue Aufnahme auf."}
          </p>
          <p className="mt-2 text-xs text-white/50">Ihr könnt direkt eine verbesserte Aufnahme einreichen.</p>
        </div>
      )}
      {!awaitingReview && (submission?.status !== "APPROVED" || allowMore) && (
        <>
          <p className="text-xs text-white/50">📸 Nehmt ein Foto auf oder wählt eine vorhandene Datei.</p>
          <input ref={cameraInputRef} className="hidden" type="file" accept="image/jpeg,image/png" capture="environment"
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void onMediaFile(file); }} />
          <input ref={fileInputRef} className="hidden" type="file" accept="image/jpeg,image/png,video/mp4,video/quicktime"
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void onMediaFile(file); }} />
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={isLoading} onClick={() => cameraInputRef.current?.click()}
              className="rounded-xl bg-[#cd7f32] py-3 text-sm font-bold text-[#1a1a2e] disabled:opacity-50">
              📷 Kamera
            </button>
            <button type="button" disabled={isLoading} onClick={() => fileInputRef.current?.click()}
              className="rounded-xl border border-[#cd7f32]/50 py-3 text-sm font-bold text-[#f4e4c1] disabled:opacity-50">
              🖼 Datei wählen
            </button>
          </div>
        </>
      )}
      {uploadProgress != null && (
        <div aria-live="polite">
          <div className="mb-1 flex justify-between text-xs text-white/60"><span>Upload läuft…</span><span>{uploadProgress}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-[#cd7f32] transition-all" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Reward view ───────────────────────────────────────────────────────────────

function RewardView({
  questTitle,
  glory,
  denarii,
  items,
  itemsSkipped,
  onClose,
}: {
  questTitle: string;
  glory: number;
  denarii: number;
  items: { defKey: string; quantity: number; owner: "PLAYER" | "TEAM" }[];
  itemsSkipped?: boolean | undefined;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-5 py-4">
      <div className="text-4xl animate-bounce">🏆</div>
      <div className="text-center">
        <p className="text-xs text-[#cd7f32] uppercase tracking-widest font-bold">
          Quest abgeschlossen!
        </p>
        <h2 className="text-lg font-bold text-[#f4e4c1] mt-1">{questTitle}</h2>
      </div>

      {/* Rewards */}
      <div className="flex gap-6">
        <div className="flex flex-col items-center gap-1">
          <span className="text-2xl">⭐</span>
          <span className="text-lg font-bold text-[#cd7f32]">+{glory}</span>
          <span className="text-xs text-white/40">Ruhm</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-2xl">🪙</span>
          <span className="text-lg font-bold text-[#cd7f32]">+{denarii}</span>
          <span className="text-xs text-white/40">Denare</span>
        </div>
      </div>

      {items.length > 0 && (
        <ul className="w-full text-center text-sm text-[#f4e4c1]/80">
          {items.map((it) => (
            <li key={`${it.owner}-${it.defKey}`}>
              {it.quantity}× {it.defKey} ({it.owner === "TEAM" ? "Team" : "Person"})
            </li>
          ))}
        </ul>
      )}
      {itemsSkipped && (
        <p className="text-xs text-yellow-400">Inventar voll – manche Items fielen aus.</p>
      )}

      <button
        onClick={onClose}
        className="w-full rounded-xl bg-[#cd7f32] py-3 text-sm font-bold
                   text-[#1a1a2e] hover:bg-[#b8712d] transition active:scale-95"
      >
        Schließen ✕
      </button>
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function ProgressBar({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;
  const pct = Math.round((done / total) * 100);

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-[#cd7f32] transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-white/40 shrink-0">
        {done}/{total}
      </span>
    </div>
  );
}

function ObjectivesList({
  objectives,
}: {
  objectives: QuestRunDetail["objectives"];
}) {
  const required = objectives.filter((o) => o.required);
  if (required.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] text-white/30 uppercase tracking-wide">
        Alle Schritte
      </p>
      {required.map((obj) => {
        const done = obj.progress?.status === "COMPLETED";
        return (
          <div
            key={obj.stepId}
            className={[
              "flex items-center gap-2 rounded-lg px-3 py-2",
              done ? "bg-green-900/20" : "bg-white/5",
            ].join(" ")}
          >
            <span className="text-sm">{done ? "✓" : stepEmoji(obj.stepActionType)}</span>
            <span
              className={[
                "text-xs",
                done ? "text-green-400 line-through" : "text-[#f4e4c1]/70",
              ].join(" ")}
            >
              {stepLabel(obj.stepActionType)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FeedbackBanner({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div
      className={[
        "rounded-xl px-4 py-3 text-sm font-medium",
        ok
          ? "bg-green-900/40 border border-green-500/30 text-green-300"
          : "bg-red-900/40 border border-red-500/30 text-red-300",
      ].join(" ")}
    >
      {ok ? "✓ " : "✗ "}
      {text}
    </div>
  );
}

function QuestTypeBadge({ type }: { type: string }) {
  if (type === "HIDDEN") {
    return (
      <span className="rounded-full bg-purple-900/40 border border-purple-500/30 px-2 py-0.5 text-[10px] text-purple-300">
        Verborgen
      </span>
    );
  }
  if (type === "LONG_TERM") {
    return (
      <span className="rounded-full bg-blue-900/40 border border-blue-500/30 px-2 py-0.5 text-[10px] text-blue-300">
        Lang
      </span>
    );
  }
  return null;
}

function stepEmoji(actionType: string): string {
  switch (actionType) {
    case "REACH_LOCATION":     return "📍";
    case "ANSWER_QUESTION":    return "❓";
    case "SOLVE_PUZZLE":       return "🧩";
    case "DEFEAT_ENEMY":       return "⚔️";
    case "UPLOAD_MEDIA":       return "📸";
    case "TALK_TO_NPC":        return "💬";
    case "ACCEPT_QUEST":       return "✋";
    default:                   return "▶";
  }
}

function stepLabel(actionType: string): string {
  switch (actionType) {
    case "REACH_LOCATION":     return "Ort erreichen";
    case "ANSWER_QUESTION":    return "Frage beantworten";
    case "SOLVE_PUZZLE":       return "Rätsel lösen";
    case "DEFEAT_ENEMY":       return "Gegner besiegen";
    case "UPLOAD_MEDIA":       return "Foto hochladen";
    case "TALK_TO_NPC":        return "Mit NPC sprechen";
    case "ACCEPT_QUEST":       return "Quest annehmen";
    case "TEAM_DECISION":      return "Team-Entscheidung";
    default:                   return actionType;
  }
}

function formatDay(day: string): string {
  return day.replace("DAY_", "Tag ").replace("_", " ");
}

function uploadFile(uploadUrl: string, file: File, onProgress: (progress: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", uploadUrl);
    request.setRequestHeader("Content-Type", file.type);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => request.status >= 200 && request.status < 300
      ? resolve()
      : reject(new Error(`Direkter Upload fehlgeschlagen (HTTP ${request.status}).`));
    request.onerror = () => reject(new Error("Direkter Upload fehlgeschlagen. Bitte Verbindung prüfen."));
    request.send(file);
  });
}
