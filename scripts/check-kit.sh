#!/usr/bin/env bash
# Installs the client-site kit into a throwaway Astro site and type-checks + builds it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
K="$(mktemp -d)"
trap 'rm -rf "$K"' EXIT
mkdir -p "$K/src/lib" "$K/src/pages/shop"
cp "$ROOT/kit/store/commerce.ts" "$ROOT/kit/cms.ts" "$K/src/lib/"
cp "$ROOT/kit/store/pages/cart.astro" "$K/src/pages/"
cp "$ROOT"/kit/store/pages/shop/*.astro "$K/src/pages/shop/"
ln -s "$ROOT/node_modules" "$K/node_modules"
echo '{ "name": "kit-check", "private": true, "type": "module" }' > "$K/package.json"
echo "import { defineConfig } from 'astro/config'; export default defineConfig({})" > "$K/astro.config.mjs"
echo '{ "extends": "astro/tsconfigs/strict", "include": [".astro/types.d.ts", "**/*"], "exclude": ["dist"] }' > "$K/tsconfig.json"
echo '<p>home</p>' > "$K/src/pages/index.astro"
cd "$K" && npx astro check && npx astro build
echo "kit OK"
