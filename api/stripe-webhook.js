const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

let stripe;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('Stripe module loaded OK');
} catch (err) {
  console.error('STRIPE MODULE LOAD ERROR:', err.message);
}

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
      console.log('uid:', uid);

      if (uid) {
        const db = getFirestore();
        await db.collection('users').doc(uid).collection('subscriptions').add({
          status: 'active',
          stripeSessionId: session.id,
          stripeSubscriptionId: session.subscription || null,
          createdAt: FieldValue.serverTimestamp(),
        });
        console.log(`Subscription activated for uid: ${uid}`);
      }
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