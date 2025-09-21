import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { fileTypeFromBuffer } from 'file-type';
import crypto from 'crypto';
import Tesseract from 'tesseract.js';
import * as pdfjsLib from 'pdfjs-dist/build/pdf.js';

const app = express();
app.use(express.json({ limit: '25mb' }));

// =================== HELPERS ===================
const log = (...args) => console.log(new Date().toISOString(), '-', ...args);

const BRL_LABEL = /(valor(?:\s+pago)?|total|pago|pagamento)\s*[:\-]?\s*R?\$?\s*([0-9.\s]+,[0-9]{2})/i;
const ANY_BRL = /R\$\s*([0-9.\s]+,[0-9]{2})/g;
const TXID_RE = /(txid|endtoendid|e2e(?:id)?)\s*[:\-]?\s*([A-Za-z0-9.\-]{10,})/i;

const toFloat = (s) => {
  if (!s) return null;
  let x = String(s).replace(/\s/g, '').replace('R$', '').replace(/\./g, '').replace(',', '.');
  const v = parseFloat(x);
  return isFinite(v) ? v : null;
};

const extractValues = (text) => {
  if (!text) return { value: null, confidence: 0, all: [] };
  const strong = BRL_LABEL.exec(text);
  if (strong) return { value: toFloat(strong[2]), confidence: 0.95, all: [toFloat(strong[2])] };

  let all = [];
  let m;
  while ((m = ANY_BRL.exec(text)) !== null) {
    const v = toFloat(m[1]);
    if (v) all.push(v);
  }
  if (all.length) return { value: Math.max(...all), confidence: 0.7, all };
  return { value: null, confidence: 0, all: [] };
};

const extractTxid = (text) => {
  if (!text) return null;
  const m = TXID_RE.exec(text);
  return m ? m[2] : null;
};

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const normalizePhone = (phone) => (phone || '').replace(/[^\d]/g, '');
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

const getUserDataHashes = ({ phone, email }) => {
  const ud = {};
  const ph = normalizePhone(phone);
  if (ph) ud.ph = [sha256(ph)];
  if (email) ud.em = [sha256(String(email).trim().toLowerCase())];
  return ud;
};

// =================== SESSION STORE ===================
const sessions = new Map();

function getSession(customerPlatformId) {
  const key = String(customerPlatformId);
  if (!sessions.has(key)) {
    sessions.set(key, {
      status: 'aberto',
      valor_total: 0,
      itens: [],
      txids: [],
      session_id: crypto.randomUUID(),
      updated_at: Date.now()
    });
  }
  return sessions.get(key);
}

// =================== FILE / OCR ===================
async function downloadBuffer(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return { buf: Buffer.from(resp.data), contentType: resp.headers['content-type'] || '' };
}

async function parsePDF(buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n';
  }
  const txid = extractTxid(text);
  const { value, confidence, all } = extractValues(text);
  return { kind: 'pdf', fileHash: sha1(buf), text, txid, value, confidence, all };
}

async function parseImage(buf) {
  const { data } = await Tesseract.recognize(buf, 'por+eng');
  const text = data.text || '';
  const txid = extractTxid(text);
  const { value, confidence, all } = extractValues(text);
  return { kind: 'image', fileHash: sha1(buf), text, txid, value, confidence, all };
}

async function parseAttachment(url) {
  const { buf, contentType } = await downloadBuffer(url);
  let kind = (await fileTypeFromBuffer(buf))?.mime || contentType || '';
  kind = kind.toLowerCase();

  if (kind.includes('pdf')) {
    return await parsePDF(buf);
  } else if (kind.startsWith('image/')) {
    return await parseImage(buf);
  } else {
    return await parseImage(buf);
  }
}

// =================== KINBOX BOT-HOOK ===================
async function sendBotHook({ customerPlatformId, text, pagamentoObj }) {
  const payload = {
    customerPlatformId,
    token: process.env.KINBOX_API_TOKEN,
    text,
    customFieldsList: [
      { value: JSON.stringify(pagamentoObj), placeholder: 'pagamento' }
    ]
  };
  log('-> bot-hook', { customerPlatformId, text });
  if (process.env.KINBOX_BOT_HOOK) {
    await axios.post(process.env.KINBOX_BOT_HOOK, payload, { timeout: 20000 });
  }
}

// =================== META CAPI ===================
async function sendPurchaseToMeta({ value, sessionId, phone, email }) {
  const url = `https://graph.facebook.com/v19.0/${process.env.FB_PIXEL_ID}/events?access_token=${process.env.FB_CAPI_TOKEN}`;
  const body = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'customer_chat',
      event_id: `kinbox-${sessionId}`,
      user_data: getUserDataHashes({ phone, email }),
      custom_data: { currency: 'BRL', value: Number(Number(value).toFixed(2)) }
    }]
  };
  if (process.env.FB_TEST_EVENT_CODE) body.test_event_code = process.env.FB_TEST_EVENT_CODE;
  const resp = await axios.post(url, body, { timeout: 20000 });
  log('-> Meta CAPI Purchase sent', resp.data);
  return resp.data;
}

// =================== ROUTES ===================

// 1) Receber comprovante
app.post('/kinbox/parse', async (req, res) => {
  try {
    const body = req.body || {};
    const customerPlatformId = body.customerPlatformId || body.customer_id || body.conversationId;
    const phone = body.phone || null;
    const email = body.email || null;
    const attachment_url = body.attachment_url || body.attachmentUrl || null;

    if (!customerPlatformId) throw new Error('customerPlatformId obrigatório');
    if (!attachment_url) throw new Error('attachment_url obrigatório');

    const sess = getSession(customerPlatformId);
    const parsed = await parseAttachment(attachment_url);

    let valorDoc = parsed.value;
    if (!valorDoc && parsed.all?.length) valorDoc = Math.max(...parsed.all);

    if (!valorDoc) {
      const text = '❌ Não consegui ler o valor no comprovante. Envie uma imagem nítida ou digite o valor.';
      await sendBotHook({ customerPlatformId, text, pagamentoObj: sess });
      return res.json({ ok: false, message: 'valor_nao_lido', data: sess });
    }

    sess.itens.push({ tipo: sess.itens.length ? 'upsell' : 'principal', valor: valorDoc, txid: parsed.txid || null });
    if (parsed.txid) sess.txids.push(parsed.txid);
    sess.valor_total = Number((sess.itens.reduce((a, b) => a + b.valor, 0)).toFixed(2));
    sess.status = 'aberto';
    sess.updated_at = Date.now();

    const text = `✅ Comprovante lido: R$ ${valorDoc.toFixed(2)}. Subtotal: R$ ${sess.valor_total.toFixed(2)}.`;
    await sendBotHook({ customerPlatformId, text, pagamentoObj: sess });

    return res.json({ ok: true, data: sess });
  } catch (err) {
    log('ERROR /kinbox/parse', err.message);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// 2) Finalizar compra
app.post('/kinbox/finalizar', async (req, res) => {
  try {
    const body = req.body || {};
    const customerPlatformId = body.customerPlatformId || body.customer_id || body.conversationId;
    const phone = body.phone || null;
    const email = body.email || null;

    if (!customerPlatformId) throw new Error('customerPlatformId obrigatório');

    const sess = getSession(customerPlatformId);
    sess.status = 'fechado';
    sess.updated_at = Date.now();

    const capi = await sendPurchaseToMeta({ value: sess.valor_total, sessionId: sess.session_id, phone, email });

    const text = `🎉 Compra finalizada! Total: R$ ${sess.valor_total.toFixed(2)}`;
    await sendBotHook({ customerPlatformId, text, pagamentoObj: sess });

    return res.json({ ok: true, data: sess, capi });
  } catch (err) {
    log('ERROR /kinbox/finalizar', err.message);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// 3) Teste de Pixel
app.get('/test-pixel', async (_req, res) => {
  try {
    const url = `https://graph.facebook.com/v19.0/${process.env.FB_PIXEL_ID}/events?access_token=${process.env.FB_CAPI_TOKEN}`;
    const body = {
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_id: 'teste-12345',
        custom_data: { currency: 'BRL', value: 10.00 }
      }],
      test_event_code: process.env.FB_TEST_EVENT_CODE
    };

    const resp = await axios.post(url, body, { timeout: 20000 });
    res.json(resp.data);
  } catch (err) {
    if (err.response) {
      res.status(400).json(err.response.data);
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// 4) Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true, now: Date.now() }));

// =================== START ===================
app.listen(process.env.PORT || 3000, () => {
  console.log('Server ON:', process.env.PORT || 3000);
});
