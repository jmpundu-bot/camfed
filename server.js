const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
// Vercel's deployment filesystem is read-only. Use /tmp at runtime unless
// an explicit DATA_ROOT is supplied (for local/Render deployments).
const IS_VERCEL = process.env.VERCEL === '1' || Boolean(process.env.VERCEL);
const DATA_ROOT = process.env.DATA_ROOT || (IS_VERCEL ? path.join('/tmp', 'camfed-attendance') : path.join(ROOT, 'storage'));
const DATA_DIR = DATA_ROOT;
const SIG_DIR = path.join(DATA_ROOT, 'signatures');
const PDF_DIR = path.join(DATA_ROOT, 'pdfs');
const DATA_FILE = path.join(DATA_ROOT, 'data.json');

function ensureRuntimeDirs() {
  [DATA_DIR, SIG_DIR, PDF_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));
}
try {
  ensureRuntimeDirs();
} catch (e) {
  console.error('Could not create runtime storage directories:', e.message);
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const seedFile = path.join(ROOT, 'data', 'data.json');
    if (fs.existsSync(seedFile)) {
      try {
        const seeded = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        return { nextEventId: seeded.nextEventId || 1, nextAttendeeId: seeded.nextAttendeeId || 1, events: seeded.events || [], attendees: seeded.attendees || [] };
      } catch {}
    }
    return { nextEventId: 1, nextAttendeeId: 1, events: [], attendees: [] };
  }
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { nextEventId: d.nextEventId || 1, nextAttendeeId: d.nextAttendeeId || 1, events: d.events || [], attendees: d.attendees || [] };
  } catch (e) {
    console.error('Could not read data.json:', e.message);
    return { nextEventId: 1, nextAttendeeId: 1, events: [], attendees: [] };
  }
}
let data = loadData();
function saveData() {
  try {
    ensureRuntimeDirs();
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
    return true;
  } catch (e) {
    // Vercel instances have ephemeral runtime storage. Keep the in-memory
    // data available for the lifetime of the function instance.
    console.warn('Runtime data could not be persisted to disk:', e.message);
    return false;
  }
}

function slugify(value) { return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70); }
function uniqueSlug(name) {
  const base = slugify(name) || 'event'; let slug = base; let n = 2;
  while (data.events.some(e => e.slug === slug)) slug = `${base}-${n++}`;
  return slug;
}
function signSession(username) {
  const payload = Buffer.from(JSON.stringify({ username, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
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
    return d.username === ADMIN_USERNAME && d.exp > Date.now();
  } catch { return false; }
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}
function requireAdmin(req, res, next) {
  if (!verifySession(getCookie(req, 'camfed_session'))) return res.status(401).json({ error: 'Admin login required.' });
  next();
}
function saveSignature(dataUrl, attendeeId) {
  if (!/^data:image\/png;base64,/.test(dataUrl || '')) throw new Error('Invalid signature image.');
  const buffer = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (buffer.length < 100 || buffer.length > 2 * 1024 * 1024) throw new Error('Signature image size is invalid.');
  const filename = `signature-${attendeeId}-${Date.now()}.png`;
  ensureRuntimeDirs();
  fs.writeFileSync(path.join(SIG_DIR, filename), buffer);
  return filename;
}
function findEventBySlug(slug) { return data.events.find(e => e.slug === slug); }
function attendeesForEvent(eventId) { return data.attendees.filter(a => a.event_id === Number(eventId)).sort((a,b) => a.id-b.id); }

app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/admin.html', (req, res) => res.redirect('/admin'));
app.get('/register', (req, res) => {
  const event = [...data.events].sort((a,b) => b.id-a.id)[0];
  return event ? res.redirect(`/register/${encodeURIComponent(event.slug)}`) : res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
});
app.get('/register/:slug', (req, res) => {
  if (!findEventBySlug(req.params.slug)) return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
});
app.use(express.static(PUBLIC_DIR));

app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/api/event/:slug', (req, res) => {
  const e = findEventBySlug(req.params.slug);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  res.json({ id:e.id, name:e.name, date:e.date, venue:e.venue, slug:e.slug });
});
app.get('/api/event', (req, res) => {
  const e = [...data.events].sort((a,b) => b.id-a.id)[0];
  if (!e) return res.status(404).json({ error: 'No event has been created yet.' });
  res.json({ id:e.id, name:e.name, date:e.date, venue:e.venue, slug:e.slug });
});

app.post('/api/attendees', (req, res) => {
  const b = req.body;
  const required = ['fullName','gender','designation','organisation','phoneNumber','nrcNumber','district','mobileRegisteredName','signature'];
  if (required.some(k => !String(b[k] || '').trim())) return res.status(400).json({ error: 'Please complete all required fields.' });
  const event = b.eventSlug ? findEventBySlug(b.eventSlug) : [...data.events].sort((a,b) => b.id-a.id)[0];
  if (!event) return res.status(400).json({ error: 'No event is available for registration.' });
  const phone = String(b.phoneNumber).trim();
  const nrc = String(b.nrcNumber).trim();
  if (!/^(09|07)[0-9]{8}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Zambian mobile number, e.g. 0971234567.' });
  if (!/^[0-9]{6}\/[0-9]{2}\/[0-9]$/.test(nrc)) return res.status(400).json({ error: 'Enter NRC in the format 123456/12/1.' });
  const id = data.nextAttendeeId++;
  let signatureFile;
  try { signatureFile = saveSignature(String(b.signature), id); } catch (e) { return res.status(400).json({ error: e.message }); }
  data.attendees.push({ id, full_name:String(b.fullName).trim(), gender:String(b.gender).trim(), designation:String(b.designation).trim(), organisation:String(b.organisation).trim(), phone_number:phone, nrc_number:nrc, district:String(b.district).trim(), mobile_registered_name:String(b.mobileRegisteredName).trim(), signature_file:signatureFile, event_id:event.id, created_at:new Date().toISOString() });
  saveData();
  res.status(201).json({ message:'Registration successful.', id });
});

app.post('/api/admin/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid username or password.' });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `camfed_session=${encodeURIComponent(signSession(username))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure}`);
  res.json({ message:'Login successful.' });
});
app.post('/api/admin/logout', (req,res) => { const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''; res.setHeader('Set-Cookie',`camfed_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`); res.json({message:'Logged out.'}); });
app.get('/api/admin/me', requireAdmin, (req,res) => res.json({ username:ADMIN_USERNAME }));
app.get('/api/admin/events', requireAdmin, (req,res) => res.json([...data.events].sort((a,b)=>b.id-a.id).map(e => ({...e, attendee_count:attendeesForEvent(e.id).length}))));
app.post('/api/admin/events', requireAdmin, (req,res) => {
  const {name,date,venue}=req.body;
  if (!String(name||'').trim() || !String(date||'').trim() || !String(venue||'').trim()) return res.status(400).json({error:'Event name, date and venue are required.'});
  const e={id:data.nextEventId++,name:String(name).trim(),date:String(date).trim(),venue:String(venue).trim(),slug:uniqueSlug(name),created_at:new Date().toISOString()};
  data.events.push(e); saveData(); res.status(201).json({id:e.id,slug:e.slug,link:`/register/${e.slug}`});
});
app.get('/api/admin/events/:id/attendees', requireAdmin, (req,res) => {
  const e=data.events.find(x=>x.id===Number(req.params.id)); if(!e)return res.status(404).json({error:'Event not found.'});
  res.json({event:e,attendees:attendeesForEvent(e.id)});
});
app.delete('/api/admin/attendees/:id', requireAdmin, (req,res) => {
  const i=data.attendees.findIndex(a=>a.id===Number(req.params.id)); if(i<0)return res.status(404).json({error:'Attendee not found.'});
  const a=data.attendees[i]; data.attendees.splice(i,1); saveData();
  if(a.signature_file){const p=path.join(SIG_DIR,a.signature_file);if(fs.existsSync(p))fs.unlinkSync(p);}
  res.json({message:'Attendee deleted.'});
});

function fitText(doc,text,x,y,width,options={}){
  const size=options.size||7;
  doc.font(options.font||'Helvetica').fontSize(size);
  doc.text(String(text??''),x,y,{width,height:options.height||20,ellipsis:true,align:options.align||'left',lineBreak:false,continued:false});
}
function makePdf(event,attendees,filePath){
  const doc=new PDFDocument({size:'A4',layout:'landscape',margins:{top:28,bottom:28,left:28,right:28},bufferPages:true});
  const stream=fs.createWriteStream(filePath);doc.pipe(stream);
  const logoPath=path.join(PUBLIC_DIR,'images','camfed-logo.png');

  // A4 landscape printable width = 842 - 56 = 786 points.
  // Every field is represented in one compact row per person.
  const cols=[24,100,48,80,105,70,65,68,90,136];
  const headers=['No.','Full Name','Gender','Designation','Organisation','Phone','NRC Number','District','Mobile Name','Signature'];
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
    if(fs.existsSync(logoPath)) doc.image(logoPath,28,22,{fit:[115,45]});
    doc.font('Helvetica-Bold').fontSize(16).text('CAMFED ATTENDANCE REGISTER',155,28,{width:600,align:'center'});
    doc.font('Helvetica').fontSize(9).text(event.name,155,49,{width:600,align:'center'});
    doc.fontSize(8).text(`Date: ${event.date}    Venue: ${event.venue}    Total: ${attendees.length}`,155,64,{width:600,align:'center'});
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
  attendees.forEach((a,index)=>{
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
      ''
    ];
    let x=tableX;
    vals.forEach((v,i)=>{
      doc.rect(x,y,cols[i],rowH).stroke();
      if(i===9){
        const sig=path.join(SIG_DIR,a.signature_file);
        if(fs.existsSync(sig)) doc.image(sig,x+4,y+4,{fit:[cols[i]-8,rowH-8],align:'center',valign:'center'});
      } else {
        fitText(doc,v,x+2,y+5,cols[i]-4,{size:i===1?5.7:5.5,height:11,align:i===0?'center':'left'});
      }
      x+=cols[i];
    });
    y+=rowH;
    rowOnPage++;
  });

  const range=doc.bufferedPageRange();
  for(let i=range.start;i<range.start+range.count;i++){
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(7).text(`CAMFED Attendance Register  |  Page ${i+1} of ${range.count}`,28,570,{width:785,align:'center'});
  }
  doc.end();
  return new Promise((resolve,reject)=>{stream.on('finish',()=>resolve(filePath));stream.on('error',reject);});
}
app.get('/api/admin/events/:id/pdf',requireAdmin,async(req,res)=>{const e=data.events.find(x=>x.id===Number(req.params.id));if(!e)return res.status(404).json({error:'Event not found.'});const a=attendeesForEvent(e.id);const safe=e.slug.replace(/[^a-z0-9-]/gi,'_');const filePath=path.join(PDF_DIR,`${safe}-attendance.pdf`);try{await makePdf(e,a,filePath);res.download(filePath,`${safe}-attendance.pdf`);}catch(err){console.error(err);res.status(500).json({error:'PDF generation failed.'});}});

app.use((req,res,next)=>{if(req.method==='GET'&&req.accepts('html'))return res.status(404).sendFile(path.join(PUBLIC_DIR,'404.html'));next();});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Internal server error.'});});

// Local Node.js server. Vercel imports the Express app as a serverless function.
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`CAMFED Attendance System running at http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
    console.log(`Login username: ${ADMIN_USERNAME}`);
  });
  function shutdown(){ server.close(() => process.exit(0)); }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
