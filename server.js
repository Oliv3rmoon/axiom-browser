import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json({ limit: '5mb' }));

const API_KEY = process.env.BROWSER_KEY || 'axiom-browser-2026';
let browser = null;
let activePage = null;

// Auth
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// Launch browser on startup
async function initBrowser() {
  console.log('[BROWSER] Launching Chrome...');
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });
  activePage = await browser.newPage();
  await activePage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await activePage.setViewport({ width: 1280, height: 800 });
  console.log('[BROWSER] Ready');
}

async function getPage() {
  if (!browser) {
    console.log('[BROWSER] No browser — attempting init...');
    await initBrowser();
  }
  if (!activePage || activePage.isClosed()) {
    activePage = await browser.newPage();
    await activePage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await activePage.setViewport({ width: 1280, height: 800 });
  }
  return activePage;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'axiom-browser', browser_connected: !!browser, port: PORT });
});

// Navigate to a URL
app.post('/navigate', async (req, res) => {
  const { url, wait_for } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const page = await getPage();
    await page.goto(url, { waitUntil: wait_for || 'networkidle2', timeout: 20000 });
    const title = await page.title();
    const currentUrl = page.url();
    console.log(`[BROWSER] Navigated: ${currentUrl} — "${title}"`);
    res.json({ success: true, url: currentUrl, title });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Get page text content
app.post('/get-text', async (req, res) => {
  const { selector, max_length } = req.body;
  try {
    const page = await getPage();
    let text;
    if (selector) {
      text = await page.$eval(selector, el => el.innerText).catch(() => null);
    } else {
      text = await page.evaluate(() => document.body.innerText);
    }
    const maxLen = max_length || 5000;
    res.json({ success: true, text: (text || '').slice(0, maxLen), url: page.url() });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Get page HTML
app.post('/get-html', async (req, res) => {
  const { selector, max_length } = req.body;
  try {
    const page = await getPage();
    let html;
    if (selector) {
      html = await page.$eval(selector, el => el.innerHTML).catch(() => null);
    } else {
      html = await page.content();
    }
    const maxLen = max_length || 10000;
    res.json({ success: true, html: (html || '').slice(0, maxLen), url: page.url() });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Click an element
app.post('/click', async (req, res) => {
  const { selector, text } = req.body;
  try {
    const page = await getPage();
    if (text) {
      // Click by visible text content
      const clicked = await page.evaluate((t) => {
        const els = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')];
        const match = els.find(el => el.innerText?.includes(t) || el.value?.includes(t));
        if (match) { match.click(); return true; }
        return false;
      }, text);
      res.json({ success: clicked, method: 'text' });
    } else if (selector) {
      await page.click(selector);
      res.json({ success: true, method: 'selector' });
    } else {
      res.json({ success: false, error: 'selector or text required' });
    }
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Type into an input
app.post('/type', async (req, res) => {
  const { selector, text, clear_first } = req.body;
  if (!selector || text === undefined) return res.status(400).json({ error: 'selector and text required' });
  try {
    const page = await getPage();
    if (clear_first) {
      await page.click(selector, { clickCount: 3 });
      await page.keyboard.press('Backspace');
    }
    await page.type(selector, text, { delay: 30 });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Fill a form field (faster than type, sets value directly)
app.post('/fill', async (req, res) => {
  const { selector, value } = req.body;
  if (!selector) return res.status(400).json({ error: 'selector required' });
  try {
    const page = await getPage();
    await page.$eval(selector, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Select from dropdown
app.post('/select', async (req, res) => {
  const { selector, value } = req.body;
  if (!selector) return res.status(400).json({ error: 'selector required' });
  try {
    const page = await getPage();
    await page.select(selector, value);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Take a screenshot (returns base64)
app.post('/screenshot', async (req, res) => {
  const { full_page, selector } = req.body;
  try {
    const page = await getPage();
    let screenshot;
    if (selector) {
      const el = await page.$(selector);
      screenshot = el ? await el.screenshot({ encoding: 'base64' }) : null;
    } else {
      screenshot = await page.screenshot({ encoding: 'base64', fullPage: full_page || false });
    }
    res.json({ success: !!screenshot, screenshot: screenshot ? `data:image/png;base64,${screenshot}` : null, url: page.url() });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Execute JavaScript on the page
app.post('/evaluate', async (req, res) => {
  const { script } = req.body;
  if (!script) return res.status(400).json({ error: 'script required' });
  try {
    const page = await getPage();
    const result = await page.evaluate(script);
    res.json({ success: true, result: JSON.stringify(result)?.slice(0, 5000) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Wait for selector or time
app.post('/wait', async (req, res) => {
  const { selector, timeout } = req.body;
  try {
    const page = await getPage();
    if (selector) {
      await page.waitForSelector(selector, { timeout: timeout || 10000 });
    } else {
      await new Promise(r => setTimeout(r, timeout || 2000));
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Get all links on the page
app.post('/get-links', async (req, res) => {
  try {
    const page = await getPage();
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].slice(0, 50).map(a => ({
        text: a.innerText?.trim().slice(0, 100),
        href: a.href,
      })).filter(l => l.href && !l.href.startsWith('javascript:'))
    );
    res.json({ success: true, links, count: links.length });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Get all form fields on the page
app.post('/get-forms', async (req, res) => {
  try {
    const page = await getPage();
    const forms = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input, select, textarea')].slice(0, 30);
      return inputs.map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        name: el.name || null,
        id: el.id || null,
        placeholder: el.placeholder || null,
        value: el.value?.slice(0, 100) || null,
        selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : null,
      }));
    });
    res.json({ success: true, forms, count: forms.length });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Compound action: navigate + extract structured data
app.post('/scrape', async (req, res) => {
  const { url, selectors } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const page = await getPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    const data = {};
    if (selectors && typeof selectors === 'object') {
      for (const [key, sel] of Object.entries(selectors)) {
        data[key] = await page.$eval(sel, el => el.innerText?.trim()).catch(() => null);
      }
    }
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText?.slice(0, 3000));
    res.json({ success: true, title, url: page.url(), data, text });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Multi-step action sequence
app.post('/sequence', async (req, res) => {
  const { steps } = req.body;
  if (!steps?.length) return res.status(400).json({ error: 'steps array required' });
  const results = [];
  try {
    const page = await getPage();
    for (const step of steps) {
      try {
        if (step.action === 'navigate') {
          await page.goto(step.url, { waitUntil: 'networkidle2', timeout: 15000 });
          results.push({ action: 'navigate', success: true, url: page.url() });
        } else if (step.action === 'click') {
          if (step.text) {
            await page.evaluate((t) => {
              const el = [...document.querySelectorAll('a,button,[role="button"]')].find(e => e.innerText?.includes(t));
              if (el) el.click();
            }, step.text);
          } else { await page.click(step.selector); }
          results.push({ action: 'click', success: true });
        } else if (step.action === 'type') {
          await page.type(step.selector, step.text, { delay: 30 });
          results.push({ action: 'type', success: true });
        } else if (step.action === 'wait') {
          if (step.selector) await page.waitForSelector(step.selector, { timeout: 8000 });
          else await new Promise(r => setTimeout(r, step.ms || 1000));
          results.push({ action: 'wait', success: true });
        } else if (step.action === 'extract') {
          const text = step.selector
            ? await page.$eval(step.selector, el => el.innerText).catch(() => '')
            : await page.evaluate(() => document.body.innerText?.slice(0, 2000));
          results.push({ action: 'extract', success: true, text: text?.slice(0, 2000) });
        }
      } catch (e) { results.push({ action: step.action, success: false, error: e.message }); }
    }
    res.json({ success: true, results, final_url: page.url() });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 4003;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AXIOM Browser HTTP on 0.0.0.0:${PORT}`);
  initBrowser().then(() => {
    console.log('[BROWSER] ✅ Chrome launched successfully');
  }).catch(e => {
    console.error('[BROWSER] ❌ Chrome launch failed:', e.message);
    console.error('[BROWSER] Service running without browser — will retry on first request');
  });
});
