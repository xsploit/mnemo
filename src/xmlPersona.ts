import fs from 'node:fs';
import path from 'node:path';

const includePattern = /<include\s+(?:src|file)="([^"]+)"\s*\/>/gi;

export function loadXmlPersonaFile(filePath: string, rootDir = process.cwd(), seen = new Set<string>()): string {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
  if (seen.has(resolvedPath)) {
    throw new Error(`Circular XML persona include: ${resolvedPath}`);
  }

  seen.add(resolvedPath);
  const xml = fs.readFileSync(resolvedPath, 'utf8');
  const baseDir = path.dirname(resolvedPath);
  const expanded = xml.replace(includePattern, (_match, includePath: string) => {
    return loadXmlPersonaFile(path.resolve(baseDir, includePath), baseDir, seen);
  });
  seen.delete(resolvedPath);
  return expanded;
}

export function renderXmlPersonaTemplate(template: string, variables: Record<string, string>): string {
  const merged = { ...defaultPersonaVariables, ...variables };
  const botName = merged.bot_name ?? 'Hikari-chan';
  return template
    .replaceAll('{NAME}', botName)
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => merged[key] ?? match)
    .trim();
}

const defaultPersonaVariables: Record<string, string> = {
  bot_name: 'Hikari-chan',
  username: 'the current Discord user',
  user_name: 'the current Discord user',
  user_input: 'the current Discord message',
  personality_mood: 'playful',
  mental_health_state: 'stable',
  mental_state: 'stable',
  chemical_mood_description: 'balanced',
  chemical_mood: 'balanced',
  lambda_psi_efficiency: '0.72',
  lambda_efficiency: '0.72',
  social_relationship_level: 'friendly',
  social_level: 'friendly',
  loneliness_percent: '8',
  oxytocin_percent: '62',
  trust_percent: '58',
  personality_mode: 'playful'
};
