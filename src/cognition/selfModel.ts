import fs from 'node:fs/promises';
import path from 'node:path';
import type { PersonaAffect } from '../llm/personaOutput.js';

const SELF_SCHEMA = 'mnemo.self-model.v1';
const SELF_PATH = path.resolve('data', 'self-model.json');
const MAX_NOTES = 6;
const NOTE_MAX_CHARS = 180;
const DRIFT_ALPHA = 0.12; // small, so meaningful change takes weeks of interaction

export interface AffectBaseline {
  valence: number; // -1..1
  arousal: number; // 0..1
  dominance: number; // 0..1
  socialEnergy: number; // 0..1
}

export interface SelfModel {
  /** Her resting emotional state — where her mood returns to between conversations. */
  baseline: AffectBaseline;
  /** A small, editable slice of self-concept she's formed by living. First person. */
  selfNotes: string[];
  version: number;
  updatedAt: string;
}

const DEFAULT_BASELINE: AffectBaseline = { valence: 0.35, arousal: 0.6, dominance: 0.55, socialEnergy: 0.72 };

function defaultModel(): SelfModel {
  return { baseline: { ...DEFAULT_BASELINE }, selfNotes: [], version: 0, updatedAt: new Date().toISOString() };
}

export class SelfModelStore {
  constructor(private readonly filePath = SELF_PATH) {}

  async get(): Promise<SelfModel> {
    let raw = '';
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return defaultModel();
    }
    try {
      const payload = JSON.parse(raw) as { model?: Partial<SelfModel> };
      const m = payload.model ?? (payload as unknown as Partial<SelfModel>);
      return {
        baseline: {
          valence: clamp(num(m.baseline?.valence, DEFAULT_BASELINE.valence), -1, 1),
          arousal: clamp(num(m.baseline?.arousal, DEFAULT_BASELINE.arousal), 0, 1),
          dominance: clamp(num(m.baseline?.dominance, DEFAULT_BASELINE.dominance), 0, 1),
          socialEnergy: clamp(num(m.baseline?.socialEnergy, DEFAULT_BASELINE.socialEnergy), 0, 1),
        },
        selfNotes: Array.isArray(m.selfNotes)
          ? m.selfNotes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).slice(0, MAX_NOTES)
          : [],
        version: num(m.version, 0),
        updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : new Date().toISOString(),
      };
    } catch {
      return defaultModel();
    }
  }

  async save(model: SelfModel): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = { schema: SELF_SCHEMA, model };
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, this.filePath);
  }

  /**
   * Evolve her self. Baseline drifts (slowly) toward the affect she actually felt
   * recently; self-notes are replaced by an evidence-grounded edited set. Returns
   * the new model plus a human-readable summary of what changed.
   */
  async evolve(args: { recentAffects: PersonaAffect[]; noteEdits?: SelfNoteEdit[] }): Promise<{ model: SelfModel; changed: string[] }> {
    const model = await this.get();
    const changed: string[] = [];

    const avg = averageAffect(args.recentAffects);
    if (avg) {
      const before = { ...model.baseline };
      model.baseline = {
        valence: drift(model.baseline.valence, avg.valence ?? model.baseline.valence),
        arousal: drift(model.baseline.arousal, avg.arousal ?? model.baseline.arousal),
        dominance: drift(model.baseline.dominance, avg.dominance ?? model.baseline.dominance),
        socialEnergy: drift(model.baseline.socialEnergy, avg.socialEnergy ?? model.baseline.socialEnergy),
      };
      if (Math.abs(model.baseline.valence - before.valence) >= 0.01 || Math.abs(model.baseline.arousal - before.arousal) >= 0.01) {
        changed.push(`baseline mood drifted toward valence ${model.baseline.valence.toFixed(2)}, energy ${model.baseline.arousal.toFixed(2)}`);
      }
    }

    for (const edit of args.noteEdits ?? []) {
      const note = edit.note?.trim().slice(0, NOTE_MAX_CHARS) ?? '';
      if (edit.op === 'add' && note && !model.selfNotes.includes(note)) {
        model.selfNotes.push(note);
        changed.push(`new self-note: "${note}"`);
      } else if (edit.op === 'revise' && note && edit.targetIndex != null && model.selfNotes[edit.targetIndex]) {
        model.selfNotes[edit.targetIndex] = note;
        changed.push(`revised self-note: "${note}"`);
      } else if (edit.op === 'drop' && edit.targetIndex != null && model.selfNotes[edit.targetIndex]) {
        const [dropped] = model.selfNotes.splice(edit.targetIndex, 1);
        changed.push(`let go of self-note: "${dropped}"`);
      }
    }
    // Keep the self-concept small: newest notes win.
    if (model.selfNotes.length > MAX_NOTES) model.selfNotes = model.selfNotes.slice(-MAX_NOTES);

    model.version += 1;
    model.updatedAt = new Date().toISOString();
    await this.save(model);
    return { model, changed };
  }
}

export interface SelfNoteEdit {
  op: 'add' | 'revise' | 'drop';
  note?: string;
  targetIndex?: number | null;
}

/** Block injected into the live system prompt so the evolving self actually shapes behavior. */
export function renderSelfBlock(model: SelfModel): string {
  const lines = [`Who you've become lately (your evolving self, shaped by everything you've lived — let it quietly color your baseline mood and reactions; never recite it):`];
  lines.push(`- resting mood: ${describeBaseline(model.baseline)}`);
  for (const note of model.selfNotes) lines.push(`- ${note}`);
  return lines.join('\n');
}

export function describeBaseline(b: AffectBaseline): string {
  const energy = b.arousal >= 0.66 ? 'high-energy' : b.arousal <= 0.33 ? 'low-key' : 'steady';
  const tone = b.valence >= 0.33 ? 'warm' : b.valence <= -0.2 ? 'guarded' : 'even';
  const edge = b.dominance >= 0.6 ? ', a little smug' : b.dominance <= 0.35 ? ', a little soft' : '';
  return `${energy} and ${tone}${edge} (valence ${b.valence.toFixed(2)}, energy ${b.arousal.toFixed(2)})`;
}

function averageAffect(affects: PersonaAffect[]): PersonaAffect | null {
  const valid = affects.filter(Boolean);
  if (!valid.length) return null;
  const mean = (key: keyof PersonaAffect): number | undefined => {
    const nums = valid.map((a) => a[key]).filter((v): v is number => typeof v === 'number');
    return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : undefined;
  };
  return { valence: mean('valence'), arousal: mean('arousal'), dominance: mean('dominance'), socialEnergy: mean('socialEnergy') };
}

function drift(current: number, target: number): number {
  return Number((current * (1 - DRIFT_ALPHA) + target * DRIFT_ALPHA).toFixed(4));
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export const selfModelStore = new SelfModelStore();
