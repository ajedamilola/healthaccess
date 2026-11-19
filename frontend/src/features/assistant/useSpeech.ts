"use client";

import { useSyncExternalStore } from "react";

export type SpeechStatus = "idle" | "loading" | "playing";

export interface SpeechState {
  status: SpeechStatus;
  id: string | null;
  error: string | null;
}

const idle: SpeechState = { status: "idle", id: null, error: null };

let state = idle;
let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let controller: AbortController | null = null;
let request = 0;

const listeners = new Set<() => void>();

function emit(next: SpeechState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function disposePlayer(player: HTMLAudioElement, url: string | null) {
  player.onended = null;
  player.onerror = null;
  try {
    player.pause();
    player.removeAttribute("src");
  } catch {
    // The element may already be detached.
  }
  if (url) URL.revokeObjectURL(url);
}

function release() {
  controller?.abort();
  controller = null;

  const player = audio;
  const url = objectUrl;
  audio = null;
  objectUrl = null;

  if (!player) {
    if (url) URL.revokeObjectURL(url);
    return;
  }
  disposePlayer(player, url);
}

export function stopSpeech() {
  request += 1;
  release();
  if (state.status !== "idle" || state.id !== null) emit(idle);
}

export async function speak(id: string, text: string, language: string) {
  if (state.status !== "idle" && state.id === id) {
    stopSpeech();
    return;
  }

  const ticket = ++request;
  release();
  emit({ status: "loading", id, error: null });
  controller = new AbortController();

  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ha-client": "web" },
      body: JSON.stringify({ text, language }),
      signal: controller.signal,
    });
    if (ticket !== request) return;
    if (!response.ok) {
      emit({
        status: "idle",
        id,
        error: response.status === 429 ? "Too many requests. Try again shortly." : "Could not read this reply aloud.",
      });
      return;
    }

    const blob = await response.blob();
    if (ticket !== request) return;

    const url = URL.createObjectURL(blob);
    objectUrl = url;
    const player = new Audio(url);
    audio = player;

    player.onended = () => {
      if (ticket !== request) return;
      player.onended = null;
      player.onerror = null;
      if (audio === player) audio = null;
      if (objectUrl === url) objectUrl = null;
      URL.revokeObjectURL(url);
      emit(idle);
    };
    player.onerror = () => {
      if (ticket !== request) return;
      player.onended = null;
      player.onerror = null;
      if (audio === player) audio = null;
      if (objectUrl === url) objectUrl = null;
      URL.revokeObjectURL(url);
      emit({ status: "idle", id, error: "Could not play this audio." });
    };

    emit({ status: "playing", id, error: null });
    // Await directly so cancellation rejections are caught without creating
    // an unhandled promise from a detached cleanup chain.
    await player.play();
  } catch (error) {
    if (ticket !== request) return;
    release();
    if (error instanceof DOMException && error.name === "AbortError") {
      emit(idle);
      return;
    }
    emit({ status: "idle", id, error: "Could not read this reply aloud." });
  }
}

export function useSpeech() {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => idle);
  return { ...snapshot, speak, stop: stopSpeech };
}
