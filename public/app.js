// ============================
// Deramina Credit Checker - Frontend Logic
// ============================

const DOM = {
  accountInput: document.getElementById('accountInput'),
  lineCount: document.getElementById('lineCount'),
  btnPaste: document.getElementById('btnPaste'),
  btnClear: document.getElementById('btnClear'),
  btnCheck: document.getElementById('btnCheck'),
  btnExportLive: document.getElementById('btnExportLive'),
  btnExportAll: document.getElementById('btnExportAll'),
  headerStats: document.getElementById('headerStats'),
  statSuccess: document.getElementById('statSuccess'),
  statFail: document.getElementById('statFail'),
  statTotal: document.getElementById('statTotal'),
  progressSection: document.getElementById('progressSection'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  resultsSection: document.getElementById('resultsSection'),
  resultsGrid: document.getElementById('resultsGrid'),
  threadCount: document.getElementById('threadCount'),
};

let results = [];
let isChecking = false;

// ============================
// Textarea line counter
// ============================
function updateLineCount() {
  const lines = DOM.accountInput.value
    .split('\n')
    .filter(l => l.trim().length > 0);
  DOM.lineCount.textContent = `${lines.length} tài khoản`;
}

DOM.accountInput.addEventListener('input', updateLineCount);

// ============================
// Paste & Clear buttons
// ============================
DOM.btnPaste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    DOM.accountInput.value = text;
    updateLineCount();
    showToast('Đã paste từ clipboard', 'success');
  } catch (err) {
    showToast('Không thể paste. Hãy dùng Ctrl+V', 'error');
  }
});

DOM.btnClear.addEventListener('click', () => {
  DOM.accountInput.value = '';
  updateLineCount();
});

// ============================
// Check button handler
// ============================
DOM.btnCheck.addEventListener('click', startCheck);

async function startCheck() {
  if (isChecking) return;

  const rawInput = DOM.accountInput.value.trim();
  if (!rawInput) {
    showToast('Vui lòng nhập tài khoản', 'error');
    return;
  }

  const accounts = rawInput
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (accounts.length === 0) {
    showToast('Không có tài khoản hợp lệ', 'error');
    return;
  }

  // Reset state
  isChecking = true;
  results = [];
  DOM.resultsGrid.innerHTML = '';

  // UI updates
  setCheckingUI(true);
  DOM.headerStats.style.display = 'flex';
  DOM.progressSection.style.display = 'block';
  DOM.resultsSection.style.display = 'block';
  updateStats(0, 0, accounts.length);
  updateProgress(0, accounts.length, 'Bắt đầu kiểm tra...');

  // Create placeholder cards
  accounts.forEach((acc, i) => {
    const email = acc.split('|')[0] || acc;
    createResultCard(i, email);
  });

  try {
    const response = await fetch('/api/check-credit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        accounts, 
        threads: parseInt(DOM.threadCount.value) || 3 
      }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let successCount = 0;
    let failCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));

        switch (data.type) {
          case 'progress':
            updateProgress(
              data.index,
              accounts.length,
              `[${data.index + 1}/${accounts.length}] ${data.email}: ${data.status}`
            );
            updateCardStatus(data.index, 'checking', data.status);
            break;

          case 'result':
            if (data.success) {
              successCount++;
              updateCardSuccess(data.index, data.data);
              results.push({ success: true, ...data.data });
            } else {
              failCount++;
              updateCardFail(data.index, data.account, data.error);
              results.push({ success: false, email: data.account, error: data.error });
            }
            updateStats(successCount, failCount, accounts.length);
            updateProgress(
              data.index + 1,
              accounts.length,
              data.index + 1 >= accounts.length
                ? 'Hoàn tất!'
                : `Đã xong ${data.index + 1}/${accounts.length}`
            );
            break;

          case 'done':
            updateProgress(accounts.length, accounts.length, `✅ Hoàn tất! ${successCount} Live | ${failCount} Die`);
            break;
        }
      }
    }
  } catch (err) {
    showToast('Lỗi kết nối server: ' + err.message, 'error');
  } finally {
    isChecking = false;
    setCheckingUI(false);
  }
}

// ============================
// UI Helpers
// ============================
function setCheckingUI(checking) {
  DOM.btnCheck.disabled = checking;
  DOM.btnCheck.querySelector('.btn-check-text').style.display = checking ? 'none' : 'flex';
  DOM.btnCheck.querySelector('.btn-check-loading').style.display = checking ? 'flex' : 'none';
}

function updateStats(success, fail, total) {
  DOM.statSuccess.textContent = success;
  DOM.statFail.textContent = fail;
  DOM.statTotal.textContent = total;
}

function updateProgress(current, total, text) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  DOM.progressBar.style.width = pct + '%';
  DOM.progressText.textContent = text;
}

function createResultCard(index, email) {
  const card = document.createElement('div');
  card.className = 'result-card checking';
  card.id = `result-${index}`;
  card.style.animationDelay = `${index * 0.05}s`;

  card.innerHTML = `
    <div class="result-status checking">
      <div class="status-spinner"></div>
    </div>
    <div class="result-info">
      <div class="result-email">${escapeHtml(email)}</div>
      <div class="result-detail">Đang chờ...</div>
    </div>
    <div class="result-credits"></div>
  `;

  DOM.resultsGrid.appendChild(card);
}

function updateCardStatus(index, status, detail) {
  const card = document.getElementById(`result-${index}`);
  if (!card) return;

  const detailEl = card.querySelector('.result-detail');
  if (detailEl) detailEl.textContent = detail;
}

function updateCardSuccess(index, data) {
  const card = document.getElementById(`result-${index}`);
  if (!card) return;

  card.className = 'result-card success';

  // Status icon
  const statusEl = card.querySelector('.result-status');
  statusEl.className = 'result-status success';
  statusEl.innerHTML = `
    <svg class="status-icon-svg" viewBox="0 0 18 18" fill="none">
      <path d="M4 9l3.5 3.5L14 5" stroke="#00D4AA" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;

  // Info
  const infoEl = card.querySelector('.result-info');
  const planClass = getPlanClass(data.plan);
  infoEl.innerHTML = `
    <div class="result-email">${escapeHtml(data.email)}</div>
    <div class="result-detail">
      ${data.username !== 'N/A' ? data.username : ''}
      ${data.plan !== 'N/A' ? `<span class="plan-tag ${planClass}">${escapeHtml(data.plan)}</span>` : ''}
    </div>
  `;

  // Credits
  const creditsEl = card.querySelector('.result-credits');
  const hasBreakdown = data.vipCredit || data.giftCredit || data.purchaseCredit;
  creditsEl.innerHTML = `
    <div class="credit-badge">
      <div class="credit-value">${data.credits !== 'N/A' ? formatNumber(data.credits) : '—'}</div>
      <div class="credit-label">credits</div>
      ${hasBreakdown ? `<div class="result-expiry">VIP: ${formatNumber(data.vipCredit || 0)} | Gift: ${formatNumber(data.giftCredit || 0)} | Buy: ${formatNumber(data.purchaseCredit || 0)}</div>` : ''}
      ${data.expiry !== 'N/A' ? `<div class="result-expiry">Hết hạn: ${data.expiry}</div>` : ''}
    </div>
  `;
}

function updateCardFail(index, email, error) {
  const card = document.getElementById(`result-${index}`);
  if (!card) return;

  card.className = 'result-card fail';

  // Status icon
  const statusEl = card.querySelector('.result-status');
  statusEl.className = 'result-status fail';
  statusEl.innerHTML = `
    <svg class="status-icon-svg" viewBox="0 0 18 18" fill="none">
      <path d="M5 5l8 8M13 5l-8 8" stroke="#FF4757" stroke-width="2.5" stroke-linecap="round"/>
    </svg>
  `;

  // Info
  const infoEl = card.querySelector('.result-info');
  infoEl.innerHTML = `
    <div class="result-email">${escapeHtml(email)}</div>
    <div class="result-detail error">${escapeHtml(error)}</div>
  `;

  // Clear credits
  const creditsEl = card.querySelector('.result-credits');
  creditsEl.innerHTML = '';
}

// ============================
// Export functionality
// ============================
DOM.btnExportLive.addEventListener('click', () => {
  const liveResults = results.filter(r => r.success);
  if (liveResults.length === 0) {
    showToast('Không có tài khoản live để export', 'error');
    return;
  }

  const text = liveResults
    .map(r => `${r.email} | ${r.plan} | ${r.credits} credits | Hết hạn: ${r.expiry}`)
    .join('\n');

  downloadFile('dreamina_live.txt', text);
  showToast(`Đã export ${liveResults.length} tài khoản live`, 'success');
});

DOM.btnExportAll.addEventListener('click', () => {
  if (results.length === 0) {
    showToast('Chưa có kết quả để export', 'error');
    return;
  }

  const text = results
    .map(r => {
      if (r.success) {
        return `[LIVE] ${r.email} | ${r.plan} | ${r.credits} credits | Hết hạn: ${r.expiry}`;
      } else {
        return `[DIE] ${r.email} | ${r.error}`;
      }
    })
    .join('\n');

  downloadFile('dreamina_all.txt', text);
  showToast(`Đã export ${results.length} kết quả`, 'success');
});

// ============================
// Utility functions
// ============================
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatNumber(num) {
  return Number(num).toLocaleString('vi-VN');
}

function getPlanClass(plan) {
  if (!plan) return 'free';
  const lower = plan.toLowerCase();
  if (lower.includes('advanced')) return 'advanced';
  if (lower.includes('standard')) return 'standard';
  if (lower.includes('basic')) return 'basic';
  if (lower.includes('pro')) return 'pro';
  return 'free';
}

function downloadFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}
