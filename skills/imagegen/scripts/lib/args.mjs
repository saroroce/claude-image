import { parseArgs } from 'node:util';
import { UsageError } from './errors.mjs';

export const parse = (args, options, allowPositionals = true) => {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
};
