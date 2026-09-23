#!/usr/bin/env node
import { main } from './lib/cli.mjs';

main(process.argv.slice(2)).catch((err) => {
  console.error(`error: ${err.message}`);
  if (process.env.IMAGEGEN_DEBUG) console.error(err.stack);
  process.exit(err.exitCode ?? 1);
});
