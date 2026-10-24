import { create } from "zustand";
import {
  CARD_DEF_BY_ID,
  CHARACTERS,
  ENEMY,
  basePoolForCharacter,
  ultimateForCharacter,
} from "./content";
import { affinity, affinityMultiplier } from "./affinity";
import { playSfx } from "./audio";
import type {
  CardInstance,
  Character,
  Enemy,
  FloatingNumber,
  LogEntry,
  Phase,
  QueuedCommand,
} from "./types";

const HAND_SIZE = 6;

/** Number of attack slots that must be filled to auto-launch the attack. */
export const ATTACK_SLOTS = 3;

// -------------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------------

let UID = 0;
const uid = () => `c${++UID}_${Math.random().toString(36).slice(2, 7)}`;

let LOG_ID = 0;
let FLOAT_ID = 0;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// -------------------------------------------------------------------------
// Store shape
// -------------------------------------------------------------------------

export interface GameState {
  characters: Character[];
  enemy: Enemy;
  hand: CardInstance[];
  phase: Phase;
  turn: number;
  /** Accumulated field "Ruido" (noise). Physical adds, Logical consumes. */
  noise: number;
  /** Queued commands during the Orders phase (cardUid -> command). */
  queue: QueuedCommand[];
  selectedCardUid: string | null;
  log: LogEntry[];
  /** Transient uid currently playing an attack animation (for sequencing). */
  activeAnim: string | null;
  /** True while the slots are full and the auto-launch is being dispatched. */
  launching: boolean;
  /** Floating damage/heal numbers currently animating over units. */
  floaters: FloatingNumber[];
  /** Cumulative damage dealt to the enemy this measurement (the "TOTAL"). */
  totalDamage: number;

  // actions
  init: () => void;
  startTurn: () => void;
  selectCard: (uid: string | null) => void;
  /** Assign a card to the next free attack slot. */
  assignToSlot: (cardUid: string) => void;
  unqueue: (cardUid: string) => void;
  moveCard: (fromIndex: number, toIndex: number) => void;
  /**
   * Drag one card onto another. If both share defId + level (and can level up)
   * they fuse into a level+1 card; otherwise the dragged card is reordered to
   * the target's position.
   */
  dropCardOn: (draggedUid: string, targetUid: string) => void;
  runMeasurement: () => Promise<void>;
  resetGame: () => void;
}

// -------------------------------------------------------------------------
// Deck / dealing
// -------------------------------------------------------------------------

function buildDealPool(characters: Character[]): CardInstance[] {
  const pool: CardInstance[] = [];
  for (const ch of characters) {
    if (!ch.alive) continue;
    const defs = basePoolForCharacter(ch.id);
    // weight: a couple of copies per def so fusions can happen
    for (const d of defs) {
      pool.push({ uid: uid(), defId: d.id, level: 1 });
      pool.push({ uid: uid(), defId: d.id, level: 1 });
    }
  }
  return pool;
}

function dealHand(
  characters: Character[],
  existing: CardInstance[]
): CardInstance[] {
  const hand = [...existing];
  const pool = buildDealPool(characters);
  // inject ready ultimates first (moxie == max)
  for (const ch of characters) {
    if (ch.alive && ch.moxie >= ch.maxMoxie) {
      const ult = ultimateForCharacter(ch.id);
      const alreadyHas = hand.some(
        (c) => CARD_DEF_BY_ID[c.defId]?.ultimate && c.defId === ult?.id
      );
      if (ult && !alreadyHas && hand.length < HAND_SIZE) {
        hand.push({ uid: uid(), defId: ult.id, level: 3 });
      }
    }
  }
  while (hand.length < HAND_SIZE && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    hand.push(pool.splice(idx, 1)[0]);
  }
  return hand;
}

// -------------------------------------------------------------------------
// Fusion — identical adjacent cards (same def + level) merge into level+1.
// Returns the fused hand and the number of fusions (for Moxie gain).
// -------------------------------------------------------------------------

function resolveFusions(hand: CardInstance[]): {
  hand: CardInstance[];
  fusions: { characterId: string }[];
} {
  const out: CardInstance[] = [];
  const fusions: { characterId: string }[] = [];
  let i = 0;
  while (i < hand.length) {
    const a = hand[i];
    const b = hand[i + 1];
    const defA = CARD_DEF_BY_ID[a.defId];
    if (
      b &&
      a.defId === b.defId &&
      a.level === b.level &&
      a.level < 3 && // max 3 levels
      !defA?.ultimate // ultimates never fuse
    ) {
      out.push({
        uid: uid(),
        defId: a.defId,
        level: (a.level + 1) as 1 | 2 | 3,
        justFused: true,
      });
      fusions.push({ characterId: defA.characterId });
      i += 2; // consume both
    } else {
      out.push(a);
      i += 1;
    }
  }
  // A fusion may create new adjacencies — resolve again until stable.
  if (fusions.length > 0) {
    const next = resolveFusions(out);
    return { hand: next.hand, fusions: [...fusions, ...next.fusions] };
  }
  return { hand: out, fusions };
}

// -------------------------------------------------------------------------
// Damage model
// -------------------------------------------------------------------------

/** Sum active buff/debuff magnitudes for a given stat (as a +/- percentage). */
function statModifierPct(unit: { buffs: { magnitude?: number }[] } & object, stat: string): number {
  // buffs carry an optional `stat` via the EffectTemplate they were built from
  const list = (unit as { buffs: Array<{ magnitude?: number; stat?: string }> }).buffs ?? [];
  return list.reduce((sum, b) => (b.stat === stat ? sum + (b.magnitude ?? 0) : sum), 0);
}

function computeCardDamage(
  caster: Character,
  card: CardInstance,
  noise: number,
  enemy: Enemy
): { damage: number; crit: boolean; noiseDelta: number; note: string } {
  const def = CARD_DEF_BY_ID[card.defId];
  const levelScale = 1 + (card.level - 1) * 0.6; // lv1=1, lv2=1.6, lv3=2.2
  const atkBuffPct = statModifierPct(caster, "attack");
  const effectiveAtk = caster.attack * (1 + atkBuffPct / 100);
  let base = effectiveAtk * def.power * levelScale;

  let note = "";
  let noiseDelta = def.noise;

  if (def.type === "Physical") {
    // Physical accumulates noise (already positive in def.noise)
    note = "Físico";
  } else {
    // Logical consumes noise for a bonus, then the def.noise (negative) applies
    const consumable = Math.max(0, noise);
    const bonus = Math.min(consumable, 9) * 0.25; // +25% per noise, cap 9
    base *= 1 + bonus;
    if (bonus > 0) note = `Lógico · Ruido consumido +${Math.round(bonus * 100)}%`;
    else note = "Lógico";
  }

  // Affinity
  const aff = affinity(caster.architecture, ENEMY.architecture);
  base *= affinityMultiplier(aff);
  if (aff === "strong") note += " · VENTAJA";
  if (aff === "weak") note += " · resistido";

  // Crit
  const crit = Math.random() < caster.critChance;
  if (crit) base *= caster.critDamage;

  // Enemy "damage taken" debuff (e.g. Forced Decoherence)
  const vulnPct = statModifierPct(enemy, "damageTaken");
  if (vulnPct !== 0) {
    base *= 1 + vulnPct / 100;
    note += ` · vuln +${vulnPct}%`;
  }

  // Attack buff note
  if (atkBuffPct !== 0) note += ` · ATK +${atkBuffPct}%`;

  // Chaos fluctuation from the enemy buff (±10%)
  base *= rand(0.9, 1.1);

  return { damage: Math.round(base), crit, noiseDelta, note };
}

function applyDamageToEnemy(enemy: Enemy, dmg: number, ignoreShieldPct = 0) {
  let remaining = dmg;
  const shieldHit = Math.round(remaining * (1 - ignoreShieldPct));
  const toShield = Math.min(enemy.shield, shieldHit);
  enemy.shield -= toShield;
  remaining -= toShield;
  enemy.hp = Math.max(0, enemy.hp - remaining);
  if (enemy.hp <= 0) {
    enemy.alive = false;
    enemy.spriteState = "dead";
  } else {
    enemy.spriteState = "hit";
  }
}

function applyDamageToCharacter(ch: Character, dmg: number) {
  let remaining = dmg;
  const toShield = Math.min(ch.shield, remaining);
  ch.shield -= toShield;
  remaining -= toShield;
  ch.hp = Math.max(0, ch.hp - remaining);
  if (ch.hp <= 0) {
    ch.alive = false;
    ch.spriteState = "dead";
  } else {
    ch.spriteState = "hit";
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function logLine(
  log: LogEntry[],
  text: string,
  tone: LogEntry["tone"]
): LogEntry[] {
  const next = [...log, { id: ++LOG_ID, text, tone }];
  return next.slice(-40);
}

// -------------------------------------------------------------------------
// Store
// -------------------------------------------------------------------------

export const useGame = create<GameState>((set, get) => ({
  characters: [],
  enemy: clone(ENEMY),
  hand: [],
  phase: "deal",
  turn: 0,
  noise: 0,
  queue: [],
  selectedCardUid: null,
  log: [],
  activeAnim: null,
  launching: false,
  floaters: [],
  totalDamage: 0,

  init: () => {
    UID = 0;
    LOG_ID = 0;
    set({
      characters: clone(CHARACTERS),
      enemy: clone(ENEMY),
      hand: [],
      phase: "deal",
      turn: 0,
      noise: 0,
      queue: [],
      selectedCardUid: null,
      log: logLine([], "Sistema cuántico inicializado. Decoherencia estable.", "system"),
      activeAnim: null,
      launching: false,
      floaters: [],
      totalDamage: 0,
    });
    get().startTurn();
  },

  resetGame: () => get().init(),

  startTurn: () => {
    const s = get();
    const characters = clone(s.characters);
    characters.forEach((c) => {
      if (c.alive) c.spriteState = "idle";
    });

    // Phase 1: Deal up to HAND_SIZE
    let hand = dealHand(characters, s.hand);

    // Phase 2: Resolve fusions (+1 Moxie to the owning character per fusion)
    const fused = resolveFusions(hand);
    hand = fused.hand;
    let log = s.log;
    for (const f of fused.fusions) {
      const owner = characters.find((c) => c.id === f.characterId);
      if (owner && owner.moxie < owner.maxMoxie) owner.moxie += 1;
      log = logLine(
        log,
        `Fusión automática — ${owner?.name ?? "?"} gana +1 Quant (${owner?.moxie}/5).`,
        "fusion"
      );
    }
    // top up again if fusion left gaps
    hand = dealHand(characters, hand);
    // re-resolve in case the refill created new pairs
    const refused = resolveFusions(hand);
    hand = refused.hand;
    for (const f of refused.fusions) {
      const owner = characters.find((c) => c.id === f.characterId);
      if (owner && owner.moxie < owner.maxMoxie) owner.moxie += 1;
    }

    // Telegraph enemy intent for this turn
    const enemy = clone(s.enemy);
    const livingIdx = characters
      .map((c, i) => (c.alive ? i : -1))
      .filter((i) => i >= 0);
    // Rotate the classical-ML attack pool each turn, then pick a target.
    const chosen =
      enemy.intentPool && enemy.intentPool.length
        ? pick(enemy.intentPool)
        : enemy.intent;
    enemy.intent = {
      ...chosen,
      targetIndex: livingIdx.length ? pick(livingIdx) : undefined,
    };

    set({
      characters,
      enemy,
      hand: hand.map((c) => ({ ...c, justFused: false })),
      turn: s.turn + 1,
      phase: "orders",
      noise: s.noise,
      queue: [],
      selectedCardUid: null,
      launching: false,
      log: logLine(log, `— Turno ${s.turn + 1} · Fase de Órdenes —`, "info"),
    });
  },

  selectCard: (uid) => set({ selectedCardUid: uid }),

  // Assign a card directly to the next free attack slot. When the slots fill
  // up (ATTACK_SLOTS) the attack launches automatically toward the enemy.
  assignToSlot: (cardUid) => {
    const s = get();
    if (s.phase !== "orders" || s.launching) return;
    if (s.queue.find((q) => q.cardUid === cardUid)) return;
    if (s.queue.length >= ATTACK_SLOTS) {
      set({ log: logLine(s.log, "Los 3 slots de ataque ya están llenos.", "system") });
      return;
    }
    const card = s.hand.find((c) => c.uid === cardUid);
    if (!card) return;
    const def = CARD_DEF_BY_ID[card.defId];
    const queue = [...s.queue, { cardUid, casterId: def.characterId, targetEnemyId: s.enemy.id }];
    const slotIndex = queue.length;
    playSfx("slot");
    set({
      queue,
      selectedCardUid: null,
      log: logLine(s.log, `Slot ${slotIndex}/${ATTACK_SLOTS} cargado: ${def.name}.`, "info"),
    });

    // Auto-launch once all three slots are occupied.
    if (queue.length >= ATTACK_SLOTS) {
      set({
        launching: true,
        log: logLine(get().log, "— Slots completos: iniciando ataque —", "info"),
      });
      // defer so the UI can paint the full third slot before the sequence runs
      setTimeout(() => {
        void get().runMeasurement();
      }, 420);
    }
  },

  unqueue: (cardUid) => {
    const s = get();
    if (!s.queue.find((q) => q.cardUid === cardUid)) return;
    set({
      queue: s.queue.filter((q) => q.cardUid !== cardUid),
    });
  },

  // Reorder a card in hand (free — no action-point cost).
  moveCard: (fromIndex, toIndex) => {
    const s = get();
    if (s.phase !== "orders") return;
    if (fromIndex === toIndex) return;
    const hand = [...s.hand];
    const [moved] = hand.splice(fromIndex, 1);
    hand.splice(toIndex, 0, moved);
    // Manual moves can create new adjacencies -> resolve fusions
    const fused = resolveFusions(hand);
    const characters = clone(s.characters);
    let log = s.log;
    for (const f of fused.fusions) {
      const owner = characters.find((c) => c.id === f.characterId);
      if (owner && owner.moxie < owner.maxMoxie) owner.moxie += 1;
      log = logLine(log, `Fusión por movimiento — ${owner?.name} +1 Quant.`, "fusion");
    }
    set({
      hand: fused.hand,
      characters,
      log,
    });
  },

  dropCardOn: (draggedUid, targetUid) => {
    const s = get();
    if (s.phase !== "orders" || s.launching) return;
    if (draggedUid === targetUid) return;

    const queued = new Set(s.queue.map((q) => q.cardUid));
    // Cards currently staged in attack slots can't be reordered/fused.
    if (queued.has(draggedUid) || queued.has(targetUid)) return;

    const hand = [...s.hand];
    const from = hand.findIndex((c) => c.uid === draggedUid);
    const to = hand.findIndex((c) => c.uid === targetUid);
    if (from < 0 || to < 0) return;

    const dragged = hand[from];
    const target = hand[to];
    const def = CARD_DEF_BY_ID[dragged.defId];

    const canFuse =
      dragged.defId === target.defId &&
      dragged.level === target.level &&
      dragged.level < 3 && // max 3 levels
      !def?.ultimate; // ultimates never fuse

    const characters = clone(s.characters);
    let log = s.log;

    if (canFuse) {
      // Build the fused card and replace the pair with a single level+1 card
      // positioned where the target was.
      const fusedCard: CardInstance = {
        uid: uid(),
        defId: dragged.defId,
        level: (dragged.level + 1) as 1 | 2 | 3,
        justFused: true,
      };
      // Remove both by uid, then insert the fused card at the target's slot.
      const rest = hand.filter(
        (c) => c.uid !== draggedUid && c.uid !== targetUid
      );
      // recompute target index inside `rest`
      const insertAt = Math.min(
        rest.length,
        hand.filter((c, idx) => idx < to && c.uid !== draggedUid).length
      );
      rest.splice(insertAt, 0, fusedCard);

      const owner = characters.find((c) => c.id === def.characterId);
      if (owner && owner.moxie < owner.maxMoxie) owner.moxie += 1;
      playSfx("fuse");
      log = logLine(
        log,
        `Fusión manual — ${def.name} sube a Lv${fusedCard.level}. ${
          owner?.name ?? "?"
        } +1 Quant.`,
        "fusion"
      );
      set({ hand: rest, characters, log });
    } else {
      // Not a fusion: reorder the dragged card to the target's position.
      const [moved] = hand.splice(from, 1);
      const newTo = hand.findIndex((c) => c.uid === targetUid);
      hand.splice(newTo < 0 ? hand.length : newTo, 0, moved);
      // Reordering may create a new adjacent identical pair -> auto-fuse.
      const refused = resolveFusions(hand);
      for (const f of refused.fusions) {
        const o = characters.find((c) => c.id === f.characterId);
        if (o && o.moxie < o.maxMoxie) o.moxie += 1;
        log = logLine(log, `Fusión por adyacencia — ${o?.name} +1 Quant.`, "fusion");
      }
      set({ hand: refused.hand, characters, log });
    }
  },

  runMeasurement: async () => {
    const s = get();
    if (s.phase !== "orders") return;
    if (s.queue.length === 0) {
      set({ log: logLine(s.log, "No hay comandos que medir.", "system") });
      return;
    }

    set({
      phase: "measurement",
      selectedCardUid: null,
      launching: false,
      floaters: [],
      totalDamage: 0,
    });

    let characters = clone(get().characters);
    let enemy = clone(get().enemy);
    let noise = get().noise;
    let log = get().log;

    // Emit a floating number over a unit and auto-expire it after ~1.1s.
    const addFloater = (f: Omit<FloatingNumber, "id">) => {
      const id = ++FLOAT_ID;
      set({ floaters: [...get().floaters, { ...f, id }] });
      setTimeout(() => {
        set({ floaters: get().floaters.filter((x) => x.id !== id) });
      }, 1100);
    };

    log = logLine(log, "— Fase de Medición: colapsando comandos —", "info");
    set({ log });

    for (const cmd of get().queue) {
      const card = get().hand.find((c) => c.uid === cmd.cardUid);
      if (!card) continue;
      const def = CARD_DEF_BY_ID[card.defId];
      const caster = characters.find((c) => c.id === cmd.casterId);
      if (!caster || !caster.alive) continue;

      const isSupport =
        def.type === "Heal" || def.type === "Buff" || def.type === "Debuff";

      // set sprite state based on card type
      caster.spriteState = def.ultimate
        ? "ultimate"
        : def.type === "Physical"
        ? "attack-physical"
        : "attack-logical"; // Logical + all support cards use the cast gesture

      // cast SFX per card type
      if (def.ultimate) playSfx("ultimate");
      else if (def.type === "Physical") playSfx("physical");
      else if (def.type === "Heal") playSfx("heal");
      else if (def.type === "Buff") playSfx("buff");
      else if (def.type === "Debuff") playSfx("debuff");
      else playSfx("logical");

      set({
        characters: clone(characters),
        activeAnim: caster.id,
      });
      await wait(def.ultimate ? 1300 : 750);

      // Support effects scale with card level too (lv1=1, lv2=1.6, lv3=2.2).
      const supportScale = 1 + (card.level - 1) * 0.6;

      if (isSupport) {
        // ---- Support resolution (no enemy damage) ----
        if (def.type === "Heal") {
          // target the living ally with the lowest HP ratio
          const living = characters.filter((c) => c.alive);
          const target =
            living.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] ?? caster;
          const healed = Math.round(target.maxHp * (def.healPct ?? 0) * supportScale);
          target.hp = Math.min(target.maxHp, target.hp + healed);
          const shieldAdd = Math.round(target.maxHp * (def.shieldPct ?? 0) * supportScale);
          if (shieldAdd > 0) target.shield += shieldAdd;
          if (healed > 0) addFloater({ targetId: target.id, amount: healed, kind: "heal" });
          log = logLine(
            log,
            `${caster.name} usa ${def.name} (Lv${card.level}) → +${healed.toLocaleString()} HP${
              shieldAdd ? ` y +${shieldAdd.toLocaleString()} escudo` : ""
            } a ${target.name}.`,
            "heal"
          );
        } else if (def.type === "Buff" && def.grantBuff) {
          const mag = Math.round(def.grantBuff.magnitude * supportScale);
          const targets = def.buffTeam
            ? characters.filter((c) => c.alive)
            : [caster];
          for (const t of targets) {
            // refresh if already present, else add
            t.buffs = t.buffs.filter((b) => b.id !== def.grantBuff!.id);
            t.buffs.push({ ...def.grantBuff!, magnitude: mag });
          }
          log = logLine(
            log,
            `${caster.name} usa ${def.name} (Lv${card.level}) → ${def.grantBuff.name} (+${mag}% ${
              def.grantBuff.stat
            }) a ${def.buffTeam ? "todo el equipo" : caster.name}.`,
            "fusion"
          );
        } else if (def.type === "Debuff" && def.applyDebuff) {
          const mag = Math.round(def.applyDebuff.magnitude * supportScale);
          enemy.buffs = enemy.buffs.filter((b) => b.id !== def.applyDebuff!.id);
          enemy.buffs.push({ ...def.applyDebuff!, magnitude: mag });
          log = logLine(
            log,
            `${caster.name} usa ${def.name} (Lv${card.level}) → ${def.applyDebuff.name} sobre ${enemy.name} (+${mag}% daño recibido).`,
            "enemy"
          );
        }
        noise = Math.max(0, noise + def.noise);
      } else {
        // ---- Damage resolution ----
        const { damage, crit, noiseDelta, note } = computeCardDamage(
          caster,
          card,
          noise,
          enemy
        );
        const ignoreShield =
          def.id === "card_factor_01" ? 0.3 : def.ultimate && def.type === "Logical" ? 1 : 0;
        applyDamageToEnemy(enemy, damage, ignoreShield);
        noise = Math.max(0, noise + noiseDelta);

        // Floating damage number + running total over the enemy.
        addFloater({ targetId: enemy.id, amount: damage, kind: crit ? "crit" : "damage" });
        set({ totalDamage: get().totalDamage + damage });
        // impact SFX slightly after the cast so it lands with the hit
        setTimeout(() => playSfx("enemyHit"), 120);

        log = logLine(
          log,
          `${caster.name} lanza ${def.name} → ${damage.toLocaleString()} ${
            crit ? "CRÍTICO " : ""
          }dmg (${note}).`,
          def.ultimate ? "ultimate" : "damage"
        );
        enemy.spriteState = "hit";
      }

      // Quant charge: a card grants Quant equal to its level (Lv1=+1 … Lv3=+3),
      // capped at the character's max. The Ultimate consumes the full charge.
      if (def.ultimate) {
        caster.moxie = 0;
        log = logLine(log, `${caster.name} descarga su Quant con el Ultimate.`, "ultimate");
      } else if (caster.moxie < caster.maxMoxie) {
        const before = caster.moxie;
        caster.moxie = Math.min(caster.maxMoxie, caster.moxie + card.level);
        log = logLine(
          log,
          `${caster.name} +${caster.moxie - before} Quant (carta Lv${card.level}) → ${caster.moxie}/${caster.maxMoxie}.`,
          "fusion"
        );
        if (caster.moxie >= caster.maxMoxie && before < caster.maxMoxie) {
          log = logLine(
            log,
            `¡${caster.name} alcanza ${caster.maxMoxie} Quant! Carta especial disponible.`,
            "ultimate"
          );
        }
      }
      set({ characters: clone(characters), enemy: clone(enemy), noise, log });
      await wait(450);

      caster.spriteState = "idle";
      enemy.spriteState = enemy.alive ? "idle" : "dead";
      set({ characters: clone(characters), enemy: clone(enemy), activeAnim: null });

      if (!enemy.alive) break;
    }

    // consume the measured cards from hand
    const measuredUids = new Set(get().queue.map((q) => q.cardUid));
    const hand = get().hand.filter((c) => !measuredUids.has(c.uid));
    set({ hand, queue: [] });

    if (!enemy.alive) {
      playSfx("victory");
      set({
        phase: "victory",
        log: logLine(log, "El modelo clásico ha sido superado por la ventaja cuántica. VICTORIA.", "system"),
      });
      return;
    }

    // --- Enemy turn ---
    await wait(500);
    set({ phase: "enemy", log: logLine(get().log, "— Turno del Enemigo —", "enemy") });
    await wait(400);

    enemy = clone(get().enemy);
    characters = clone(get().characters);
    enemy.spriteState = "attack-physical";
    set({ enemy: clone(enemy) });
    await wait(700);

    const intent = enemy.intent;

    if (intent.kind === "shield") {
      // Classical ML "regularization" — the model armours itself.
      const gained = Math.round(enemy.maxHp * 0.06 * intent.power);
      enemy.shield += gained;
      const enemyNoise = intent.noise ?? 0;
      if (enemyNoise) noise = noise + enemyNoise;
      log = logLine(
        get().log,
        `${enemy.name} usa ${intent.name} → +${gained.toLocaleString()} de Escudo${
          enemyNoise ? ` · +${enemyNoise} Ruido Estadístico` : ""
        }.`,
        "enemy"
      );
      addFloater({ targetId: enemy.id, amount: gained, kind: "heal" });
      set({ enemy: clone(enemy), noise, log });
    } else if (intent.kind === "buff") {
      // "Boosting" — the model strengthens its own attack for a few turns.
      const mag = Math.round(20 * intent.power);
      enemy.buffs = enemy.buffs.filter((b) => b.id !== "e_boost");
      enemy.buffs.push({
        id: "e_boost",
        name: "Boosting",
        kind: "buff",
        description: `Ensamble de modelos débiles: +${mag}% de Ataque.`,
        duration: 2,
        magnitude: mag,
        stat: "attack",
      });
      const enemyNoise = intent.noise ?? 0;
      if (enemyNoise) noise = noise + enemyNoise;
      log = logLine(
        get().log,
        `${enemy.name} usa ${intent.name} → Boosting (+${mag}% Ataque, 2 turnos)${
          enemyNoise ? ` · +${enemyNoise} Ruido` : ""
        }.`,
        "enemy"
      );
      set({ enemy: clone(enemy), noise, log });
    } else {
      // --- Attack ---
      const targetIdx =
        intent.targetIndex != null && characters[intent.targetIndex]?.alive
          ? intent.targetIndex
          : characters.findIndex((c) => c.alive);

      if (targetIdx >= 0) {
        const target = characters[targetIdx];
        const aff = affinity(enemy.architecture, target.architecture);
        // enemy attack scales with its own "Boosting" buff if active
        const atkBuff = statModifierPct(enemy, "attack");
        const effAtk = enemy.attack * (1 + atkBuff / 100);
        let dmg = Math.round(
          effAtk * intent.power * affinityMultiplier(aff) * rand(0.9, 1.1)
        );
        applyDamageToCharacter(target, dmg);
        addFloater({ targetId: target.id, amount: dmg, kind: "enemy-damage" });
        playSfx("allyHit");
        const enemyNoise = intent.noise ?? 3;
        noise = noise + enemyNoise;
        log = logLine(
          get().log,
          `${enemy.name} usa ${intent.name} sobre ${target.name} → ${dmg.toLocaleString()} dmg${
            atkBuff ? ` (ATK +${atkBuff}%)` : ""
          }. +${enemyNoise} Ruido Estadístico.`,
          "enemy"
        );
        if (!target.alive) {
          log = logLine(log, `${target.name} ha caído.`, "system");
        }
        set({ characters: clone(characters), noise, log });
      }
    }

    await wait(500);
    characters.forEach((c) => {
      if (c.alive) c.spriteState = "idle";
    });
    enemy.spriteState = "idle";

    // --- End of turn: tick buff/debuff durations ---
    const tick = (list: Character["buffs"]) =>
      list
        .map((b) => (b.duration > 0 ? { ...b, duration: b.duration - 1 } : b))
        .filter((b) => b.duration !== 0);
    characters.forEach((c) => (c.buffs = tick(c.buffs)));
    // tick the enemy's own buffs (Boosting) and player-applied debuffs too
    enemy.buffs = tick(enemy.buffs);

    const anyAlive = characters.some((c) => c.alive);
    set({
      characters: clone(characters),
      enemy: clone(enemy),
      noise,
      phase: "end",
      log: logLine(get().log, "— Fin de Turno: verificando efectos —", "info"),
    });
    await wait(500);

    if (!anyAlive) {
      playSfx("defeat");
      set({ phase: "defeat", log: logLine(get().log, "Todo el equipo ha decoherido. DERROTA.", "system") });
      return;
    }

    // next turn
    get().startTurn();
  },
}));
