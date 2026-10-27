# CAMFED Attendance System v4

## PDF layout update
The attendance PDF has been redesigned so that **all registered details for each person fit on one horizontal row** on A4 landscape.

Included columns:
- No.
- Full Name
- Gender
- Designation
- Organisation
- Phone
- NRC Number
- District
- Mobile Name
- Live Photo (captured from the device camera)\n- Signature

Long text is kept on the same row using compact typography and ellipsis where necessary. The CAMFED Zambia logo remains in the header and as a light watermark on every PDF page.

## Run
```cmd
npm install
npm start
```

Open http://localhost:3000/

Admin: http://localhost:3000/admin

Default admin username: `admin`
Default admin password: `ChangeThisPassword123!`


## Registration expiry and reports

Administrators can choose the registration link validity in whole hours when creating an event (1–720 hours, up to 30 days). Each event card displays its expiry date/time and whether registration is open or expired. To change an existing link, enter a new number of hours and select **Save Expiry / Restart Countdown**. This starts a fresh countdown from the time the setting is saved, so an expired link can be reopened. Registration is checked on the server, not just hidden in the browser. After expiry, use the event card buttons to download the attendance PDF and CSV manually. No email delivery is configured.

## GPS location capture

The attendee registration form requests browser location permission when the attendee submits the form. If permission is granted, latitude, longitude, estimated accuracy, and capture timestamp are saved with the attendance record. Admins can view coordinates and open the location in Google Maps from the attendee list. If permission is denied or the device cannot provide a location, registration can still continue and the record will show that GPS was not captured.

Browser geolocation requires a secure context (HTTPS on a deployed website; localhost is also permitted during local development). Explain the location collection to attendees and restrict access to attendee coordinates to authorised administrators.

This distribution ZIP starts with an empty data store and does not include previous attendee records, signatures, or generated attendance PDFs.

## Live photo capture

The attendee registration page now requires a live photo captured directly from the device camera. On a phone, attendees should open the registration link in a browser, allow camera permission, and select **Open Camera** then **Capture Photo**. The saved photo is included as a **Live Photo** column in the generated A4 landscape attendance PDF. Existing attendee records without a photo will have a blank photo cell.

Camera access requires HTTPS on the deployed site (Vercel provides HTTPS) or localhost during local development. Explain to attendees why photos are collected and restrict access to the stored photos. This application stores photos alongside signature image files in its image storage directory; note that Vercel's serverless filesystem is ephemeral, so production deployments that need persistent photo storage should use object storage such as Supabase Storage.

## Automatic attendee data deletion after three months

Attendee personal records are automatically deleted three calendar months after their registration timestamp. The cleanup also removes each expired attendee's saved signature and live-photo files. Any generated attendance PDF for an affected event is deleted because it may contain expired personal data; an administrator can generate a fresh PDF containing only the remaining attendee records. Event definitions are retained.

Cleanup runs when the server starts, on incoming requests, and once every 24 hours while the Node.js process remains running. Records with missing or invalid registration timestamps are left untouched rather than being deleted accidentally.

**Hosting note:** this build stores records and images on the local filesystem (`data/data.json`, `signatures/`, and `pdfs/`). The automatic timer is suitable for a continuously running Node.js server or local installation. Vercel serverless instances do not guarantee persistent local files or continuously running timers; use a persistent database/object storage and a scheduled cleanup job for reliable automatic deletion on Vercel.
