#!/usr/bin/env node
import { main } from '../../bin/flowcairn.mjs';

await main(['ui', ...process.argv.slice(2)]);
