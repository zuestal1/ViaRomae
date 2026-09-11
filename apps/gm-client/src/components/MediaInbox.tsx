/**
 * Media Inbox Component – Epic 9
 * Shows pending media submissions for GM review.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { MediaSubmissionWithTeam } from "@jlw/contracts";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";

export function MediaInbox() {
  const queryClient = useQueryClient();
  const [selectedSubmission, setSelectedSubmission] =
    useState<MediaSubmissionWithTeam | null>(null);
  const [criteria, setCriteria] = useState({ taskLocation: 2, storyRoles: 1, creativity: 1, execution: 1 });
  const score = Object.values(criteria).reduce((sum, value) => sum + value, 0);
  const [reason, setReason] = useState("");

  // Fetch pending submissions
  const { data: submissions, isLoading } = useQuery<MediaSubmissionWithTeam[]>({
    queryKey: ["gm", "media-inbox"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/v1/gm/dashboard/media-inbox`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("gm_token")}`,
        },
      });
      if (!res.ok) throw new Error("Failed to fetch media inbox");
      return res.json();
    },
  });

  // Submit review mutation
  const reviewMutation = useMutation({
    mutationFn: async ({
      submissionId,
      score,
      criteria,
      reason,
    }: {
      submissionId: string;
      score: number;
      criteria: { taskLocation: number; storyRoles: number; creativity: number; execution: number };
      reason?: string;
    }) => {
      const res = await fetch(
        `${API_BASE}/api/v1/media/${submissionId}/review`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("gm_token")}`,
          },
          body: JSON.stringify({ score, criteria, reason }),
        },
      );
      if (!res.ok) throw new Error("Failed to submit review");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gm", "media-inbox"] });
      setSelectedSubmission(null);
      setCriteria({ taskLocation: 2, storyRoles: 1, creativity: 1, execution: 1 });
      setReason("");
    },
  });

  const handleReview = () => {
    if (!selectedSubmission) return;
    const payload: {
      submissionId: string;
      score: number;
      criteria: { taskLocation: number; storyRoles: number; creativity: number; execution: number };
      reason?: string;
    } = {
      submissionId: selectedSubmission.id,
      score,
      criteria,
    };
    if (reason) {
      payload.reason = reason;
    }
    reviewMutation.mutate(payload);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-slate-400">Loading media inbox...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Submission list */}
      <div className="w-96 border-r border-slate-700 overflow-y-auto">
        <div className="p-4 border-b border-slate-700 bg-slate-800">
          <h2 className="text-lg font-bold">
            Pending Reviews ({submissions?.length ?? 0})
          </h2>
        </div>
        <div className="divide-y divide-slate-700">
          {submissions?.map((submission) => (
            <button
              key={submission.id}
              onClick={() => setSelectedSubmission(submission)}
              className={`w-full text-left p-4 hover:bg-slate-800 transition-colors ${
                selectedSubmission?.id === submission.id ? "bg-slate-800" : ""
              }`}
            >
              <div className="font-medium">{submission.teamName}</div>
              <div className="text-sm text-slate-400 mt-1">
                {new Date(submission.submittedAt).toLocaleString()}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Status: {submission.status}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Review panel */}
      <div className="flex-1 flex flex-col">
        {selectedSubmission ? (
          <>
            <div className="p-6 border-b border-slate-700 bg-slate-800">
              <h2 className="text-xl font-bold">{selectedSubmission.teamName}</h2>
              <p className="text-sm text-slate-400 mt-1">
                Submitted: {new Date(selectedSubmission.submittedAt).toLocaleString()}
              </p>
            </div>

            {/* Media preview */}
            <div className="flex-1 p-6 overflow-y-auto">
              <div className="bg-slate-800 rounded-lg p-4 mb-6">
                <p className="text-sm text-slate-400">
                  Object Key: <code className="text-xs">{selectedSubmission.objectKey}</code>
                </p>
                {selectedSubmission.previewUrl && selectedSubmission.mimeType.startsWith("image/") &&
                  <img src={selectedSubmission.previewUrl} alt="Eingereichtes Questmedium" className="mt-3 max-h-[55vh] w-full rounded object-contain" />}
                {selectedSubmission.previewUrl && selectedSubmission.mimeType.startsWith("video/") &&
                  <video src={selectedSubmission.previewUrl} controls className="mt-3 max-h-[55vh] w-full rounded" />}
              </div>

              {/* GDD 4.13 rubric */}
              <div className="mb-6">
                <label className="block text-sm font-medium mb-2">
                  GDD-Bewertungsraster (0–10): {score}
                </label>
                {([['taskLocation','Aufgabe / Ort',2],['storyRoles','Geschichte / Rollen',3],['creativity','Kreativität',3],['execution','Ausführung / Vollständigkeit',2]] as const).map(([key,label,max]) =>
                  <label key={key} className="mb-3 block text-sm text-slate-300">{label}: {criteria[key]}/{max}
                    <input className="mt-1 w-full" type="range" min="0" max={max} value={criteria[key]}
                      onChange={(event) => setCriteria((old) => ({ ...old, [key]: Number(event.target.value) }))} />
                  </label>)}
              </div>

              {/* Reason input */}
              <div className="mb-6">
                <label className="block text-sm font-medium mb-2">
                  Reason (optional)
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Add feedback for the team..."
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={4}
                />
              </div>

              {/* Submit button */}
              <button
                onClick={handleReview}
                disabled={reviewMutation.isPending}
                className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
              >
                {reviewMutation.isPending
                  ? "Submitting..."
                  : score >= 5
                  ? `Approve (${score} points)`
                  : "Reject"}
              </button>

              {reviewMutation.isError && (
                <div className="mt-4 p-3 bg-red-900/50 border border-red-700 rounded-lg text-sm">
                  Failed to submit review. Please try again.
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-slate-400">
            Select a submission to review
          </div>
        )}
      </div>
    </div>
  );
}
