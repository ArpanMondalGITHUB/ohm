#!/usr/bin/env node
import { register } from "tsx/esm/api";

register();                    // teach Node to load .ts files
await import("../src/cli.ts"); // start the app
