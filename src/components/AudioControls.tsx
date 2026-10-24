"use client";

import { useEffect, useState } from "react";
import { startMusic, stopMusic, unlockAudio, toggleMuted, isMuted } from "@/game/audio";

/**
 * Starts the looping battle music after the first user gesture (required by
 * browser autoplay policies) and exposes a mute toggle. Synthesized audio —
 * no asset files needed.
 */
export function AudioControls() {
  const [muted, setMuted] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (started) return;
    const kick = () => {
      unlockAudio();
      startMusic();
      setStarted(true);
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
    };
    window.addEventListener("pointerdown", kick);
    window.addEventListener("keydown", kick);
    return () => {
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
    };
  }, [started]);

  useEffect(() => {
    return () => stopMusic();
  }, []);

  const onToggle = () => {
    unlockAudio();
    if (!started) {
      startMusic();
      setStarted(true);
    }
    setMuted(toggleMuted());
  };

  return (
    <button
      onClick={onToggle}
      title={muted ? "Activar sonido" : "Silenciar"}
      className="panel-glass flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-white/70 transition hover:text-white"
    >
      <span className="text-sm">{muted || isMuted() ? "🔇" : "🔊"}</span>
      <span className="text-[9px] uppercase tracking-widest">
        {muted ? "Silencio" : "Audio"}
      </span>
    </button>
  );
}
