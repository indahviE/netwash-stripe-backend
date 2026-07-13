// api/upload-photo.js
//
// Endpoint buat upload foto profil ke Cloudinary.
// Taruh file ini di folder `api/` project Vercel kamu (satu folder sama
// endpoint Stripe kamu). Vercel otomatis expose ini di:
//   https://<domain-vercel-kamu>/api/upload-photo
//
// Env vars yang wajib ada di Vercel (Settings > Environment Variables):
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

module.exports = async (req, res) => {
  // Izinin diakses dari domain manapun (termasuk localhost pas development).
  // Kalau nanti udah production, boleh diganti '*' jadi domain app kamu aja.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Browser ngirim OPTIONS dulu (preflight) sebelum POST beneran.
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image, uid } = req.body || {};

  if (!image || !uid) {
    return res.status(400).json({ error: 'image dan uid wajib diisi' });
  }

  try {
    // `image` dikirim dari Flutter sebagai data URI base64:
    // "data:image/jpeg;base64,xxxxxx"
    const result = await cloudinary.uploader.upload(image, {
      folder: 'netwash/profile_photos',
      public_id: uid,
      overwrite: true,
      transformation: [
        { width: 400, height: 400, crop: 'fill', gravity: 'face' },
      ],
    });

    return res.status(200).json({ url: result.secure_url });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: 'Upload gagal', detail: err.message });
  }
};

// Foto base64 bisa lumayan gede, naikin limit body parser default (1mb).
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
  },
};