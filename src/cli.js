// CLI: node src/cli.js owner/repo  -> prints the brief JSON.
import { parseRepoInput } from './sources/github.js';
import { buildBrief } from './brief.js';

const parsed = parseRepoInput(process.argv[2] || '');
if (!parsed) {
  console.error('Usage: node src/cli.js <github-url|owner/repo>');
  process.exit(2);
}
const brief = await buildBrief(parsed.owner, parsed.repo);
if (!brief) {
  console.error('Repository not found.');
  process.exit(1);
}
console.log(JSON.stringify(brief, null, 2));
