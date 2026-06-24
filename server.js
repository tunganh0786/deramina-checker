const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Check credit for a single Dreamina account using Playwright + API interception
 */
async function checkCredit(email, password, sendProgress) {
  let browser;
  try {
    sendProgress('Đang tạo phiên duyệt web...');

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
    });
    
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Asia/Ho_Chi_Minh',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    // Block unnecessary resources to speed up (only images and media to avoid breaking React)
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // ================================
    // Set up API response interceptor
    // ================================
    const capturedData = {
      userInfo: null,
      creditInfo: null,
      subscriptionInfo: null,
    };

    page.on('response', async (response) => {
      const url = response.url();
      try {
        const status = response.status();
        if (status !== 200) return;
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('json')) return;

        // Capture user info
        if (url.includes('/user/web/user_info') || url.includes('/user_info')) {
          const json = await response.json();
          if (json.ret === '0' && json.data?.user_info) {
            capturedData.userInfo = json.data.user_info;
          }
        }

        // Capture credit balance
        if (url.includes('/benefits/user_credit') && !url.includes('history')) {
          const json = await response.json();
          if (json.ret === '0') {
            const responseStr = typeof json.response === 'string' ? json.response : JSON.stringify(json.response);
            try {
              capturedData.creditInfo = JSON.parse(responseStr);
            } catch {
              capturedData.creditInfo = json.response || json.data;
            }
          }
        }

        // Capture subscription info
        if (url.includes('/subscription/user_info')) {
          const json = await response.json();
          if (json.ret === '0') {
            const responseStr = typeof json.response === 'string' ? json.response : JSON.stringify(json.response);
            try {
              const subData = JSON.parse(responseStr);
              // Only store subscription with actual plan info (flag=true means active subscription)
              if (subData.flag === true || (capturedData.subscriptionInfo === null)) {
                capturedData.subscriptionInfo = subData;
              }
            } catch {
              capturedData.subscriptionInfo = json.response || json.data;
            }
          }
        }
      } catch (e) {
        // Ignore parsing errors
      }
    });

    // ================================
    // STEP 1: Navigate to login page
    // ================================
    sendProgress('Đang truy cập Dreamina...');
    await page.goto('https://dreamina.capcut.com/ai-tool/home?need_login=true', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // ================================
    // STEP 2: Click "Continue with email"
    // ================================
    sendProgress('Đang tìm form đăng nhập...');
    try {
      const continueWithEmail = await page.waitForSelector('text=Continue with email', { timeout: 10000 });
      if (continueWithEmail) {
        await continueWithEmail.click({ force: true });
        await page.waitForTimeout(1000);
      }
    } catch (e) {
      // Might already be on email form, continue
    }

    // ================================
    // STEP 3: Fill login form
    // ================================
    sendProgress('Đang nhập thông tin đăng nhập...');

    // Find email input
    let emailInput = null;
    for (const sel of ['input[placeholder="Enter email"]', 'input[type="email"]', 'input[name="username"]']) {
      try {
        emailInput = await page.waitForSelector(sel, { timeout: 5000, state: 'visible' });
        if (emailInput) break;
      } catch (e) { /* try next */ }
    }
    if (!emailInput) throw new Error('Không tìm thấy ô nhập email');

    await emailInput.click({ force: true });
    await page.waitForTimeout(200);
    // Use type instead of fill to simulate real human typing (triggers React onChange properly)
    await emailInput.fill('');
    await emailInput.type(email, { delay: 15 });

    // Find password input
    let passwordInput = null;
    for (const sel of ['input[placeholder="Enter password"]', 'input[type="password"]', 'input[name="password"]']) {
      try {
        passwordInput = await page.waitForSelector(sel, { timeout: 5000, state: 'visible' });
        if (passwordInput) break;
      } catch (e) { /* try next */ }
    }
    if (!passwordInput) throw new Error('Không tìm thấy ô nhập mật khẩu');

    await passwordInput.click({ force: true });
    await page.waitForTimeout(200);
    // Use type to simulate human typing
    await passwordInput.fill('');
    await passwordInput.type(password, { delay: 15 });

    // ================================
    // STEP 4: Submit login
    // ================================
    sendProgress('Đang đăng nhập...');
    
    // Wait for React to validate password and enable the Continue button
    await page.waitForTimeout(500);
    
    // Press Enter to submit (most reliable)
    await passwordInput.press('Enter');
    await page.waitForTimeout(500);

    // Fallback: If still on login page, try clicking explicitly
    const stillOnLoginCheck = await page.$('input[placeholder="Enter email"]');
    if (stillOnLoginCheck) {
      for (const sel of ['button:has-text("Continue")', 'button:has-text("Log in")', 'button[type="submit"]']) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click();
            break;
          }
        } catch (e) { /* try next */ }
      }
    }

    // ================================
    // STEP 5: Wait for login and API responses
    // ================================
    sendProgress('Đang chờ xác thực...');

    // Wait for API responses to arrive (credit/user info is fetched automatically after login)
    let waitAttempts = 0;
    const maxWaitAttempts = 20; // 20 * 1s = 20s max wait
    while (waitAttempts < maxWaitAttempts) {
      await page.waitForTimeout(1000);
      waitAttempts++;

      // Check for login errors
      if (waitAttempts === 12) {
        const stillOnLogin = await page.$('input[placeholder="Enter email"]');
        if (stillOnLogin) {
          const isVisible = await stillOnLogin.isVisible();
          if (isVisible) {
            // Check for error text
            const bodyText = await page.evaluate(() => document.body.innerText);
            if (/incorrect|wrong|invalid|not\s*found/i.test(bodyText)) {
              throw new Error('Sai email hoặc mật khẩu');
            }
            throw new Error('Đăng nhập thất bại');
          }
        }
      }

      // Break early if we have credit data
      if (capturedData.creditInfo) {
        sendProgress('Đã nhận dữ liệu credit!');
        // Wait a bit more for subscription info
        await page.waitForTimeout(2000);
        break;
      }
    }

    // If no credit data captured via API, try fetching directly
    if (!capturedData.creditInfo) {
      sendProgress('Đang truy vấn API credit...');
      try {
        const creditResult = await page.evaluate(async () => {
          const resp = await fetch('https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          return await resp.json();
        });

        if (creditResult.ret === '0') {
          const responseStr = typeof creditResult.response === 'string' ? creditResult.response : JSON.stringify(creditResult.response);
          try {
            capturedData.creditInfo = JSON.parse(responseStr);
          } catch {
            capturedData.creditInfo = creditResult.response || creditResult.data;
          }
        }
      } catch (e) {
        // Ignore
      }
    }

    // If no subscription data, try fetching directly
    if (!capturedData.subscriptionInfo) {
      try {
        const subResult = await page.evaluate(async () => {
          const resp = await fetch('https://commerce-api-sg.capcut.com/commerce/v1/subscription/user_info', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          return await resp.json();
        });

        if (subResult.ret === '0') {
          const responseStr = typeof subResult.response === 'string' ? subResult.response : JSON.stringify(subResult.response);
          try {
            capturedData.subscriptionInfo = JSON.parse(responseStr);
          } catch {
            capturedData.subscriptionInfo = subResult.response || subResult.data;
          }
        }
      } catch (e) {
        // Ignore
      }
    }

    // Also try to get username from sidebar "credit-amount-text" element
    if (!capturedData.userInfo) {
      try {
        const userResult = await page.evaluate(async () => {
          const resp = await fetch('https://dreamina.capcut.com/lv/v1/user/web/user_info', {
            credentials: 'include',
          });
          return await resp.json();
        });

        if (userResult.ret === '0' && userResult.data?.user_info) {
          capturedData.userInfo = userResult.data.user_info;
        }
      } catch (e) {
        // Ignore
      }
    }

    // ================================
    // Parse results
    // ================================
    sendProgress('Đang phân tích kết quả...');

    let credits = 'N/A';
    let vipCredit = 0;
    let giftCredit = 0;
    let purchaseCredit = 0;
    let plan = 'Free';
    let expiry = 'N/A';
    let username = 'N/A';

    // Parse credit info
    if (capturedData.creditInfo) {
      const ci = capturedData.creditInfo;
      if (ci.credit) {
        vipCredit = ci.credit.vip_credit || 0;
        giftCredit = ci.credit.gift_credit || 0;
        purchaseCredit = ci.credit.purchase_credit || 0;
        credits = String(vipCredit + giftCredit + purchaseCredit);
      }

      // Get VIP level from credits_detail
      if (ci.credits_detail?.vip_credits?.length > 0) {
        const vipLevel = ci.credits_detail.vip_credits[0].vip_level;
        if (vipLevel) {
          plan = vipLevel.charAt(0).toUpperCase() + vipLevel.slice(1);
        }
      }
    }

    // Parse subscription info
    if (capturedData.subscriptionInfo) {
      const si = capturedData.subscriptionInfo;
      if (si.end_time && si.end_time > 0) {
        const endDate = new Date(si.end_time * 1000);
        expiry = endDate.toISOString().replace('T', ' ').substring(0, 16);
      }
      if (si.product_id) {
        // Parse plan from product_id like "dreamina.standard.monthly_new"
        const productParts = si.product_id.split('.');
        if (productParts.length >= 2) {
          const planName = productParts[1];
          plan = planName.charAt(0).toUpperCase() + planName.slice(1);
          if (productParts.length >= 3) {
            const cycle = productParts[2].replace('_new', '').replace('_', ' ');
            plan += ' ' + cycle.charAt(0).toUpperCase() + cycle.slice(1);
          }
        }
      }

      // Determine cycle from subscription data
      if (si.subscribe_cycle) {
        const cycleMap = { 1: 'Monthly', 3: 'Quarterly', 6: 'Semi-Annual', 12: 'Yearly' };
        const cycleName = cycleMap[si.subscribe_cycle] || si.cycle_unit;
        if (cycleName && !plan.toLowerCase().includes(cycleName.toLowerCase())) {
          plan += ' ' + cycleName;
        }
      }
    }

    // Parse user info
    if (capturedData.userInfo) {
      username = capturedData.userInfo.nick_name || capturedData.userInfo.user_id || 'N/A';
    }

    // If no credit data at all, try to get from sidebar
    if (credits === 'N/A') {
      try {
        const sidebarCredit = await page.$eval('.credit-amount-text-kJNIlf, [class*="credit-amount"]', el => el.textContent);
        if (sidebarCredit) {
          // Convert "1.2K" to "1200"
          const match = sidebarCredit.match(/([\d.]+)([KkMm])?/);
          if (match) {
            let num = parseFloat(match[1]);
            if (match[2] && (match[2] === 'K' || match[2] === 'k')) num *= 1000;
            if (match[2] && (match[2] === 'M' || match[2] === 'm')) num *= 1000000;
            credits = String(Math.round(num));
          }
        }
      } catch (e) {
        // Ignore
      }
    }

    return {
      success: true,
      data: {
        email,
        username,
        plan,
        credits,
        vipCredit: String(vipCredit),
        giftCredit: String(giftCredit),
        purchaseCredit: String(purchaseCredit),
        expiry,
      },
    };

  } catch (err) {
    return {
      success: false,
      error: err.message || 'Lỗi không xác định',
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
  }
}

// SSE endpoint for real-time progress updates
app.post('/api/check-credit', async (req, res) => {
  const { accounts, threads } = req.body;

  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: 'Vui lòng cung cấp danh sách tài khoản (email|password)' });
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent({ type: 'start', total: accounts.length });

  // Limit concurrency to 3 to prevent RAM crash on 512MB VPS
  const maxConcurrent = Math.min(parseInt(threads) || 2, 3);
  let currentIndex = 0;

  const worker = async (workerId) => {
    while (currentIndex < accounts.length) {
      const i = currentIndex++;
      const raw = accounts[i].trim();
      if (!raw) continue;

      // Stagger start to avoid triggering Capcut's DDoS firewall
      if (workerId > 0 && i < maxConcurrent) {
        await new Promise(r => setTimeout(r, workerId * 800));
      }

      const parts = raw.split('|');
      if (parts.length < 2) {
        sendEvent({
          type: 'result',
          index: i,
          account: raw,
          success: false,
          error: 'Sai định dạng. Dùng: email|password',
        });
        continue;
      }

      const email = parts[0].trim();
      const password = parts.slice(1).join('|').trim();

      const sendProgress = (status) => {
        sendEvent({ type: 'progress', index: i, email, status });
      };

      const result = await checkCredit(email, password, sendProgress);

      sendEvent({
        type: 'result',
        index: i,
        account: email,
        ...result,
      });
    }
  };

  const workers = [];
  for (let i = 0; i < maxConcurrent; i++) {
    workers.push(worker(i));
  }

  await Promise.all(workers);

  sendEvent({ type: 'done' });
  res.end();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Deramina Credit Checker đang chạy tại cổng ${PORT}`);
});
