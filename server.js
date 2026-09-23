const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para JSON com preservação do raw body para webhook
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(express.static(path.join(__dirname)));

// Configurações ZumboPay
const ZUMBOPAY_BASE_URL = process.env.ZUMBOPAY_BASE_URL || 'https://zumbopay.com/api/public/v1';
const ZUMBOPAY_API_KEY = process.env.ZUMBOPAY_API_KEY || 'zk_live_371ffd52d6';
const ZUMBOPAY_MERCHANT_ID = process.env.ZUMBOPAY_MERCHANT_ID || 'MCH_6000FA2DF2';
const ZUMBOPAY_WALLET_ID = process.env.ZUMBOPAY_WALLET_ID || '312584';
const ZUMBOPAY_WEBHOOK_SECRET = process.env.ZUMBOPAY_WEBHOOK_SECRET || 'whsec_635600b6360f6272e0dbc273fe276b6911164a6d10b01275';

// Banco em memória / storage para tracking de pedidos e idempotência
const ordersDb = new Map();
const processedEvents = new Set();

/**
 * Normaliza número de telefone moçambicano para o formato 258XXXXXXXXX
 */
function normalizeMsisdn(phone) {
  let cleaned = (phone || '').replace(/\D/g, '');
  if (cleaned.startsWith('258') && cleaned.length === 12) {
    return cleaned;
  }
  if (cleaned.length === 9) {
    return '258' + cleaned;
  }
  return cleaned;
}

/**
 * POST /api/pagamento
 * Cria a cobrança C2B direta via M-Pesa na ZumboPay
 */
app.post('/api/pagamento', async (req, res) => {
  try {
    const { amount, msisdn, ref, customer_name, order_details } = req.body;

    if (!amount || !msisdn || !ref) {
      return res.status(400).json({
        success: false,
        message: 'Dados incompletos fornecidos para o pagamento.'
      });
    }

    const formattedMsisdn = normalizeMsisdn(msisdn);
    console.log(`[ZUMBOPAY] Iniciando cobrança M-Pesa: Ref: ${ref} | Valor: ${amount} MT | Tel: ${formattedMsisdn}`);

    // Salva o pedido inicial no banco interno
    const orderData = {
      id: ref,
      date: new Date().toISOString(),
      amount: Number(amount),
      msisdn: formattedMsisdn,
      customer_name: customer_name || 'Cliente',
      details: order_details || {},
      status_pagamento: 'Pagamento pendente',
      status_pedido: 'Em processamento',
      created_at: new Date()
    };
    ordersDb.set(ref, orderData);

    // Chamada oficial à ZumboPay /charges
    const payload = {
      wallet_id: ZUMBOPAY_WALLET_ID,
      amount: Number(amount),
      msisdn: formattedMsisdn,
      customer_name: customer_name || 'Cliente Canetas Premium',
      source_id: ref
    };

    const response = await fetch(`${ZUMBOPAY_BASE_URL}/charges`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ZUMBOPAY_API_KEY}`,
        'X-Merchant-Id': ZUMBOPAY_MERCHANT_ID,
        'Content-Type': 'application/json',
        'Idempotency-Key': ref
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log(`[ZUMBOPAY] Resposta (${response.status}):`, data);

    if (response.status === 200) {
      // Sucesso síncrono
      orderData.status_pagamento = 'Pagamento confirmado';
      orderData.zumbo_reference = data.data?.reference;
      ordersDb.set(ref, orderData);

      return res.json({
        success: true,
        status: 'success',
        message: 'Pagamento confirmado com sucesso.',
        reference: data.data?.reference,
        order: orderData
      });
    }

    if (response.status === 202) {
      // Pendente — cliente deve aceitar no telemóvel (PIN prompt)
      orderData.status_pagamento = 'Pagamento pendente';
      orderData.zumbo_reference = data.data?.reference;
      ordersDb.set(ref, orderData);

      return res.json({
        success: true,
        status: 'pending',
        message: 'Prompt USSD enviado para o telemóvel do cliente. A aguardar inserção do PIN M-Pesa.',
        reference: data.data?.reference,
        order: orderData
      });
    }

    // Erro / Recusado
    const errorMessage = data.error?.message || data.message || 'Pagamento recusado ou não autorizado pelo M-Pesa.';
    orderData.status_pagamento = 'Cancelado';
    ordersDb.set(ref, orderData);

    return res.status(400).json({
      success: false,
      status: 'failed',
      message: errorMessage,
      error: data.error
    });

  } catch (error) {
    console.error('[ERRO PAGAMENTO]:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro interno ao comunicar com o gateway de pagamento.'
    });
  }
});

/**
 * GET /api/pedidos/:id/status
 * Consulta o status real do pedido
 */
app.get('/api/pedidos/:id/status', (req, res) => {
  const orderId = req.params.id;
  const order = ordersDb.get(orderId);

  if (!order) {
    return res.status(404).json({ success: false, message: 'Pedido não encontrado.' });
  }

  return res.json({
    success: true,
    status_pagamento: order.status_pagamento,
    status_pedido: order.status_pedido,
    order: order
  });
});

/**
 * POST /api/webhooks/zumbopay
 * Webhook oficial com validação HMAC-SHA256 e idempotência
 */
app.post('/api/webhooks/zumbopay', (req, res) => {
  try {
    const signature = req.headers['x-zumbo-signature'] || req.headers['x-signature'] || req.headers['signature'];
    
    // Verificação de assinatura conforme documentação ZumboPay
    if (ZUMBOPAY_WEBHOOK_SECRET && signature && req.rawBody) {
      const expected = crypto
        .createHmac('sha256', ZUMBOPAY_WEBHOOK_SECRET)
        .update(req.rawBody)
        .digest('hex');

      const isValid = crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expected, 'hex')
      );

      if (!isValid) {
        console.warn('[WEBHOOK] Assinatura inválida rejeitada.');
        return res.status(401).json({ error: 'Assinatura inválida' });
      }
    }

    const event = req.body;
    const eventId = event.id || event.event_id || `${event.data?.reference}_${event.event}`;

    // Prevenção de duplicidade (Idempotência)
    if (eventId && processedEvents.has(eventId)) {
      console.log(`[WEBHOOK] Evento já processado anteriormente: ${eventId}`);
      return res.status(200).json({ received: true, already_processed: true });
    }
    if (eventId) processedEvents.add(eventId);

    console.log('[WEBHOOK RECEBIDO]:', event);

    const sourceId = event.data?.source_id || event.data?.order_id || event.source_id;
    const status = event.data?.status || event.status;

    if (sourceId && ordersDb.has(sourceId)) {
      const order = ordersDb.get(sourceId);
      if (status === 'success' || event.event === 'payment.succeeded') {
        order.status_pagamento = 'Pagamento confirmado';
        order.status_pedido = 'Em processamento';
        console.log(`[WEBHOOK] Pedido ${sourceId} atualizado para: Pagamento confirmado!`);
      } else if (status === 'failed' || event.event === 'payment.failed') {
        order.status_pagamento = 'Cancelado';
        order.status_pedido = 'Cancelado';
      }
      ordersDb.set(sourceId, order);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[ERRO WEBHOOK]:', err);
    return res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor Canetas Premium MZ rodando em http://localhost:${PORT}`);
});
