# How to Get Your Supabase Service Role Key

## Steps:

1. **Go to your Supabase Dashboard**
   - Visit: https://supabase.com/dashboard
   - Sign in to your account

2. **Select your project**
   - Click on the project: `opxeruasowoaybceskyp`

3. **Navigate to Settings**
   - Click on the "Settings" icon in the left sidebar
   - Or go to: https://supabase.com/dashboard/project/opxeruasowoaybceskyp/settings/api

4. **Find the Service Role Key**
   - Scroll down to the "Project API keys" section
   - Look for the **"service_role"** key (NOT the "anon" key)
   - It will be a long JWT token starting with `eyJ...`

5. **Copy the Service Role Key**
   - Click the "Reveal" button or copy icon next to the service_role key
   - **⚠️ IMPORTANT: Keep this key secret! Never commit it to git or share it publicly.**

6. **Update your .env file**
   - Open `back/.env`
   - Replace `YOUR_SERVICE_ROLE_KEY_HERE` with your actual service role key:
   ```env
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9weGVydWFzb3dvYXliY2Vza3lwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTUwNjIzNywiZXhwIjoyMDg1MDgyMjM3fQ.ACTUAL_KEY_HERE
   ```

7. **Restart your backend server**
   ```bash
   cd back
   npm run dev
   ```

## Why do you need the Service Role Key?

The service role key has elevated permissions that allow:
- Writing to the database (inserting subscriptions)
- Uploading files to Supabase Storage
- Bypassing Row Level Security (RLS) policies

The anon key (which you already have) has limited permissions and cannot perform these operations.

## Security Note

- **Never** commit the service role key to git
- **Never** expose it in client-side code
- **Only** use it in your backend server
- The `.env` file should already be in `.gitignore`
