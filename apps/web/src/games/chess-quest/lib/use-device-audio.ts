"use client";

// Keep the sfx/voice singletons in sync with the active device settings so
// the header toggles take effect everywhere.
import { useEffect } from "react";
import { useProgress } from "./progress";
import { sfx } from "./sfx";
import { voice } from "./voice";

export function useDeviceAudio(): void {
  const progress = useProgress();
  const muted = progress.getMuted();
  const voiceOn = progress.getVoiceOn();
  useEffect(() => {
    sfx.setMuted(muted);
  }, [muted]);
  useEffect(() => {
    voice.setEnabled(voiceOn);
  }, [voiceOn]);
}
