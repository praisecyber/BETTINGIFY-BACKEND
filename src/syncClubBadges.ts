import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSportApiDay, getSportApiTeamLogo } from './services/sportApiFeed.js';

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`))) {
    throw new Error('Usage: npm run sync:club-badges -- [YYYY-MM-DD]');
}

const sourceDir = dirname(fileURLToPath(import.meta.url));
const assetDir = resolve(sourceDir, '../../frontend/public/assets/club-badges');
const manifestPath = resolve(assetDir, 'manifest.json');
const feed = await getSportApiDay(date);
const teamIds = new Set<number>();

for (const event of feed.events) {
    for (const logo of [event.homeLogo, event.awayLogo]) {
        const match = logo?.match(/\/teams\/(\d+)\/logo$/);
        if (match) teamIds.add(Number(match[1]));
    }
}

if (teamIds.size === 0) throw new Error(`No team IDs found in SportAPI fixtures for ${date}`);
await mkdir(assetDir, { recursive: true });

let manifest: Record<string, string> = {};
try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, string>;
} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const extensionFor: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
};
const pending = [...teamIds].filter((id) => !manifest[String(id)]);
let synced = 0;
let failed = 0;
let next = 0;

await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (next < pending.length) {
        const teamId = pending[next++];
        try {
            const logo = await getSportApiTeamLogo(teamId);
            const extension = extensionFor[logo.contentType];
            if (!extension) throw new Error(`Unsupported image format: ${logo.contentType}`);
            const fileName = `${teamId}.${extension}`;
            await writeFile(resolve(assetDir, fileName), logo.body);
            manifest[String(teamId)] = `/assets/club-badges/${fileName}`;
            synced++;
        } catch (error) {
            failed++;
            console.error(`Could not sync team ${teamId}: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    }
}));

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Club badges for ${date}: ${synced} downloaded, ${teamIds.size - pending.length} already present, ${failed} failed.`);