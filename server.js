const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const PAGE_SIZE = 5;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

const CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cards.json'), 'utf8'));

function todayStrKST() {
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, '0');
  const d = String(kst.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS couple_draws (
      date TEXT PRIMARY KEY,
      card_index INTEGER NOT NULL,
      review TEXT,
      photo1 TEXT,
      photo2 TEXT,
      drawn_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE couple_draws ADD COLUMN IF NOT EXISTS photo1 TEXT;`);
  await pool.query(`ALTER TABLE couple_draws ADD COLUMN IF NOT EXISTS photo2 TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS couple_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      pool JSONB NOT NULL DEFAULT '[]'
    );
  `);
  await pool.query(`
    INSERT INTO couple_state (id, pool) VALUES (1, '[]')
    ON CONFLICT (id) DO NOTHING;
  `);

  // 사람별(슬빵/지빵) 후기를 독립적으로 저장하는 테이블
  await pool.query(`
    CREATE TABLE IF NOT EXISTS couple_reviews (
      date TEXT NOT NULL REFERENCES couple_draws(date) ON DELETE CASCADE,
      author TEXT NOT NULL,
      text TEXT,
      photo1 TEXT,
      photo2 TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (date, author)
    );
  `);

  // 예전 구조(couple_draws.review/photo1/photo2)에 남아있던 데이터를
  // 새 테이블로 1회성 이관 (작성자 미상 데이터는 'seul'로 편입, 이미 이관됐으면 건너뜀)
  await pool.query(`
    INSERT INTO couple_reviews (date, author, text, photo1, photo2)
    SELECT date, 'seul', review, photo1, photo2
    FROM couple_draws
    WHERE (review IS NOT NULL AND review <> '') OR photo1 IS NOT NULL OR photo2 IS NOT NULL
    ON CONFLICT (date, author) DO NOTHING;
  `);
}

async function getPool() {
  const r = await pool.query('SELECT pool FROM couple_state WHERE id = 1');
  return r.rows[0] ? r.rows[0].pool : [];
}
async function savePool(poolArr) {
  await pool.query('UPDATE couple_state SET pool = $1 WHERE id = 1', [JSON.stringify(poolArr)]);
}

async function pickNextIndex() {
  let usedPool = await getPool();
  let available = CARDS.map((_, i) => i).filter(i => !usedPool.includes(i));
  if (available.length === 0) {
    usedPool = [];
    available = CARDS.map((_, i) => i);
  }
  const chosen = available[Math.floor(Math.random() * available.length)];
  usedPool.push(chosen);
  await savePool(usedPool);
  return chosen;
}

app.use(express.json({ limit: '8mb' }));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 오늘 상태 조회
app.get('/api/status', async (req, res) => {
  try {
    const today = todayStrKST();
    const drawRes = await pool.query('SELECT card_index FROM couple_draws WHERE date = $1', [today]);
    if (drawRes.rowCount === 0) {
      return res.json({ date: today, drawn: false });
    }
    const reviewRes = await pool.query(
      'SELECT author, text, photo1, photo2 FROM couple_reviews WHERE date = $1',
      [today]
    );
    const reviews = {};
    for (const r of reviewRes.rows) {
      reviews[r.author] = { text: r.text || '', photos: [r.photo1, r.photo2].filter(Boolean) };
    }
    res.json({
      date: today,
      drawn: true,
      text: CARDS[drawRes.rows[0].card_index].text,
      reviews
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'status_failed' });
  }
});

// 오늘 카드 뽑기 (이미 뽑았으면 그 카드를 그대로 반환, 재추첨 안 함)
app.post('/api/draw', async (req, res) => {
  try {
    const today = todayStrKST();
    const existing = await pool.query('SELECT card_index FROM couple_draws WHERE date = $1', [today]);
    if (existing.rowCount > 0) {
      return res.json({ date: today, text: CARDS[existing.rows[0].card_index].text });
    }
    const idx = await pickNextIndex();
    await pool.query(
      'INSERT INTO couple_draws (date, card_index) VALUES ($1, $2) ON CONFLICT (date) DO NOTHING',
      [today, idx]
    );
    res.json({ date: today, text: CARDS[idx].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'draw_failed' });
  }
});

// 카드 후기 저장 (작성자별로 독립 저장, 한쪽 저장이 다른쪽을 안 건드림)
app.post('/api/review', async (req, res) => {
  try {
    const today = todayStrKST();
    // 과거 카드 수정용(임시 기능): body.date가 유효한 YYYY-MM-DD면 그 날짜를, 없으면 오늘 날짜를 대상으로 함
    const bodyDate = req.body && req.body.date;
    const targetDate = (typeof bodyDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bodyDate)) ? bodyDate : today;

    const author = (req.body && req.body.author === 'seul') || (req.body && req.body.author === 'ji')
      ? req.body.author
      : null;
    if (!author) {
      return res.status(400).json({ error: 'invalid_author' });
    }

    const text = (req.body && typeof req.body.text === 'string') ? req.body.text.slice(0, 200) : '';
    const photosInput = Array.isArray(req.body && req.body.photos) ? req.body.photos.slice(0, 2) : [];

    // 사진은 data URL(base64) 형태만 허용, 개당 3MB 넘으면 거절
    for (const p of photosInput) {
      if (typeof p !== 'string' || !p.startsWith('data:image/')) {
        return res.status(400).json({ error: 'invalid_photo' });
      }
      if (p.length > 3 * 1024 * 1024) {
        return res.status(400).json({ error: 'photo_too_large' });
      }
    }

    const photo1 = photosInput[0] || null;
    const photo2 = photosInput[1] || null;

    // 해당 날짜에 카드가 뽑혀있어야 후기를 남길 수 있음
    const drawCheck = await pool.query('SELECT 1 FROM couple_draws WHERE date = $1', [targetDate]);
    if (drawCheck.rowCount === 0) {
      return res.status(400).json({ error: 'not_drawn_yet' });
    }

    if (!text && photosInput.length === 0) {
      // 내용이 비었으면 그 사람의 항목 자체를 삭제
      await pool.query('DELETE FROM couple_reviews WHERE date = $1 AND author = $2', [targetDate, author]);
      return res.json({ ok: true });
    }

    await pool.query(
      `INSERT INTO couple_reviews (date, author, text, photo1, photo2)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (date, author)
       DO UPDATE SET text = $3, photo1 = $4, photo2 = $5, updated_at = now()`,
      [targetDate, author, text, photo1, photo2]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'review_failed' });
  }
});

// 지난 카드 (오늘 제외, 페이지네이션)
app.get('/api/history', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const countRes = await pool.query('SELECT COUNT(*) FROM couple_draws');
    const total = parseInt(countRes.rows[0].count, 10);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const rowsRes = await pool.query(
      'SELECT date, card_index FROM couple_draws ORDER BY date DESC LIMIT $1 OFFSET $2',
      [PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );
    const dates = rowsRes.rows.map(r => r.date);

    let reviewsByDate = {};
    if (dates.length > 0) {
      const reviewRes = await pool.query(
        'SELECT date, author, text, photo1, photo2 FROM couple_reviews WHERE date = ANY($1::text[])',
        [dates]
      );
      for (const r of reviewRes.rows) {
        if (!reviewsByDate[r.date]) reviewsByDate[r.date] = {};
        reviewsByDate[r.date][r.author] = { text: r.text || '', photos: [r.photo1, r.photo2].filter(Boolean) };
      }
    }

    const items = rowsRes.rows.map(r => ({
      date: r.date,
      text: CARDS[r.card_index].text,
      reviews: reviewsByDate[r.date] || {}
    }));

    res.json({ page, totalPages, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'history_failed' });
  }
});

// 가장 최근 후기 업데이트 시각 (새 소식 배지용)
app.get('/api/last-update', async (req, res) => {
  try {
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    let rows;
    if (since) {
      const r = await pool.query(
        'SELECT author, MAX(updated_at) AS latest FROM couple_reviews WHERE updated_at > $1::timestamptz GROUP BY author ORDER BY latest DESC',
        [since]
      );
      rows = r.rows;
    } else {
      const r = await pool.query(
        'SELECT author, MAX(updated_at) AS latest FROM couple_reviews GROUP BY author ORDER BY latest DESC'
      );
      rows = r.rows;
    }
    res.json({ updates: rows.map(r => ({ author: r.author, latest: r.latest })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'last_update_failed' });
  }
});

app.get('/health', (req, res) => res.send('ok'));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`couple-card server listening on ${PORT}`));
  })
  .catch(err => {
    console.error('DB 초기화 실패', err);
    process.exit(1);
  });
