import { createDb } from './client';
import { loadLibrary, seedLibrary } from './seed-lib';

const publish = process.argv.includes('--publish');
const file = new URL('../../seed/biblioteca_v1.json', import.meta.url).pathname;
const report = await seedLibrary(createDb(), loadLibrary(file), { publishRules: publish });
console.log(report);
if (!publish) console.log('Regras importadas como RASCUNHO (revisão no painel). Use --publish só em desenvolvimento.');
process.exit(0);
