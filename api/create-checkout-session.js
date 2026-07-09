const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Peta planId (dikirim dari Flutter) ke Price ID asli Stripe.
// Format planId: 'starter', 'starter_yearly', 'professional', dst.
const PRICE_ID_MAP = {
  starter: 'price_1Tr9iZC8N5qFcv8QdZki33yq',
  starter_yearly: 'price_1Tr9knC8N5qFcv8Qddwlpm22',
  professional: 'price_1Tr9jTC8N5qFcv8Q9p4yXXD7',
  professional_yearly: 'price_1Tr9lKC8N5qFcv8QqRb4M5PK',
  enterprise: 'price_1Tr9kCC8N5qFcv8QuuOTThLQ',
  enterprise_yearly: 'price_1Tr9lwC8N5qFcv8QqKGtptzC',
};

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*'); // nanti ganti ke domain spesifik
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { planId, successUrl, cancelUrl, uid } = req.body;

    const priceId = PRICE_ID_MAP[planId];
    if (!priceId) {
      return res.status(400).json({ error: `Paket "${planId}" tidak dikenali.` });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: uid, // TAMBAHIN INI
    });

    res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};