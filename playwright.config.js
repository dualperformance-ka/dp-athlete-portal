import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { defineConfig } from '@playwright/test';

function executableFile(path) {
  try {
    return !!path && existsSync(path) && statSync(path).isFile() && !accessSync(path, constants.X_OK);
  } catch (error) {
    return false;
  }
}

function findPreinstalledChromium(root) {
  if (!root || !existsSync(root)) return undefined;
  if (executableFile(root)) return root;
  const directories = [root];
  const browserNames = new Set(['chrome', 'chromium', 'chrome-headless-shell']);
  while (directories.length) {
    const directory = directories.shift();
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) { continue; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (browserNames.has(basename(path)) && executableFile(path)) return path;
    }
  }
  return undefined;
}

const ciChromium = process.env.CI && (
  findPreinstalledChromium(process.env.PLAYWRIGHT_BROWSERS_PATH) ||
  findPreinstalledChromium('/opt/pw-browsers') ||
  ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(executableFile)
);
const macChromium = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.CI && ciChromium
  ? ciChromium
  : (!process.env.CI && existsSync(macChromium) ? macChromium : undefined);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    timezoneId: 'Australia/Adelaide',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'node tests/e2e/static-server.mjs',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
