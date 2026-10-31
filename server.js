const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./lib/db');
const { getSql } = db;
const neonStorage = require('./lib/neon-storage');
const { createEprfWorkbook } = require('./lib/eprf-xlsx');

// Load .env without requiring a native module or an extra dependency.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeThisPassword123!';
const SESSION_SECRET = process.env.SESSION_SECRET || 'camfed-local-session-secret-change-me';

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// Vercel's function bundle is read-only. Use its writable scratch directory
// there, while keeping the existing project-local layout for local installs.
const STORAGE_ROOT = process.env.CAMFED_STORAGE_DIR ||
  (process.env.VERCEL ? path.join(require('os').tmpdir(), 'camfed-registration') : ROOT);
const DATA_DIR = path.join(STORAGE_ROOT, 'data');
const SIG_DIR = path.join(STORAGE_ROOT, 'signatures');
const PDF_DIR = path.join(STORAGE_ROOT, 'pdfs');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
[DATA_DIR, SIG_DIR, PDF_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

function loadLegacyData() {
  if (!fs.existsSync(DATA_FILE)) return { nextEventId: 1, nextAttendeeId: 1, events: [], attendees: [] };
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { nextEventId: d.nextEventId || 1, nextAttendeeId: d.nextAttendeeId || 1, events: d.events || [], attendees: d.attendees || [] };
  } catch (e) {
    console.error('Could not read data.json:', e.message);
    return { nextEventId: 1, nextAttendeeId: 1, events: [], attendees: [] };
  }
}
function slugify(value) { return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70); }
async function uniqueSlug(name) {
  const base = slugify(name) || 'event'; let slug = base; let n = 2;
  const existing = new Set(await db.listEventSlugs());
  while (existing.has(slug)) slug = `${base}-${n++}`;
  return slug;
}
function signSession(username) {
  const identity = typeof username === 'string' ? { username, role: 'admin', province: null } : username;
  const payload = Buffer.from(JSON.stringify({ ...identity, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifySession(token) {
  try {
    if (!token || !token.includes('.')) return false;
    const [payload, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (d.exp <= Date.now()) return null;
    if (d.role === 'admin' && typeof d.username === 'string') return { username: d.username, role: 'admin', province: null };
    if (d.role === 'user' && PROVINCES.includes(d.province)) return { username: d.username, role: 'user', province: d.province };
    return null;
  } catch { return null; }
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}
async function activeAdmin(identity) {
  if (identity?.role !== 'admin') return false;
  if (identity.username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) return true;
  return Boolean(await db.getAdminUser(identity.username));
}
function isPrimaryAdmin(identity) {
  return identity?.role === 'admin' && identity.username.toLowerCase() === ADMIN_USERNAME.toLowerCase();
}
async function requireAdmin(req, res, next) {
  const identity = verifySession(getCookie(req, 'camfed_admin_session'));
  if (!await activeAdmin(identity)) return res.status(401).json({ error:'Admin login required.' });
  req.auth = { ...identity, isPrimary: isPrimaryAdmin(identity) };
  next();
}
function requirePrimaryAdmin(req, res, next) {
  if (!req.auth?.isPrimary) return res.status(403).json({error:'Only the original administrator can create accounts.'});
  next();
}
async function requireUser(req, res, next) {
  const identity = verifySession(getCookie(req, 'camfed_user_session'));
  if (identity?.role !== 'user') return res.status(401).json({ error:'Provincial user login required.' });
  const current = await db.getProvincialUser(identity.username);
  if (!current) return res.status(401).json({ error:'This provincial account is no longer active. Please log in again.' });
  req.auth = { username:current.username, role:'user', province:current.province };
  next();
}
async function saveSignature(dataUrl, attendeeId) {
  if (!/^data:image\/png;base64,/.test(dataUrl || '')) throw new Error('Invalid signature image.');
  const buffer = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (buffer.length < 100 || buffer.length > 2 * 1024 * 1024) throw new Error('Signature image size is invalid.');
  const filename = `signature-${attendeeId}-${Date.now()}.png`;
  return storeImage(filename, buffer, 'image/png');
}
async function saveLivePhoto(dataUrl, attendeeId) {
  if (!/^data:image\/(jpeg|jpg|png);base64,/.test(dataUrl || '')) throw new Error('Invalid live photo image.');
  const match = dataUrl.match(/^data:image\/(jpeg|jpg|png);base64,/);
  const ext = match[1] === 'png' ? 'png' : 'jpg';
  const buffer = Buffer.from(dataUrl.replace(/^data:image\/(jpeg|jpg|png);base64,/, ''), 'base64');
  if (buffer.length < 100 || buffer.length > 5 * 1024 * 1024) throw new Error('Live photo size is invalid. Please retake the photo.');
  const filename = `photo-${attendeeId}-${Date.now()}.${ext}`;
  return storeImage(filename, buffer, `image/${ext === 'jpg' ? 'jpeg' : ext}`);
}
async function storeImage(filename, buffer, contentType) {
  if (process.env.VERCEL || process.env.NEON_STORAGE_BUCKET || process.env.AWS_S3_BUCKET) {
    await neonStorage.put(`attendees/${filename}`, buffer, contentType);
    return `attendees/${filename}`;
  }
  fs.writeFileSync(path.join(SIG_DIR, filename), buffer);
  return filename;
}
async function getStoredImage(key) {
  if (key && (key.startsWith('attendees/') || process.env.VERCEL)) return neonStorage.get(key);
  return fs.readFileSync(path.join(SIG_DIR, path.basename(key)));
}
async function removeStoredImage(key) {
  if (!key) return;
  if (key.startsWith('attendees/')) return neonStorage.remove(key);
  deleteStoredFile(SIG_DIR, key);
}
function findEventBySlug(slug) { return db.getEventBySlug(slug); }
const DEFAULT_REGISTRATION_HOURS = 2;
const MAX_REGISTRATION_HOURS = 720; // 30 days
const PROVINCES = ['Lusaka', 'Western', 'Central', 'Muchinga', 'Luapula', 'Northern', 'Eastern'];
function requestedProvince(value) { return PROVINCES.includes(String(value || '')) ? String(value) : null; }
function provinceForRequest(req) {
  if (req.auth?.role === 'user') return req.auth.province;
  return requestedProvince(req.query.province ?? req.body?.province);
}
function eventExpiryMs(event) {
  const configuredExpiry = Date.parse(event.registration_expires_at || '');
  if (Number.isFinite(configuredExpiry)) return configuredExpiry;
  const created = Date.parse(event.created_at || '');
  // Older records without a valid creation timestamp are closed safely rather than left open indefinitely.
  return Number.isFinite(created) ? created + DEFAULT_REGISTRATION_HOURS * 60 * 60 * 1000 : 0;
}
function isRegistrationExpired(event) { return Date.now() >= eventExpiryMs(event); }
function attendeesForEvent(eventId) { return db.listAttendeesForEvent(eventId); }

// Automatically remove attendee personal data three calendar months after registration.
// This includes the JSON record, signature/photo files, and generated PDFs containing those records.
const ATTENDEE_RETENTION_MONTHS = 3;
const RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
function subtractCalendarMonths(date, months) {
  const result = new Date(date);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}
function deleteStoredFile(directory, filename) {
  if (!filename) return;
  const safeName = path.basename(String(filename));
  const target = path.join(directory, safeName);
  try { if (fs.existsSync(target) && fs.statSync(target).isFile()) fs.unlinkSync(target); }
  catch (err) { console.error(`Could not delete expired attendee file ${safeName}:`, err.message); }
}
async function cleanupExpiredAttendees() {
  const now = new Date();
  const cutoff = subtractCalendarMonths(now, ATTENDEE_RETENTION_MONTHS);
  const expired = await db.deleteExpiredAttendees(cutoff);
  if (!expired.length) return 0;

  const affectedEventIds = new Set(expired.map(a => Number(a.event_id)));

  for (const attendee of expired) {
    await removeStoredImage(attendee.signature_file).catch(err => console.error('Could not remove expired signature:', err.message));
    await removeStoredImage(attendee.photo_file).catch(err => console.error('Could not remove expired photo:', err.message));
  }
  // PDFs may contain expired personal information. Remove them so an admin can
  // regenerate a fresh PDF containing only attendees still within retention.
  for (const eventId of affectedEventIds) {
    const event = await db.getEventById(eventId);
    if (event?.slug) deleteStoredFile(PDF_DIR, `${String(event.slug).replace(/[^a-z0-9-]/gi, '_')}-attendance.pdf`);
  }
  console.log(`Automatic retention cleanup deleted ${expired.length} attendee record(s) older than three calendar months.`);
  return expired.length;
}
function publicBaseUrl(req) {
  return String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}
async function buildCsv(event) {
  const rows = [
    ['Provider Id*', 'Reciever Msisdn*', 'Amount*', 'Remarks', 'Payer Wallet Type Id*(N-Normal/S-Salary)'],
    ...(await attendeesForEvent(event.id)).map(a => ['', a.phone_number, '', '', ''])
  ];
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
async function makeQrPdfBuffer(event, link) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&format=png&data=${encodeURIComponent(link)}`;
  const response = await fetch(qrUrl);
  if (!response.ok) throw new Error('Could not retrieve the QR code image. Check the server internet connection and try again.');
  const qrBuffer = Buffer.from(await response.arrayBuffer());
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 } });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  doc.font('Helvetica-Bold').fontSize(20).text('CAMFED Event Registration', { align: 'center' });
  doc.moveDown(0.8).font('Helvetica-Bold').fontSize(15).text(event.name, { align: 'center' });
  doc.moveDown(0.5).font('Helvetica').fontSize(11).text(`Date: ${event.date}\nVenue: ${event.venue}`, { align: 'center' });
  doc.image(qrBuffer, 170, 175, { fit: [270, 270], align: 'center' });
  doc.fontSize(11).text('Scan this QR code to register for the event', 50, 465, { align: 'center', width: 495 });
  doc.fontSize(9).text(link, 50, 490, { align: 'center', width: 495 });
  doc.end();
  return finished;
}

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));
const databaseReady = db.initializeDatabase(loadLegacyData());
app.use((req, res, next) => {
  // Keep the health endpoint available when database initialization itself
  // fails so deployments can report the actual dependency failure.
  if (req.path === '/api/test') return next();
  // Wait for schema initialization, but keep retention work out of the request
  // path. A transient storage/cleanup failure should not fail every API call.
  databaseReady.then(() => next(), next);
});
app.get('/api/test', async (req, res) => {
  if (!process.env.DATABASE_URL?.trim()) {
    return res.status(503).json({
      ok: false,
      database: 'disconnected',
      objectStorage: 'not checked',
      error: 'DATABASE_URL is missing from the deployment environment.',
    });
  }

  try {
    await getSql()`SELECT 1`;
    try {
      await neonStorage.check();
      res.json({ ok: true, database: 'connected', objectStorage: 'connected' });
    } catch (storageErr) {
      console.error('Neon Object Storage check failed:', storageErr.message);
      res.status(503).json({ ok: false, database: 'connected', objectStorage: 'disconnected', error: 'Neon Object Storage is unavailable. Check the storage endpoint, bucket name, and credential scopes.' });
    }
  } catch (err) {
    console.error('Neon connection check failed:', err.message);
    res.status(503).json({
      ok: false,
      database: 'disconnected',
      objectStorage: 'not checked',
      error: 'Neon is unreachable. Check DATABASE_URL and the Neon project status.',
    });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin-login.html')));
app.get('/admin/dashboard', async (req, res) => {
  if (!await activeAdmin(verifySession(getCookie(req, 'camfed_admin_session')))) return res.redirect('/admin');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});
app.get('/user', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'user-login.html')));
app.get('/user/dashboard', async (req, res) => {
  const identity = verifySession(getCookie(req, 'camfed_user_session'));
  if (identity?.role !== 'user') return res.redirect('/user');
  if (!await db.getProvincialUser(identity.username)) return res.redirect('/user');
  res.sendFile(path.join(PUBLIC_DIR, 'user-dashboard.html'));
});
app.get('/registration-success', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'success.html')));
app.get('/registration-details', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'attendee-details.html')));
app.get('/api/registration-details/:token', async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).json({ error: 'Registration details could not be found.' });
  const attendee = await db.getAttendeeByToken(token);
  if (!attendee) return res.status(404).json({ error: 'Registration details could not be found.' });
  const event = await db.getEventById(attendee.event_id);
  res.json({ fullName: attendee.full_name, gender: attendee.gender, designation: attendee.designation, organisation: attendee.organisation, phoneNumber: attendee.phone_number, nrcNumber: attendee.nrc_number, district: attendee.district, mobileRegisteredName: attendee.mobile_registered_name, registeredAt: attendee.created_at, eventName: event ? event.name : 'CAMFED event', eventDate: event ? event.date : '', venue: event ? event.venue : '' });
});
app.get('/admin.html', (req, res) => res.redirect('/admin/dashboard'));
app.get('/admin-login.html', (req,res) => res.redirect('/admin'));
app.get('/user-login.html', (req,res) => res.redirect('/user'));
app.get('/user-dashboard.html', (req,res) => res.redirect('/user/dashboard'));
app.get('/register', async (req, res) => {
  const event = await db.getLatestEvent();
  return event ? res.redirect(`/register/${encodeURIComponent(event.slug)}`) : res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
});
app.get('/register/:slug', async (req, res) => {
  if (!await findEventBySlug(req.params.slug)) return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
});
app.use(express.static(PUBLIC_DIR));

app.get('/api/event/:slug', async (req, res) => {
  const e = await findEventBySlug(req.params.slug);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  res.json({ id:e.id, name:e.name, date:e.date, venue:e.venue, slug:e.slug, expiresAt:new Date(eventExpiryMs(e)).toISOString(), expired:isRegistrationExpired(e) });
});
app.get('/api/event', async (req, res) => {
  const e = await db.getLatestEvent();
  if (!e) return res.status(404).json({ error: 'No event has been created yet.' });
  res.json({ id:e.id, name:e.name, date:e.date, venue:e.venue, slug:e.slug, expiresAt:new Date(eventExpiryMs(e)).toISOString(), expired:isRegistrationExpired(e) });
});

app.post('/api/attendees', async (req, res) => {
  const b = req.body;
  const required = ['fullName','gender','designation','organisation','phoneNumber','nrcNumber','district','mobileRegisteredName','signature','livePhoto'];
  if (required.some(k => !String(b[k] || '').trim())) return res.status(400).json({ error: 'Please complete all required fields.' });
  const event = b.eventSlug ? await findEventBySlug(b.eventSlug) : await db.getLatestEvent();
  if (!event) return res.status(400).json({ error: 'No event is available for registration.' });
  if (isRegistrationExpired(event)) return res.status(410).json({ error: 'Registration for this event has expired. Please contact the event administrator.' });
  const phone = String(b.phoneNumber).trim();
  const nrc = String(b.nrcNumber).trim();
  if (!/^(09|07)[0-9]{8}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Zambian mobile number, e.g. 0971234567.' });
  if (!/^[0-9]{6}\/[0-9]{2}\/[0-9]$/.test(nrc)) return res.status(400).json({ error: 'Enter NRC in the format 123456/12/1.' });
  // Prevent duplicate registrations for the same event. Phone and NRC are unique identifiers.
  const eventAttendees = await attendeesForEvent(event.id);
  if (eventAttendees.some(a => String(a.phone_number).trim() === phone)) {
    return res.status(409).json({ error: 'This phone number is already registered for this event. Please check the details or contact the event administrator.' });
  }
  if (eventAttendees.some(a => String(a.nrc_number).trim().toLowerCase() === nrc.toLowerCase())) {
    return res.status(409).json({ error: 'This NRC number is already registered for this event. Please check the details or contact the event administrator.' });
  }
  // Enforce GPS on the server before saving any signature or attendee details.
  const latitude = b.latitude === undefined || b.latitude === null ? NaN : Number(b.latitude);
  const longitude = b.longitude === undefined || b.longitude === null ? NaN : Number(b.longitude);
  const accuracy = b.accuracy === undefined || b.accuracy === null ? null : Number(b.accuracy);
  const hasValidGps = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  if (!hasValidGps) return res.status(400).json({ error: 'GPS location is required. Registration is blocked until location permission is granted and valid coordinates are available. No attendee details have been saved.' });
  const confirmationToken = crypto.randomBytes(32).toString('hex');
  const uploadId = crypto.randomUUID();
  let signatureFile;
  let photoFile;
  try {
    signatureFile = await saveSignature(String(b.signature), uploadId);
    photoFile = await saveLivePhoto(String(b.livePhoto), uploadId);
  } catch (e) {
    // Clean up a partial image if either image fails validation.
    for (const filename of [signatureFile, photoFile]) {
      if (filename) {
        await removeStoredImage(filename).catch(() => {});
      }
    }
    return res.status(400).json({ error: e.message });
  }
  let attendee;
  try {
    attendee = await db.createAttendee({ full_name:String(b.fullName).trim(), gender:String(b.gender).trim(), designation:String(b.designation).trim(), organisation:String(b.organisation).trim(), phone_number:phone, nrc_number:nrc, district:String(b.district).trim(), mobile_registered_name:String(b.mobileRegisteredName).trim(), signature_file:signatureFile, photo_file:photoFile, event_id:event.id, latitude, longitude, gps_accuracy_m:Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null, gps_captured_at:b.locationCapturedAt ? String(b.locationCapturedAt).slice(0, 40) : null, confirmation_token:confirmationToken, created_at:new Date().toISOString() });
  } catch (e) {
    console.error('Could not save attendee registration:', e);
    for (const filename of [signatureFile, photoFile]) {
      await removeStoredImage(filename).catch(() => {});
    }
    if (e.code === '23505') return res.status(409).json({ error: 'This phone number or NRC number is already registered for this event.' });
    return res.status(500).json({ error: 'Registration could not be saved to the database. Please try again.' });
  }
  res.status(201).json({ message:'Registration successful.', id: attendee.id, confirmationToken });
});

app.post('/api/admin/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  let authenticatedUsername = null;
  if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && password === ADMIN_PASSWORD) authenticatedUsername = ADMIN_USERNAME;
  if (!authenticatedUsername) {
    const admin = await db.getAdminUser(username);
    if (admin) {
      const hash = await new Promise((resolve,reject)=>crypto.scrypt(password,admin.password_salt,64,(err,key)=>err?reject(err):resolve(key.toString('hex'))));
      if (crypto.timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(admin.password_hash,'hex'))) authenticatedUsername = admin.username;
    }
  }
  if (!authenticatedUsername) return res.status(401).json({ error:'Invalid admin username or password.' });
  const identity = { username:authenticatedUsername, role:'admin', province:null };
  res.setHeader('Set-Cookie', `camfed_admin_session=${encodeURIComponent(signSession(identity))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
  res.json({ message:'Admin login successful.' });
});
app.post('/api/user/login', async (req,res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const selectedProvince = requestedProvince(req.body.province);
  const user = await db.getProvincialUser(username);
  if (!user) return res.status(401).json({error:'Invalid username or password.'});
  const hash = await new Promise((resolve,reject)=>crypto.scrypt(password,user.password_salt,64,(err,key)=>err?reject(err):resolve(key.toString('hex'))));
  if (!crypto.timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(user.password_hash,'hex'))) return res.status(401).json({error:'Invalid username or password.'});
  if (!selectedProvince) return res.status(400).json({error:'Select your assigned province to continue.'});
  if (selectedProvince !== user.province) return res.status(403).json({error:'The selected province does not match this account.'});
  const identity = {username:user.username,role:'user',province:user.province};
  res.setHeader('Set-Cookie',`camfed_user_session=${encodeURIComponent(signSession(identity))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
  res.json({message:'Provincial login successful.'});
});
app.post('/api/admin/logout', (req,res) => { res.setHeader('Set-Cookie','camfed_admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({message:'Admin logged out.'}); });
app.post('/api/user/logout', (req,res) => { res.setHeader('Set-Cookie','camfed_user_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({message:'Provincial user logged out.'}); });
app.get('/api/admin/me', requireAdmin, (req,res) => res.json(req.auth));
app.get('/api/user/me', requireUser, (req,res) => res.json(req.auth));
app.get('/api/admin/accounts/admins', requireAdmin, async (req,res) => {
  const admins = await db.listAdminUsers();
  res.json([{username:ADMIN_USERNAME,created_at:null,isPrimary:true},...admins]);
});
app.post('/api/admin/accounts/admins', requireAdmin, requirePrimaryAdmin, async (req,res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (username.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) return res.status(400).json({error:'Enter a valid email address to use as the admin username.'});
  if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) return res.status(409).json({error:'That email is already reserved for the primary administrator.'});
  if (password.length < 10) return res.status(400).json({error:'Password must be at least 10 characters.'});
  if (await db.getProvincialUser(username)) return res.status(409).json({error:'That email is already assigned to a provincial account.'});
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,(err,key)=>err?reject(err):resolve(key.toString('hex'))));
  try { res.status(201).json(await db.createAdminUser({username,password_salt:salt,password_hash:passwordHash,created_at:new Date().toISOString()})); }
  catch (err) { if (err.code === '23505') return res.status(409).json({error:'That admin email is already in use.'}); throw err; }
});
app.patch('/api/admin/accounts/admins/:id', requireAdmin, requirePrimaryAdmin, async (req,res) => {
  const id = Number(req.params.id);
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({error:'Invalid admin account.'});
  if (username.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) return res.status(400).json({error:'Enter a valid email address to use as the admin username.'});
  if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) return res.status(409).json({error:'That email is reserved for the original administrator.'});
  if (password && password.length < 10) return res.status(400).json({error:'Password must be at least 10 characters.'});
  if (await db.getProvincialUser(username)) return res.status(409).json({error:'That email is already assigned to a provincial account.'});
  const existing = (await db.listAdminUsers()).find(a => a.id === id);
  if (!existing) return res.status(404).json({error:'Additional admin account not found.'});
  if ((await db.listAdminUsers()).some(a => a.id !== id && a.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({error:'That admin email is already in use.'});
  let credentials = {};
  if (password) {
    const password_salt = crypto.randomBytes(16).toString('hex');
    credentials = {password_salt, password_hash:await new Promise((resolve,reject)=>crypto.scrypt(password,password_salt,64,(err,key)=>err?reject(err):resolve(key.toString('hex'))))};
  }
  try { res.json(await db.updateAdminUser(id, {username, ...credentials})); }
  catch (err) { if (err.code === '23505') return res.status(409).json({error:'That admin email is already in use.'}); throw err; }
});
app.delete('/api/admin/accounts/admins/:id', requireAdmin, requirePrimaryAdmin, async (req,res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({error:'Invalid admin account.'});
  if (!await db.deleteAdminUser(id)) return res.status(404).json({error:'Additional admin account not found.'});
  res.json({message:'Admin account deleted.'});
});
app.get('/api/admin/users', requireAdmin, async (req,res) => res.json(await db.listProvincialUsers()));
app.post('/api/admin/users', requireAdmin, requirePrimaryAdmin, async (req,res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const province = requestedProvince(req.body.province);
  if (username.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) return res.status(400).json({ error:'Enter a valid email address to use as the username.' });
  if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) return res.status(400).json({ error:'That username is reserved for the administrator.' });
  if (await db.getAdminUser(username)) return res.status(409).json({error:'That email is already assigned to an admin account.'});
  if (password.length < 10) return res.status(400).json({ error:'Password must be at least 10 characters.' });
  if (!province) return res.status(400).json({ error:'Select a valid province.' });
  if ((await db.listProvincialUsers()).some(user => user.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error:'That username is already in use.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,(err,key)=>err?reject(err):resolve(key.toString('hex'))));
  try { res.status(201).json(await db.createProvincialUser({ username, province, password_salt:salt, password_hash:passwordHash, created_at:new Date().toISOString() })); }
  catch (err) { if (err.code === '23505') return res.status(409).json({error:'That username is already in use.'}); throw err; }
});
app.patch('/api/admin/users/:id', requireAdmin, async (req,res) => {
  const username = String(req.body.username || '').trim();
  const province = requestedProvince(req.body.province);
  const password = String(req.body.password || '');
  if (username.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) || username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) return res.status(400).json({error:'Enter a valid email address to use as the username.'});
  if (await db.getAdminUser(username)) return res.status(409).json({error:'That email is already assigned to an admin account.'});
  if (!province) return res.status(400).json({error:'Select a valid province.'});
  if (password && password.length < 10) return res.status(400).json({error:'Password must be at least 10 characters.'});
  const duplicate = (await db.listProvincialUsers()).find(user => user.username.toLowerCase() === username.toLowerCase() && user.id !== Number(req.params.id));
  if (duplicate) return res.status(409).json({error:'That username is already in use.'});
  let password_salt = null, password_hash = null;
  if (password) { password_salt = crypto.randomBytes(16).toString('hex'); password_hash = await new Promise((resolve,reject)=>crypto.scrypt(password,password_salt,64,(err,key)=>err?reject(err):resolve(key.toString('hex')))); }
  const user = await db.updateProvincialUser(req.params.id,{username,province,password_salt,password_hash});
  if (!user) return res.status(404).json({error:'Provincial user not found.'});
  res.json(user);
});
app.delete('/api/admin/users/:id', requireAdmin, async (req,res) => {
  if (!await db.deleteProvincialUser(req.params.id)) return res.status(404).json({error:'Provincial user not found.'});
  res.json({message:'Provincial user deleted.'});
});
app.get('/api/admin/events', requireAdmin, async (req,res) => {
  const province = provinceForRequest(req);
  if (!province) return res.status(400).json({ error: 'Select a valid province.' });
  res.json(await db.listEvents(province));
});
app.post('/api/admin/events', requireAdmin, async (req,res) => {
  const {name,date,venue}=req.body;
  const province = provinceForRequest(req);
  if (!province) return res.status(400).json({error:'Select a valid province.'});
  const hours = Number(req.body.registrationHours ?? DEFAULT_REGISTRATION_HOURS);
  if (!String(name||'').trim() || !String(date||'').trim() || !String(venue||'').trim()) return res.status(400).json({error:'Event name, date and venue are required.'});
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_REGISTRATION_HOURS) return res.status(400).json({error:`Registration link validity must be a whole number from 1 to ${MAX_REGISTRATION_HOURS} hours.`});
  const createdAt = new Date();
  const e=await db.createEvent({name:String(name).trim(),date:String(date).trim(),venue:String(venue).trim(),province,slug:await uniqueSlug(name),created_at:createdAt.toISOString(),registration_hours:hours,registration_expires_at:new Date(createdAt.getTime()+hours*60*60*1000).toISOString()});
  const link = `${publicBaseUrl(req)}/register/${e.slug}`;
  res.status(201).json({id:e.id,slug:e.slug,link,expiresAt:e.registration_expires_at,registrationHours:hours,message:`Event created. The registration link will expire in ${hours} hour(s). Share the link or download the QR-code PDF from the event card.`});
});
app.patch('/api/admin/events/:id/expiry', requireAdmin, async (req,res) => {
  const province = provinceForRequest(req);
  if (!province || !await db.getEventById(req.params.id, province)) return res.status(404).json({error:'Event not found in this province.'});
  const hours = Number(req.body.registrationHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_REGISTRATION_HOURS) return res.status(400).json({error:`Registration link validity must be a whole number from 1 to ${MAX_REGISTRATION_HOURS} hours.`});
  const event = await db.updateEventExpiry(req.params.id, hours, new Date(Date.now() + hours * 60 * 60 * 1000).toISOString());
  if (!event) return res.status(404).json({error:'Event not found.'});
  res.json({id:event.id, registrationHours:hours, expiresAt:event.registration_expires_at, expired:false, message:`Registration link updated. It will expire in ${hours} hour(s) from now.`});
});
app.delete('/api/admin/events/:id', requireAdmin, async (req,res) => {
  const eventId = Number(req.params.id);
  const province = provinceForRequest(req);
  const event = province && await db.getEventById(eventId, province);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  // Remove attendee records and their signature images together with the event.
  const removedAttendees = await attendeesForEvent(eventId);
  for (const attendee of removedAttendees) {
    for (const imageFile of [attendee.signature_file, attendee.photo_file]) {
      await removeStoredImage(imageFile);
    }
  }
  await db.deleteEvent(eventId);

  // Remove this event's generated attendance PDF, if one exists.
  const safeSlug = String(event.slug || '').replace(/[^a-z0-9-]/gi, '_');
  const pdfPath = path.join(PDF_DIR, `${safeSlug}-attendance.pdf`);
  if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

  res.json({ message: 'Event and its attendee records deleted.', deletedAttendees: removedAttendees.length });
});
app.get('/api/admin/events/:id/attendees', requireAdmin, async (req,res) => {
  const province = provinceForRequest(req);
  const e=province && await db.getEventById(req.params.id, province); if(!e)return res.status(404).json({error:'Event not found in this province.'});
  res.json({event:e,attendees:await attendeesForEvent(e.id)});
});
function csvCell(value) {
  // Quote every cell and escape embedded quotes. Keep phone numbers as text in the CSV.
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}
app.get('/api/admin/events/:id/csv', requireAdmin, async (req,res) => {
  const province = provinceForRequest(req);
  const e = province && await db.getEventById(req.params.id, province);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  const safe = e.slug.replace(/[^a-z0-9-]/gi, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}-attendees.csv"`);
  res.send(await buildCsv(e));
});
app.get('/api/admin/events/:id/eprf', requireAdmin, async (req, res) => {
  const province = provinceForRequest(req);
  const event = province && await db.getEventById(req.params.id, province);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const attendees = await attendeesForEvent(event.id);
  if (!attendees.length) return res.status(400).json({ error: 'No participants are registered for this event yet.' });
  try {
    const templatePath = path.join(ROOT, 'templates', 'EPRF.xlsx');
    if (!fs.existsSync(templatePath)) throw new Error('The EPRF template file is missing from the templates folder.');
    const workbook = createEprfWorkbook(attendees, templatePath, event);
    const safeEventName = String(event.name || 'Event').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    const filename = `EPRF – ${safeEventName || 'Event'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="EPRF.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(workbook);
  } catch (err) {
    console.error('EPRF document generation failed:', err);
    res.status(500).json({ error: 'EPRF document generation failed. Please check that the EPRF template is valid.' });
  }
});
app.delete('/api/admin/attendees/:id', requireAdmin, async (req,res) => {
  const province = provinceForRequest(req);
  const existing = await db.getAttendeeById(req.params.id);
  const owningEvent = existing && await db.getEventById(existing.event_id, province);
  if (!owningEvent) return res.status(404).json({ error: 'Attendee not found in this province.' });
  const a=await db.deleteAttendee(req.params.id); if(!a)return res.status(404).json({error:'Attendee not found.'});
  for(const f of [a.signature_file,a.photo_file]) await removeStoredImage(f);
  res.json({message:'Attendee deleted.'});
});

function fitText(doc,text,x,y,width,options={}){
  const size=options.size||7;
  doc.font(options.font||'Helvetica').fontSize(size);
  doc.text(String(text??''),x,y,{width,height:options.height||20,ellipsis:true,align:options.align||'left',lineBreak:false,continued:false});
}
async function makePdf(event,attendees,filePath){
  const doc=new PDFDocument({size:'A4',layout:'landscape',margins:{top:28,bottom:28,left:28,right:28},bufferPages:true});
  const stream=fs.createWriteStream(filePath);doc.pipe(stream);
  const logoPath=path.join(PUBLIC_DIR,'images','camfed-logo.png');

  // A4 landscape printable width = 842 - 56 = 786 points.
  // All 11 columns total exactly 786 points, including the live photo.
  const cols=[22,82,38,62,80,55,58,54,70,110,155];
  const headers=['No.','Full Name','Gender','Designation','Organisation','Phone','NRC Number','District','Mobile Name','Signature','Live Photo'];
  const tableX=28, pageBottom=535, headerH=20, rowH=21, rowsPerPage=20;

  function pageWatermark(){
    if(!fs.existsSync(logoPath)) return;
    doc.save();
    doc.opacity(0.08);
    doc.image(logoPath,170,180,{fit:[650,325],align:'center',valign:'center'});
    doc.restore();
  }
  function pageHeader(){
    pageWatermark();
    if(fs.existsSync(logoPath)) {
      // Preserve the original register logo and place the supplementary mark
      // in the unused far-right strip of the header.
      doc.image(logoPath,28,22,{fit:[115,45]});
      doc.image(logoPath,768,20,{fit:[42,24]});
    }
    doc.font('Helvetica-Bold').fontSize(16).text('CAMFED ATTENDANCE REGISTER',155,28,{width:600,align:'center'});
    doc.font('Helvetica').fontSize(9).text(event.name,155,49,{width:600,align:'center'});
    doc.fontSize(8).text(`Province: ${event.province || 'Lusaka'}    Date: ${event.date}    Venue: ${event.venue}    Total: ${attendees.length}`,155,64,{width:600,align:'center'});
    doc.font('Helvetica-Bold').fontSize(5).fillColor('#087742').text('Learn, Thrive & Lead for Change',760,47,{width:54,align:'center'}).fillColor('#000000');
    let x=tableX;
    headers.forEach((h,i)=>{
      doc.rect(x,82,cols[i],headerH).stroke();
      fitText(doc,h,x+2,87,cols[i]-4,{font:'Helvetica-Bold',size:5.8,height:10,align:'center'});
      x+=cols[i];
    });
  }

  let y=102;
  let rowOnPage=0;
  pageHeader();
  for (const [index, a] of attendees.entries()) {
    if(rowOnPage >= rowsPerPage || y+rowH>pageBottom){doc.addPage();pageHeader();y=102;rowOnPage=0;}
    // All registered details are kept on ONE horizontal row for each person.
    const vals=[
      index+1,
      a.full_name,
      a.gender,
      a.designation,
      a.organisation,
      a.phone_number,
      a.nrc_number,
      a.district,
      a.mobile_registered_name,
      '',
      ''
    ];
    let x=tableX;
    for (const [i, v] of vals.entries()) {
      doc.rect(x,y,cols[i],rowH).stroke();
      if(i===9){
        if(a.signature_file) {
          try { doc.image(await getStoredImage(a.signature_file),x+4,y+4,{fit:[cols[i]-8,rowH-8],align:'center',valign:'center'}); }
          catch(imageErr) { console.error('Skipping unreadable signature image for attendee',a.id,imageErr.message); }
        }
      } else if(i===10){
        if(a.photo_file) {
          try { doc.image(await getStoredImage(a.photo_file),x+4,y+2,{fit:[cols[i]-8,rowH-4],align:'center',valign:'center'}); }
          catch(imageErr) { console.error('Skipping unreadable live photo for attendee',a.id,imageErr.message); }
        }
      } else {
        fitText(doc,v,x+2,y+5,cols[i]-4,{size:i===1?5.7:5.5,height:11,align:i===0?'center':'left'});
      }
      x+=cols[i];
    }
    y+=rowH;
    rowOnPage++;
  }

  const range=doc.bufferedPageRange();
  for(let i=range.start;i<range.start+range.count;i++){
    doc.switchToPage(i);
    // Keep the footer above PDFKit's bottom-margin boundary (567pt). Writing
    // at 570pt caused PDFKit to append an otherwise empty page at doc.end().
    doc.font('Helvetica').fontSize(7).text(`CAMFED Attendance Register  |  Page ${i+1} of ${range.count}`,28,550,{width:785,align:'center'});
  }
  doc.end();
  return new Promise((resolve,reject)=>{stream.on('finish',()=>resolve(filePath));stream.on('error',reject);});
}
app.get('/api/admin/events/:id/pdf',requireAdmin,async(req,res)=>{const province=provinceForRequest(req);const e=province&&await db.getEventById(req.params.id,province);if(!e)return res.status(404).json({error:'Event not found in this province.'});const a=await attendeesForEvent(e.id);if(!a.length)return res.status(400).json({error:'No attendee details are available yet, so an attendance PDF cannot be generated.'});const safe=e.slug.replace(/[^a-z0-9-]/gi,'_');const filePath=path.join(PDF_DIR,`${safe}-attendance.pdf`);try{await makePdf(e,a,filePath);res.download(filePath,`${safe}-attendance.pdf`);}catch(err){console.error(err);res.status(500).json({error:'PDF generation failed.'});}});

// Provincial-user API: this namespace accepts only the independent user session.
app.get('/api/user/events', requireUser, async (req,res) => res.json(await db.listEvents(req.auth.province)));
app.post('/api/user/events', requireUser, async (req,res) => {
  const {name,date,venue} = req.body;
  const hours = DEFAULT_REGISTRATION_HOURS;
  if (!String(name || '').trim() || !String(date || '').trim() || !String(venue || '').trim()) return res.status(400).json({error:'Event name, date and venue are required.'});
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_REGISTRATION_HOURS) return res.status(400).json({error:`Registration link validity must be a whole number from 1 to ${MAX_REGISTRATION_HOURS} hours.`});
  const createdAt = new Date();
  const event = await db.createEvent({name:String(name).trim(),date:String(date).trim(),venue:String(venue).trim(),province:req.auth.province,slug:await uniqueSlug(name),created_at:createdAt.toISOString(),registration_hours:hours,registration_expires_at:new Date(createdAt.getTime()+hours*60*60*1000).toISOString()});
  const link = `${publicBaseUrl(req)}/register/${event.slug}`;
  res.status(201).json({id:event.id,slug:event.slug,link,expiresAt:event.registration_expires_at,registrationHours:hours,message:`Event created. The registration link will expire in ${hours} hour(s).`});
});
app.patch('/api/user/events/:id/expiry', requireUser, (req,res) => res.status(403).json({error:'Only an administrator can change an event registration expiry.'}));
app.get('/api/user/events/:id/attendees', requireUser, async (req,res) => {
  const event = await db.getEventById(req.params.id,req.auth.province);
  if (!event) return res.status(404).json({error:'Event not found in your province.'});
  const attendees = await attendeesForEvent(event.id);
  const provinceVisibleAttendees = attendees.map(({latitude,longitude,gps_accuracy_m,gps_captured_at,...attendee}) => attendee);
  res.json({event,attendees:provinceVisibleAttendees});
});
app.get('/api/user/events/:id/csv', requireUser, async (req,res) => {
  const event = await db.getEventById(req.params.id,req.auth.province);
  if (!event) return res.status(404).json({error:'Event not found in your province.'});
  const safe = event.slug.replace(/[^a-z0-9-]/gi,'_');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="${safe}-attendees.csv"`);
  res.send(await buildCsv(event));
});
app.get('/api/user/events/:id/eprf', requireUser, async (req,res) => {
  const event = await db.getEventById(req.params.id,req.auth.province);
  if (!event) return res.status(404).json({error:'Event not found in your province.'});
  const attendees = await attendeesForEvent(event.id);
  if (!attendees.length) return res.status(400).json({error:'No participants are registered for this event yet.'});
  try {
    const templatePath = path.join(ROOT,'templates','EPRF.xlsx');
    if (!fs.existsSync(templatePath)) throw new Error('The EPRF template file is missing.');
    const workbook = createEprfWorkbook(attendees,templatePath,event);
    const safeName = String(event.name || 'Event').replace(/[\\/:*?"<>|\r\n]+/g,' ').replace(/\s+/g,' ').trim();
    const filename = `EPRF – ${safeName || 'Event'}.xlsx`;
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="EPRF.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(workbook);
  } catch (err) { console.error('EPRF document generation failed:',err); res.status(500).json({error:'EPRF document generation failed.'}); }
});
app.delete('/api/user/attendees/:id', requireUser, async (req,res) => {
  const attendee = await db.getAttendeeById(req.params.id);
  const event = attendee && await db.getEventById(attendee.event_id,req.auth.province);
  if (!event) return res.status(404).json({error:'Attendee not found in your province.'});
  const removed = await db.deleteAttendee(req.params.id);
  if (!removed) return res.status(404).json({error:'Attendee not found.'});
  for (const file of [removed.signature_file,removed.photo_file]) await removeStoredImage(file);
  res.json({message:'Attendee deleted.'});
});
app.get('/api/user/events/:id/pdf', requireUser, async (req,res) => {
  const event = await db.getEventById(req.params.id,req.auth.province);
  if (!event) return res.status(404).json({error:'Event not found in your province.'});
  const attendees = await attendeesForEvent(event.id);
  if (!attendees.length) return res.status(400).json({error:'No attendee details are available yet, so an attendance PDF cannot be generated.'});
  const safe = event.slug.replace(/[^a-z0-9-]/gi,'_');
  const filePath = path.join(PDF_DIR,`${safe}-attendance.pdf`);
  try { await makePdf(event,attendees,filePath); res.download(filePath,`${safe}-attendance.pdf`); }
  catch (err) { console.error(err); res.status(500).json({error:'PDF generation failed.'}); }
});

app.use((req,res,next)=>{if(req.method==='GET'&&req.accepts('html'))return res.status(404).sendFile(path.join(PUBLIC_DIR,'404.html'));next();});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  const errorStatus = err.statusCode || err.status;
  const status = Number.isInteger(errorStatus) && errorStatus >= 400 && errorStatus < 500
    ? errorStatus
    : 500;
  // Body parser errors (invalid JSON / payload too large) should be reported as
  // client errors rather than appearing as server crashes.
  const message = status === 400
    ? 'Invalid request body.'
    : status === 413
      ? 'Request body is too large.'
      : 'Internal server error.';
  console.error(`Request failed (${req.method} ${req.originalUrl}, ${status}):`, err);
  res.status(status).json({ error: message });
});

let server;
// Vercel detects and invokes the exported Express app as a serverless function.
// Local installations still start their own HTTP listener below.
module.exports = app;
databaseReady.then(async () => {
  await cleanupExpiredAttendees().catch(err => console.error('Initial attendee retention cleanup failed:', err.message));
  setInterval(() => cleanupExpiredAttendees().catch(err => console.error('Attendee retention check failed:', err.message)), RETENTION_CHECK_INTERVAL_MS).unref();
  if (process.env.VERCEL) return;
  server = app.listen(PORT,()=>{console.log(`CAMFED Attendance System running at http://localhost:${PORT}`);console.log(`Admin: http://localhost:${PORT}/admin`);console.log(`Login username: ${ADMIN_USERNAME}`);console.log(`Login password: ${ADMIN_PASSWORD}`);});
}).catch(err => {
  console.error('Could not initialize Neon database:', err.message);
  // A serverless function can still serve /api/test and report the database
  // failure. Local mode has no useful listener if initialization failed.
  if (!process.env.VERCEL) process.exitCode = 1;
});
function shutdown(){if (server) server.close(()=>process.exit(0)); else process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
