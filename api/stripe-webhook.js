const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

let stripe;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('Stripe module loaded OK');
} catch (err) {
  console.error('STRIPE MODULE LOAD ERROR:', err.message);
}

// Mapping planId -> limits, sesuai Blueprint §3.6.1.
// HARUS sinkron dengan PRICE_ID_MAP di create-checkout-session.js.
const PLAN_LIMITS = {
  starter: { max_laundries: 1, max_employees: 5, max_orders_per_month: 500 },
  professional: { max_laundries: 5, max_employees: 25, max_orders_per_month: 2000 },
  enterprise: { max_laundries: -1, max_employees: -1, max_orders_per_month: -1 },
};

// Reverse map Price ID Stripe -> { planId, isYearly }.
const PRICE_ID_TO_PLAN = {
  'price_1Tr9iZC8N5qFcv8QdZki33yq': { planId: 'starter', isYearly: false },
  'price_1Tr9knC8N5qFcv8Qddwlpm22': { planId: 'starter', isYearly: true },
  'price_1Tr9jTC8N5qFcv8Q9p4yXXD7': { planId: 'professional', isYearly: false },
  'price_1Tr9lKC8N5qFcv8QqRb4M5PK': { planId: 'professional', isYearly: true },
  'price_1Tr9kCC8N5qFcv8QuuOTThLQ': { planId: 'enterprise', isYearly: false },
  'price_1Tr9lwC8N5qFcv8QqKGtptzC': { planId: 'enterprise', isYearly: true },
};

function initFirebase() {
  if (getApps().length) return true;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

  console.log('Env check:', {
    hasProjectId: !!projectId,
    hasClientEmail: !!clientEmail,
    hasPrivateKey: !!privateKeyRaw,
  });

  if (!projectId || !clientEmail || !privateKeyRaw) {
    console.error('Missing Firebase env vars.');
    return false;
  }

  try {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
      }),
    });
    console.log('Firebase Admin initialized OK');
    return true;
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return false;
  }
}

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  console.log('Webhook hit:', req.method);

  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe module not loaded.' });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const firebaseReady = initFirebase();
    console.log('Firebase ready:', firebaseReady);

    if (!firebaseReady) {
      return res.status(500).json({ error: 'Firebase Admin not initialized.' });
    }

    const sig = req.headers['stripe-signature'];
    const rawBody = await buffer(req);
    console.log('Raw body length:', rawBody.length);

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Signature verification failed:', err.message);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    console.log('Event type:', event.type);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const uid = session.client_reference_id;
      // FIX: ambil companyId dari metadata (dikirim dari
      // create-checkout-session.js). Tanpa ini dokumen subscription baru
      // nggak punya company_id, jadi streamActiveSubscription(companyId)
      // di subscription_repository.dart selalu return null.
      const companyId = session.metadata?.companyId;
      console.log('uid:', uid, 'companyId:', companyId);

      if (!uid) {
        console.warn('client_reference_id (uid) kosong, skip.');
        return res.status(200).json({ received: true, warning: 'Missing uid' });
      }

      if (!companyId) {
        console.error('metadata.companyId kosong — subscription tidak akan ter-link ke company manapun.');
        return res.status(200).json({ received: true, warning: 'Missing companyId in metadata' });
      }

      const db = getFirestore();

      // session.line_items TIDAK otomatis ikut di payload event ini,
      // jadi harus di-fetch manual buat tau price ID yang beneran dibeli.
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        limit: 1,
      });
      const priceId = lineItems.data[0]?.price?.id;
      const planInfo = PRICE_ID_TO_PLAN[priceId];

      if (!planInfo) {
        console.error(`Price ID ${priceId} tidak dikenali di PRICE_ID_TO_PLAN.`);
        return res.status(200).json({ received: true, warning: 'Unknown price ID' });
      }

      const limits = PLAN_LIMITS[planInfo.planId];
      const subscriptionsRef = db.collection('users').doc(uid).collection('subscriptions');

      // Nonaktifkan dulu subscription aktif lama milik company yang sama
      // (kasus upgrade/downgrade), biar nggak ada 2+ dokumen berstatus
      // 'active' bersamaan untuk company yang sama.
      const existingActive = await subscriptionsRef
        .where('company_id', '==', companyId)
        .where('status', 'in', ['active', 'trialing'])
        .get();

      const batch = db.batch();

      existingActive.docs.forEach((doc) => {
        batch.update(doc.ref, {
          status: 'canceled',
          canceled_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
        });
      });

      const newSubRef = subscriptionsRef.doc();
      // FIX: semua nama field disamain jadi snake_case supaya cocok
      // dengan query & model di subscription_repository.dart
      // (company_id, created_at, plan_id, dst — sesuai skema PRD §3.6.2).
      // Sebelumnya field ini ditulis camelCase (createdAt, stripeSessionId,
      // dst) dan company_id sama sekali nggak ada, jadi
      // streamActiveSubscription(companyId) selalu kosong walau plan
      // sudah keupgrade.
      batch.set(newSubRef, {
        status: 'active',
        company_id: companyId,
        plan_id: planInfo.planId,
        plan_name: planInfo.planId.charAt(0).toUpperCase() + planInfo.planId.slice(1),
        billing_cycle: planInfo.isYearly ? 'yearly' : 'monthly',
        limits,
        stripe_session_id: session.id,
        stripe_subscription_id: session.subscription || null,
        stripe_customer_id: session.customer || null,
        current_period_start: FieldValue.serverTimestamp(),
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });

      await batch.commit();
      console.log(`Subscription activated for uid: ${uid}, company: ${companyId}, plan: ${planInfo.planId}`);
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      // Catatan: event ini butuh uid & company_id untuk tau dokumen mana
      // yang harus diupdate. Karena Stripe subscription object nggak
      // otomatis punya metadata ini kecuali di-set eksplisit pas
      // checkout.sessions.create (lewat subscription_data.metadata),
      // pastikan itu ditambahkan juga kalau event ini mau dipakai.
      console.log(`Event ${event.type} diterima tapi belum di-handle di sini.`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('UNHANDLED ERROR:', err.message, err.stack);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false,
  },
};