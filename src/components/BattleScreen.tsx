"use client";

import { useEffect } from "react";
import { useGame } from "@/game/store";
import { Battlefield } from "./Battlefield";
import { CardHand } from "./CardHand";
import { TopHud } from "./TopHud";
import { CommandBar } from "./CommandBar";
import { CombatLog } from "./CombatLog";
import { ResultOverlay } from "./ResultOverlay";
import { AffinityLegend } from "./AffinityLegend";
import { AudioControls } from "./AudioControls";

export function BattleScreen() {
  const init = useGame((s) => s.init);
  const started = useGame((s) => s.characters.length > 0);

  useEffect(() => {
    if (!started) init();
  }, [started, init]);

  if (!started) {
    return (
      <div className="flex h-screen items-center justify-center text-white/40">
        Inicializando sistema cuántico…
      </div>
    );
  }

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden">
      <TopHud />

      {/* Audio mute toggle (music starts on first interaction) */}
      <div className="absolute right-3 top-3 z-40">
        <AudioControls />
      </div>

      {/* Battlefield fills the upper area */}
      <Battlefield />

      {/* Bottom control deck */}
      <div className="relative z-20 border-t border-white/10 bg-gradient-to-t from-black/90 to-black/40 px-4 pb-4 pt-6">
        <div className="mb-3 flex items-end justify-between gap-4">
          <CombatLog />
          <div className="flex-1">
            <CardHand />
          </div>
          <div className="flex flex-col items-end gap-3">
            <CommandBar />
            <AffinityLegend />
          </div>
        </div>
      </div>

      <ResultOverlay />
    </div>
  );
}
