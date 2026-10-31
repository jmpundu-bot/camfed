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

Choose **Admin Dashboard** for administrator access or **User Dashboard** for provincial accounts. They use separate login pages, session cookies, and API routes. Admin access requires the configured administrator username and password, or an admin account email and password; provincial access requires the account email, password, and assigned province. Logging into one dashboard does not replace or redirect the other dashboard's session. Only the original administrator (configured through `ADMIN_USERNAME` and `ADMIN_PASSWORD`) can create, edit, or delete additional admin accounts, and can create provincial accounts. All admins can view both account lists, and all admins have the same event and attendee management permissions. Additional admin accounts use email addresses as usernames, and their passwords must be at least 10 characters. A user's email address is their username. Each provincial account is assigned to exactly one of the seven provinces; its event and attendee access is enforced by the server on every request. Provincial users can manage events and attendance only in their assigned province. Provincial passwords are stored as salted scrypt hashes.

Provincial accounts are stored in the `camfed_provincial_users` table, and additional admin accounts are stored in the `camfed_admin_users` table; both are created automatically at startup. Admin account passwords are stored as salted scrypt hashes. No provincial user account is created by default; sign in with the administrator account to create one.

Admin: http://localhost:3000/admin



## Registration expiry and reports

Administrators can choose the registration link validity in whole hours when creating an event (1–720 hours, up to 30 days). Each event card displays its expiry date/time and whether registration is open or expired. To change an existing link, enter a new number of hours and select **Save Expiry / Restart Countdown**. This starts a fresh countdown from the time the setting is saved, so an expired link can be reopened. Registration is checked on the server, not just hidden in the browser. After expiry, use the event card buttons to download the attendance PDF and CSV manually. No email delivery is configured.

## GPS location capture

The attendee registration form requests browser location permission when the attendee submits the form. If permission is granted, latitude, longitude, estimated accuracy, and capture timestamp are saved with the attendance record. Admins can view coordinates and open the location in Google Maps from the attendee list. If permission is denied or the device cannot provide a location, registration can still continue and the record will show that GPS was not captured.

Browser geolocation requires a secure context (HTTPS on a deployed website; localhost is also permitted during local development). Explain the location collection to attendees and restrict access to attendee coordinates to authorised administrators.

This distribution ZIP starts with an empty data store and does not include previous attendee records, signatures, or generated attendance PDFs.

## Live photo capture

The attendee registration page now requires a live photo captured directly from the device camera. On a phone, attendees should open the registration link in a browser, allow camera permission, and select **Open Camera** then **Capture Photo**. The saved photo is included as a **Live Photo** column in the generated A4 landscape attendance PDF. Existing attendee records without a photo will have a blank photo cell.

Camera access requires HTTPS on the deployed site (Vercel provides HTTPS) or localhost during local development. Explain to attendees why photos are collected and restrict access to the stored photos. Signature images and live photos are uploaded to a private Neon Object Storage bucket when configured. On Vercel, set `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `NEON_STORAGE_BUCKET`, and `AWS_REGION` from the Neon storage guide. The Neon credential needs `storage:read` and `storage:write` scopes. Keep the bucket private.

## Automatic attendee data deletion after three months

Attendee personal records are automatically deleted three calendar months after their registration timestamp. The cleanup also removes each expired attendee's saved signature and live-photo files. Any generated attendance PDF for an affected event is deleted because it may contain expired personal data; an administrator can generate a fresh PDF containing only the remaining attendee records. Event definitions are retained.

Cleanup runs when the server starts, on incoming requests, and once every 24 hours while the Node.js process remains running. Records with missing or invalid registration timestamps are left untouched rather than being deleted accidentally.

**Hosting note:** event and attendee records are stored in Neon Postgres. Signatures and live photos are stored in Neon Object Storage. Generated PDFs are built in temporary local storage and downloaded on demand. Vercel does not guarantee continuously running timers, so use a scheduled cleanup job for reliable automatic deletion there.

## Neon database setup

Set `DATABASE_URL` to the connection string for the Neon branch used by the deployment. At startup, the app creates the `camfed_events` and `camfed_attendees` tables and indexes if they do not exist. If those tables are empty and a local `data/data.json` file exists, its event and attendee records are imported once. New event and attendee changes are written directly to Neon Postgres. Uploaded signature and photo bytes are stored in Neon Object Storage; their object keys are kept on each attendee row. The `/api/test` endpoint checks both the database and object storage connections.


## EPRF document downloads

The administrator event card includes a **Download EPRF** action. It uses the original workbook template at `templates/EPRF.xlsx` and populates participant rows beginning at row 8 using each event's existing registration records:

- District (`district`)
- Participant name (`full_name`)
- Designation (`designation`)
- Phone number (`phone_number`)
- Name registered to mobile (`mobile_registered_name`, column V beginning at V8)

The event name and date are populated beside and below the `Activity :` label. The phone number is reused from the existing registration field and is written as text so leading zeroes are retained. The participant count is written beside the `Total` label. The participant table expands to the exact number of registered participants, with no fixed participant-row limit. The Total row is placed immediately after the final participant (for example, 100 participants occupy rows 8–107 and Total appears on row 108). Later template sections move with the Total row, retaining the template's formatting and manually completed columns. The downloaded file is named `EPRF – [Event Name].xlsx`.

Keep `templates/EPRF.xlsx` in place when deploying the application; it is the source template for every EPRF download. No additional attendee registration fields are required.
