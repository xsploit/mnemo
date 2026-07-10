import { runDevelopmentReplay } from '../development/replay.js';

const report = await runDevelopmentReplay();
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
