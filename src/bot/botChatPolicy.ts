import { config } from '../config.js';

let respondToBots = config.bot.respondToBots;
let repliesPaused = false;

export function getRespondToBots(): boolean {
  return respondToBots;
}

export function setRespondToBots(enabled: boolean): void {
  respondToBots = enabled;
}

export function getRepliesPaused(): boolean {
  return repliesPaused;
}

export function setRepliesPaused(paused: boolean): void {
  repliesPaused = paused;
}
