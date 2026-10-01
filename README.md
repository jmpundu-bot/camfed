# CAMFED Zambia Attendance System

Vercel-ready Node.js/Express attendance registration system.

## Vercel deployment

1. Push the complete project to GitHub.
2. Import the repository into Vercel.
3. Vercel detects `vercel.json` and deploys `api/index.js`.
4. Set these Environment Variables in Vercel:
   - `NODE_ENV=production`
   - `ADMIN_USERNAME` = your chosen admin username
   - `ADMIN_PASSWORD` = a strong admin password
   - `SESSION_SECRET` = a long random secret
5. Redeploy after saving the variables.

The app exports the Express application instead of calling `app.listen()` when imported by Vercel. Runtime files are written under `/tmp` on Vercel, because the deployment filesystem is not a persistent writable disk.

## Important production storage limitation

The current project uses JSON data and local runtime files for attendance records, signatures, and generated PDFs. This is suitable for local testing and a basic Vercel demonstration, but **Vercel runtime storage is ephemeral**. Data can disappear after a cold start/redeployment.

For a production attendance system, move:
- attendance records -> PostgreSQL/Supabase/Neon
- signatures/PDFs -> object storage such as Vercel Blob or another persistent storage service

The Vercel deployment itself should work without the `500 FUNCTION_INVOCATION_FAILED` caused by the previous `app.listen()`/filesystem assumptions.

## Local development

```bash
npm install
npm start
```

Open `http://localhost:3000/`.

Default local credentials:
- Username: `admin`
- Password: `ChangeThisPassword123!`

Change these before real use.
