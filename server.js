import express from 'express';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.BROWSER_KEY || 'axiom-browser-2026';
const CAPTCHA_KEY = process.env.CAPTCHA_API_KEY || ''; // 2Captcha/Anti-Captcha key
const COOKIE_DIR = '/tmp/axiom-cookies';

// Multi-tab support
let browser = null;
const pages = {};  // { tabId: page }
let nextTabId = 1;
let defaultTabId = null;

// Ensure cookie directory exists
try { fs.mkdirSync(COOKIE_DIR, { recursive: true }); } catch {}

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
      '--no-zygote',
    ],
  });
  // Create default tab
  const page = await createTab();
  defaultTabId = page.tabId;
  console.log('[BROWSER] Ready with default tab:', defaultTabId);
}

async function createTab() {
  if (!browser) await initBrowser();
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 900 });
  // Enable file downloads
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp/axiom-downloads' });
  const tabId = nextTabId++;
  pages[tabId] = page;
  page._tabId = tabId;
  console.log(`[BROWSER] Tab ${tabId} created`);
  return { page, tabId };
}

async function getPage(tabId) {
  if (!browser) await initBrowser();
  const tid = tabId || defaultTabId;
  if (pages[tid] && !pages[tid].isClosed()) return pages[tid];
  // Tab was closed, create new one
  const { page, tabId: newId } = await createTab();
  if (tid === defaultTabId) defaultTabId = newId;
  return page;
}

// ============================================================
// COOKIE PERSISTENCE
// ============================================================
async function saveCookies(page, domain) {
  try {
    const cookies = await page.cookies();
    const file = path.join(COOKIE_DIR, `${domain.replace(/[^a-z0-9]/gi, '_')}.json`);
    fs.writeFileSync(file, JSON.stringify(cookies, null, 2));
    console.log(`[COOKIES] Saved ${cookies.length} cookies for ${domain}`);
    return cookies.length;
  } catch (e) { console.error('[COOKIES] Save error:', e.message); return 0; }
}

async function loadCookies(page, domain) {
  try {
    const file = path.join(COOKIE_DIR, `${domain.replace(/[^a-z0-9]/gi, '_')}.json`);
    if (!fs.existsSync(file)) return 0;
    const cookies = JSON.parse(fs.readFileSync(file, 'utf-8'));
    await page.setCookie(...cookies);
    console.log(`[COOKIES] Loaded ${cookies.length} cookies for ${domain}`);
    return cookies.length;
  } catch (e) { console.error('[COOKIES] Load error:', e.message); return 0; }
}

// ============================================================
// CAPTCHA SOLVING (2Captcha compatible)
// ============================================================
async function solveCaptcha(page, type = 'recaptcha') {
  if (!CAPTCHA_KEY) return { solved: false, error: 'No CAPTCHA_API_KEY configured' };
  
  try {
    if (type === 'recaptcha') {
      // Find reCAPTCHA sitekey
      const sitekey = await page.evaluate(() => {
        const el = document.querySelector('.g-recaptcha, [data-sitekey]');
        return el?.getAttribute('data-sitekey') || null;
      });
      if (!sitekey) return { solved: false, error: 'No reCAPTCHA sitekey found' };

      const pageUrl = page.url();
      console.log(`[CAPTCHA] Solving reCAPTCHA for ${pageUrl} (sitekey: ${sitekey.slice(0, 10)}...)`);

      // Submit to 2Captcha
      const submitRes = await fetch(`https://2captcha.com/in.php?key=${CAPTCHA_KEY}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`);
      const submitData = await submitRes.json();
      if (submitData.status !== 1) return { solved: false, error: submitData.request };
      
      const captchaId = submitData.request;
      console.log(`[CAPTCHA] Submitted, ID: ${captchaId}. Polling...`);

      // Poll for solution (max 120 seconds)
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const pollRes = await fetch(`https://2captcha.com/res.php?key=${CAPTCHA_KEY}&action=get&id=${captchaId}&json=1`);
        const pollData = await pollRes.json();
        if (pollData.status === 1) {
          const token = pollData.request;
          // Inject token into page
          await page.evaluate((t) => {
            const textarea = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]');
            if (textarea) { textarea.value = t; textarea.style.display = 'block'; }
            // Also try callback
            if (window.___grecaptcha_cfg) {
              const clients = window.___grecaptcha_cfg.clients;
              for (const c of Object.values(clients || {})) {
                try { Object.values(c)[0][Object.keys(Object.values(c)[0])[0]].callback(t); } catch {}
              }
            }
          }, token);
          console.log(`[CAPTCHA] Solved!`);
          return { solved: true, captchaId };
        }
        if (pollData.request !== 'CAPCHA_NOT_READY') return { solved: false, error: pollData.request };
      }
      return { solved: false, error: 'Timeout' };

    } else if (type === 'hcaptcha') {
      const sitekey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey], .h-captcha');
        return el?.getAttribute('data-sitekey') || null;
      });
      if (!sitekey) return { solved: false, error: 'No hCaptcha sitekey found' };

      const submitRes = await fetch(`https://2captcha.com/in.php?key=${CAPTCHA_KEY}&method=hcaptcha&sitekey=${sitekey}&pageurl=${encodeURIComponent(page.url())}&json=1`);
      const submitData = await submitRes.json();
      if (submitData.status !== 1) return { solved: false, error: submitData.request };

      const captchaId = submitData.request;
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const pollRes = await fetch(`https://2captcha.com/res.php?key=${CAPTCHA_KEY}&action=get&id=${captchaId}&json=1`);
        const pollData = await pollRes.json();
        if (pollData.status === 1) {
          await page.evaluate((t) => {
            const textarea = document.querySelector('[name="h-captcha-response"], textarea[name="g-recaptcha-response"]');
            if (textarea) textarea.value = t;
          }, pollData.request);
          return { solved: true, captchaId };
        }
        if (pollData.request !== 'CAPCHA_NOT_READY') return { solved: false, error: pollData.request };
      }
      return { solved: false, error: 'Timeout' };
    }
    return { solved: false, error: `Unknown captcha type: ${type}` };
  } catch (e) { return { solved: false, error: e.message }; }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok', service: 'axiom-browser', browser_connected: !!browser,
    tabs: Object.keys(pages).length, default_tab: defaultTabId,
    captcha_configured: !!CAPTCHA_KEY, cookie_persistence: true,
    port: PORT,
  });
});

// --- TAB MANAGEMENT ---
app.post('/tab/new', async (req, res) => {
  try {
    const { page, tabId } = await createTab();
    res.json({ success: true, tabId });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/tab/close', async (req, res) => {
  const { tab_id } = req.body;
  if (pages[tab_id]) {
    await pages[tab_id].close().catch(() => {});
    delete pages[tab_id];
    res.json({ success: true });
  } else { res.json({ success: false, error: 'Tab not found' }); }
});

app.get('/tabs', (req, res) => {
  const tabs = Object.entries(pages).map(([id, page]) => ({
    id: parseInt(id), url: page.url(), closed: page.isClosed(),
  }));
  res.json({ tabs, count: tabs.length, default: defaultTabId });
});

// --- NAVIGATION ---
app.post('/navigate', async (req, res) => {
  const { url, wait_for, tab_id, load_cookies } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const page = await getPage(tab_id);
    // Load cookies for this domain before navigating
    if (load_cookies !== false) {
      try { const domain = new URL(url).hostname; await loadCookies(page, domain); } catch {}
    }
    await page.goto(url, { waitUntil: wait_for || 'networkidle2', timeout: 30000 });
    const title = await page.title();
    const currentUrl = page.url();
    // Auto-save cookies after navigation
    try { const domain = new URL(currentUrl).hostname; await saveCookies(page, domain); } catch {}
    console.log(`[BROWSER] Navigated: ${currentUrl} — "${title}"`);
    res.json({ success: true, url: currentUrl, title });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- TEXT & HTML EXTRACTION ---
app.post('/get-text', async (req, res) => {
  const { selector, max_length, tab_id } = req.body;
  try {
    const page = await getPage(tab_id);
    let text = selector
      ? await page.$eval(selector, el => el.innerText).catch(() => null)
      : await page.evaluate(() => document.body.innerText);
    res.json({ success: true, text: (text || '').slice(0, max_length || 8000), url: page.url() });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/get-html', async (req, res) => {
  const { selector, max_length, tab_id } = req.body;
  try {
    const page = await getPage(tab_id);
    let html = selector
      ? await page.$eval(selector, el => el.innerHTML).catch(() => null)
      : await page.content();
    res.json({ success: true, html: (html || '').slice(0, max_length || 15000), url: page.url() });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- INTERACTIONS ---
app.post('/click', async (req, res) => {
  const { selector, text, tab_id } = req.body;
  try {
    const page = await getPage(tab_id);
    if (text) {
      const clicked = await page.evaluate((t) => {
        const els = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"], [onclick], label, span')];
        const match = els.find(el => el.innerText?.trim().includes(t) || el.value?.includes(t) || el.getAttribute('aria-label')?.includes(t));
        if (match) { match.click(); return true; }
        return false;
      }, text);
      res.json({ success: clicked, method: 'text' });
    } else if (selector) {
      await page.click(selector);
      res.json({ success: true, method: 'selector' });
    } else { res.json({ success: false, error: 'selector or text required' }); }
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/type', async (req, res) => {
  const { selector, text, clear_first, tab_id } = req.body;
  if (!selector || text === undefined) return res.status(400).json({ error: 'selector and text required' });
  try {
    const page = await getPage(tab_id);
    if (clear_first) { await page.click(selector, { clickCount: 3 }); await page.keyboard.press('Backspace'); }
    await page.type(selector, text, { delay: 20 });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/fill', async (req, res) => {
  const { selector, value, tab_id } = req.body;
  if (!selector) return res.status(400).json({ error: 'selector required' });
  try {
    const page = await getPage(tab_id);
    await page.$eval(selector, (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/select', async (req, res) => {
  const { selector, value, tab_id } = req.body;
  if (!selector) return res.status(400).json({ error: 'selector required' });
  try {
    const page = await getPage(tab_id);
    await page.select(selector, value);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- SCREENSHOT (base64) ---
app.post('/screenshot', async (req, res) => {
  const { full_page, selector, tab_id, quality } = req.body;
  try {
    const page = await getPage(tab_id);
    let screenshot;
    if (selector) {
      const el = await page.$(selector);
      screenshot = el ? await el.screenshot({ encoding: 'base64' }) : null;
    } else {
      screenshot = await page.screenshot({ encoding: 'base64', fullPage: full_page || false, type: 'jpeg', quality: quality || 60 });
    }
    res.json({ success: !!screenshot, screenshot: screenshot ? `data:image/jpeg;base64,${screenshot}` : null, url: page.url() });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- EVALUATE JS ---
app.post('/evaluate', async (req, res) => {
  const { script, tab_id } = req.body;
  if (!script) return res.status(400).json({ error: 'script required' });
  try {
    const page = await getPage(tab_id);
    const result = await page.evaluate(script);
    res.json({ success: true, result: JSON.stringify(result)?.slice(0, 10000) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- WAIT ---
app.post('/wait', async (req, res) => {
  const { selector, timeout, tab_id } = req.body;
  try {
    const page = await getPage(tab_id);
    if (selector) await page.waitForSelector(selector, { timeout: timeout || 15000 });
    else await new Promise(r => setTimeout(r, timeout || 2000));
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- LINKS & FORMS ---
app.post('/get-links', async (req, res) => {
  const { tab_id, max } = req.body;
  try {
    const page = await getPage(tab_id);
    const links = await page.evaluate((m) =>
      [...document.querySelectorAll('a[href]')].slice(0, m || 100).map(a => ({
        text: a.innerText?.trim().slice(0, 100), href: a.href,
      })).filter(l => l.href && !l.href.startsWith('javascript:')),
    max);
    res.json({ success: true, links, count: links.length });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/get-forms', async (req, res) => {
  const { tab_id } = req.body;
  try {
    const page = await getPage(tab_id);
    const forms = await page.evaluate(() => {
      return [...document.querySelectorAll('input, select, textarea')].slice(0, 50).map(el => ({
        tag: el.tagName.toLowerCase(), type: el.type || null,
        name: el.name || null, id: el.id || null,
        placeholder: el.placeholder || null, required: el.required || false,
        value: el.value?.slice(0, 100) || null,
        selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : null,
        label: el.labels?.[0]?.innerText?.trim()?.slice(0, 50) || null,
      }));
    });
    res.json({ success: true, forms, count: forms.length });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- SCRAPE ---
app.post('/scrape', async (req, res) => {
  const { url, selectors, tab_id } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const page = await getPage(tab_id);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const data = {};
    if (selectors && typeof selectors === 'object') {
      for (const [key, sel] of Object.entries(selectors)) {
        data[key] = await page.$eval(sel, el => el.innerText?.trim()).catch(() => null);
      }
    }
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText?.slice(0, 5000));
    res.json({ success: true, title, url: page.url(), data, text });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- CAPTCHA SOLVING ---
app.post('/solve-captcha', async (req, res) => {
  const { type, tab_id } = req.body;
  try {
    const page = await getPage(tab_id);
    const result = await solveCaptcha(page, type || 'recaptcha');
    res.json(result);
  } catch (e) { res.json({ solved: false, error: e.message }); }
});

// --- COOKIE MANAGEMENT ---
app.post('/cookies/save', async (req, res) => {
  const { domain, tab_id } = req.body;
  try {
    const page = await getPage(tab_id);
    const d = domain || new URL(page.url()).hostname;
    const count = await saveCookies(page, d);
    res.json({ success: true, count, domain: d });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/cookies/load', async (req, res) => {
  const { domain, tab_id } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  try {
    const page = await getPage(tab_id);
    const count = await loadCookies(page, domain);
    res.json({ success: true, count, domain });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/cookies/clear', async (req, res) => {
  const { tab_id } = req.body;
  try {
    const page = await getPage(tab_id);
    const client = await page.createCDPSession();
    await client.send('Network.clearBrowserCookies');
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- FILE DOWNLOAD ---
app.post('/download', async (req, res) => {
  const { url, filename, tab_id } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const page = await getPage(tab_id);
    const downloadDir = '/tmp/axiom-downloads';
    fs.mkdirSync(downloadDir, { recursive: true });
    
    // Navigate to trigger download
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    
    // Wait for download to complete
    await new Promise(r => setTimeout(r, 3000));
    const files = fs.readdirSync(downloadDir);
    res.json({ success: true, files, download_dir: downloadDir });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- MULTI-STEP SEQUENCE (up to 20 steps) ---
app.post('/sequence', async (req, res) => {
  const { steps, tab_id } = req.body;
  if (!steps?.length) return res.status(400).json({ error: 'steps array required' });
  if (steps.length > 20) return res.status(400).json({ error: 'Max 20 steps per sequence' });
  
  const results = [];
  try {
    const page = await getPage(tab_id);
    for (const step of steps) {
      try {
        if (step.action === 'navigate') {
          // Load cookies before navigating
          try { const domain = new URL(step.url).hostname; await loadCookies(page, domain); } catch {}
          await page.goto(step.url, { waitUntil: 'networkidle2', timeout: 20000 });
          // Save cookies after
          try { const domain = new URL(page.url()).hostname; await saveCookies(page, domain); } catch {}
          results.push({ action: 'navigate', success: true, url: page.url() });
        } else if (step.action === 'click') {
          if (step.text) {
            await page.evaluate((t) => {
              const el = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],[onclick],label,span')].find(e => e.innerText?.trim().includes(t) || e.value?.includes(t) || e.getAttribute('aria-label')?.includes(t));
              if (el) el.click();
            }, step.text);
          } else { await page.click(step.selector); }
          results.push({ action: 'click', success: true });
        } else if (step.action === 'type') {
          if (step.clear) { await page.click(step.selector, { clickCount: 3 }); await page.keyboard.press('Backspace'); }
          await page.type(step.selector, step.text, { delay: 20 });
          results.push({ action: 'type', success: true });
        } else if (step.action === 'fill') {
          await page.$eval(step.selector, (el, v) => {
            el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
          }, step.value || step.text);
          results.push({ action: 'fill', success: true });
        } else if (step.action === 'select') {
          await page.select(step.selector, step.value);
          results.push({ action: 'select', success: true });
        } else if (step.action === 'wait') {
          if (step.selector) await page.waitForSelector(step.selector, { timeout: step.timeout || 10000 });
          else await new Promise(r => setTimeout(r, step.ms || 1000));
          results.push({ action: 'wait', success: true });
        } else if (step.action === 'extract') {
          const text = step.selector
            ? await page.$eval(step.selector, el => el.innerText).catch(() => '')
            : await page.evaluate(() => document.body.innerText?.slice(0, 5000));
          results.push({ action: 'extract', success: true, text: text?.slice(0, 5000) });
        } else if (step.action === 'screenshot') {
          const ss = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 50 });
          results.push({ action: 'screenshot', success: true, screenshot: `data:image/jpeg;base64,${ss}` });
        } else if (step.action === 'solve_captcha') {
          const captchaResult = await solveCaptcha(page, step.type || 'recaptcha');
          results.push({ action: 'solve_captcha', ...captchaResult });
        } else if (step.action === 'scroll') {
          await page.evaluate((dir) => {
            if (dir === 'down') window.scrollBy(0, 500);
            else if (dir === 'up') window.scrollBy(0, -500);
            else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
            else if (dir === 'top') window.scrollTo(0, 0);
          }, step.direction || 'down');
          results.push({ action: 'scroll', success: true });
        } else if (step.action === 'press') {
          await page.keyboard.press(step.key || 'Enter');
          results.push({ action: 'press', success: true });
        } else if (step.action === 'save_cookies') {
          const domain = new URL(page.url()).hostname;
          await saveCookies(page, domain);
          results.push({ action: 'save_cookies', success: true, domain });
        }
      } catch (e) { results.push({ action: step.action, success: false, error: e.message }); }
    }
    // Auto-save cookies at end of sequence
    try { const domain = new URL(page.url()).hostname; await saveCookies(page, domain); } catch {}
    res.json({ success: true, results, final_url: page.url() });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- KEYBOARD ---
app.post('/keyboard', async (req, res) => {
  const { key, text, tab_id } = req.body;
  try {
    const page = await getPage(tab_id);
    if (key) await page.keyboard.press(key);
    else if (text) await page.keyboard.type(text, { delay: 20 });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// --- SCROLL ---
app.post('/scroll', async (req, res) => {
  const { direction, amount, tab_id } = req.body;
  try {
    const page = await getPage(tab_id);
    const px = amount || 500;
    await page.evaluate((dir, px) => {
      if (dir === 'down') window.scrollBy(0, px);
      else if (dir === 'up') window.scrollBy(0, -px);
      else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
      else if (dir === 'top') window.scrollTo(0, 0);
    }, direction || 'down', px);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 4003;
try { fs.mkdirSync('/tmp/axiom-downloads', { recursive: true }); } catch {}
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AXIOM Browser v2.0 on 0.0.0.0:${PORT}`);
  initBrowser().then(() => {
    console.log('[BROWSER] ✅ Chrome launched — multi-tab, cookies, captcha, downloads ready');
  }).catch(e => {
    console.error('[BROWSER] ❌ Chrome launch failed:', e.message);
  });
});
