import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '25mb' }));

// ================== HELPERS ==================
const log = (...args) => console.log(new Date().toISOString(), '-', ...args);

// Hash SHA256 para os dados do usuário (exigência Meta CAPI)
const sha256 = (x) => crypto.createHash('sha256').update(String(x).trim().toLowerCase()).digest('hex');

// Normaliza número de telefone
const normalizePhone = (phone) => (phone || '').replace(/[^\d]/g, '');

// Monta user_data (e-mail e telefone hasheados)
const getUserDataHashes = ({ phone, email }) => {
  const ud = {};
  const ph = normalizePhone(phone);
  if (ph) ud.ph = [sha256(ph)];
  if (email) ud.em = [sha256(email)];
  return ud;
};

// ================== META CAPI ==================
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

// ================== ROTAS ==================

// Health check
app.get('/', (_req, res) => res.send('✅ Servidor do Kinbox Pix Parser rodando!'));

// Rota de teste para o Pixel
app.get('/test-pixel', async (_req, res) => {
  try {
    const url = `https://graph.facebook.com/v19.0/${process.env.FB_PIXEL_ID}/events?access_token=${process.env.FB_CAPI_TOKEN}`;

    // Dados fake para teste
    const userEmail = "teste@exemplo.com";
    const userPhone = "558598887777";

    const body = {
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_id: 'teste-123',
        user_data: getUserDataHashes({ phone: userPhone, email: userEmail }),
        custom_data: {
          currency: 'BRL',
          value: 9.90
        }
      }],
      test_event_code: process.env.FB_TEST_EVENT_CODE || undefined
    };

    const resp = await axios.post(url, body, { timeout: 20000 });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    log('ERROR /test-pixel', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Endpoint Kinbox parse (exemplo simplificado)
app.post('/kinbox/parse', async (req, res) => {
  try {
    const body = req.body || {};
    log(">>> BODY RECEBIDO NO /kinbox/parse:", body);

    if (!body.customerPlatformId) throw new Error("customerPlatformId obrigatório");
    if (!body.attachment_url) throw new Error("attachment_url obrigatório");

    // Aqui você colocaria sua lógica de OCR ou PDF parsing
    // Por enquanto simulamos valor detectado
    const valorDetectado = 10.0;

    res.json({
      ok: true,
      message: 'ok',
      data: {
        customerPlatformId: body.customerPlatformId,
        valor: valorDetectado
      }
    });
  } catch (err) {
    log('ERROR /kinbox/parse', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Endpoint Kinbox finalizar
app.post('/kinbox/finalizar', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.customerPlatformId) throw new Error("customerPlatformId obrigatório");

    // Simula valor total
    const valorTotal = 10.0;

    const capi = await sendPurchaseToMeta({
      value: valorTotal,
      sessionId: body.customerPlatformId,
      phone: body.phone,
      email: body.email
    });

    res.json({ ok: true, message: "Compra finalizada", capi });
  } catch (err) {
    log('ERROR /kinbox/finalizar', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ================== SERVER ON ==================
app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Server ON:', process.env.PORT || 3000);
});
