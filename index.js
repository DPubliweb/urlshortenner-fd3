// index.js

const admin = require('firebase-admin');
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const readXlsxFile = require('read-excel-file/node');
const xl = require('excel4node');
const { customAlphabet } = require('nanoid');
const express = require('express');
const UAParser = require('ua-parser-js');

const app = express();

// ----------------------------- CONFIG -----------------------------
const port = process.env.PORT || 8002;
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const nanoid = customAlphabet(alphabet, 5);

// Dossier uploads automatique
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log('📂 uploads/ directory created');
}

// ----------------------------- FIREBASE -----------------------------
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : null,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: "googleapis.com",
};

if (!serviceAccount.private_key) {
  console.error('❌ FIREBASE_PRIVATE_KEY missing or malformed. Check your Qoddi env vars.');
} else {
  console.log('✅ Firebase private key detected.');
}

try {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log('🔥 Firebase initialized successfully.');
} catch (e) {
  console.error('🚨 Firebase initialization failed:', e.message);
}

const db = admin.firestore();

// ----------------------------- MIDDLEWARES -----------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ createParentPath: true, limits: { fileSize: 256 * 1024 * 1024 * 1024 } }));

// ----------------------------- DOMAINS -----------------------------
const shortUrlDomains = ['https://aide.bz'];

// ----------------------------- IP BLOCKING -----------------------------
const checkBlockedIP = async (req, res, next) => {
  let ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
  try {
    const blockedIPsSnapshot = await db.collection('blockedIps').where('ip', '==', ip).get();
    if (!blockedIPsSnapshot.empty) {
      const blocked = blockedIPsSnapshot.docs.some(doc => doc.data().blocked);
      if (blocked) {
        console.log(`🚫 Blocked IP tried access: ${ip}`);
        return res.status(403).send('Your IP has been blocked due to suspicious activity.');
      }
    }
    next();
  } catch (err) {
    console.error('Error checking IP blocklist:', err.message);
    next();
  }
};
app.use(checkBlockedIP);

// ----------------------------- REDIRECTION -----------------------------
app.get('/:id', async (req, res) => {
  let ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
  const { id } = req.params;

  try {
    const docRef = db.collection('urls').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      await db.collection('blockedIps').doc(ip).set({ blocked: true, ip: ip });
      console.log(`🚨 IP blocked for invalid short link: ${ip}`);
      return res.status(404).send('URL not found and your IP has been blocked.');
    }

    const urlData = doc.data();
    const parser = new UAParser(req.headers['user-agent']);
    const deviceType = parser.getDevice().type || 'desktop';

    const updates = { clicks: admin.firestore.FieldValue.increment(1) };
    if (deviceType === 'mobile') updates.mobileClicks = admin.firestore.FieldValue.increment(1);

    res.redirect(urlData.url);
    await docRef.update(updates);

  } catch (error) {
    console.error('Redirection error:', error.message);
    return res.status(500).send('Internal Server Error');
  }
});

// ----------------------------- UNBLOCK IP -----------------------------
app.post('/unblock-ip', async (req, res) => {
  const { ipToUnblock } = req.body;
  try {
    await db.collection('blockedIps').doc(ipToUnblock).delete();
    res.send(`✅ IP ${ipToUnblock} has been successfully unblocked.`);
  } catch (error) {
    console.error('Error unblocking IP:', error.message);
    res.status(500).send('Internal Server Error');
  }
});

// ----------------------------- UPLOAD FILE -----------------------------
app.post('/upload-file', async (req, res) => {
  const wb = new xl.Workbook();
  const ws = wb.addWorksheet('FileSheet');
  const getRandomDomain = () => shortUrlDomains[Math.floor(Math.random() * shortUrlDomains.length)];

  try {
    if (!req.files || !req.files.xlsxFile) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const xlsxFile = req.files.xlsxFile;
    const uploadPath = path.join(uploadDir, xlsxFile.name);
    await xlsxFile.mv(uploadPath);

    const rows = await readXlsxFile(uploadPath);
    if (rows.length === 0) return res.status(400).json({ error: 'Empty file' });

    const cols = ['nom', 'prenom', 'mail', 'phone', 'lien', 'civilite', 'code', 'code_postal', 'utm', 'ville'];
    rows.shift();

    const formattedRows = [];

    for (const row of rows) {
      const url = row[4];
      const campaignId = row[8];
      const phone = row[3];
      const newRow = [...row];

      if (url) {
        const id = nanoid();
        const selectedDomain = getRandomDomain();
        await db.collection('urls').doc(id).set({
          id,
          url,
          short: `${selectedDomain}/${id}`,
          phone,
          campaign: campaignId,
          clicks: 0,
          mobileClicks: 0,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        newRow[4] = `${selectedDomain}/${id}`;
      }

      const obj = cols.reduce((acc, col, i) => {
        acc[col] = newRow[i] || '';
        return acc;
      }, {});
      formattedRows.push(obj);
    }

    cols.forEach((h, i) => ws.cell(1, i + 1).string(h));
    formattedRows.forEach((rec, r) =>
      Object.values(rec).forEach((v, c) => ws.cell(r + 2, c + 1).string(v))
    );

    const parsedPath = path.join(uploadDir, `parsed_${xlsxFile.name}`);
    wb.write(parsedPath, (err) => {
      if (err) {
        console.error('❌ Excel write error:', err.message);
        return res.status(500).send(err);
      }
      console.log(`✅ Parsed file created: ${parsedPath}`);
      res.download(parsedPath, `parsed_${xlsxFile.name}`);
    });

  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

// ----------------------------- CAMPAIGN STATS -----------------------------
app.get('/campaign/:campaignId/stats', async (req, res) => {
  const { campaignId } = req.params;
  try {
    const snapshot = await db.collection('urls').where('campaign', '==', campaignId).get();

    let totalClicks = 0;
    let totalMobileClicks = 0;
    snapshot.forEach(doc => {
      const data = doc.data();
      totalClicks += data.clicks || 0;
      totalMobileClicks += data.mobileClicks || 0;
    });

    res.json({
      campaign: campaignId,
      totalUrls: snapshot.size,
      totalClicks,
      mobileClicks: totalMobileClicks,
    });
  } catch (err) {
    console.error('Error fetching campaign stats:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

// ----------------------------- START SERVER -----------------------------
app.get('/', (req, res) => res.send('✅ URL Shortener backend is running.'));
app.listen(port, () => console.log(`🚀 Server is live on port ${port}`));
