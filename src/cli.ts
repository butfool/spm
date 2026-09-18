#!/usr/bin/env node
import { run } from "./cli/index.js";

process.exitCode = await run(process.argv);
