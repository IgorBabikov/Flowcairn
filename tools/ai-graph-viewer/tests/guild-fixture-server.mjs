// Standalone TEST ONLY fixture. Does not access external AI/accounts.
import { createGuildFixture } from './guild-workflow-fixture.mjs';
if (!process.env.FLOWCAIRN_GUILD_DIST) throw Error('FLOWCAIRN_GUILD_DIST must name a prepared viewer dist');
const fixture = await createGuildFixture({ dist: process.env.FLOWCAIRN_GUILD_DIST, port: Number(process.env.FLOWCAIRN_GUILD_PORT ?? 57864), repair: process.env.FLOWCAIRN_GUILD_REPAIR === '1' });
console.log(JSON.stringify({ label: 'TEST ONLY synthetic AI', url: `${fixture.url}/#session=${fixture.token}`, root: fixture.root }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(0); });
