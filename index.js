const puppeteer = require('puppeteer');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function refreshToken() {
  console.log('[token-refresher] 시작:', new Date().toISOString());

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();

    // 1. 카페24 로그인 페이지 접속
    console.log('[1] 로그인 페이지 접속...');
    await page.goto('https://eclogin.cafe24.com/Shop/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // 2. 아이디/비밀번호 입력
    console.log('[2] 로그인 정보 입력...');
    await page.type('#mall_id', process.env.CAFE24_LOGIN_ID);
    await page.type('#userpasswd', process.env.CAFE24_LOGIN_PW);

    // 3. 로그인 버튼 클릭 + 리다이렉트 대기
    console.log('[3] 로그인 중...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('.btnStrong')
    ]);

    console.log('[3] 현재 URL:', page.url());

    // 4. 어드민 페이지 접속 대기
    await page.waitForTimeout(2000);

    // 5. ca-token API 호출
    console.log('[4] Analytics 토큰 발급 중...');
    const response = await page.evaluate(async () => {
      const res = await fetch('https://ca-internal.cafe24data.com/auth/ca-token', {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Origin': 'https://ca-web.cafe24data.com',
          'Content-Type': 'application/json'
        }
      });
      return res.json();
    });

    console.log('[4] 응답:', JSON.stringify(response));

    if (!response.token) {
      throw new Error('토큰 발급 실패: ' + JSON.stringify(response));
    }

    // 6. Postgres 저장
    console.log('[5] Postgres 저장 중...');
    await pool.query(
      `INSERT INTO analytics_tokens (key, value, updated_at)
       VALUES ('CAFE24_ANALYTICS_TOKEN', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [response.token]
    );
    console.log('[5] 저장 완료!');

    // 7. Slack 알림 (매일 8시에만)
    const hour = new Date().getUTCHours();
    if (hour === 23) { // UTC 23 = KST 8시
      await sendSlackNotification('✅ Analytics 토큰 자동갱신 완료! (매일 오전 8시)');
    }

    console.log('[token-refresher] 완료!');

  } catch (err) {
    console.error('[token-refresher] 오류:', err.message);
    await sendSlackNotification(`❌ Analytics 토큰 갱신 실패!\n오류: ${err.message}`);
    throw err;
  } finally {
    await browser.close();
    await pool.end();
  }
}

async function sendSlackNotification(message) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  try {
    const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message })
    });
    console.log('[Slack] 알림 발송:', res.status);
  } catch (err) {
    console.error('[Slack] 알림 실패:', err.message);
  }
}

refreshToken()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
