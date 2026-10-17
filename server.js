const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure data directory and DB file exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading DB file:', err);
  }
  return { orders: [], audit: [], couriers: {}, stores: [] };
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving DB file:', err);
  }
}

// Global Middlewares
app.use(cors());
app.use(express.static(__dirname));

// Custom raw body capture for Shopify HMAC verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Portal Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin_portal.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin_portal.html'));
});

app.get('/caller', (req, res) => {
  res.sendFile(path.join(__dirname, 'caller_portal.html'));
});

app.get('/calling', (req, res) => {
  res.sendFile(path.join(__dirname, 'caller_portal.html'));
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    server: 'MSA Order Management Backend',
  });
});

// -------------------------------------------------------------
// 1. ORDERS CRUD API (Cloud Sync for multiple Callers)
// -------------------------------------------------------------

// Fetch all orders
app.get('/api/orders', (req, res) => {
  const db = loadDB();
  res.json({ success: true, count: db.orders.length, orders: db.orders });
});

// Full state sync (pull / push)
app.post('/api/sync-state', (req, res) => {
  const { orders, audit } = req.body;
  const db = loadDB();

  if (Array.isArray(orders) && orders.length > 0) {
    // Merge strategy: update or append
    const orderMap = new Map();
    db.orders.forEach(o => orderMap.set(o.no || o.id, o));
    orders.forEach(o => orderMap.set(o.no || o.id, o));
    db.orders = Array.from(orderMap.values());
  }

  if (Array.isArray(audit) && audit.length > 0) {
    db.audit = [...audit, ...db.audit].slice(0, 200);
  }

  saveDB(db);
  res.json({ success: true, message: 'State synced successfully', orders: db.orders });
});

// Update specific order
app.put('/api/orders/:id', (req, res) => {
  const orderId = req.params.id;
  const db = loadDB();
  const index = db.orders.findIndex(o => String(o.id) === String(orderId) || o.no === orderId);

  if (index === -1) {
    return res.status(404).json({ success: false, error: 'Order not found' });
  }

  db.orders[index] = { ...db.orders[index], ...req.body, updatedAt: Date.now() };
  saveDB(db);
  res.json({ success: true, order: db.orders[index] });
});

// -------------------------------------------------------------
// 2. SHOPIFY LIVE WEBHOOK & REST SYNC
// -------------------------------------------------------------

// Shopify HMAC verification helper
function verifyShopifyHmac(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true; // If no secret set in dev, permit
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader || !req.rawBody) return false;

  const generatedHmac = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('base64');

  return crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(generatedHmac));
}

// Live Webhook Endpoint: POST /api/webhooks/shopify/orders-create
app.post('/api/webhooks/shopify/orders-create', (req, res) => {
  if (!verifyShopifyHmac(req)) {
    console.warn('⚠️ Unauthorized Shopify webhook attempt (HMAC Mismatch)');
    return res.status(401).send('Unauthorized');
  }

  const payload = req.body;
  if (!payload || !payload.id) {
    return res.status(400).json({ error: 'Invalid order payload' });
  }

  const db = loadDB();

  // Normalize Shopify customer data
  const customerName =
    payload.shipping_address?.name ||
    payload.customer?.first_name + ' ' + (payload.customer?.last_name || '') ||
    'Unknown Customer';

  const phone =
    payload.shipping_address?.phone ||
    payload.billing_address?.phone ||
    payload.customer?.phone ||
    '';

  const address = [
    payload.shipping_address?.address1,
    payload.shipping_address?.address2,
    payload.shipping_address?.city,
    payload.shipping_address?.province,
  ]
    .filter(Boolean)
    .join(', ');

  const items = (payload.line_items || [])
    .map(i => `${i.title} (${i.quantity}x)`)
    .join(', ') || 'General Order';

  const cod = Math.round(parseFloat(payload.total_price || payload.current_total_price || '0'));

  const newOrder = {
    id: db.orders.length ? Math.max(...db.orders.map(o => o.id || 0)) + 1 : 1,
    no: payload.name || `MSA-${payload.order_number || payload.id}`,
    shopifyId: payload.id,
    store: 0,
    cust: customerName.trim(),
    phone: phone.trim(),
    addr: address || 'Address not provided',
    item: items,
    cod: cod,
    call: 'Pending Call',
    at: [],
    ship: null,
    t: payload.created_at ? new Date(payload.created_at).getTime() : Date.now(),
    source: 'Shopify Webhook',
  };

  // Prevent duplicate insertion
  const existing = db.orders.find(o => o.shopifyId === payload.id || o.no === newOrder.no);
  if (!existing) {
    db.orders.unshift(newOrder);
    db.audit.unshift({
      t: Date.now(),
      by: 'Shopify Webhook',
      a: `New order ${newOrder.no} received (${newOrder.cust} - PKR ${newOrder.cod})`,
    });
    saveDB(db);
    console.log(`✅ [Shopify Webhook] Created new order: ${newOrder.no} for ${newOrder.cust}`);
  } else {
    console.log(`ℹ️ [Shopify Webhook] Order ${newOrder.no} already exists, skipping.`);
  }

  res.status(200).json({ success: true, orderNo: newOrder.no });
});

// Manual / Polling Shopify Order Fetcher
app.post('/api/shopify/fetch-store-orders', async (req, res) => {
  const { storeDomain, accessToken } = req.body;
  const domain = storeDomain || process.env.SHOPIFY_STORE_1_DOMAIN;
  const token = accessToken || process.env.SHOPIFY_STORE_1_ACCESS_TOKEN;

  if (!domain || !token) {
    return res.status(400).json({
      success: false,
      error: 'Shopify store domain and admin access token (shpat_...) are required',
    });
  }

  try {
    const url = `https://${domain}/admin/api/2024-01/orders.json?status=open&limit=25`;
    const response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ success: false, error: errText });
    }

    const data = await response.json();
    const fetchedOrders = data.orders || [];
    const db = loadDB();
    let imported = 0;

    fetchedOrders.forEach(payload => {
      const existing = db.orders.find(o => o.shopifyId === payload.id || o.no === payload.name);
      if (!existing) {
        const customerName =
          payload.shipping_address?.name ||
          (payload.customer ? `${payload.customer.first_name} ${payload.customer.last_name || ''}` : 'Customer');
        const phone = payload.shipping_address?.phone || payload.customer?.phone || '';
        const address = [
          payload.shipping_address?.address1,
          payload.shipping_address?.address2,
          payload.shipping_address?.city,
        ]
          .filter(Boolean)
          .join(', ');
        const items = (payload.line_items || []).map(i => `${i.title} (x${i.quantity})`).join(', ');

        db.orders.unshift({
          id: db.orders.length ? Math.max(...db.orders.map(o => o.id || 0)) + 1 : 1,
          no: payload.name || `MSA-${payload.order_number}`,
          shopifyId: payload.id,
          store: 0,
          cust: customerName.trim(),
          phone: phone.trim(),
          addr: address,
          item: items,
          cod: Math.round(parseFloat(payload.total_price || '0')),
          call: 'Pending Call',
          at: [],
          ship: null,
          t: new Date(payload.created_at).getTime(),
          source: 'Shopify REST API',
        });
        imported++;
      }
    });

    saveDB(db);
    res.json({ success: true, count: imported, message: `Imported ${imported} new orders from Shopify.` });
  } catch (err) {
    console.error('Error fetching Shopify orders:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 3. REAL COURIER INTEGRATION (POSTEX, TRAX, LEOPARDS)
// -------------------------------------------------------------

// Courier Booking Dispatcher
app.post('/api/couriers/book', async (req, res) => {
  const { courier, order, config } = req.body;

  if (!courier || !order) {
    return res.status(400).json({ success: false, error: 'Courier name and order data required' });
  }

  console.log(`📦 Initiating Booking for Order ${order.no} with ${courier}...`);

  try {
    // 1. POSTEX INTEGRATION
    if (courier === 'PostEx') {
      const token = config?.token || process.env.POSTEX_TOKEN;
      const isProd = (config?.env || process.env.POSTEX_ENV) === 'production';
      const endpoint = isProd
        ? 'https://api.postex.pk/services/integration/api/order/v1/create-order'
        : 'https://api.postex.pk/services/integration/api/order/v1/create-order';

      if (!token) {
        // Fallback simulation if no real token provided
        const trackingNum = `PX${Math.floor(700000 + Math.random() * 200000)}`;
        return res.json({
          success: true,
          mode: 'simulated',
          trackingNumber: trackingNum,
          courier: 'PostEx',
          status: 'Booked',
          message: 'PostEx booking completed (Simulated mode: Add token for live API).',
        });
      }

      // Live PostEx Payload Schema
      const postexPayload = {
        cityName: order.city || 'Lahore',
        customerName: order.cust,
        customerPhone: order.phone.replace(/[^0-9]/g, ''),
        deliveryAddress: order.addr,
        invoiceDivision: 1,
        invoicePayment: order.cod,
        items: 1,
        orderDetail: order.item,
        orderRefNumber: order.no,
        orderType: 'Normal',
        pickupAddressCode: config?.pickupId || process.env.POSTEX_PICKUP_ADDRESS_ID || '001',
        transactionNotes: 'Handle with care',
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          token: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(postexPayload),
      });

      const result = await response.json();
      if (result.statusCode === '200' || result.dist?.trackingNumber) {
        return res.json({
          success: true,
          mode: 'live',
          trackingNumber: result.dist.trackingNumber,
          courier: 'PostEx',
          status: 'Booked',
          rawResponse: result,
        });
      } else {
        return res.status(400).json({
          success: false,
          error: result.statusMessage || 'PostEx rejected booking',
          rawResponse: result,
        });
      }
    }

    // 2. TRAX INTEGRATION
    if (courier === 'Trax') {
      const apiKey = config?.apiKey || process.env.TRAX_API_KEY;
      if (!apiKey) {
        const trackingNum = `TX${Math.floor(800000 + Math.random() * 200000)}`;
        return res.json({
          success: true,
          mode: 'simulated',
          trackingNumber: trackingNum,
          courier: 'Trax',
          status: 'Booked',
          message: 'Trax booking completed (Simulated mode: Add API key for live API).',
        });
      }

      const traxEndpoint = 'https://sonic.pk/api/v1/orders';
      const traxPayload = {
        service_type_id: 1, // Regular Rush
        pickup_address_id: config?.pickupId || process.env.TRAX_PICKUP_ADDRESS_ID || 1,
        information_display: 1,
        consignee_name: order.cust,
        consignee_address: order.addr,
        consignee_phone_number_1: order.phone.replace(/[^0-9]/g, ''),
        consignee_email_address_1: 'customer@order.pk',
        order_id: order.no,
        item_product_type_id: 1,
        item_description: order.item,
        item_quantity: 1,
        item_insurance: 0,
        pickup_date: new Date().toISOString().slice(0, 10),
        estimated_weight: 0.5,
        shipping_mode_id: 1,
        amount: order.cod,
        payment_mode_id: 1, // COD
      };

      const response = await fetch(traxEndpoint, {
        method: 'POST',
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(traxPayload),
      });

      const result = await response.json();
      if (result.status === 0 || result.tracking_number) {
        return res.json({
          success: true,
          mode: 'live',
          trackingNumber: result.tracking_number,
          courier: 'Trax',
          status: 'Booked',
          rawResponse: result,
        });
      } else {
        return res.status(400).json({
          success: false,
          error: result.message || 'Trax rejected booking',
          rawResponse: result,
        });
      }
    }

    // 3. LEOPARDS INTEGRATION
    if (courier === 'Leopards') {
      const apiKey = config?.apiKey || process.env.LEOPARDS_API_KEY;
      const apiPassword = config?.apiPassword || process.env.LEOPARDS_API_PASSWORD;

      if (!apiKey || !apiPassword) {
        const trackingNum = `LP${Math.floor(900000 + Math.random() * 200000)}`;
        return res.json({
          success: true,
          mode: 'simulated',
          trackingNumber: trackingNum,
          courier: 'Leopards',
          status: 'Booked',
          message: 'Leopards booking completed (Simulated mode: Add API credentials for live API).',
        });
      }

      const leopardsEndpoint = 'https://merchantapi.leopardscourier.com/api/BookPacket';
      const leopardsPayload = {
        api_key: apiKey,
        api_password: apiPassword,
        booked_packet_weight: 500,
        booked_packet_vol_weight_w: 1,
        booked_packet_vol_weight_h: 1,
        booked_packet_vol_weight_l: 1,
        booked_packet_no_piece: 1,
        booked_packet_collect_amount: order.cod,
        booked_packet_order_id: order.no,
        origin_city: 1, // Karachi or configured
        destination_city: 2,
        shipment_name_eng: order.cust,
        shipment_email: 'customer@order.pk',
        shipment_phone: order.phone.replace(/[^0-9]/g, ''),
        shipment_address: order.addr,
        special_instructions: 'Fragile / COD Delivery',
        shipment_type: 'Overnight',
      };

      const response = await fetch(leopardsEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(leopardsPayload),
      });

      const result = await response.json();
      if (result.status === 1 || result.track_number) {
        return res.json({
          success: true,
          mode: 'live',
          trackingNumber: result.track_number,
          courier: 'Leopards',
          status: 'Booked',
          rawResponse: result,
        });
      } else {
        return res.status(400).json({
          success: false,
          error: result.error || 'Leopards rejected booking',
          rawResponse: result,
        });
      }
    }

    return res.status(400).json({ success: false, error: 'Unknown courier' });
  } catch (err) {
    console.error('Error booking courier:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Courier Tracking Proxy
app.get('/api/couriers/track/:courier/:trackingNumber', async (req, res) => {
  const { courier, trackingNumber } = req.params;

  try {
    if (courier === 'PostEx') {
      const token = process.env.POSTEX_TOKEN;
      if (!token) {
        return res.json({ success: true, trackingNumber, status: 'In Transit', events: [] });
      }
      const response = await fetch(
        `https://api.postex.pk/services/integration/api/order/v1/track-order/${trackingNumber}`,
        { headers: { token } }
      );
      const data = await response.json();
      return res.json({ success: true, trackingNumber, data });
    }

    res.json({
      success: true,
      courier,
      trackingNumber,
      message: 'Tracking details requested',
      events: [{ s: 'In Transit', t: Date.now(), raw: 'Package at sorting hub' }],
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 4. SERVER STARTUP
// -------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 MSA Order Management Backend running on port ${PORT}`);
  console.log(`👑 Admin Portal:  http://localhost:${PORT}/admin`);
  console.log(`📞 Caller Portal: http://localhost:${PORT}/caller`);
  console.log(`📡 Health Check:  http://localhost:${PORT}/api/health`);
  console.log(`🔔 Shopify Webhook: http://localhost:${PORT}/api/webhooks/shopify/orders-create`);
  console.log(`======================================================\n`);
});
