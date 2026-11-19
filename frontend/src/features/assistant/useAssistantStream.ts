"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { ApiError, toApiError } from "@/api/errors";
import { qk } from "@/api/keys";
import type { SymptomDetailResponse } from "@/api/schemas";
import { streamSymptom } from "@/api/stream";

export type StreamPhase = "idle" | "streaming" | "error" | "cancelled";

export type StreamRequest =
  | {
      mode: "create";
      message: string;
      files: File[];
      includeRecords: boolean;
      modifyHistory: boolean;
      language: string;
    }
  | { mode: "followup"; id: string; message: string; files: File[] };

export interface PendingTurn {
  message: string;
  fileNames: string[];
}

/** Friendly status text for the agent's tool steps. */
export function activityLabel(tool: string): string {
  switch (tool) {
    case "lookupPatientDetails":
      return "Reading your health profile";
    case "searchOnline":
      return "Checking trusted health sources";
    case "webBrowser":
      return "Reading a source";
    case "editSymptomAnalysis":
      return "Updating this conversation";
    default:
      return "Working on it";
  }
}

function formFor(request: StreamRequest) {
  const body = new FormData();
  body.append("message", request.message);
  if (request.mode === "create") {
    body.append("includeRecords", String(request.includeRecords));
    body.append("modifyHistory", String(request.modifyHistory));
    body.append("language", request.language);
  }
  request.files.forEach((file) => body.append("images", file, file.name));
  return body;
}

export function useAssistantStream() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<StreamPhase>("idle");
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [reply, setReply] = useState("");
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [symptomId, setSymptomId] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<StreamRequest | null>(null);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);

  const reset = useCallback(() => {
    setPhase("idle");
    setPending(null);
    setReply("");
    setActivity(null);
    setError(null);
  }, []);

  const start = useCallback(
    async (request: StreamRequest): Promise<SymptomDetailResponse | null> => {
      if (busy.current) return null;
      busy.current = true;
      const abort = new AbortController();
      controller.current = abort;
      setLastRequest(request);
      setPending({ message: request.message, fileNames: request.files.map((file) => file.name) });
      setReply("");
      setActivity("Thinking");
      setError(null);
      setSymptomId(request.mode === "followup" ? request.id : null);
      setPhase("streaming");

      const path =
        request.mode === "create" ? "/symptom/stream" : `/symptom/${encodeURIComponent(request.id)}/follow-up/stream`;
      let result: SymptomDetailResponse | null = null;
      try {
        for await (const event of streamSymptom(path, () => formFor(request), abort.signal)) {
          if (event.type === "record") {
            setSymptomId(event.symptom.id);
          } else if (event.type === "token") {
            setActivity(null);
            setReply((current) => current + event.content);
          } else if (event.type === "step") {
            if (event.status === "started") {
              // Text before a tool call is the model thinking aloud; the final answer follows the tool.
              setReply("");
              setActivity(activityLabel(event.name));
            } else {
              setActivity("Thinking");
            }
          } else if (event.type === "done") {
            result = event.data;
          } else if (event.type === "error") {
            throw event.error;
          }
        }
        if (!result) throw new ApiError({ status: 0, code: "invalid_response" });
        const done = result;
        queryClient.setQueryData(qk.symptom(done.symptom.id), done);
        void queryClient.invalidateQueries({ queryKey: ["symptoms"] });
        setPhase("idle");
        setPending(null);
        setReply("");
        setActivity(null);
        return done;
      } catch (caught) {
        void queryClient.invalidateQueries({ queryKey: ["symptoms"] });
        if (request.mode === "followup") void queryClient.invalidateQueries({ queryKey: qk.symptom(request.id) });
        setActivity(null);
        if (abort.signal.aborted) {
          setPhase("cancelled");
        } else {
          setError(toApiError(caught));
          setPhase("error");
        }
        return null;
      } finally {
        busy.current = false;
        controller.current = null;
      }
    },
    [queryClient],
  );

  const cancel = useCallback(() => controller.current?.abort(), []);
  const retry = useCallback(() => (lastRequest ? start(lastRequest) : Promise.resolve(null)), [lastRequest, start]);

  return { phase, pending, reply, activity, error, symptomId, start, cancel, retry, reset, lastRequest };
}
