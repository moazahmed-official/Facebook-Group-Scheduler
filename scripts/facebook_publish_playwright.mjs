import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const FEED_URL = process.env.FACEBOOK_PAGE_URL || 'https://www.facebook.com/';

const DEBUG_ATTEMPT_DIR = process.env.FACEBOOK_DEBUG_ATTEMPT_DIR
  ? path.resolve(process.env.FACEBOOK_DEBUG_ATTEMPT_DIR)
  : null;

let activePage = null;

function parseArgs(argv) {
  const options = {
    file: null,
    image: null,
    storageState: null,
    headless: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--storage-state':
        options.storageState = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--image':
        options.image = path.resolve(process.cwd(), argv[++i]);
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--headed':
        options.headless = false;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        if (options.file) {
          throw new Error('Only one text file is allowed');
        }
        options.file = path.resolve(process.cwd(), arg);
    }
  }

  if (!options.file) {
    throw new Error('Usage: node scripts/facebook_publish_playwright.mjs [options] <txt-file>');
  }
  if (!options.storageState) {
    throw new Error('--storage-state is required');
  }

  return options;
}

async function saveDebugScreenshot(page, filename) {
  if (!DEBUG_ATTEMPT_DIR) return;
  try {
    await fs.mkdir(DEBUG_ATTEMPT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(DEBUG_ATTEMPT_DIR, filename),
      fullPage: true,
    });
  } catch (err) {
    console.error('Debug screenshot failed:', err.message);
  }
}

async function switchToPageProfile(page) {
  // When posting as a Page, switch into the Page profile if Facebook offers it
  const switchButton = page.locator('[role="button"]').filter({
    hasText: /^(Switch now|Switch|تبديل الآن)$/,
  }).first();
  if (await switchButton.count()) {
    await switchButton.click();
    await page.waitForTimeout(6000);
  }
}

async function openComposer(page) {
  const groupUrl = process.env.FACEBOOK_GROUP_URL;
  const pageUrl = process.env.FACEBOOK_PAGE_URL;

  if (pageUrl) {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await switchToPageProfile(page);
  }

  await page.goto(groupUrl || pageUrl || FEED_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Click composer trigger — "What's on your mind?" (EN) / "Что у вас нового" (RU) / "اكتب شيئًا" (AR group)
  const composerTrigger = page.locator('[role="button"]').filter({
    hasText: /What.s on your mind|Write something|Create post|Что у вас нового|بم تفكر|اكتب شيئًا|إنشاء منشور/,
  });
  await composerTrigger.first().click();

  // Wait for composer textbox to appear
  await page.waitForSelector('div[role="textbox"][contenteditable="true"]', { timeout: 15000 });
}

async function attachImage(page, imagePath) {
  const trigger = page.locator(
    '[role="button"][aria-label="صورة/فيديو"], [role="button"][aria-label="Photo/video"]',
  ).first();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    trigger.click(),
  ]);
  await chooser.setFiles(imagePath);
  await page.waitForTimeout(8000);
}

async function fillPost(page, text) {
  const editor = page.locator('div[role="dialog"] div[role="textbox"][contenteditable="true"]').first();
  await editor.click();
  await editor.fill(text);
  await page.waitForTimeout(500);
}

async function submitPost(page) {
  // Step 1: Click "Next" (EN) / "Далее" (RU)
  const nextButton = page.locator('div[role="dialog"] [role="button"]').filter({
    hasText: /^(Next|Далее|التالي)$/,
  }).first();
  if (await nextButton.count()) {
    await nextButton.click();
    await page.waitForTimeout(2000);
  }

  // Step 2: Click "Post" (EN) / "Опубликовать" (RU)
  const postButton = page.locator('div[role="dialog"] [role="button"][aria-label]').filter({
    hasText: /^(Post|Опубликовать|نشر)$/,
  }).first();
  await postButton.click();

  // Wait for dialog to close
  await page.waitForFunction(
    () => !document.querySelector('div[role="dialog"] div[role="textbox"]'),
    { timeout: 30000 },
  );
  await page.waitForTimeout(3000);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const text = (await fs.readFile(options.file, 'utf-8')).trim();

  if (!text) {
    throw new Error(`Text file is empty: ${options.file}`);
  }

  const browser = await chromium.launch({ channel: process.env.FACEBOOK_BROWSER_CHANNEL || undefined, headless: options.headless });
  const context = await browser.newContext({
    storageState: options.storageState,
    viewport: { width: 1440, height: 980 },
  });
  const page = await context.newPage();
  activePage = page;

  try {
    await openComposer(page);
    await fillPost(page, text);
    if (options.image) {
      await attachImage(page, options.image);
    }
    await saveDebugScreenshot(page, 'before-submit.png');
    if (process.env.FACEBOOK_STOP_BEFORE_SUBMIT === '1') {
      console.log(JSON.stringify({ file: options.file, status: 'stopped-before-submit' }, null, 2));
      return;
    }
    await submitPost(page);
    await saveDebugScreenshot(page, 'after-submit.png');
  } catch (error) {
    await saveDebugScreenshot(page, 'failure.png');
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }

  const result = { file: options.file, status: 'posted' };
  console.log(JSON.stringify(result, null, 2));
}

main().catch(async (error) => {
  if (activePage) {
    await saveDebugScreenshot(activePage, 'fatal.png').catch(() => {});
  }
  console.error(error);
  process.exit(1);
});
