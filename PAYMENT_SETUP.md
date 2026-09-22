# 💳 PAYMENT_SETUP.md — Guia de Integração de Pagamento

## Canetas Premium MZ

---

## Métodos de Pagamento Suportados

| Gateway | Operadora | Moeda | País |
|---------|-----------|-------|------|
| M-Pesa OpenAPI | Vodacom Moçambique | MZN | MZ |
| E-Mola API | Tmcel Moçambique | MZN | MZ |

---

## 1. M-Pesa (Vodacom Moçambique)

### Credenciais necessárias

```env
MPESA_API_KEY=your_api_key_here
MPESA_PUBLIC_KEY=your_public_key_here
MPESA_SERVICE_PROVIDER_CODE=your_provider_code_here
MPESA_ENV=sandbox   # ou: production
```

### Endpoint

```
Sandbox:    https://api.sandbox.vm.co.mz/ipg/v1x/
Produção:   https://api.vm.co.mz/ipg/v1x/
Rota:       /c2bPayment/singleStage/
Método:     POST
```

### Documentação oficial
→ https://developer.vm.co.mz/

### Exemplo de chamada (Node.js)

```js
const axios = require('axios');
const crypto = require('crypto');

async function initiateMpesaPayment({ amount, msisdn, reference }) {
  // 1. Encrypt API key with public key
  const publicKey = Buffer.from(process.env.MPESA_PUBLIC_KEY, 'base64');
  const encrypted = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(process.env.MPESA_API_KEY)
  ).toString('base64');

  const baseUrl = process.env.MPESA_ENV === 'production'
    ? 'https://api.vm.co.mz/ipg/v1x'
    : 'https://api.sandbox.vm.co.mz/ipg/v1x';

  const response = await axios.post(
    `${baseUrl}/c2bPayment/singleStage/`,
    {
      input_Amount: amount,
      input_CustomerMSISDN: msisdn.replace(/\s/g, ''),
      input_Country: 'MOZ',
      input_Currency: 'MZN',
      input_ServiceProviderCode: process.env.MPESA_SERVICE_PROVIDER_CODE,
      input_TransactionReference: reference,
      input_ThirdPartyConversationID: `cpm-${Date.now()}`,
      input_PurchasedItemsDesc: 'Canetas Premium MZ'
    },
    {
      headers: {
        'Authorization': `Bearer ${encrypted}`,
        'Content-Type': 'application/json',
        'Origin': '*'
      }
    }
  );

  return response.data;
}
```

---

## 2. E-Mola (Tmcel)

### Credenciais necessárias

```env
EMOLA_API_KEY=your_api_key_here
EMOLA_MERCHANT_ID=your_merchant_id_here
EMOLA_ENV=sandbox   # ou: production
```

### Como obter credenciais
→ Contacte a Tmcel Moçambique para acesso à API E-Mola para comerciantes.

---

## 3. Backend Server (Express.js)

```js
// server.js
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('.'));  // serve o index.html

app.post('/api/pagamento', async (req, res) => {
  try {
    const { amount, msisdn, ref, gateway } = req.body;

    if (!amount || !msisdn || !ref || !gateway) {
      return res.json({ success: false, message: 'Dados incompletos.' });
    }

    let result;
    if (gateway === 'mpesa') {
      result = await initiateMpesaPayment({ amount, msisdn, reference: ref });
      // Verifique result.output_ResponseCode === 'INS-0' para sucesso
      const success = result.output_ResponseCode === 'INS-0';
      return res.json({ success, transactionId: result.output_TransactionID, message: result.output_ResponseDesc });
    }

    if (gateway === 'emola') {
      // Implemente a chamada E-Mola aqui
      return res.json({ success: false, message: 'E-Mola em configuração.' });
    }

    res.json({ success: false, message: 'Gateway não suportado.' });
  } catch (err) {
    console.error('Erro de pagamento:', err.message);
    res.json({ success: false, message: 'Erro ao processar pagamento.' });
  }
});

app.listen(3000, () => console.log('Servidor rodando na porta 3000'));
```

### package.json mínimo

```json
{
  "name": "canetas-premium-mz",
  "version": "1.0.0",
  "dependencies": {
    "express": "^4.18.0",
    "axios": "^1.6.0"
  },
  "scripts": {
    "start": "node server.js"
  }
}
```

---

## 4. Substituir o bloco simulado no index.html

Localize este comentário no `index.html`:

```js
// Simulated processing (remove after integrating real gateway)
await new Promise(r => setTimeout(r, 1800));
order.status_pagamento = 'confirmado';
```

**Substitua por:**

```js
const res = await fetch('/api/pagamento', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    amount: order.total,
    msisdn: order.tel_pagamento,
    ref: order.id,
    gateway: order.metodo
  })
});
const result = await res.json();
if (!result.success) {
  const errEl = document.getElementById('submit-error');
  errEl.textContent = result.message || 'Erro ao processar pagamento. Tente novamente.';
  errEl.classList.remove('hidden');
  btn.disabled = false;
  btn.innerHTML = '<svg width="18" height="18" ...>...</svg> FINALIZAR PEDIDO';
  return;
}
order.status_pagamento = 'confirmado';
order.transactionId = result.transactionId;
```

---

## 5. Ver Pedidos (Admin)

Os pedidos são guardados no `localStorage` do navegador.

Para ver os pedidos, abra o **Console do Browser** (F12) e execute:

```js
viewOrders()    // Mostra todos os pedidos em tabela
clearOrders()   // Apaga todos os pedidos
```

### Estrutura de um pedido

```json
{
  "id": "CPM-ABC123",
  "date": "2024-01-01T12:00:00.000Z",
  "nome": "João Manuel",
  "telefone": "84 123 4567",
  "provincia": "Maputo Cidade",
  "cidade": "Maputo",
  "bairro": "Sommerschield",
  "referencia": "Perto do supermercado",
  "quantidade": 3,
  "total": 360,
  "metodo": "mpesa",
  "tel_pagamento": "84 000 0000",
  "status_pagamento": "confirmado",
  "status_pedido": "em_processamento"
}
```

### Estados do pedido

| Status | Descrição |
|--------|-----------|
| `pendente` | Aguarda pagamento |
| `confirmado` | Pagamento confirmado |
| `em_processamento` | Pedido em preparação |
| `enviado` | Em trânsito |
| `entregue` | Entregue ao cliente |
| `cancelado` | Pedido cancelado |

---

## 6. Adicionar Imagens do Produto

Coloque as imagens na pasta `images/` e edite o `index.html`:

```js
// Linha ~80 do JavaScript:
const productImages = [
  'images/caneta-1.jpg',
  'images/caneta-2.jpg',
  'images/caneta-3.jpg',
  'images/caneta-4.jpg',
];
```

E substitua o `<div class="placeholder-box">` por:

```html
<img id="main-product-img" src="images/caneta-1.jpg" alt="Caneta Premium"
     style="width:100%;height:100%;object-fit:cover;">
```

---

## 7. Personalizar WhatsApp

Substitua `258000000000` pelo número real em:
- `#whatsapp-btn href`
- `#footer a[href]`
- `#c-whatsapp` na confirmação

---

*Canetas Premium MZ — Página de Vendas*
