'use strict';

require('dotenv').config();

const express  = require('express');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3000;

const MONGO_URI             = process.env.MONGO_URI;
const JWT_SECRET            = process.env.JWT_SECRET;
const ADMIN_KEY             = process.env.ADMIN_KEY;
const LEMON_SQUEEZY_SECRET  = process.env.LEMON_SQUEEZY_SECRET;
const LEMON_SQUEEZY_API_KEY = process.env.LEMON_SQUEEZY_API_KEY;
const LS_API_BASE           = 'https://api.lemonsqueezy.com/v1';

if (!MONGO_URI || !JWT_SECRET || !ADMIN_KEY) {
    console.error('FATAL: Missing required env vars: MONGO_URI, JWT_SECRET, ADMIN_KEY');
    process.exit(1);
}
if (!LEMON_SQUEEZY_API_KEY) {
    console.warn('WARNING: LEMON_SQUEEZY_API_KEY not set — subscription details (trial/renewal dates) will be unavailable');
}

// Raw body needed for webhook signature verification
app.use('/api/webhook', express.raw({ type: '*/*' }));
app.use(express.json());

// --- MongoDB Schema ----------------------------------------------------------

const activationSchema = new mongoose.Schema({
    licenseKey:     { type: String, required: true },
    machineId:      { type: String, required: true },
    lsInstanceId:   { type: String, required: true },
    plan:           { type: String, default: 'Pro' },
    status:         { type: String, default: 'active' },
    email:          { type: String, default: null },
    customerName:   { type: String, default: null },
    variantName:    { type: String, default: null },
    productName:    { type: String, default: null },
    trialEndsAt:      { type: Date,   default: null },
    renewsAt:         { type: Date,   default: null },
    endsAt:           { type: Date,   default: null },
    activationLimit:  { type: Number, default: null },
    activationUsage:  { type: Number, default: null },
    activatedAt:      { type: Date,   default: Date.now }
});
activationSchema.index({ licenseKey: 1, machineId: 1 }, { unique: true });

const Activation = mongoose.model('Activation', activationSchema);

async function connectDB() {
    await mongoose.connect(MONGO_URI);
    console.log('MongoDB connected');
}

// --- Lemon Squeezy License API helpers --------------------------------------
// LS license endpoints are public — no API key required.

async function lsActivate(licenseKey, instanceName) {
    const body = new URLSearchParams({ license_key: licenseKey, instance_name: instanceName });
    const res = await fetch(`${LS_API_BASE}/licenses/activate`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    return { status: res.status, data: await res.json() };
}

async function lsValidate(licenseKey, instanceId) {
    const params = new URLSearchParams({ license_key: licenseKey });
    if (instanceId) params.set('instance_id', instanceId);
    const res = await fetch(`${LS_API_BASE}/licenses/validate`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });
    return { status: res.status, data: await res.json() };
}

async function lsDeactivate(licenseKey, instanceId) {
    const body = new URLSearchParams({ license_key: licenseKey, instance_id: instanceId });
    const res = await fetch(`${LS_API_BASE}/licenses/deactivate`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    return { status: res.status, data: await res.json() };
}

// --- Lemon Squeezy REST API (requires API key) -----------------------------

async function lsFetchSubscription(orderId) {
    if (!LEMON_SQUEEZY_API_KEY || !orderId) return null;
    try {
        const url = `${LS_API_BASE}/subscriptions?filter[order_id]=${orderId}`;
        const res = await fetch(url, {
            headers: {
                Accept: 'application/vnd.api+json',
                Authorization: `Bearer ${LEMON_SQUEEZY_API_KEY}`
            }
        });
        const json = await res.json();
        const sub = json.data && json.data[0];
        if (!sub) return null;
        const a = sub.attributes;
        return {
            status:       a.status,
            variantName:  a.variant_name,
            productName:  a.product_name,
            trialEndsAt:  a.trial_ends_at  || null,
            renewsAt:     a.renews_at      || null,
            endsAt:       a.ends_at        || null,
            customerPortalUrl: a.urls && a.urls.customer_portal || null
        };
    } catch (err) {
        console.error('[lsFetchSubscription] error:', err.message);
        return null;
    }
}

// --- Helpers ----------------------------------------------------------------

function requireAdmin(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!key || key !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
    next();
}

function resolvePlanLabel(subStatus, variantName) {
    if (subStatus === 'on_trial') return 'Trial';
    if (subStatus === 'cancelled') return 'Cancelled';
    if (subStatus === 'expired') return 'Expired';
    if (subStatus === 'paused') return 'Paused';
    if (subStatus === 'past_due' || subStatus === 'unpaid') return 'Past Due';
    // Active subscription
    if (!variantName || variantName.toLowerCase() === 'default') return 'Pro';
    return variantName;
}

function computeDaysLeft(subStatus, trialEndsAt, renewsAt, endsAt) {
    let target = null;
    if (subStatus === 'on_trial' && trialEndsAt) {
        target = trialEndsAt;
    } else if (subStatus === 'cancelled' && endsAt) {
        target = endsAt;
    } else if (renewsAt) {
        target = renewsAt;
    }
    if (!target) return null;
    const ms = new Date(target) - new Date();
    return ms > 0 ? Math.ceil(ms / (1000 * 60 * 60 * 24)) : 0;
}

function buildLicenseResponse(sub, token) {
    const plan     = resolvePlanLabel(sub.status, sub.variantName);
    const daysLeft = computeDaysLeft(sub.status, sub.trialEndsAt, sub.renewsAt, sub.endsAt);

    const resp = { ok: true, plan, status: sub.status, daysLeft };
    if (token) resp.token = token;

    // Send the relevant date based on status
    if (sub.status === 'on_trial' && sub.trialEndsAt) {
        resp.expiresAt = sub.trialEndsAt;
        resp.expiryLabel = 'Trial ends';
    } else if (sub.status === 'cancelled' && sub.endsAt) {
        resp.expiresAt = sub.endsAt;
        resp.expiryLabel = 'Access until';
    } else if (sub.renewsAt) {
        resp.expiresAt = sub.renewsAt;
        resp.expiryLabel = 'Renews';
    } else {
        resp.expiresAt = null;
        resp.expiryLabel = null;
    }

    return resp;
}

function lsErrorMessage(msg) {
    if (!msg) return 'Activation failed. Please try again.';
    const m = msg.toLowerCase();
    if (m.includes('maximum') || m.includes('limit'))
        return 'License already activated on another machine. Deactivate it there first.';
    if (m.includes('invalid') || m.includes('not found') || m.includes('does not exist'))
        return 'Invalid license key. Please check your key and try again.';
    if (m.includes('expired') || m.includes('inactive') || m.includes('disabled'))
        return 'Your license has expired or is inactive. Please renew your subscription.';
    return msg;
}

// --- GET / ------------------------------------------------------------------

app.get('/', (req, res) => {
    res.json({ ok: true, service: 'Marketplace Bot License Server' });
});

// --- POST /api/activate -----------------------------------------------------

app.post('/api/activate', async (req, res) => {
    const { licenseKey, machineId } = req.body || {};
    if (!licenseKey || !machineId)
        return res.status(400).json({ error: 'licenseKey and machineId are required' });

    const key = licenseKey.trim().toUpperCase();

    // If this machine already has a stored activation, validate it
    const existing = await Activation.findOne({ licenseKey: key, machineId });
    if (existing) {
        const { data } = await lsValidate(key, existing.lsInstanceId);
        if (data.valid && data.license_key && data.license_key.status === 'active') {
            // Fetch fresh subscription data from LS REST API
            const sub = await lsFetchSubscription(data.meta && data.meta.order_id);
            const subData = sub || {
                status: 'active', variantName: data.meta && data.meta.variant_name,
                trialEndsAt: null, renewsAt: null, endsAt: null
            };
            const plan            = resolvePlanLabel(subData.status, subData.variantName);
            const activationLimit = data.license_key.activation_limit ?? null;
            const activationUsage = data.license_key.activation_usage ?? null;
            await Activation.updateOne({ _id: existing._id }, {
                plan, status: subData.status,
                variantName: subData.variantName, productName: subData.productName,
                trialEndsAt: subData.trialEndsAt, renewsAt: subData.renewsAt, endsAt: subData.endsAt,
                activationLimit, activationUsage
            });
            const token = jwt.sign({ licenseKey: key, machineId, plan }, JWT_SECRET, { expiresIn: '30d' });
            return res.json(buildLicenseResponse(subData, token));
        }
        // No longer valid — remove stale record and re-activate below
        await Activation.deleteOne({ licenseKey: key, machineId });
    }

    // Activate with Lemon Squeezy
    const { data } = await lsActivate(key, machineId);

    if (!data.activated) {
        const errMsg = lsErrorMessage(data.error);
        const status = (data.error || '').toLowerCase().includes('invalid') ||
                       (data.error || '').toLowerCase().includes('not found') ? 404 : 403;
        return res.status(status).json({ error: errMsg });
    }

    const lsInstanceId   = data.instance && data.instance.id;
    const email           = (data.meta && data.meta.customer_email) || null;
    const customerName    = (data.meta && data.meta.customer_name) || null;
    const activationLimit = data.license_key && data.license_key.activation_limit != null
        ? data.license_key.activation_limit : null;
    const activationUsage = data.license_key && data.license_key.activation_usage != null
        ? data.license_key.activation_usage : null;

    // Fetch subscription details from LS REST API
    const sub = await lsFetchSubscription(data.meta && data.meta.order_id);
    const subData = sub || {
        status: 'active', variantName: data.meta && data.meta.variant_name,
        productName: data.meta && data.meta.product_name,
        trialEndsAt: null, renewsAt: null, endsAt: null
    };
    const plan = resolvePlanLabel(subData.status, subData.variantName);

    await Activation.create({
        licenseKey: key, machineId, lsInstanceId, plan,
        status: subData.status, email, customerName,
        variantName: subData.variantName, productName: subData.productName,
        trialEndsAt: subData.trialEndsAt, renewsAt: subData.renewsAt, endsAt: subData.endsAt,
        activationLimit, activationUsage
    });

    const token = jwt.sign({ licenseKey: key, machineId, plan }, JWT_SECRET, { expiresIn: '30d' });
    return res.json(buildLicenseResponse(subData, token));
});

// --- GET /api/verify --------------------------------------------------------

app.get('/api/verify', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer '))
        return res.status(401).json({ error: 'No token provided' });

    let payload;
    try { payload = jwt.verify(auth.slice(7), JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Invalid or expired token' }); }

    const activation = await Activation.findOne({ licenseKey: payload.licenseKey, machineId: payload.machineId });
    if (!activation)
        return res.status(403).json({ error: 'Machine not registered for this license' });

    // Verify against LS to catch cancellations/expirations
    const { data } = await lsValidate(payload.licenseKey, activation.lsInstanceId);
    if (!data.valid) {
        const status = (data.license_key && data.license_key.status) || 'inactive';
        return res.status(403).json({ error: `Subscription is ${status}. Please renew to continue.` });
    }

    // Fetch fresh subscription data from LS REST API
    const sub = await lsFetchSubscription(data.meta && data.meta.order_id);
    const subData = sub || {
        status: 'active', variantName: data.meta && data.meta.variant_name,
        trialEndsAt: null, renewsAt: null, endsAt: null
    };
    const plan            = resolvePlanLabel(subData.status, subData.variantName);
    const activationLimit = data.license_key && data.license_key.activation_limit != null
        ? data.license_key.activation_limit : null;
    const activationUsage = data.license_key && data.license_key.activation_usage != null
        ? data.license_key.activation_usage : null;
    await Activation.updateOne({ _id: activation._id }, {
        plan, status: subData.status,
        variantName: subData.variantName, productName: subData.productName,
        trialEndsAt: subData.trialEndsAt, renewsAt: subData.renewsAt, endsAt: subData.endsAt,
        activationLimit, activationUsage
    });

    return res.json(buildLicenseResponse(subData, null));
});

// --- POST /api/deactivate ---------------------------------------------------

app.post('/api/deactivate', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer '))
        return res.status(401).json({ error: 'No token provided' });

    let payload;
    try { payload = jwt.verify(auth.slice(7), JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Invalid token' }); }

    const activation = await Activation.findOne({ licenseKey: payload.licenseKey, machineId: payload.machineId });
    if (activation) {
        await lsDeactivate(payload.licenseKey, activation.lsInstanceId).catch(() => {});
        await Activation.deleteOne({ _id: activation._id });
    }

    return res.json({ ok: true });
});

// --- Admin: GET /api/admin/activations --------------------------------------

app.get('/api/admin/activations', requireAdmin, async (req, res) => {
    const activations = await Activation.find().sort({ activatedAt: -1 }).lean();
    return res.json(activations);
});

// --- Admin: POST /api/admin/revoke ------------------------------------------

app.post('/api/admin/revoke', requireAdmin, async (req, res) => {
    const { licenseKey } = req.body || {};
    if (!licenseKey) return res.status(400).json({ error: 'licenseKey required' });

    const key = licenseKey.trim().toUpperCase();
    const activations = await Activation.find({ licenseKey: key });
    for (const a of activations) {
        await lsDeactivate(key, a.lsInstanceId).catch(() => {});
    }
    await Activation.deleteMany({ licenseKey: key });
    return res.json({ ok: true, deactivated: activations.length });
});

// --- POST /api/webhook (Lemon Squeezy) --------------------------------------

app.post('/api/webhook', async (req, res) => {
    if (LEMON_SQUEEZY_SECRET) {
        const signature = req.headers['x-signature'];
        const hmac = crypto.createHmac('sha256', LEMON_SQUEEZY_SECRET);
        hmac.update(req.body);
        const expected = hmac.digest('hex');
        if (!signature || signature !== expected)
            return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    let event;
    try { event = JSON.parse(req.body.toString()); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    const eventName = event.meta && event.meta.event_name;
    console.log('[webhook]', eventName);

    // License keys are managed by Lemon Squeezy automatically.
    // Subscription cancellations are enforced on /api/verify via LS validate call.
    return res.sendStatus(200);
});

// --- Start ------------------------------------------------------------------

connectDB().then(() => {
    app.listen(PORT, () => console.log('License server listening on port ' + PORT));
}).catch(err => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
});
